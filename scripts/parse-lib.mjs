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
  let items = tc.items.filter(it => it.str && it.str.trim()).map(it => ({ x: it.transform[4], y: it.transform[5], s: it.str, w: it.width || 0, rot: Math.abs(it.transform[1]) > Math.abs(it.transform[0]) ? (it.transform[1] > 0 ? 1 : -1) : 0 }));
  // pagina con il testo ruotato di 90° (es. Biella): giro le coordinate in modo che il testo si legga da sinistra a destra
  // e le righe vadano dall'alto in basso; se la pagina è mista non tocco nulla
  const nRot = items.filter(i => i.rot !== 0).length;
  if (items.length && nRot / items.length > 0.8) {
    const sgn = items.filter(i => i.rot === 1).length >= items.filter(i => i.rot === -1).length ? 1 : -1;
    items = items.map(i => sgn === 1 ? { x: i.y, y: -i.x, s: i.s, w: i.w } : { x: -i.y, y: i.x, s: i.s, w: i.w });
  }
  // Raggruppo i frammenti per riga con una tolleranza sulla y (non con un
  // arrotondamento a gradini fissi: due frammenti della stessa riga, sfalsati
  // di 0,1 punti, potevano finire in righe diverse, come la fascia a Ravenna).
  const sorted = items.slice().sort((a, b) => b.y - a.y);
  const groups = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.y - it.y) <= 2.6) g.items.push(it); else groups.push({ y: it.y, items: [it] });
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
  const classe = find('Classe di concorso') || find('Classe concorso') || find('CDC') || find('C.D.C.') || fs('classediconcorso', 'classediconcorsodi') || fs('c.d.c.');
  const fascia = find('Fascia') || fs('fasci');
  const grOrig = find('Graduatoria di origine') || fs('graduatoriadi');
  const clOrig = find('Classe di concorso di origine') || fs('classediconcorsodi');
  const posiz = find('Posizione') || find('POSTO') || find('Pos.') || fs('posizi');
  const scuola = find('Codice scuola') || fs('codicescu');
  let tipo = find('Tipo graduatoria') || find('Graduatoria') || find('GRAD') || fs('tipograd') || find('Tipo');
  // titolo unico per classe e tipo (L'Aquila: "C.d.C. Tipo grad."): il tipo (GPS/GAE...) si trova nelle righe dei dati
  if (classe && (!tipo || classe === tipo) && sp(classe.label).includes('tipograd')) {
    const rec = rows.slice(stopAt).find(r => r.some(it => /^(GPS|GAE|GM|GUI|GI)$/.test(norm(it.s))));
    const it = rec && rec.find(i => /^(GPS|GAE|GM|GUI|GI)$/.test(norm(i.s)));
    tipo = it ? { x: it.x } : null;
  }
  // Le colonne "di origine" (sostegno per incrocio) ci sono solo in alcuni uffici;
  // dove mancano (Parma, Caserta...) la zona dei numeri parte dalla colonna Posizione.
  // In alcuni bollettini la colonna \"Ordine nomina\" sta PRIMA di \"Punteggio\" (Ravenna
  // del 26/10): il punteggio è allora il terzo numero e non il secondo. Lo leggo
  // dall'intestazione, altrimenti si prenderebbe l'ordine al posto del punteggio.
  const ordine = find('Ordine nomina') || fs('ordinenomin');
  const punt = find('Punteggio') || fs('punteggi');
  const ordinePrima = !!(ordine && punt && ordine.x < punt.x && (!posiz || ordine.x > posiz.x));
  // titolo unico "Tipo graduatoria Fascia Elenco aggiuntivo ..." (Bergamo): tipo e fascia si leggono dalla prima riga di dati
  let fasciaCol = fascia;
  if (classe && scuola && posiz && (!tipo || !fasciaCol || tipo === fasciaCol) && cols.some(c => sp(c.label).startsWith('tipograduatoriafascia'))) {
    const rec = rows.slice(stopAt).find(r => r.some(it => /^(GPS|GAE|GM|GUI|GI)$/.test(norm(it.s))));
    const ti = rec && rec.find(i => /^(GPS|GAE|GM|GUI|GI)$/.test(norm(i.s)));
    const fi = rec && ti && rec.find(i => i.x > ti.x && /^(F[123]|[123])$/.test(norm(i.s)));
    if (ti && fi) { tipo = { x: ti.x }; fasciaCol = { x: fi.x }; }
  }
  if (classe && fasciaCol && scuola && tipo && ((grOrig && clOrig) || posiz)) {
    return {
      ptsIdx: ordinePrima ? 2 : 1,
      headerRowIndex: stopAt,
      xClasse: classe.x, xTipo: tipo.x, xFascia: fasciaCol.x,
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
  const cands = row.filter(i => i.x < b12);
  const it = cands.find(i => /^([A-Z0-9]{4})\s*[-–—]/.test(norm(i.s).toUpperCase())) || cands[0];
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
  // codice della scuola (le prime due lettere sono la sigla della provincia): serve per gli uffici che pubblicano due province insieme
  const scIt = row.slice().sort((a, b) => a.x - b.x).find(it => /^[A-Z]{4}\d[A-Z0-9]{4,5}(\s|$)/.test(norm(it.s)) && it.x > cal.xTipo);
  const out = {
    sc: scIt ? norm(scIt.s).split(/\s+/)[0] : null,
    code: codeM[1].toUpperCase(),
    tipo: tipoIt ? norm(tipoIt.s).toUpperCase() : null,
    fascia: fasciaIt ? norm(fasciaIt.s).toUpperCase() : null,
  };
  // Alcuni PDF (es. Rimini) mettono tipo e fascia nella stessa cella: \"GPS F1\".
  // Li separo, altrimenti la riga non risulterebbe GPS e verrebbe scartata.
  const tf = /^(GPS|GUI|GAE|GM)\s*-?\s*(F[12])$/.exec(out.tipo || '');
  if (tf) { out.tipo = tf[1]; if (!out.fascia) out.fascia = tf[2]; }
  // le prime due cifre da sinistra sono Posizione e Punteggio; un'eventuale terza
  // ("Ordine nomina", quando sta sulla stessa riga) va ignorata
  const pi = cal.ptsIdx || 1;
  if (nums.length > pi) { out.pos = parseFloat(norm(nums[0].s).replace(',', '.')); out.pts = parseFloat(norm(nums[pi].s).replace(',', '.')); out.ok = true; }
  else { out.ok = false; out.nNums = nums.length; }
  return out;
}

// Lettura "a testo" per i PDF in cui l'intestazione non si divide in colonne riconoscibili
// (es. Bergamo n. 5: "Tipo graduatoria Fascia Elenco aggiuntivo..." è un solo blocco di
// testo). Si usa SOLO se l'intestazione nomina classe, graduatoria, posizione e punteggio, e
// il punteggio è il 2° numero dopo la fascia (o il 3° se "Ordine nomina" precede "Punteggio").
export function textFallback(pagesRows) {
  const lineOf = r => r.slice().sort((a, b) => a.x - b.x).map(it => norm(it.s)).join(' ');
  const headRows = pagesRows.slice(0, 2).flat();
  const head = headRows.map(lineOf).join(' ').toLowerCase();
  // Le intestazioni con molte colonne spezzano i titoli su più righe (\"Classe\" / \"di\" / \"concorso\"):
  // \"classe di concorso\" non compare di seguito. Basta che le parole chiave ci siano tutte.
  if (!(/classe/.test(head) && /graduatoria/.test(head) && /posizione|\bpos\./.test(head) && /punteggio/.test(head))) return null;
  // \"Ordine nomina\" prima di \"Punteggio\"? Lo decido dalle x (le righe sono spezzate), non dal testo di seguito.
  const xDi = re => { const xs = headRows.flat().filter(it => re.test(norm(it.s))).map(it => it.x); return xs.length ? Math.min(...xs) : null; };
  const xOrd = xDi(/^ordine\b/i), xPun = xDi(/^punteggio\b/i), xPos = xDi(/^posizione\b/i);
  const ptsIdx = (xOrd != null && xPun != null && xOrd < xPun && (xPos == null || xOrd > xPos)) ? 2 : 1;
  const rows = [], skipped = []; let code = null;
  for (const pr of pagesRows) for (const row of pr) {
    const line = lineOf(row);
    const cm = /^([A-Z0-9]{4})\s*[-–—]\s/.exec(line);
    if (cm) code = cm[1];
    const tr = textRecord(row, ptsIdx);
    if (!tr || !code) continue;
    if (tr.pos != null && tr.pts != null) rows.push({ code, tipo: tr.tipo, fascia: tr.fascia, pos: tr.pos, pts: tr.pts, ok: true });
    else if (tr.tipo === 'GPS') skipped.push({ raw: tr.line.slice(0, 60) });
  }
  return rows.length ? { rows, skipped } : null;
}

// Alcuni uffici centrano i titoli delle colonne e allineano i dati a sinistra (es. Massa-Carrara):
// le x dell'intestazione non coincidono con quelle dei dati e nessuna riga si legge. Prendo allora
// le x di classe, tipo e fascia dalla prima riga di dati e uso la nuova calibrazione SOLO se legge
// più righe di quella dell'intestazione (così i bollettini già letti bene non cambiano).
function countOk(rows, cal) {
  const out = [], sk = [];
  processRows(rows, cal, { code: null }, out, sk);
  return out.filter(r => r.tipo === 'GPS' && normFascia(r.fascia)).length;
}
export function refineCal(rows, cal) {
  for (const row of rows) {
    const ord = row.slice().sort((a, b) => a.x - b.x);
    const ic = ord.find(it => /^[A-Z0-9]{4}\s*[-–—]/.test(norm(it.s).toUpperCase()));
    const it = ord.findIndex(i => /^GPS$/.test(norm(i.s)));
    if (!ic || it < 0) continue;
    const f = ord.slice(it + 1).find(i => /^F[12]$/i.test(norm(i.s)));
    if (!f) continue;
    const ref = { ...cal, xClasse: ic.x, xTipo: ord[it].x, xFascia: f.x };
    if (ref.xClasse === cal.xClasse && ref.xTipo === cal.xTipo && ref.xFascia === cal.xFascia) return null;
    return ref;
  }
  return null;
}

// Lettura "a dati" per i PDF dove classe, tipo, fascia, posizione e punteggio stanno in colonne diverse da quelle
// attese (es. Padova e Rovigo: la classe di concorso è DOPO i numeri, a destra del codice scuola). Non uso
// l'intestazione: in ogni riga cerco "GPS" + fascia, poi i due numeri che li seguono prima del codice scuola, e il codice
// classe ("A002 - ..." ) ovunque nella riga. L'ordine posizione/punteggio lo decido dai decimali: il punteggio è
// la colonna che ha valori con ".5" (la posizione è sempre intera). Se i dati non lo dimostrano, non leggo niente.
export function flexFallback(pagesRows) {
  const cand = [], skipped = [];
  for (const pr of pagesRows) for (const row of pr) {
    const ord = row.slice().sort((a, b) => a.x - b.x);
    const g = ord.findIndex(it => /^(GPS|GUI|GAE|GM)$/.test(norm(it.s)));
    if (g < 0 || !ord[g + 1]) continue;
    const fm = /^F([12])$/i.exec(norm(ord[g + 1].s)); if (!fm) continue;
    // il codice classe deve avere la forma di un codice vero (A..., B..., EEEE, PPPP...): così un nome di scuola come "ITIS - ..." non vale
    const cm = ord.map(it => /^([A-Z0-9]{4})\s*[-–—]/.exec(norm(it.s).toUpperCase())).find(m => m && /^(A[A-Z0-9]{3}|B[A-Z0-9]{3}|EEEE|EEEM|EEIL|PPPP)$/.test(m[1]));
    const nums = [];
    for (const it of ord.slice(g + 2)) {
      const t = norm(it.s);
      if (/^[A-Z]{2}[A-Z0-9]{6,8}$/.test(t)) break;                       // codice scuola: finiscono i numeri
      if (/^\d{1,6}(?:[.,]\d{1,2})?$/.test(t)) nums.push(t); else if (nums.length) break;
    }
    const tipo = norm(ord[g].s);
    if (!cm || nums.length < 2) { if (tipo === 'GPS') skipped.push({ raw: ord.map(i => norm(i.s)).join(' ').slice(0, 60) }); continue; }
    cand.push({ code: cm[1], tipo, fascia: 'F' + fm[1], a: nums[0], b: nums[1] });
  }
  if (cand.length < 3) return null;
  const dec = t => /[.,]\d*[1-9]/.test(t);
  const d1 = cand.filter(c => dec(c.a)).length, d2 = cand.filter(c => dec(c.b)).length;
  let primaPos;
  if (d2 > 0 && d1 === 0) primaPos = true; else if (d1 > 0 && d2 === 0) primaPos = false; else return null;
  const rows = cand.map(c => {
    const pos = primaPos ? c.a : c.b, pts = primaPos ? c.b : c.a;
    return { code: c.code, tipo: c.tipo, fascia: c.fascia, pos: parseFloat(pos.replace(',', '.')), pts: parseFloat(pts.replace(',', '.')), ok: true };
  });
  return { rows, skipped };
}

export async function parseBulletin(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true }).promise;
  let cal = null;
  const rowsAll = [], skipped = [], state = { code: null }, allPages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const rows = await pageRows(pg);
    allPages.push(rows);
    if (!cal) {
      cal = findHeader(rows);
      if (!cal) continue; // magari l'intestazione è su un'altra pagina
      const ref = refineCal(rows, cal);
      if (ref && countOk(rows, ref) > countOk(rows, cal)) cal = ref;
    }
    const n0 = rowsAll.length;
    processRows(rows, cal, state, rowsAll, skipped);
    for (let i = n0; i < rowsAll.length; i++) rowsAll[i].pg = p;
  }
  if (!cal) { const fb = textFallback(allPages); if (fb) return { calibrated: true, rows: fb.rows, skipped: fb.skipped }; }
  // la lettura per colonne legge poco o niente (più righe scartate che lette): provo la lettura "a dati"
  const okGps = rowsAll.filter(r => r.tipo === 'GPS' && normFascia(r.fascia)).length;
  if (okGps < skipped.length) {
    const fx = flexFallback(allPages);
    if (fx && fx.rows.filter(r => r.tipo === 'GPS').length > okGps) return { calibrated: true, rows: fx.rows, skipped: fx.skipped };
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
// Se la fascia non si legge dalla colonna (etichetta unita a un'altra o spostata), la cerco
// nella riga: l'elemento "F1"/"F2" che segue "GPS", o "GPS F1" nel testo della riga.
function fasciaDaRiga(row) {
  const ord = row.slice().sort((a, b) => a.x - b.x);
  const i = ord.findIndex(it => /^GPS$/i.test(norm(it.s)));
  if (i >= 0 && ord[i + 1]) { const m = /^F\s*([12])$/i.exec(norm(ord[i + 1].s)); if (m) return 'F' + m[1]; }
  const t = ord.map(it => norm(it.s)).join(' ');
  const m2 = /\bGPS\s*-?\s*F\s*([12])\b/i.exec(t);
  return m2 ? 'F' + m2[1] : null;
}
// Classe riconosciuta dal solo nome (quando la riga con il codice, es. \"AAAA -\", manca nel PDF): vale solo per i nomi che
// corrispondono a un unico codice. Il confronto è senza spazi perché le celle strette spezzano le parole.
function codiceDaNome(testo) {
  const t = String(testo || '').toLowerCase().replace(/[^a-zàèéìòù]/g, '');
  if (t.includes('educazionemotoria')) return 'EEEM';
  if (t.includes('insegnamentoscuolaprimaria') && t.includes('linguainglese')) return 'EEIL';
  if (t.includes('sostegnoscuolainfanzia')) return 'ADAA';
  if (t.includes('sostegnoscuolaprimaria')) return 'ADEE';
  if (t.includes('insegnamentoscuolainfanzia')) return 'AAAA';
  if (t.includes('insegnamentoscuolaprimaria')) return 'EEEE';
  return null;
}

// Alcuni uffici (es. Vicenza) centrano le celle in verticale: a seconda di quante righe occupa la descrizione, i numeri
// (posizione e punteggio) finiscono sulla riga PRIMA oppure DOPO quella con classe, tipo e fascia.
// Unisco una riga "solo numeri" a una riga "classe/tipo/fascia senza numeri" vicina SOLO se l'abbinamento è
// inequivocabile: se i numeri potrebbero appartenere sia alla riga sopra sia a quella sotto, non unisco niente
// (meglio una riga non letta che un punteggio attribuito alla classe sbagliata).
export function ricomponiRighe(rows, cal) {
  if (!cal || rows.length < 2) return rows;
  const cls = rows.map(row => {
    if (row.length < 3) return 'x';
    let r; try { r = parseRow(row, cal, 'ZZZZ'); } catch (e) { return 'x'; }
    if (!r) return 'x';
    if (r.ok && !r.tipo) return 'num';
    if (!r.ok && r.tipo === 'GPS' && (r.nNums || 0) === 0) return 'lone';
    return 'x';
  });
  if (!cls.includes('num') || !cls.includes('lone')) return rows;
  const pair = new Array(rows.length).fill(-1);   // num -> riga lone
  let dopo = 0, prima = 0; const ambigui = [];
  for (let j = 0; j < rows.length; j++) {
    if (cls[j] !== 'num') continue;
    const sopra = j > 0 && cls[j - 1] === 'lone', sotto = j + 1 < rows.length && cls[j + 1] === 'lone';
    if (sopra && !sotto) { pair[j] = j - 1; dopo++; }
    else if (sotto && !sopra) { pair[j] = j + 1; prima++; }
    else if (sopra && sotto) ambigui.push(j);
  }
  if (ambigui.length && (dopo === 0) !== (prima === 0)) {   // un solo schema nel documento: lo applico anche ai casi dubbi
    for (const j of ambigui) pair[j] = dopo > 0 ? j - 1 : j + 1;
  }
  const usata = new Set();
  for (let j = 0; j < rows.length; j++) if (pair[j] >= 0) { if (usata.has(pair[j])) pair[j] = -1; else usata.add(pair[j]); }
  const out = rows.map(r => r.slice()), scarta = new Set();
  for (let j = 0; j < rows.length; j++) if (pair[j] >= 0) { out[pair[j]] = out[pair[j]].concat(rows[j]); scarta.add(j); }
  return out.filter((_, k) => !scarta.has(k));
}

export function processRows(rows, cal, state, rowsAll, skipped) {
  rows = ricomponiRighe(rows, cal);
  const b12n = cal ? (cal.xClasse + cal.xTipo) / 2 : 0;
  for (const row of rows) {
    const t = row.map(it => norm(it.s)).join(' ');
    if (/^Classe di concorso/.test(t) || /^\d+ di \d+$/.test(t)) continue;
    const own = classCodeOf(row, cal);
    if (own) state.code = own;
    // testo della colonna classe nelle righe senza codice (per riconoscere la classe dal nome, vedi codiceDaNome)
    const ctext = row.filter(i => i.x < b12n).map(i => norm(i.s)).join(' ');
    if (own) state.nameBuf = '';
    else if (!row.some(i => /^(GPS|GAE|GM|GUI|GI)$/.test(norm(i.s)))) state.nameBuf = ((state.nameBuf || '') + ' ' + ctext).slice(-120);
    // 1) per colonne (come prima)
    const r1 = row.length >= 3 ? parseRow(row, cal, state.code) : null;
    const colOk = !!(r1 && r1.ok && r1.tipo && /^(GPS|GUI|GAE|GM)$/.test(r1.tipo));
    // 2) a testo, se per colonne non è uscito un record con tipo
    if (!colOk) {
      const tf = textRecord(row, cal && cal.ptsIdx);
      if (tf) {
        if (tf.tipo === 'GPS') {
          if (tf.pos != null && state.code) rowsAll.push({ code: state.code, tipo: 'GPS', fascia: tf.fascia, pos: tf.pos, pts: tf.pts, ok: true });
          else if (tf.pos != null && !state.code && codiceDaNome((state.nameBuf || '') + ' ' + ctext)) { rowsAll.push({ code: codiceDaNome((state.nameBuf || '') + ' ' + ctext), tipo: 'GPS', fascia: tf.fascia, pos: tf.pos, pts: tf.pts, ok: true }); state.nameBuf = ''; }
          else skipped.push({ code: state.code, tipo: 'GPS', raw: tf.line.slice(0, 160) });
          continue;
        }
        if (!r1) continue; // GAE/GUI/GM senza lettura per colonne: ignoro
      }
    }
    if (!r1) continue;
    if (r1.ok) { if (r1.tipo === 'GPS' && !normFascia(r1.fascia)) r1.fascia = fasciaDaRiga(row) || r1.fascia; rowsAll.push(r1); }
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
// La fascia può essere scritta in modi diversi ("F1", "1", "I", "Fascia 2", "seconda"...):
// la riduco a "F1"/"F2". Se non la riconosco restituisco null (la riga NON deve sparire
// in silenzio: vedi diagnosiFasce).
export function normFascia(v) {
  const s = String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^(F|FASCIA)?1$|^(FASCIAI|I|PRIMA|PRIMAFASCIA|1FASCIA|1A)$/.test(s)) return 'F1';
  if (/^(F|FASCIA)?2$|^(FASCIAII|II|SECONDA|SECONDAFASCIA|2FASCIA|2A)$/.test(s)) return 'F2';
  return null;
}
// Quante righe GPS hanno la fascia riconosciuta e quante no
export function diagnosiFasce(rows) {
  const d = { F1: 0, F2: 0, senza: 0, valori: {} };
  rows.filter(r => r.tipo === 'GPS').forEach(r => {
    const f = normFascia(r.fascia);
    if (f) { d[f]++; return; }
    d.senza++;
    if (r.pg && (!d.pagSenza || r.pg < d.pagSenza)) d.pagSenza = r.pg;
    // valore non riconosciuto, mostrato solo se è breve e ha l'aspetto di una fascia (mai testo libero: potrebbe essere un nome)
    const v = String(r.fascia == null ? '' : r.fascia).trim();
    const etichetta = v === '' ? '(vuota)' : (v.length <= 10 && /\d|^(prima|seconda|fascia|f|i|ii)\b/i.test(v)) ? v : '(altro testo)';
    d.valori[etichetta] = (d.valori[etichetta] || 0) + 1;
  });
  return d;
}
// Riepilogo compatto per il log: "ADMM:F1=2 ADSS:F1=6 EEEE:F1=4" (solo codici e conteggi,
// mai nomi). Serve a controllare quali classi/fasce ha davvero un bollettino senza aprire il PDF.
export function riepilogoClassi(rows) {
  const c = {};
  rows.filter(r => r.tipo === 'GPS').forEach(r => { const f = normFascia(r.fascia) || '??'; const k = r.code + ':' + f; c[k] = (c[k] || 0) + 1; });
  return Object.keys(c).sort().map(k => k + '=' + c[k]).join(' ').slice(0, 1500);
}
export function aggregate(rows) {
  const out = {};
  rows.filter(r => r.tipo === 'GPS').forEach(r => {
    const nf = normFascia(r.fascia);
    const f = nf === 'F1' ? '1' : (nf === 'F2' ? '2' : null);
    if (!f) return;
    out[r.code] = out[r.code] || {};
    const cur = out[r.code][f];
    if (!cur || r.pts < cur.p) out[r.code][f] = { p: r.pts, n: r.pos };
  });
  return out;
}
