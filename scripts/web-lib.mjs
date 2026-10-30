// web-lib.mjs: lettura dal web.
//  - browser (Chromium via Playwright) per pagine con verifica anti-robot o contenuti caricati dal JavaScript;
//  - download con vie alternative quando un sito risponde 403 ai server di GitHub;
//  - tabelle da pagine HTML e da file CSV;
//  - lettura della piattaforma dei bollettini dell'AT di Benevento (trovaTurniBenevento, leggiTurnoBenevento).
//
// Piattaforma "Bollettini Ufficiali Supplenze" dell'AT di Benevento.
// Qui i bollettini non sono PDF da scaricare: c'è una pagina con i turni (1, 2, 3...), e
// ogni turno si apre in una pagina con la tabella CDC | GRADUATORIA | POS. | PUNTI | ...
// (la pagina indica anche il file sorgente "Bollettino_TotaleNomine_N.csv").
//
// Strategia: per ogni turno provo prima la tabella nella pagina del turno e, se non c'è
// (tabella costruita dal browser), il file CSV sorgente. Nei log scrivo solo la struttura
// (collegamenti e intestazioni), MAI righe con nomi di persone.

const decodeEnt = s => String(s)
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const testoDi = h => decodeEnt(String(h).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// ---- elenco dei turni ------------------------------------------------------------
// Restituisce [{ turno, pageUrl, csvUrl }] ricavati dalla pagina elenco.
export function trovaTurniBenevento(html, baseUrl) {
  const abs = u => { try { return new URL(decodeEnt(u), baseUrl).href; } catch (e) { return null; } };
  const out = [];
  // la pagina ha un riquadro per turno: "Turno Supplenze N"
  const parts = String(html).split(/(?=Turno\s+Supplenze\s+\d+)/i).slice(1);
  for (const chunk of parts) {
    const n = parseInt(/Turno\s+Supplenze\s+(\d+)/i.exec(chunk)[1], 10);
    const prox = chunk.slice(10).search(/Turno\s+Supplenze\s+\d+/i);
    const parte = prox >= 0 ? chunk.slice(0, prox + 10) : chunk;
    const csv = /[^"'\s<>()=]*\.csv[^"'\s<>()]*/i.exec(parte);
    // tutti i valori di collegamento del riquadro (href, data-*, onclick, form action)
    const link = [];
    const re = /(?:href|action|data-[a-z-]+)\s*=\s*["']([^"']+)["']/gi; let m;
    while ((m = re.exec(parte))) link.push(m[1]);
    const reOn = /['"]([^'"\s]+\.(?:php|html?|aspx?)[^'"\s]*)['"]/gi;
    while ((m = reOn.exec(parte))) link.push(m[1]);
    const candidati = link.filter(u => u && !/^(#|javascript:|mailto:)/i.test(u) && !/\.(pdf|csv|zip)(?:[?#]|$)/i.test(u));
    // preferisco il collegamento "Visualizza Bollettino"
    let pageUrl = null;
    const reA = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = reA.exec(parte))) { if (/visualizza|bollettin/i.test(testoDi(m[2])) && !/\.pdf/i.test(m[1]) && !/^(#|javascript:)/i.test(m[1])) { pageUrl = m[1]; break; } }
    if (!pageUrl && candidati.length) pageUrl = candidati[0];
    out.push({ turno: n, pageUrl: pageUrl ? abs(pageUrl) : null, csvUrl: csv ? abs(csv[0]) : null });
  }
  return out;
}

// ---- tabelle ------------------------------------------------------------------------
export function tabellaDaHtml(html) {
  const rows = [];
  const reTr = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi; let m;
  while ((m = reTr.exec(String(html)))) {
    const cells = []; const reTd = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi; let c;
    while ((c = reTd.exec(m[1]))) cells.push(testoDi(c[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// CSV con separatore "," o ";" (lo deduco dalla prima riga)
export function tabellaDaCsv(text) {
  const t = String(text).replace(/^\uFEFF/, '');
  const first = t.split(/\r?\n/, 1)[0] || '';
  const d = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === d) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const key = t => String(t || '').toLowerCase().replace(/[\s.]+/g, '');
const num = v => parseFloat(String(v).trim().replace(',', '.'));
const GRAD = /^(GPS|GAE|GUI|GM)\s*-?\s*(F[12])?$/i;

// Da una tabella (righe di celle) alle righe { code, tipo, fascia, pos, pts }.
// Legge l'intestazione se c'è (CDC/Classe di concorso, Graduatoria, Pos., Punti); se
// non la trova, riconosce le righe dalla forma: "A003 - ...", "GPS - F1", numeri.
export function parseTabellaBollettino(table) {
  const rows = [], skipped = [];
  const hi = table.findIndex(r => r.some(c => ['cdc', 'classediconcorso'].includes(key(c))));
  let iC = -1, iG = -1, iF = -1, iP = -1, iS = -1;
  if (hi >= 0) {
    const h = table[hi].map(key);
    iC = h.findIndex(x => x === 'cdc' || x === 'classediconcorso');
    iG = h.findIndex(x => x === 'graduatoria' || x === 'tipograduatoria');
    iF = h.indexOf('fascia');
    iP = h.findIndex(x => x === 'pos' || x === 'posizione');
    iS = h.findIndex(x => x === 'punti' || x === 'punteggio');
  }
  const conHeader = hi >= 0 && iC >= 0 && iG >= 0 && iP >= 0 && iS >= 0;
  for (const r of table.slice(conHeader ? hi + 1 : 0)) {
    let cls, grad, pos, pts, fascia = null;
    if (conHeader) { cls = r[iC]; grad = r[iG]; pos = num(r[iP]); pts = num(r[iS]); if (iF >= 0) fascia = String(r[iF] || '').trim().toUpperCase(); }
    else {
      cls = r.find(c => /^[A-Z0-9]{4}\s*-\s/.test(c));
      const gi = r.findIndex(c => /^(GPS|GAE|GUI|GM)\s*-\s*F[12]$/i.test(c));
      if (!cls || gi < 0) continue;
      grad = r[gi];
      const nums = r.slice(gi + 1).filter(c => /^\d+([.,]\d+)?$/.test(c.trim()));
      pos = nums.length ? num(nums[0]) : NaN; pts = nums.length > 1 ? num(nums[1]) : NaN;
    }
    cls = String(cls || '').trim(); grad = String(grad || '').trim();
    if (!cls) continue;
    const mc = /^([A-Z0-9]{4})\b/i.exec(cls);
    const mg = GRAD.exec(grad);
    const tipo = mg ? mg[1].toUpperCase() : grad.toUpperCase();
    const fas = (mg && mg[2] ? mg[2].toUpperCase() : fascia) || null;
    if (!mc || !mg || Number.isNaN(pos) || Number.isNaN(pts)) { if (tipo === 'GPS') skipped.push({ raw: cls.slice(0, 60) }); continue; }
    rows.push({ code: mc[1].toUpperCase(), tipo, fascia: fas, pos, pts, ok: true });
  }
  return { calibrated: conHeader || rows.length > 0, rows, skipped };
}

// ---- lettura di un turno -------------------------------------------------------
// fetchText: funzione che scarica un indirizzo e restituisce il testo.
// Restituisce { calibrated, rows, skipped, dataIso, fonte }.
export async function leggiTurnoBenevento(src, fetchText, log = console.log) {
  const vuoto = { calibrated: false, rows: [], skipped: [], dataIso: null, fonte: null };
  let dataIso = null;
  if (src.pageUrl) {
    try {
      const html = await fetchText(src.pageUrl, 'pagina');
      const dm = /Data\s*Produzione:?\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(testoDi(html));
      if (dm) dataIso = `${dm[3]}-${dm[2]}-${dm[1]}`;
      const res = parseTabellaBollettino(tabellaDaHtml(html));
      log('    pagina del turno ' + src.turno + ': ' + html.length + ' caratteri, tabelle/righe lette=' + res.rows.length + (dataIso ? ', data produzione ' + dataIso : ''));
      if (res.rows.length) return { ...res, dataIso, fonte: 'pagina' };
      // tabella costruita dal browser: cerco il file dati citato nella pagina
      if (!src.csvUrl) {
        const m = /[^"'`\s<>()=]*\.csv[^"'`\s<>()]*/i.exec(html);
        if (m) { try { src = { ...src, csvUrl: new URL(decodeEnt(m[0]), src.pageUrl).href }; log('    file dati trovato nella pagina: ' + src.csvUrl.slice(-80)); } catch (e) {} }
      }
    } catch (e) { log('    pagina del turno ' + src.turno + ' non letta: ' + e.message); }
  }
  if (src.csvUrl) {
    try {
      const text = await fetchText(src.csvUrl, 'csv');
      const table = tabellaDaCsv(text);
      const res = parseTabellaBollettino(table);
      // nel log solo l'intestazione, se riconosciuta; mai una riga di dati (contiene nomi)
      const hr = table.find(r => r.some(c => ['cdc', 'classediconcorso'].includes(key(c))));
      const hdr = hr ? hr.join(' | ').slice(0, 200) : '(non riconosciuta, ' + ((table[0] || []).length) + ' colonne)';
      log('    CSV del turno ' + src.turno + ': ' + table.length + ' righe, lette=' + res.rows.length + ', intestazione: ' + hdr);
      if (res.rows.length) return { ...res, dataIso, fonte: 'csv' };
    } catch (e) { log('    CSV del turno ' + src.turno + ' non letto: ' + e.message); }
  }
  return { ...vuoto, dataIso };
}

// ---- download con vie alternative -------------------------------------------------
// Il sito di Benevento risponde 403 ai server di GitHub. Provo, nell'ordine:
//   1) accesso diretto;
//   2) r.jina.ai (legge la pagina da un altro indirizzo e, se serve, esegue il JavaScript);
//   3) copia dell'Internet Archive (web.archive.org);
//   4) altri due servizi pubblici di inoltro (allorigins, corsproxy).
// Ogni tentativo è scritto nel log (stato e dimensione, mai il contenuto). Una risposta
// vale solo se supera il controllo "valida" (es. contiene "Turno Supplenze"): così una
// pagina di errore o di blocco non viene scambiata per il bollettino.
// NB: i bollettini sono pubblici, ma passando da questi servizi il contenuto (anche i nomi
// dei candidati) transita da terzi: l'uso è limitato a Benevento e si può spegnere
// togliendo `proxyFallback` dalla configurazione della provincia.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Accept': 'text/html,application/xhtml+xml,text/csv,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9',
};

async function provaFetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, redirect: 'follow', signal: AbortSignal.timeout(45000) });
  const text = await r.text();
  return { status: r.status, text, server: r.headers && r.headers.get ? (r.headers.get('server') || '') : '' };
}

// Il server di Benevento (Aruba) mostra una pagina "Wait a moment..." che un browser supera
// eseguendo il suo JavaScript. Uso un browser vero (Chromium via Playwright, installato dal
// workflow solo quando serve). Una sola sessione per tutto il giro, così i cookie della
// verifica valgono anche per le pagine e i CSV successivi.
let _bw = null;
async function sessioneBrowser() {
  if (_bw) return _bw;
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch (e) { throw new Error('Playwright non installato'); }
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ locale: 'it-IT', viewport: { width: 1280, height: 900 } });
  _bw = { browser, ctx, page: await ctx.newPage() };
  return _bw;
}
export async function chiudiBrowser() { if (_bw) { try { await _bw.browser.close(); } catch (e) {} _bw = null; } }
async function leggiConBrowser(url, tipo, log) {
  const { page, ctx } = await sessioneBrowser();
  if (tipo === 'csv') { // stessa sessione: i cookie della verifica sono già validi
    const r = await ctx.request.get(url, { timeout: 45000 });
    return { status: r.status(), text: await r.text() };
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !/wait a moment|just a moment|attendere|checking/i.test(document.title), null, { timeout: 40000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  if (tipo === 'pagina') await page.waitForSelector('table tr', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const titolo = await page.title().catch(() => '');
  log('        browser: titolo pagina "' + String(titolo).slice(0, 80) + '"');
  return { status: 200, text: await page.content() };
}

// HTML di una pagina dopo l'esecuzione del suo JavaScript (allegati caricati dinamicamente).
// Lancia un errore se il browser non è installato: il chiamante ignora e prosegue.
export async function htmlConBrowser(url, log = console.log) {
  const r = await leggiConBrowser(url, 'pagina', log);
  return r.text;
}

export async function scaricaConFallback(url, fetchDiretto, valida, log = console.log, tipo = 'pagina') {
  const enc = encodeURIComponent(url);
  const vie = [
    { nome: 'diretto', run: async () => ({ status: 200, text: await fetchDiretto(url) }) },
    { nome: 'browser', run: () => leggiConBrowser(url, tipo, log) },
    { nome: 'r.jina.ai', run: () => provaFetch('https://r.jina.ai/' + url, { headers: { 'X-Return-Format': 'html', 'Accept': 'text/html' } }) },
    { nome: 'web.archive.org', run: () => provaFetch('https://web.archive.org/web/2/' + url, { headers: BROWSER_HEADERS }) },
    { nome: 'allorigins', run: () => provaFetch('https://api.allorigins.win/raw?url=' + enc, { headers: BROWSER_HEADERS }) },
    { nome: 'corsproxy', run: () => provaFetch('https://corsproxy.io/?' + enc, { headers: BROWSER_HEADERS }) },
  ];
  for (const via of vie) {
    try {
      const r = await via.run();
      const ok = r.status >= 200 && r.status < 300 && r.text && (!valida || valida(r.text));
      log('      via ' + via.nome + ': stato ' + r.status + ', ' + (r.text || '').length + ' caratteri' + (ok ? ' -> OK' : ' -> non valida'));
      if (ok) return r.text;
      // pagina di blocco: ne scrivo il titolo (non il contenuto) per capire chi blocca
      if (via.nome === 'diretto' || r.status >= 400) {
        const t = /<title[^>]*>([\s\S]{0,120}?)<\/title>/i.exec(r.text || '');
        if (t && via.nome !== 'diretto') log('        titolo pagina: ' + testoDi(t[1]));
      }
    } catch (e) {
      log('      via ' + via.nome + ': errore ' + String(e.message).slice(0, 100));
      if (via.nome === 'diretto') {
        // diagnosi del blocco: intestazioni e titolo della pagina di errore
        try {
          const d = await provaFetch(url, { headers: BROWSER_HEADERS });
          const t = /<title[^>]*>([\s\S]{0,120}?)<\/title>/i.exec(d.text || '');
          log('        diagnosi blocco: stato ' + d.status + ', server "' + d.server + '"' + (t ? ', titolo "' + testoDi(t[1]) + '"' : '') + ', ' + (d.text || '').length + ' caratteri');
        } catch (e2) { log('        diagnosi: ' + String(e2.message).slice(0, 100)); }
      }
    }
  }
  throw new Error('nessuna via ha dato una risposta valida per ' + url.slice(-70));
}

// controlli di validità per i tre tipi di contenuto della piattaforma
export const VALIDA_BN = {
  elenco: t => /Turno\s+Supplenze\s+\d+/i.test(t),
  pagina: t => /<tr\b/i.test(t) || /Data\s*Produzione/i.test(testoDi(t)) || /\.csv/i.test(t),
  csv: t => /classe\s*di\s*concorso|cdc/i.test(t.slice(0, 2000)) && !/^\s*<(!doctype|html)/i.test(t),
};
