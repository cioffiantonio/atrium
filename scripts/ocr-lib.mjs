// Lettura OCR delle pagine SCANSIONATE di un bollettino (PDF senza testo).
// Usa gli strumenti di sistema pdftoppm (poppler) e tesseract: sono installati
// dal workflow GitHub (vedi .github/workflows). Se non ci sono, l'OCR viene
// semplicemente saltato e il bollettino resta "non letto".
//
// REGOLA: quello che esce da qui NON colora mai la mappa. Il risultato finisce
// in data/da-verificare.json, con la riga letta, così il punteggio si controlla
// a mano; solo dopo la conferma entra in data/bollettini-manuali.json.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const DPI = 300;
// una pagina con meno di tanti frammenti di testo è una scansione
const MIN_TEXT_ITEMS = 8;

function haveTool(cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; }
  catch (e) { try { execFileSync(cmd, ['-v'], { stdio: 'ignore' }); return true; } catch (e2) { return e2.code !== 'ENOENT'; } }
}

function ocrLanguages() {
  try {
    const out = execFileSync('tesseract', ['--list-langs'], { encoding: 'utf8' });
    return out.split(/\r?\n/).includes('ita') ? 'ita+eng' : 'eng';
  } catch (e) { return 'eng'; }
}

// Righe di testo di una pagina scansionata, lette da tesseract (formato TSV).
function ocrPageLines(pngPath, lang) {
  const tsv = execFileSync('tesseract', [pngPath, 'stdout', '-l', lang, '--psm', '6', 'tsv'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = new Map();
  for (const ln of tsv.split(/\r?\n/).slice(1)) {
    const c = ln.split('\t');
    if (c.length < 12 || c[0] !== '5') continue; // livello 5 = parola
    const text = c.slice(11).join('\t').trim();
    if (!text) continue;
    const key = c[2] + '-' + c[3] + '-' + c[4];
    const w = { x: +c[6], y: +c[7], w: +c[8], h: +c[9], s: text };
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(w);
  }
  const out = [];
  for (const ws of lines.values()) {
    ws.sort((a, b) => a.x - b.x);
    out.push({ y: ws.reduce((s, w) => s + w.y, 0) / ws.length, text: ws.map(w => w.s).join(' ').replace(/\s+/g, ' ').trim() });
  }
  return out.sort((a, b) => a.y - b.y).map(l => l.text);
}

// Errori tipici dell'OCR su codici e cifre dentro un codice classe
function fixCode(s) {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Cerca nelle righe i record GPS: "<CODICE> - NOME ... GPS F1 <posizione> <punteggio>".
// Il codice classe può stare in una riga precedente (nome della classe a capo).
export function recordsFromLines(lines) {
  const recs = [], illeggibili = [];
  let code = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const cm = /^([A-Z0-9]{4})\s*[-–—]\s/.exec(line.toUpperCase());
    if (cm) code = fixCode(cm[1]);
    const m = /\b(GPS|GAE|GM|GUI)\s*(F[12])(?![0-9])/i.exec(line);
    if (!m) continue;
    if (m[1].toUpperCase() !== 'GPS') continue; // GUI/GAE/GM non servono
    const rest = line.slice(m.index + m[0].length);
    const nm = /^\s*(?:[NS-]\s+)?(\d{1,6})\s+(\d{1,3}(?:[.,]\d{1,3})?)(?=\s|$)/.exec(rest);
    if (!code || !nm) { illeggibili.push(line.slice(0, 160)); continue; }
    recs.push({ code, fascia: m[2].toUpperCase(), pos: parseInt(nm[1], 10), pts: parseFloat(nm[2].replace(',', '.')), riga: line.slice(0, m.index + m[0].length + nm[0].length).trim().slice(0, 120) });
  }
  return { recs, illeggibili };
}

// Per ogni (classe, fascia) tengo il punteggio più basso: è quello che serve.
function lowest(recs) {
  const best = {};
  for (const r of recs) {
    const k = r.code + '|' + r.fascia;
    if (!best[k] || r.pts < best[k].pts) best[k] = r;
  }
  return Object.values(best).sort((a, b) => a.code.localeCompare(b.code) || a.fascia.localeCompare(b.fascia));
}

// Restituisce { eseguito, pagineOcr, righe: [...], illeggibili: [...] }.
// Se il PDF non ha pagine scansionate, o gli strumenti mancano, eseguito=false.
export async function ocrBulletin(buf) {
  const res = { eseguito: false, pagineOcr: 0, righe: [], illeggibili: [] };
  if (!haveTool('tesseract') || !haveTool('pdftoppm')) { res.nota = 'tesseract o pdftoppm non installati'; return res; }
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true }).promise;
  const scanned = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const tc = await pg.getTextContent();
    if (tc.items.filter(it => it.str && it.str.trim()).length < MIN_TEXT_ITEMS) scanned.push(p);
  }
  if (!scanned.length) return res;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atrium-ocr-'));
  const pdfPath = path.join(tmp, 'doc.pdf');
  fs.writeFileSync(pdfPath, Buffer.from(buf));
  const lang = ocrLanguages();
  const allLines = [];
  try {
    for (const p of scanned.slice(0, 40)) { // al massimo 40 pagine per bollettino
      const base = path.join(tmp, 'p' + p);
      execFileSync('pdftoppm', ['-r', String(DPI), '-gray', '-png', '-f', String(p), '-l', String(p), '-singlefile', pdfPath, base]);
      allLines.push(...ocrPageLines(base + '.png', lang));
      res.pagineOcr++;
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const { recs, illeggibili } = recordsFromLines(allLines);
  res.eseguito = true;
  res.righe = lowest(recs);
  res.illeggibili = illeggibili.map(() => '(omessa)'); // contano soltanto: il testo può contenere nomi
  return res;
}
