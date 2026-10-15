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
  // le righe di titolo sopra la tabella ("UAT ... NOMINE ... TURNO 3") non fanno
  // parte dell'intestazione: parto dalla riga che contiene "Classe di concorso"
  let rStart = rows.findIndex(row => row.some(it => /^Classe di concorso/.test(norm(it.s))));
  if (rStart < 0 || rStart >= HEADER_ROWS) rStart = 0;
  for (let r = rStart; r < HEADER_ROWS; r++) {
    const hasNumber = rows[r].some(it => NUM_RE.test(norm(it.s)));
    // anche l'inizio di un record ("A008 - DISCIPLINE ...") chiude l'intestazione:
    // se il nome della prima classe va a capo su più righe, queste righe
    // arrivano prima del primo numero e sporcherebbero il titolo della colonna
    const startsRecord = rows[r].some(it => /^[A-Z0-9]{4}\s*-\s/.test(norm(it.s)));
    if (hasNumber || startsRecord) { stopAt = r; break; }
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

// Codice classe scritto all'inizio di una cella della colonna "Classe di
// concorso" (es. "A008 - DISCIPLINE"). Quando la colonna è stretta il testo
// va a capo su 3-6 righe: il codice sta nella PRIMA riga, mentre tipo,
// fascia, posizione e punteggio stanno nell'ULTIMA. Per questo il codice
// va ricordato di riga in riga (vedi processRows).
export function classCodeOf(row, cal) {
  const b12 = (cal.xClasse + cal.xTipo) / 2;
  const it = row.find(i => i.x < b12);
  if (!it) return null;
  const t = norm(it.s).toUpperCase();
  const strict = /^([A-Z0-9]{4})\s*-/.exec(t);
  if (strict) return strict[1];
  const m = /^([A-Z0-9]{4})\b/.exec(t);
  if (m && (/\d/.test(m[1]) || /^(AAAA|EEEE|EEEM|PPPP|AD[A-Z]{2})$/.test(m[1]))) return m[1];
  return null;
}

export function parseRow(row, cal, carryCode) {
  if (!row.length) return null;
  const b12 = (cal.xClasse + cal.xTipo) / 2, b23 = (cal.xTipo + cal.xFascia) / 2, b34 = (cal.xFascia + cal.xGrOrig) / 2;
  const rowCode = classCodeOf(row, cal) || carryCode || null;
  if (!rowCode) return null;
  const codeM = [null, rowCode];
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
  // le prime due cifre da sinistra sono Posizione e Punteggio; un'eventuale terza
  // ("Ordine nomina", quando sta sulla stessa riga) va ignorata
  if (nums.length >= 2) { out.pos = parseFloat(norm(nums[0].s).replace(',', '.')); out.pts = parseFloat(norm(nums[1].s).replace(',', '.')); out.ok = true; }
  else { out.ok = false; out.nNums = nums.length; }
  return out;
}

export async function parseBulletin(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true }).promise;
  let cal = null;
  const rowsAll = [], skipped = [], state = { code: null };
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const rows = await pageRows(pg);
    if (!cal) {
      cal = findHeader(rows);
      if (!cal) continue; // magari l'intestazione è su un'altra pagina
    }
    processRows(rows, cal, state, rowsAll, skipped);
  }
  return { calibrated: !!cal, rows: rowsAll, skipped };
}

// Scorre le righe di una pagina ricordando l'ultimo codice classe visto.
// Scarta intestazioni ripetute e piè di pagina ("1 di 12"). Tra le righe non
// leggibili segnalo come "scartate" solo quelle di graduatoria GPS: le righe
// GUI/GAE o i pezzi di celle a capo non devono far scattare il "dubbio".
export function processRows(rows, cal, state, rowsAll, skipped) {
  for (const row of rows) {
    const t = row.map(it => norm(it.s)).join(' ');
    if (/^Classe di concorso/.test(t) || /^\d+ di \d+$/.test(t)) continue;
    const own = classCodeOf(row, cal);
    if (own) state.code = own;
    if (row.length < 3) continue;
    const r = parseRow(row, cal, state.code);
    if (!r) continue;
    if (r.ok) rowsAll.push(r);
    else if (r.tipo === 'GPS') skipped.push({ ...r, raw: t.slice(0, 160) });
  }
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
