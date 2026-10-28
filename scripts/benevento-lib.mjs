// Lettura dei bollettini dalla piattaforma "Bollettini Ufficiali Supplenze" dell'AT di Benevento.
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
      const html = await fetchText(src.pageUrl);
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
      const text = await fetchText(src.csvUrl);
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
