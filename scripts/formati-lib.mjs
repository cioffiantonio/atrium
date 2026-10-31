// formati-lib.mjs: bollettini pubblicati come file Excel (.xlsx) o come archivio .zip
// (che può contenere PDF, Excel e CSV). Le librerie (read-excel-file, fflate) sono installate
// dal workflow; se mancano, la lettura di questi formati viene saltata con un messaggio nel log.
//
// Nel log vanno solo conteggi, mai righe con nomi di persone.
import { tabellaDaCsv, parseTabellaBollettino } from './web-lib.mjs';
import { parseBulletin } from './parse-lib.mjs';

let _xl = null, _fz = null;
async function leggiXlsxLib() { if (!_xl) { try { _xl = (await import('read-excel-file/node')).default; } catch (e) { throw new Error('libreria read-excel-file non installata'); } } return _xl; }
async function fflateLib() { if (!_fz) { try { _fz = await import('fflate'); } catch (e) { throw new Error('libreria fflate non installata'); } } return _fz; }

const cella = c => (c === null || c === undefined) ? '' : (c instanceof Date ? c.toISOString().slice(0, 10) : String(c));

// Un file .xlsx -> righe del bollettino (tutti i fogli)
export async function righeDaExcel(buf) {
  const readXlsxFile = await leggiXlsxLib();
  const fogli = await readXlsxFile(buf);
  const rows = [], skipped = []; let calibrated = false;
  for (const f of fogli) {
    const tabella = (f.data || []).map(r => r.map(cella));
    const res = parseTabellaBollettino(tabella);
    if (res.calibrated) calibrated = true;
    rows.push(...res.rows); skipped.push(...res.skipped);
  }
  return { calibrated, rows, skipped };
}

// Data di creazione/modifica indicata dentro il file .xlsx (docProps/core.xml)
export async function dataDaXlsx(buf) {
  try {
    const { unzipSync, strFromU8 } = await fflateLib();
    const f = unzipSync(new Uint8Array(buf), { filter: x => x.name === 'docProps/core.xml' });
    const xml = f['docProps/core.xml'] ? strFromU8(f['docProps/core.xml']) : '';
    const m = /<dcterms:(?:modified|created)[^>]*>(\d{4}-\d{2}-\d{2})/i.exec(xml);
    if (!m) return null;
    return m[1] >= '2026-08-01' && m[1] <= new Date(Date.now() + 86400000).toISOString().slice(0, 10) ? m[1] : null;
  } catch (e) { return null; }
}

// Un archivio .zip -> righe di tutti i PDF, Excel e CSV contenuti (al massimo 40 file)
export async function righeDaZip(buf, log = () => {}) {
  const { unzipSync } = await fflateLib();
  const files = unzipSync(new Uint8Array(buf), { filter: f => /\.(pdf|xlsx|csv)$/i.test(f.name) && !/^__MACOSX\//.test(f.name) && f.originalSize < 60e6 });
  const nomi = Object.keys(files).slice(0, 40);
  const rows = [], skipped = []; let calibrated = false, data = null;
  for (const nome of nomi) {
    const dati = Buffer.from(files[nome]);
    let res = null;
    try {
      if (/\.pdf$/i.test(nome)) res = await parseBulletin(dati);
      else if (/\.xlsx$/i.test(nome)) { res = await righeDaExcel(dati); if (!data) data = await dataDaXlsx(dati); }
      else res = parseTabellaBollettino(tabellaDaCsv(dati.toString('utf8')));
    } catch (e) { log('      file nello zip non letto (' + (nome.split('.').pop()) + '): ' + String(e.message).slice(0, 60)); continue; }
    if (res.calibrated) calibrated = true;
    rows.push(...res.rows); skipped.push(...res.skipped);
  }
  log('      zip: ' + nomi.length + ' file (pdf/xlsx/csv), righe lette=' + rows.length);
  return { calibrated, rows, skipped, data };
}
