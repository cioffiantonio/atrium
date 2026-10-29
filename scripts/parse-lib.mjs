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
  const items = tc.items.filter(it => it.str && it.str.trim()).map(it => ({ x: it.transform[4], y: it.transform[5], s: it.str, w: it.width || 0 }));
  // Raggruppo i frammenti per riga con una tolleranza sulla y (non con un
  // arrotondamento a gradini fissi: due frammenti della stessa riga, sfalsati
  // di 0,1 punti, potevano finire in righe diverse, come la fascia a Ravenna).
  const sorted = items.slice().sort((a, b) => b.y - a.y);
  const groups = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.y - it.y) <= 1.6) g.items.push(it); else groups.push({ y: it.y, items: [it] });
  }
  return groups.map(g => g.items.sort((a, b) => a.x - b.x));
}

// Prima provo a raggruppare i frammenti dei titoli per x di partenza; se non basta
// (titoli centrati e spezzati su molte righe: i frammenti iniziano a x diverse)
// li raggruppo per CENTRO. Vedi headerWith.
export function findHeader(rows) {
  return headerWith(rows, 'left') || headerWith(rows, 'center');
}

function headerWith(rows, mode) {
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
  // (il ciclo si ferma comunque alla prima riga di dati: servono più di 14 righe
  // quando l'intestazione è spezzata su molte righe, come a Ravenna)
  const HEADER_ROWS = Math.min(rows.length, 40);
  const cols = []; // { x, parts: [{r, text}] }
  let stopAt = HEADER_ROWS;
  for (let r = 0; r < HEADER_ROWS; r++) {
    // L'intestazione finisce alla prima riga di dati: quella con il tipo di
    // graduatoria ("GPS", "GAE"...) oppure con l'inizio del nome della classe
    // ("A008 - DISCIPLINE ..."; anche se il nome va a capo, le righe prima del
    // tipo cominciano così). I numeri NON bastano: nell'intestazione ce ne sono
    // ("L. 104", "Codice comune L. 104") e quando un titolo è spezzato a metà
    // parola ("Fasci" / "a") l'ultima riga del titolo viene dopo di loro.
    const startsRecord = rows[r].some(it => /^[A-Z0-9]{4}\s*[-–—]\s/.test(norm(it.s)) || /^(GPS|GAE|GM|GUI|GI)$/.test(norm(it.s)));
    if (startsRecord) { stopAt = r; break; }
    for (const it of rows[r]) {
      const t = norm(it.s);
      if (!t) continue;
      const key = mode === 'center' ? it.x + (it.w || 0) / 2 : it.x;
      let col = cols.find(c => Math.abs(c.k - key) < (mode === 'center' ? 7 : 6));
      if (!col) { col = { k: key, x: it.x, parts: [] }; cols.push(col); }
      else if (mode === 'center') col.x = Math.min(col.x, it.x);
      col.parts.push({ r, text: t });
    }
  }
  cols.forEach(c => { c.label = c.parts.sort((a, b) => a.r - b.r).map(p => p.text).join(' ').replace(/\s+/g, ' ').trim(); });
  // il titolo di una colonna può avere davanti righe di titolo del documento
  // (es. "TURNO 3" nella stessa colonna di "Classe di concorso"): accetto anche
  // un'etichetta che FINISCE con il titolo cercato
  // confronto senza spazi né maiuscole: alcuni uffici spezzano le parole ("gradua" / "toria")
  const sp = t => t.toLowerCase().replace(/\s+/g, '');
  const find = label => cols.find(c => sp(c.label) === sp(label)) || cols.find(c => sp(c.label).endsWith(sp(label)));

  // alcuni uffici usano sigle: CDC / GRAD / POSTO / PUNTI (Avellino)
  // ultima spiaggia: titolo che COMINCIA come atteso (frammenti staccati a fine parola)
  const fs = (pref, not) => cols.find(c => sp(c.label).startsWith(pref) && !(not && sp(c.label).startsWith(not)));
  const classe = find('Classe di concorso') || find('CDC') || find('C.D.C.') || fs('classediconcorso', 'classediconcorsodi');
  const fascia = find('Fascia') || fs('fasci');
  const grOrig = find('Graduatoria di origine') || fs('graduatoriadi');
  const clOrig = find('Classe di concorso di origine') || fs('classediconcorsodi');
  const posiz = find('Posizione') || find('POSTO') || fs('posizi');
  const scuola = find('Codice scuola') || fs('codicescu');
  const tipo = find('Tipo graduatoria') || find('Graduatoria') || find('GRAD') || fs('tipograd') || find('Tipo');
  // Le colonne "di origine" (sostegno per incrocio) ci sono solo in alcuni uffici;
  // dove mancano (Parma, Caserta...) la zona dei numeri parte dalla colonna Posizione.
  // In alcuni bollettini la colonna \"Ordine nomina\" sta PRIMA di \"Punteggio\" (Ravenna
  // del 26/10): il punteggio è allora il terzo numero e non il secondo. Lo leggo
  // dall'intestazione, altrimenti si prenderebbe l'ordine al posto del punteggio.
  const ordine = find('Ordine nomina') || fs('ordinenomin');
  const punt = find('Punteggio') || fs('punteggi');
  const ordinePrima = !!(ordine && punt && ordine.x < punt.x && (!posiz || ordine.x > posiz.x));
  if (classe && fascia && scuola && tipo && ((grOrig && clOrig) || posiz)) {
    return {
      ptsIdx: ordinePrima ? 2 : 1,
      headerRowIndex: stopAt,
      xClasse: classe.x, xTipo: tipo.x, xFascia: fascia.x,
      xGrOrig: grOrig && clOrig ? grOrig.x : posiz.x - 1,
      xClOrig: grOrig && clOrig ? clOrig.x : posiz.x - 12,
      xScuola: scuola.x,
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
  const strict = /^([A-Z0-9]{4})\s*[-–—]/.exec(t);
  if (strict) return strict[1];
  const m = /^([A-Z0-9]{4})\b/.exec(t);
  if (m && (/\d/.test(m[1]) || /^(AAAA|EEEE|EEEM|EEIL|PPPP|AD[A-Z]{2})$/.test(m[1]))) return m[1];
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
  // Alcuni PDF (es. Rimini) mettono tipo e fascia nella stessa cella: \"GPS F1\".
  // Li separo, altrimenti la riga non risulterebbe GPS e verrebbe scartata.
  const tf = /^(GPS|GUI|GAE|GM)\s*(F[12])$/.exec(out.tipo || '');
  if (tf) { out.tipo = tf[1]; if (!out.fascia) out.fascia = tf[2]; }
  // le prime due cifre da sinistra sono Posizione e Punteggio; un'eventuale terza
  // ("Ordine nomina", quando sta sulla stessa riga) va ignorata
  const pi = cal.ptsIdx || 1;
  if (nums.length > pi) { out.pos = parseFloat(norm(nums[0].s).replace(',', '.')); out.pts = parseFloat(norm(nums[pi].s).replace(',', '.')); out.ok = true; }
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

// Lettura "a testo" di una riga: serve quando il PDF mette classe, tipo, fascia,
// posizione e punteggio nello stesso blocco di testo (es. Piacenza) e quindi
// le colonne non si distinguono dalla posizione. Si guarda il PRIMO tipo di
// graduatoria della riga: se è GPS, i due numeri dopo la fascia sono
// Posizione e Punteggio; "GUI F1 GPS F2 ..." (incrocio) si ignora.
function textRecord(row, ptsIdx) {
  const line = row.slice().sort((a, b) => a.x - b.x).map(it => norm(it.s)).join(' ');
  const m = /(GPS|GAE|GM|GUI)\s*(F[12])(?![0-9])/.exec(line);
  if (!m) return null;
  const rest = line.slice(m.index + m[0].length);
  const nm = /^\s*(\d{1,6})\s+(\d{1,3}(?:[.,]\d{1,2})?)(?:\s+(\d{1,3}(?:[.,]\d{1,2})?))?(?=\s|$)/.exec(rest);
  // il punteggio è il 2° numero (o il 3° se \"Ordine nomina\" lo precede); se manca, la riga è non leggibile
  const ptsTxt = nm ? nm[ptsIdx === 2 ? 3 : 2] : null;
  return {
    tipo: m[1], fascia: m[2],
    pos: nm && ptsTxt != null ? parseFloat(nm[1]) : null,
    pts: ptsTxt != null ? parseFloat(ptsTxt.replace(',', '.')) : null,
    line,
  };
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
    // 1) per colonne (come prima)
    const r1 = row.length >= 3 ? parseRow(row, cal, state.code) : null;
    const colOk = !!(r1 && r1.ok && r1.tipo && /^(GPS|GUI|GAE|GM)$/.test(r1.tipo));
    // 2) a testo, se per colonne non è uscito un record con tipo
    if (!colOk) {
      const tf = textRecord(row, cal && cal.ptsIdx);
      if (tf) {
        if (tf.tipo === 'GPS') {
          if (tf.pos != null && state.code) rowsAll.push({ code: state.code, tipo: 'GPS', fascia: tf.fascia, pos: tf.pos, pts: tf.pts, ok: true });
          else skipped.push({ code: state.code, tipo: 'GPS', raw: tf.line.slice(0, 160) });
          continue;
        }
        if (!r1) continue; // GAE/GUI/GM senza lettura per colonne: ignoro
      }
    }
    if (!r1) continue;
    if (r1.ok) rowsAll.push(r1);
    else if (r1.tipo === 'GPS') skipped.push({ ...r1, raw: t.slice(0, 160) });
  }
}

// Bollettino pubblicato come foglio di calcolo (es. Google Sheets di Bologna):
// colonne "Classe di concorso", "Tipo graduatoria", "Fascia", "Posizione",
// "Punteggio" (l'ordine può cambiare, si cercano per nome).
export function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
export function parseCsvBulletin(text) {
  const table = parseCsv(text);
  const key = t => String(t || '').toLowerCase().replace(/\s+/g, '');
  let hi = table.findIndex(r => r.some(c => key(c) === 'classediconcorso'));
  if (hi < 0) return { calibrated: false, rows: [], skipped: [] };
  const h = table[hi].map(key);
  const ix = n => h.indexOf(n);
  const iC = ix('classediconcorso'), iT = ix('tipograduatoria'), iF = ix('fascia'), iP = ix('posizione'), iS = ix('punteggio');
  if ([iC, iT, iF, iP, iS].some(i => i < 0)) return { calibrated: false, rows: [], skipped: [] };
  const num = v => parseFloat(String(v).trim().replace(',', '.'));
  const rowsAll = [], skipped = [];
  for (const r of table.slice(hi + 1)) {
    const cls = String(r[iC] || '').trim();
    if (!cls) continue;
    const m = /^([A-Z0-9]{4})\b/i.exec(cls);
    const tipo = String(r[iT] || '').trim().toUpperCase();
    const fascia = String(r[iF] || '').trim().toUpperCase();
    const pos = num(r[iP]), pts = num(r[iS]);
    if (!m) { if (tipo === 'GPS') skipped.push({ raw: cls.slice(0, 80) }); continue; }
    if (Number.isNaN(pos) || Number.isNaN(pts)) { if (tipo === 'GPS') skipped.push({ raw: cls.slice(0, 80) }); continue; }
    rowsAll.push({ code: m[1].toUpperCase(), tipo, fascia, pos, pts, ok: true });
  }
  return { calibrated: true, rows: rowsAll, skipped };
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
