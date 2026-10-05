// Estrae dal bollettino, riga per riga, i valori delle colonne che interessano
// (Classe di concorso, Tipo Graduatoria, Fascia, Posizione, Punteggio),
// usando le coordinate x della tabella (il PDF è generato da un foglio Excel
// con colonne a x fissa), invece di leggere il testo come un unico blocco:
// questo evita che un codice di classe citato in un'altra colonna
// (per esempio la "classe di concorso di origine" nelle righe di sostegno
// per incrocio, GUI) venga scambiato per la classe della riga.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

function norm(s) { return s.replace(/\s+/g, ' ').trim(); }
const NUM_RE = /^\d{1,4}(?:[.,]\d{1,3})?$/;

async function pageRows(pg) {
  const tc = await pg.getTextContent();
  const items = tc.items.filter(it => it.str && it.str.trim()).map(it => ({ x: it.transform[4], y: it.transform[5], s: it.str }));
  const rows = {};
  items.forEach(it => { const y = Math.round(it.y / 2); (rows[y] = rows[y] || []).push(it); });
  return Object.keys(rows).map(Number).sort((a, b) => b - a).map(y => rows[y].sort((a, b) => a.x - b.x));
}

export function findHeader(rows) {
  // L'intestazione può stare su una riga sola (Modena) o spezzarsi su più
  // righe quando la tabella ha più colonne (per esempio a Ravenna, che ha
  // "Elenco aggiuntivo", "Inclusione con riserva" e "Ordine nomina" in più:
  // con meno spazio per colonna, un titolo come "Classe di concorso di
  // origine" può finire scritto su tre righe separate). Per ritrovarlo in
  // entrambi i casi, raggruppo i frammenti di testo per colonna (stessa x,
  // pochi punti di tolleranza) leggendo le prime righe della pagina, e li
  // ricompongo leggendo dall'alto in basso finché non arrivo a una riga con
  // un numero dentro: lì l'intestazione è finita e comincia la prima riga
  // di dati.
  const HEADER_ROWS = Math.min(rows.length, 14);
  const cols = []; // { x, parts: [{r, text}] }
  let stopAt = HEADER_ROWS;
  for (let r = 0; r < HEADER_ROWS; r++) {
    const hasNumber = rows[r].some(it => NUM_RE.test(norm(it.s)));
    if (hasNumber) { stopAt = r; break; }
    for (const it of rows[r]) {
      const t = norm(it.s);
      if (!t) continue;
      let col = cols.find(c => Math.abs(c.x - it.x) < 6);
      if (!col) { col = { x: it.x, parts: [] }; cols.push(col); }
      col.parts.push({ r, text: t });
    }
  }
  cols.forEach(c => { c.label = c.parts.sort((a, b) => a.r - b.r).map(p => p.text).join(' ').replace(/\s+/g, ' ').trim(); });
  const find = label => cols.find(c => c.label === label);

  const classe = find('Classe di concorso');
  const fascia = find('Fascia');
  const grOrig = find('Graduatoria di origine');
  const clOrig = find('Classe di concorso di origine');
  const scuola = find('Codice scuola');
  const tipo = find('Tipo Graduatoria') || find('Tipo graduatoria') || find('Graduatoria') || find('Tipo');
  if (classe && fascia && grOrig && clOrig && scuola && tipo) {
    return {
      headerRowIndex: stopAt,
      xClasse: classe.x, xTipo: tipo.x, xFascia: fascia.x, xGrOrig: grOrig.x,
      xClOrig: clOrig.x, xScuola: scuola.x,
    };
  }
  return null;
}

export function parseRow(row, cal) {
  if (!row.length) return null;
  const b12 = (cal.xClasse + cal.xTipo) / 2, b23 = (cal.xTipo + cal.xFascia) / 2, b34 = (cal.xFascia + cal.xGrOrig) / 2;
  const classeIt = row.find(it => it.x < b12);
  if (!classeIt) return null;
  const classeTxt = norm(classeIt.s);
  const codeM = /^([A-Za-z0-9]{2,6})\b/.exec(classeTxt);
  if (!codeM) return null;
  const tipoIt = row.find(it => it.x >= b12 && it.x < b23);
  const fasciaIt = row.find(it => it.x >= b23 && it.x < b34);
  var nums = [];
  row.filter(function(it){return it.x > cal.xClOrig + 2 && it.x < cal.xScuola - 2;}).forEach(function(it){
    norm(it.s).split(/\s+/).forEach(function(tok,ti){ if(NUM_RE.test(tok)) nums.push({x:it.x+ti*0.001,s:tok}); });
  });
  nums.sort((a, b) => a.x - b.x);
  const out = {
    code: codeM[1].toUpperCase(),
    tipo: tipoIt ? norm(tipoIt.s).toUpperCase() : null,
    fascia: fasciaIt ? norm(fasciaIt.s).toUpperCase() : null,
  };
  if (nums.length === 2) { out.pos = parseFloat(norm(nums[0].s).replace(',', '.')); out.pts = parseFloat(norm(nums[1].s).replace(',', '.')); out.ok = true; }
  else { out.ok = false; out.nNums = nums.length; }
  return out;
}

export async function parseBulletin(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true }).promise;
  let cal = null;
  const rowsAll = [], skipped = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const rows = await pageRows(pg);
    if (!cal) {
      cal = findHeader(rows);
      if (!cal) continue; // magari l'intestazione è su un'altra pagina
    }
    // scarta le righe di intestazione ripetuta e i piè di pagina tipo "1 di 12"
    for (const row of rows) {
      const t = row.map(it => norm(it.s)).join(' ');
      if (/^Classe di concorso/.test(t) || /^\d+ di \d+$/.test(t) || row.length < 3) continue;
      const r = parseRow(row, cal);
      if (r) { if (r.ok) rowsAll.push(r); else skipped.push({ ...r, raw: t.slice(0, 160) }); }
    }
  }
  return { calibrated: !!cal, rows: rowsAll, skipped };
}

// Aggrega per (classe, fascia), solo graduatoria "GPS" (esclude GAE e GUI,
// che userebbero un punteggio "di origine" non direttamente confrontabile).
export function aggregate(rows) {
  const out = {};
  rows.filter(r => r.tipo === 'GPS').forEach(r => {
    const f = r.fascia === 'F1' ? '1' : (r.fascia === 'F2' ? '2' : null);
    if (!f) return;
    out[r.code] = out[r.code] || {};
    const cur = out[r.code][f];
    if (!cur || r.pts < cur.p) out[r.code][f] = { p: r.pts, n: r.pos };
  });
  return out;
}
