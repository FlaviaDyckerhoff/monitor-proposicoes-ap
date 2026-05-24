const fs = require('fs');

const CASA = 'ALAP';
const PORTAL = 'https://elegis.al.ap.leg.br/portal/proposicoes';
const ARQUIVO_ESTADO = 'estado.json';

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function limparHtml(texto) {
  return String(texto || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function buscarPagina(pagina) {
  const url = pagina === 1 ? PORTAL : `${PORTAL}?page=${pagina}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120', 'Accept': 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

function normalizarNumero(numero) {
  const match = numero.match(/^(.+?)\s+n[º°o]\s*([\d.]+)\/(\d{2,4})/i);
  if (!match) return { tipo: numero, numero: '-', ano: '-' };
  const ano = match[3].length === 2 ? `20${match[3]}` : match[3];
  return { tipo: match[1].trim(), numero: match[2].replace(/\./g, ''), ano };
}

function extrairProposicoes(html) {
  const linhas = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const itens = [];
  for (const [, linha] of linhas) {
    const colunas = [...linha.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (colunas.length < 5) continue;
    const link = (colunas[4].match(/href=["']([^"']+)/i) || [])[1] || '';
    const id = (link.match(/proposicao\/(\d+)/) || [])[1];
    if (!id) continue;
    const numeroTexto = limparHtml(colunas[1]);
    const normal = normalizarNumero(numeroTexto);
    itens.push({
      id: String(id),
      tipo: normal.tipo,
      numero: normal.numero,
      ano: normal.ano,
      autor: limparHtml(colunas[2]),
      data: limparHtml(colunas[0]),
      ementa: limparHtml(colunas[3]),
      link,
    });
  }
  return itens;
}

async function buscarProposicoes() {
  const todas = [];
  const vistos = new Set();
  for (let pagina = 1; pagina <= 3; pagina++) {
    const html = await buscarPagina(pagina);
    const itens = extrairProposicoes(html);
    console.log(`Página ${pagina}: ${itens.length} proposições`);
    if (itens.length === 0) break;
    for (const item of itens) {
      if (!vistos.has(item.id)) {
        vistos.add(item.id);
        todas.push(item);
      }
    }
  }
  return todas;
}

async function enviarEmail(novas) {
  if (process.env.DRY_RUN_EMAIL === '1') {
    console.log(`[DRY_RUN_EMAIL] ${novas.length} proposições novas.`);
    novas.slice(0, 10).forEach(p => console.log(`${p.tipo} ${p.numero}/${p.ano} - ${p.data} - ${p.link}`));
    return;
  }
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_REMETENTE, pass: process.env.EMAIL_SENHA },
  });
  const linhas = novas.map(p => `<tr>
    <td style="padding:8px;border-bottom:1px solid #eee"><a href="${escapeHtml(p.link)}"><strong>${escapeHtml(p.tipo)} ${escapeHtml(p.numero)}/${escapeHtml(p.ano)}</strong></a></td>
    <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(p.autor)}</td>
    <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">${escapeHtml(p.data)}</td>
    <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(p.ementa)}</td>
  </tr>`).join('');
  await transporter.sendMail({
    from: `"Monitor ${CASA}" <${process.env.EMAIL_REMETENTE}>`,
    to: process.env.EMAIL_DESTINO,
    subject: `🏛️ ${CASA}: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:960px"><h2>${CASA} — ${novas.length} nova(s) proposição(ões)</h2><table style="border-collapse:collapse;width:100%">${linhas}</table></div>`,
  });
}

(async () => {
  console.log('Iniciando Monitor Proposições AP...');
  const estado = carregarEstado();
  const ids = new Set((estado.proposicoes_vistas || []).map(String));
  const proposicoes = await buscarProposicoes();
  const novas = proposicoes.filter(p => !ids.has(p.id));
  console.log(`Total: ${proposicoes.length} | Novas: ${novas.length}`);
  if (process.env.SEED_ONLY === '1') {
    proposicoes.forEach(p => ids.add(p.id));
    estado.proposicoes_vistas = Array.from(ids);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
    console.log('SEED_ONLY=1 — estado semeado sem envio.');
    return;
  }
  if (novas.length) {
    await enviarEmail(novas);
    novas.forEach(p => ids.add(p.id));
    estado.proposicoes_vistas = Array.from(ids);
  }
  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();
