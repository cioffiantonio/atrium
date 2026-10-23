// Aggiorna data/bollettini.json leggendo i bollettini pubblicati sui siti degli
// Uffici Scolastici Provinciali.
//
// Il modo principale con cui trovo i link è una pagina di Orizzonte Scuola
// (una testata di settore) aggiornata ogni giorno da una redazione, che elenca
// regione per regione, provincia per provincia, il link a ogni turno di nomine.
// L'ho scelta perché i siti dei singoli USP sono troppo diversi tra loro (uno
// ordina i risultati per rilevanza e non per data, un altro chiama "fase" quello
// che un altro chiama "turno", ecc.): seguire un'unica pagina curata a mano è
// molto più affidabile che indovinare le parole giuste per ogni sito.
//
// Come riserva, per le province già configurate con un "searchUrl" (i siti
// dell'Emilia-Romagna e alcuni della Campania), provo ANCHE la ricerca diretta
// sul sito dell'USP: se un giorno la pagina di Orizzonte Scuola non si
// aggiornasse più, l'app continua comunque a cercare da sola, invece di restare
// ferma. I link trovati dalle due strade vengono uniti (senza doppioni).
import fs from 'fs';
import path from 'path';
import { parseBulletin, parseCsvBulletin, aggregate } from './parse-lib.mjs';
import { extractProvinceLinks } from './discover-orizzonte.mjs';
import { PROVINCE_ITALIA } from './province-italia.mjs';

const DATA_PATH = path.join(process.cwd(), 'data', 'bollettini.json');
// Bollettini che il lettore automatico non riesce a leggere (scansioni, fogli
// con intestazioni spezzate...), trascritti a mano o con l'OCR: vedi
// data/bollettini-manuali.json. La "data" deve coincidere con quella del
// bollettino sul sito dell'USP.
const MAN_PATH = path.join(process.cwd(), 'data', 'bollettini-manuali.json');
let MAN = {};
try { MAN = JSON.parse(fs.readFileSync(MAN_PATH, 'utf8')); } catch (e) {}
const AGGREGATOR_URL = 'https://www.orizzontescuola.it/supplenze-docenti-ecco-i-bollettini-nomine-al-31-agosto-o-30-giugno-2027-in-aggiornamento/';

// Vero solo se il testo contiene INSIEME "turno", "nomin[ae]" e "gps", in
// qualunque ordine: esclude rettifiche, avvisi su "sedi vacanti" o "esiti
// nomine finalizzate al ruolo", che non sono i bollettini di un turno.
const TURNO_MATCH = { test: s => /turno/i.test(s) && /nomin[ae]/i.test(s) && /gps/i.test(s) };

// Rete degli Uffici Scolastici Provinciali dell'Emilia-Romagna: stesso sito
// WordPress, stesso modo di pubblicare i bollettini, cambia solo la sigla nel
// sottodominio (<sigla>.istruzioneer.gov.it).
function er(sigla, nome) {
  return { nome, searchUrl: `https://${sigla}.istruzioneer.gov.it/?s=nomine+gps`, postMatch: TURNO_MATCH };
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
  // Campania: qui i siti sono diversi da provincia a provincia (non c'è una
  // rete unica come in Emilia-Romagna), quindi mi affido soprattutto alla
  // pagina di Orizzonte Scuola; dove il sito sembra WordPress ho aggiunto
  // anche la ricerca diretta come riserva, mai verificata di persona.
  AV: { nome: 'Avellino', searchUrl: 'https://atavellino.it/?s=nomine+gps', postMatch: TURNO_MATCH },
  BN: { nome: 'Benevento', searchUrl: 'https://www.uspbenevento.it/?s=nomine+gps', postMatch: TURNO_MATCH, hostHint: 'benevento' },
  CE: { nome: 'Caserta', searchUrl: 'https://www.uat-caserta.it/?s=nomine+gps', postMatch: TURNO_MATCH },
  NA: { nome: 'Napoli', searchUrl: 'https://www.uat-napoli.it/?s=nomine+gps', postMatch: TURNO_MATCH },
  // Salerno pubblica sul portale del Ministero (mim.gov.it), che non ha una
  // ricerca interna paragonabile: mi affido solo a Orizzonte Scuola.
  SA: { nome: 'Salerno' },
};

// Tutte le altre province d'Italia: per ora solo tramite la pagina di Orizzonte
// Scuola (nessuna ricerca diretta sul sito dell'USP). Quelle che non
// funzionano si vedono nel log e avranno una configurazione su misura.
for (const [code, p] of Object.entries(PROVINCE_ITALIA)) if (!PROVINCE[code]) PROVINCE[code] = { nome: p.nome };

// Prima la richiesta "semplice" (è l'unica che Orizzonte Scuola accetta: con un
// browser finto risponde 403); se un sito risponde 403, riprovo con
// intestazioni da browser.
const H_SIMPLE = { 'user-agent': 'Mozilla/5.0 (AtriumBollettini/1.0)' };
const H_BROWSER = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/pdf,text/csv,*/*;q=0.8',
  'accept-language': 'it-IT,it;q=0.9,en;q=0.5',
};
async function getWithFallback(url) {
  const sig = () => AbortSignal.timeout(45000); // un sito che non risponde non deve bloccare il giro
  let r = await fetch(url, { headers: H_SIMPLE, signal: sig() });
  if (r.status === 403) r = await fetch(url, { headers: H_BROWSER, signal: sig() });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' su ' + url);
  return r;
}
async function fetchText(url) { return (await getWithFallback(url)).text(); }
async function fetchBuf(url) { return Buffer.from(await (await getWithFallback(url)).arrayBuffer()); }

// --- Lettura della pagina aggregatore (Orizzonte Scuola) ---------------------
function stripTags(s) { return s.replace(/<[^>]+>/g, ''); }
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
// Converte l'HTML dell'articolo in un testo semplice dove i grassetti diventano
// **testo** e i link diventano [etichetta](url) — lo stesso formato su cui è
// costruito e collaudato extractProvinceLinks().
function htmlToMdish(html) {
  const bodyMatch = /<article[\s\S]*?<\/article>/i.exec(html) || /<div[^>]*entry-content[^>]*>[\s\S]*/i.exec(html);
  let body = bodyMatch ? bodyMatch[0] : html;
  body = body.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => '**' + stripTags(inner) + '**');
  body = body.replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => `[${stripTags(inner).trim()}](${href})`);
  return decodeEntities(stripTags(body));
}
async function fetchAggregatorLinks() {
  try {
    const html = await fetchText(AGGREGATOR_URL);
    const text = htmlToMdish(html);
    const links = extractProvinceLinks(text);
    console.log('Orizzonte Scuola: province trovate nella pagina ->', Object.keys(links).length);
    return links;
  } catch (e) {
    console.warn('Non riesco a leggere la pagina aggregatore, uso solo la ricerca diretta:', e.message);
    return {};
  }
}

// --- Ricerca diretta sul sito dell'USP (riserva) ------------------------------
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

// Tutti i documenti di una pagina che possono essere il bollettino, dal più
// probabile al meno probabile. Sono PDF (anche quelli scaricati con un
// indirizzo del tipo "?download=123", dove il nome si legge dal testo del
// link) oppure fogli Google (Bologna). Prima quelli che sembrano il
// bollettino delle nomine, in fondo disponibilità, decreti, rettifiche, avvisi.
function findDocLinks(html) {
  const out = [], seen = new Set();
  const add = (href, text, kind) => {
    href = decodeEntities(href);
    if (seen.has(href)) return;
    seen.add(href);
    out.push({ href, text: stripTags(text || '').replace(/\s+/g, ' ').trim(), kind, i: out.length });
  };
  let m;
  const reA = /<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = reA.exec(html))) {
    const href = m[1];
    if (/docs\.google\.com\/spreadsheets\/d\//i.test(href)) add(href, m[2], 'sheet');
    else if (/\.pdf(?:[/?#]|$)/i.test(href) || /[?&]download=\d+/i.test(href)) add(href, m[2], 'pdf');
  }
  const reP = /(?:src|data)=["']([^"']+?\.pdf)(?:[?#][^"']*)?["']/gi;
  while ((m = reP.exec(html))) add(m[1], '', 'pdf');
  const reS = /https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+[^\s"'<>)]*/gi;
  while ((m = reS.exec(html))) add(m[0], '', 'sheet');
  const nameOf = d => { let u = d.href; try { u = decodeURIComponent(u); } catch (e) {} return u.replace(/^.*\//, '').replace(/\?.*$/, '') + ' ' + d.text; };
  const bad = d => /dispon|dipon|decret|rettific|avviso|sedi|posti/i.test(nameOf(d));
  const decree = d => /(^|\s)m_pi[.\s]|registro.?ufficiale|^disp[._-]/i.test(nameOf(d));
  const strong = d => d.kind === 'sheet' || /bollettin|totale.?nomin|allegat/i.test(nameOf(d));
  const weak = d => /nomin|turno/i.test(nameOf(d));
  // 0 = bollettino vero, 1 = sembra un bollettino, 2 = altro, 3 = disponibilità/decreti
  const score = d => bad(d) ? 3 : (strong(d) && !decree(d) ? 0 : (weak(d) && !decree(d) ? 1 : (decree(d) ? 3 : 2)));
  return out.sort((a, b) => score(a) - score(b) || a.i - b.i);
}
// Riconosce il numero del turno scritto in cifre ("2° turno"), in numeri
// romani ("I turno", "IV turno") o in parole ("primo turno", "quarto turno").
const ROMANI = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const ORDINALI = { primo: 1, seconda: 2, secondo: 2, terzo: 3, quarto: 4, quinto: 5, sesto: 6, settimo: 7, ottavo: 8, nono: 9, decimo: 10 };
function guessTurno(text) {
  if (!text) return null;
  // il numero prima della parola ("2° turno", "IV turno", "quarto turno")
  let m = /(\d+)\s*°?\s*turno/i.exec(text);
  if (m) return parseInt(m[1], 10);
  m = /\b([ivx]{1,4})\s*turno/i.exec(text);
  if (m && ROMANI[m[1].toLowerCase()]) return ROMANI[m[1].toLowerCase()];
  m = /\b(primo|secondo|seconda|terzo|quarto|quinto|sesto|settimo|ottavo|nono|decimo)\s*turno/i.exec(text);
  if (m) return ORDINALI[m[1].toLowerCase()];
  // il numero dopo la parola ("turno n. 2", "turno numero 2", "turno 2")
  // (ma non "turno 7 ottobre" o "turno 31/08": lì il numero è una data)
  m = /turno\s*([ivx]{1,4})\b(?!\w)/i.exec(text);
  if (m && ROMANI[m[1].toLowerCase()]) return ROMANI[m[1].toLowerCase()];
  m = /turno\s*(?:n\.?|numero)?\s*(\d{1,2})(?![\d/]|\s*(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre))/i.exec(text);
  if (m) return parseInt(m[1], 10);
  return null;
}
function guessDateFromUrl(url) {
  const m = /\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(url);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
// Data di pubblicazione scritta nella pagina (meta, JSON-LD o <time>): serve
// per i siti i cui indirizzi non contengono la data (es. Avellino, Napoli).
function guessDateFromHtml(html) {
  const pats = [
    /property="article:published_time"\s+content="(\d{4}-\d{2}-\d{2})/i,
    /content="(\d{4}-\d{2}-\d{2})[^"]*"\s+property="article:published_time"/i,
    /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/i,
    /<time[^>]+datetime="(\d{4}-\d{2}-\d{2})/i,
  ];
  for (const re of pats) { const m = re.exec(html); if (m) return m[1]; }
  return null;
}
function guessTitle(html) {
  const m = /<title>([^<]+)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s*[-|–]\s*[^-|–]*$/, '').trim() : 'Bollettino nomine';
}

// Inizio dell'anno scolastico in corso: i bollettini precedenti non contano.
const SEASON_START = (() => { const d = new Date(); const y = d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return y + '-08-20'; })();

async function updateProvince(code, cfg, store, aggregatorLinks) {
  console.log('--', code, cfg.nome, '--');
  const candidates = []; // { url, fromAggregator, label }
  const labelByUrl = {}; // etichetta di Orizzonte Scuola per quell'indirizzo, se disponibile
  const fromAgg = aggregatorLinks[code] || [];
  fromAgg.forEach(l => {
    // alcuni elenchi di Orizzonte Scuola rimandano a documenti di un altro ufficio
    if (cfg.hostHint && !l.url.toLowerCase().includes(cfg.hostHint)) { console.log('  ignoro (altro ufficio):', l.url); return; }
    candidates.push({ url: l.url, fromAggregator: true, label: l.label }); labelByUrl[l.url] = l.label;
  });
  console.log('link da Orizzonte Scuola:', fromAgg.length);
  if (cfg.searchUrl) {
    try {
      const searchHtml = await fetchText(cfg.searchUrl);
      const posts = discoverPosts(searchHtml, cfg.searchUrl, cfg.postMatch).slice(0, 15);
      console.log('pagine candidate dalla ricerca diretta:', posts.length);
      posts.forEach(url => candidates.push({ url, fromAggregator: false }));
    } catch (e) {
      console.warn('ricerca diretta non riuscita:', e.message);
    }
  }
  // unisco togliendo i doppioni, mantenendo la prima occorrenza (l'aggregatore
  // viene prima, quindi ha la precedenza quando lo stesso indirizzo compare
  // in entrambe le fonti)
  const seen = new Set(); const posts = [];
  for (const c of candidates) { if (seen.has(c.url)) continue; seen.add(c.url); posts.push(c.url); }
  console.log('totale pagine da controllare:', posts.length);

  // Ricostruisco ogni volta i dati della provincia da zero (senza trascinarmi
  // appresso bollettini di anni scorsi o punteggi vecchi). Se però in questo
  // giro non riesco a leggere nulla (sito giù), tengo quelli di prima.
  const old = store.province[code];
  const prov = { bollettini: [], soglie: {} };
  store.province[code] = prov;
  const seenPdf = new Set();
  const manuali = MAN[code] || [];
  const manDates = new Set(manuali.map(m => m.data));
  const unreadDates = []; // date dei bollettini di turno non leggibili
  let letti = 0, nonLetti = 0, errs = 0;
  for (const postUrl of posts) {
    let kind = 'turno';
    try {
      const postHtml = await fetchText(postUrl);
      const title = guessTitle(postHtml);
      // per il numero del turno mi fido per primo dell'etichetta di Orizzonte
      // Scuola (di solito è la più chiara), poi del titolo della pagina, poi
      // dell'indirizzo.
      const turno = guessTurno(labelByUrl[postUrl]) ?? guessTurno(title) ?? guessTurno(postUrl);
      const data = guessDateFromUrl(postUrl) || guessDateFromHtml(postHtml) || new Date().toISOString().slice(0, 10);
      if (data < SEASON_START) { console.log('  anno scolastico precedente, salto:', postUrl); continue; }
      const txt = (labelByUrl[postUrl] || '') + ' ' + title + ' ' + (() => { try { return decodeURIComponent(postUrl); } catch (e) { return postUrl; } })();
      // solo i bollettini di turno servono per i punteggi: rettifiche, nomine
      // finalizzate al ruolo, conferme di sostegno e semplici disponibilità no
      const txtR = txt.replace(/rettific\w*[\s-]+((dei|ai|di)[\s-]+)?posti[\s-]*orario/gi, ' ');
      if (/rettific|annull|errata/i.test(txtR)) kind = 'rett';
      else if (/finalizzat|al-ruolo|al ruolo|continuit|conferm|posti orario|posti-orario|deroga/i.test(txtR)) kind = 'altro';
      else if (/dispon/i.test(txtR) && !/esiti|bollettin/i.test(txtR)) kind = 'altro';
      const id = code + '-' + (turno ?? data);
      const docList = findDocLinks(postHtml).map(d => ({ ...d, url: /^https?:/i.test(d.href) ? d.href : new URL(d.href, postUrl).href }));
      if (!docList.length) { console.log('  nessun PDF o foglio trovato in', postUrl); if (kind === 'turno') { if (manDates.has(data)) letti++; else { nonLetti++; unreadDates.push(data); } } continue; }
      // provo i documenti della pagina (al massimo 5) finché uno contiene righe GPS
      let pdfUrl = null, calibrated = false, rows = [], skipped = [];
      for (const cand of docList.slice(0, 5)) {
        if (seenPdf.has(cand.url)) { console.log('  stesso documento già trovato in questo giro, salto:', cand.url); continue; }
        console.log('  scarico', cand.url);
        try {
          let res;
          if (cand.kind === 'sheet') {
            const sm = /spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(cand.url), gm = /[?#&]gid=(\d+)/.exec(cand.url);
            const csvUrl = 'https://docs.google.com/spreadsheets/d/' + sm[1] + '/export?format=csv' + (gm ? '&gid=' + gm[1] : '');
            res = parseCsvBulletin(await fetchText(csvUrl));
          } else {
            res = await parseBulletin(await fetchBuf(cand.url));
          }
          if (!pdfUrl) { pdfUrl = cand.url; calibrated = res.calibrated; rows = res.rows; skipped = res.skipped; }
          if (res.rows.some(r => r.tipo === 'GPS')) { pdfUrl = cand.url; calibrated = res.calibrated; rows = res.rows; skipped = res.skipped; break; }
        } catch (e) { console.warn('    documento non leggibile:', cand.url, e.message); }
      }
      if (!pdfUrl) { console.log('  nessun PDF utilizzabile in', postUrl); if (kind === 'turno') { if (manDates.has(data)) letti++; else { nonLetti++; unreadDates.push(data); } } continue; }
      seenPdf.add(pdfUrl);
      const nomine = rows.filter(r => r.tipo === 'GPS').length;
      const dubbio = (!calibrated || skipped.length > 0) && !manDates.has(data); // coperto dal file manuale = non dubbio
      prov.bollettini.push({ id, turno, data, titolo: title, nomine, url: postUrl, pdfUrl, dubbio });
      if (kind === 'turno') {
        if (dubbio) { nonLetti++; unreadDates.push(data); } else letti++;
        // punteggio più basso nominato finora, per classe e fascia: è l'"ultimo
        // punteggio" con cui confrontarsi (le nomine scendono lungo la graduatoria)
        for (const [cdc, byFascia] of Object.entries(aggregate(rows))) {
          prov.soglie[cdc] = prov.soglie[cdc] || {};
          for (const [f, v] of Object.entries(byFascia)) {
            const cur = prov.soglie[cdc][f];
            if (!cur || v.p < cur.p || (v.p === cur.p && data > (cur.dt || ''))) prov.soglie[cdc][f] = { p: v.p, n: v.n, t: turno, dt: data };
          }
        }
      }
      console.log('    ok [' + kind + ']: calibrato=' + calibrated, 'righe GPS=' + nomine, 'scartate=' + skipped.length);
    } catch (e) {
      console.warn('  errore su', postUrl, '->', e.message); errs++;
      if (kind === 'turno' && /turno|fase|bollettin|nomin/i.test((labelByUrl[postUrl] || '') + postUrl)) { nonLetti++; unreadDates.push('9999'); } // dopo un errore non so la data: la considero la più recente
    }
  }
  // Se anche un solo bollettino di turno non è stato letto bene, i punteggi
  // potrebbero essere superati da nomine che non vedo: li segno "da verificare"
  // (l'app non colora la provincia) invece di mostrare un colore che potrebbe
  // essere sbagliato.
  // Punteggi dei bollettini trascritti a mano (data/bollettini-manuali.json)
  for (const m of manuali) {
    for (const [cdc, byF] of Object.entries(m.soglie || {})) {
      prov.soglie[cdc] = prov.soglie[cdc] || {};
      for (const [f, v] of Object.entries(byF)) {
        const cur = prov.soglie[cdc][f];
        if (!cur || v.p < cur.p || (v.p === cur.p && m.data > (cur.dt || ''))) prov.soglie[cdc][f] = { p: v.p, n: v.n, t: m.turno == null ? null : m.turno, dt: m.data };
      }
    }
    console.log('  bollettino manuale aggiunto:', m.data, m.fonte || '');
  }
  // "d" ora vale per ogni singola classe: è vero solo se esiste un bollettino
  // di turno non leggibile PIÙ RECENTE di quello da cui viene il punteggio (lì
  // potrebbe esserci un punteggio più basso). In quel caso l'app mostra il
  // colore a strisce; altrimenti il colore pieno, anche se esistono bollettini
  // vecchi non leggibili.
  const completo = nonLetti === 0 && letti > 0;
  Object.values(prov.soglie).forEach(byF => Object.values(byF).forEach(e => { e.d = unreadDates.some(d => d > (e.dt || '')); }));
  prov.stato = { turniLetti: letti, turniNonLetti: nonLetti };
  console.log('  turni letti=' + letti, 'non letti=' + nonLetti, completo ? '-> provincia completa' : '-> da verificare');
  prov.v = 4;
  // I dati non devono mai peggiorare da un giro all'altro: se non ho trovato
  // pagine (fonte che non risponde, es. Orizzonte Scuola) o ho letto MENO turni
  // di prima, tengo i dati precedenti (solo se prodotti da questa stessa versione).
  if (old && old.v === 4 && old.bollettini && old.bollettini.length &&
      (posts.length === 0 || letti < ((old.stato && old.stato.turniLetti) || 0))) {
    console.log('  tengo i dati precedenti: turni letti ora=' + letti + ', prima=' + ((old.stato && old.stato.turniLetti) || 0) + ', pagine=' + posts.length);
    store.province[code] = old;
    return;
  }
  // sito che non risponde e niente letto: ripristino solo ciò che è dell'anno scolastico in corso e dell'ufficio giusto
  if (!prov.bollettini.length && errs > 0 && old && old.bollettini) {
    const ok = old.bollettini.filter(b => b.data >= SEASON_START && (!cfg.hostHint || (b.url || '').toLowerCase().includes(cfg.hostHint)));
    store.province[code] = ok.length ? { ...old, bollettini: ok } : prov;
    return;
  }
}

async function main() {
  let store = { aggiornato: new Date().toISOString(), province: {} };
  if (fs.existsSync(DATA_PATH)) {
    try { store = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch (e) {}
  }
  store.province = store.province || {};
  const aggregatorLinks = await fetchAggregatorLinks();
  const senza = Object.keys(PROVINCE).filter(c => !(aggregatorLinks[c] && aggregatorLinks[c].length));
  console.log('Province CON link su Orizzonte Scuola:', Object.keys(PROVINCE).length - senza.length, '| SENZA link:', senza.join(' ') || '-');
  for (const [code, cfg] of Object.entries(PROVINCE)) {
    try { await updateProvince(code, cfg, store, aggregatorLinks); }
    catch (e) { console.error('Provincia', code, 'non aggiornata:', e.message); }
  }
  store.aggiornato = new Date().toISOString();
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(store));
  console.log('Scritto', DATA_PATH);
}
main();
