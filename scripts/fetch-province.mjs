// Aggiorna data/bollettini.json leggendo i bollettini pubblicati sul sito
// dell'Ufficio Scolastico Provinciale. Per ora è configurata solo Modena (MO):
// per aggiungere un'altra provincia, aggiungi una voce a PROVINCE qui sotto
// (vedi il file README-DEPLOY.md per come trovare i valori giusti) e verifica
// il risultato: ogni sito USP pubblica le pagine in modo un po' diverso, quindi
// la ricerca dei link (discoverPosts) può avere bisogno di un piccolo adattamento.
import fs from 'fs';
import path from 'path';
import { parseBulletin, aggregate } from './parse-lib.mjs';

const DATA_PATH = path.join(process.cwd(), 'data', 'bollettini.json');

// Rete degli Uffici Scolastici Provinciali dell'Emilia-Romagna: stesso sito
// WordPress, stesso modo di pubblicare i bollettini, cambia solo la sigla
// nel sottodominio (<sigla>.istruzioneer.gov.it). Modena (MO), Ferrara (FE) e
// Reggio Emilia (RE) li ho controllati davvero: il sito esiste ed è fatto così.
// Bologna, Forlì-Cesena, Parma, Piacenza, Ravenna e Rimini seguono lo stesso
// schema di indirizzo, ma non li ho verificati uno per uno: se il sito di una
// di queste province fosse diverso, lo script non trova nulla per quella
// provincia (lo si vede nel log dell'azione GitHub) invece di inventare dati.
function er(sigla, nome) {
  return {
    nome,
    searchUrl: `https://${sigla}.istruzioneer.gov.it/?s=nomine+gps`,
    postMatch: /nomin[ae].*gps|gps.*nomin[ae]/i,
  };
}
const PROVINCE = {
  MO: er('mo', 'Modena'),
  FE: er('fe', 'Ferrara'),
  RE: er('re', 'Reggio Emilia'),
  BO: er('bo', 'Bologna'),
  FC: er('fc', 'Forlì-Cesena'),
  PR: er('pr', 'Parma'),
  PC: er('pc', 'Piacenza'),
  RA: er('ra', 'Ravenna'),
  RN: er('rn', 'Rimini'),
};

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (AtriumBollettini/1.0)' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' su ' + url);
  return r.text();
}
async function fetchBuf(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (AtriumBollettini/1.0)' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' su ' + url);
  return Buffer.from(await r.arrayBuffer());
}

// Trova, nella pagina di ricerca del sito, i link ai singoli articoli.
function discoverPosts(html, baseUrl, postMatch) {
  const links = new Set();
  const re = /href="([^"]+)"/g; let m;
  const base = new URL(baseUrl);
  while ((m = re.exec(html))) {
    let href = m[1];
    if (href.startsWith('/')) href = base.origin + href;
    if (!href.startsWith(base.origin)) continue;
    if (!/\/20\d\d\/\d\d\/\d\d\//.test(href)) continue; // solo articoli datati (yyyy/mm/dd)
    if (postMatch && !postMatch.test(href)) continue;
    links.add(href.split('#')[0]);
  }
  return [...links];
}

// Dentro l'articolo, trova il link diretto al PDF del bollettino.
function findPdfLink(html) {
  const re = /href="([^"]+\.pdf)"/gi; let m; const cands = [];
  while ((m = re.exec(html))) cands.push(m[1]);
  // preferisco un file il cui nome contiene "bollettino" o "nomine"
  const pref = cands.find(u => /bollettino|nomin/i.test(u));
  return pref || cands[0] || null;
}

function guessTurno(title) {
  const m = /(\d+)\s*°?\s*turno/i.exec(title);
  return m ? parseInt(m[1], 10) : null;
}
function guessDateFromUrl(url) {
  const m = /\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(url);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function guessTitle(html) {
  const m = /<title>([^<]+)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s*[-|–]\s*[^-|–]*$/, '').trim() : 'Bollettino nomine';
}

async function updateProvince(code, cfg, store) {
  console.log('--', code, cfg.nome, '--');
  const searchHtml = await fetchText(cfg.searchUrl);
  const posts = discoverPosts(searchHtml, cfg.searchUrl, cfg.postMatch).slice(0, 15);
  console.log('pagine candidate trovate:', posts.length);
  store.province[code] = store.province[code] || { bollettini: [], soglie: {} };
  const prov = store.province[code];
  const known = new Set(prov.bollettini.map(b => b.url));
  for (const postUrl of posts) {
    try {
      const postHtml = await fetchText(postUrl);
      const pdfHref = findPdfLink(postHtml);
      if (!pdfHref) continue;
      const pdfUrl = pdfHref.startsWith('http') ? pdfHref : new URL(pdfHref, postUrl).href;
      const title = guessTitle(postHtml);
      const turno = guessTurno(title) ?? guessTurno(postUrl);
      const data = guessDateFromUrl(postUrl) || new Date().toISOString().slice(0, 10);
      const id = code + '-' + (turno ?? data);
      if (known.has(pdfUrl)) { console.log('già elaborato:', pdfUrl); continue; }
      console.log('scarico', pdfUrl);
      const buf = await fetchBuf(pdfUrl);
      const { calibrated, rows, skipped } = await parseBulletin(buf);
      const agg = aggregate(rows);
      const nomine = rows.filter(r => r.tipo === 'GPS').length;
      const dubbio = !calibrated || skipped.length > 0;
      prov.bollettini = prov.bollettini.filter(b => b.url !== pdfUrl);
      prov.bollettini.push({ id, turno, data, titolo: title, nomine, url: postUrl, pdfUrl, dubbio });
      for (const [cdc, byFascia] of Object.entries(agg)) {
        prov.soglie[cdc] = prov.soglie[cdc] || {};
        for (const [f, v] of Object.entries(byFascia)) {
          const cur = prov.soglie[cdc][f];
          if (!cur || (turno ?? 0) >= (cur.t ?? 0)) prov.soglie[cdc][f] = { p: v.p, n: v.n, t: turno, d: dubbio };
        }
      }
      console.log('  ok: calibrato=' + calibrated, 'righe GPS=' + nomine, 'scartate=' + skipped.length);
    } catch (e) {
      console.warn('  errore su', postUrl, '->', e.message);
    }
  }
}

async function main() {
  let store = { aggiornato: new Date().toISOString(), province: {} };
  if (fs.existsSync(DATA_PATH)) {
    try { store = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch (e) {}
  }
  store.province = store.province || {};
  for (const [code, cfg] of Object.entries(PROVINCE)) {
    try { await updateProvince(code, cfg, store); }
    catch (e) { console.error('Provincia', code, 'non aggiornata:', e.message); }
  }
  store.aggiornato = new Date().toISOString();
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2));
  console.log('Scritto', DATA_PATH);
}
main();
