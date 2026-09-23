// Estrae dal bollettino, riga per riga, i valori delle colonne che interessano
// (Classe di concorso, Tipo Graduatoria, Fascia, Posizione, Punteggio),
// usando le coordinate x della tabella (il PDF è generato da un foglio Excel
// con colonne a x fissa), invece di leggere il testo come un unico blocco:
// questo evita che un codice di classe citato in un'altra colonna
// (per esempio la "classe di concorso di origine" nelle righe di sostegno
// per incrocio, GUI) venga scambiato per la classe della riga.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

function norm(s) { return s.replace(/\s+/g, ' ').trim(); }

async function pageRows(pg) {
  const tc = await pg.getTextContent();
  const items = tc.items.filter(it => it.str && it.str.trim()).map(it => ({ x: it.transform[4], y: it.transform[5], s: it.str }));
  const rows = {};
  items.forEach(it => { const y = Math.round(it.y / 2); (rows[y] = rows[y] || []).push(it); });
  return Object.keys(rows).map(Number).sort((a, b) => b - a).map(y => rows[y].sort((a, b) => a.x - b.x));
}

function findHeader(rows) {
  // L'intestazione occupa due righe fisiche ravvicinate ("Tipo" sopra "Graduatoria").
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    const classe = a.find(it => norm(it.s) === 'Classe di concorso');
    const fascia = a.find(it => norm(it.s) === 'Fascia');
    const grOrig = a.find(it => norm(it.s) === 'Graduatoria di origine');
    const clOrig = a.find(it => norm(it.s) === 'Classe di concorso di origine');
    const scuola = a.find(it => norm(it.s) === 'Codice scuola');
    const tipo = b.find(it => norm(it.s) === 'Graduatoria') || a.find(it => norm(it.s) === 'Graduatoria');
    if (classe && fascia && grOrig && clOrig && scuola && tipo) {
      return {
        headerRowIndex: i + 1, // la riga dati inizia dopo la seconda riga di intestazione
        xClasse: classe.x, xTipo: tipo.x, xFascia: fascia.x, xGrOrig: grOrig.x,
        xClOrig: clOrig.x, xScuola: scuola.x,
      };
    }
  }
  return null;
}

const NUM_RE = /^\d{1,4}(?:[.,]\d{1,3})?$/;

function parseRow(row, cal) {
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
