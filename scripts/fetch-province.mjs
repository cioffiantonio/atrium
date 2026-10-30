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
import { ocrBulletin } from './ocr-lib.mjs';
import { strutturaPdf, dataCreazionePdf } from './struttura-lib.mjs';
import { trovaTurniBenevento, leggiTurnoBenevento, scaricaConFallback, chiudiBrowser, VALIDA_BN, tabellaDaHtml, parseTabellaBollettino, htmlConBrowser } from './web-lib.mjs';
import crypto from 'crypto';

const DATA_PATH = path.join(process.cwd(), 'data', 'bollettini.json');
// Bollettini che il lettore automatico non riesce a leggere (scansioni, fogli
// con intestazioni spezzate...), trascritti a mano o con l'OCR: vedi
// data/bollettini-manuali.json. La "data" deve coincidere con quella del
// bollettino sul sito dell'USP.
const MAN_PATH = path.join(process.cwd(), 'data', 'bollettini-manuali.json');
let MAN = {};
try { MAN = JSON.parse(fs.readFileSync(MAN_PATH, 'utf8')); } catch (e) {}
// Elenco di ciò che non è stato letto con certezza: serve a controllarlo a mano
// (punteggi letti con l'OCR, PDF a zero righe, turni mancanti). Non colora nulla.
const REPORT_PATH = path.join(process.cwd(), 'data', 'da-verificare.json');
const report = { ocr: [], zeroRighe: [], nonLetti: [], turniMancanti: [], decretiIgnorati: [] };

// Solo certe province (es. PROVINCE_FILTER=SA,BN): serve per provare una correzione
// in pochi minuti invece di rifare tutto il giro. Le altre province restano com'erano.
const FILTRO = (process.env.PROVINCE_FILTER || '').split(/[,\s]+/).map(x => x.trim().toUpperCase()).filter(Boolean);

// Memoria dei PDF già letti: un bollettino pubblicato non cambia, quindi non lo
// riscarico e rileggo a ogni giro. La memoria vale solo per la versione corrente del
// lettore (se cambio parse-lib/ocr-lib/struttura-lib, si rilegge tutto). I documenti
// NON letti si riprovano dopo 2 giorni (il sito poteva avere un problema passeggero).
const CACHE_PATH = path.join(process.cwd(), 'data', 'cache-pdf.json');
const STRUTTURA_PATH = path.join(process.cwd(), 'data', 'struttura-non-letti.json');
const NON_LETTI_RIPROVA_MS = 2 * 24 * 3600 * 1000;
const PARSER_VERSION = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['parse-lib.mjs', 'ocr-lib.mjs', 'struttura-lib.mjs']) { try { h.update(fs.readFileSync(new URL('./' + f, import.meta.url))); } catch (e) {} }
  return h.digest('hex').slice(0, 10);
})();
let cache = {};
const cacheVisti = new Set();
// Download per la piattaforma di Benevento: accesso diretto e, se il sito blocca GitHub (403),
// vie alternative (vedi web-lib.mjs). tipo: 'elenco' | 'pagina' | 'csv'
const fetchBn = (url, tipo) => scaricaConFallback(url, fetchText, VALIDA_BN[tipo] || null, console.log, tipo);
// Piattaforma di Benevento: indirizzo del turno -> sorgenti (pagina del turno, CSV)
const piattaformaMap = {};
// Tabelle trovate direttamente nel testo di una pagina (senza allegati): indirizzo#tabella -> esito
const htmlTabs = {};
// Decreti di pubblicazione (testo, nessuna tabella): non sono bollettini
const DECRETO = /decret/i, DECRETO_MA_BOLLETTINO = /bollettin|nomin|esit|totale|elenc/i;
// Strutture (senza dati personali) dei PDF che non riesco a leggere, per correggere il lettore
const strutture = [];

const AGGREGATOR_URL = 'https://www.orizzontescuola.it/supplenze-docenti-ecco-i-bollettini-nomine-al-31-agosto-o-30-giugno-2027-in-aggiornamento/';

// Vero solo se il testo contiene INSIEME "turno", "nomin[ae]" e "gps", in
// qualunque ordine: esclude rettifiche, avvisi su "sedi vacanti" o "esiti
// nomine finalizzate al ruolo", che non sono i bollettini di un turno.
const TURNO_MATCH = { test: s => /turno/i.test(s) && /nomin[ae]/i.test(s) && /gps/i.test(s) };

// Rete degli Uffici Scolastici Provinciali dell'Emilia-Romagna: stesso sito
// WordPress, stesso modo di pubblicare i bollettini, cambia solo la sigla nel
// sottodominio (<sigla>.istruzioneer.gov.it).
function er(sigla, nome) {
  return {
    nome, searchUrl: `https://${sigla}.istruzioneer.gov.it/?s=nomine+gps`, postMatch: TURNO_MATCH,
    // ricerca \"bollettino\": trova anche le pagine che non hanno \"turno\" nel titolo (es. \"fase\")
    searchExtra: [{ url: `https://${sigla}.istruzioneer.gov.it/?s=bollettino`, match: LOOSE_MATCH }],
  };
}
// Una pagina che non legge e che non parla di bollettino/turno/fase non è un bollettino
// (interpelli, circolari, avvisi): non deve far risultare la provincia "da verificare".
// Allegati generici che compaiono in molte pagine (organigramma, contatti, curriculum...):
// non sono bollettini e non vanno nemmeno scaricati.
const DOC_NON_BOLLETTINO = /funzionigramma|contatti|organigramma|(^|[\/_+ -])cv[_+ -]|curriculum|informativa|accessibilit|modulo|istanza/i;
const SEMBRA_BOLLETTINO = /bollettin|turno|fase|totale.?nomin|esit/i;
const LOOSE_MATCH = { test: s => /bollettin|nomin|gps|turno|fase/i.test(s) };
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
  // Benevento: le pagine WordPress rispondono 403 a GitHub, quindi uso solo l'elenco dei PDF
  BN: { nome: 'Benevento', senzaAggregatore: true, searchUrl: 'https://www.uspbenevento.it/?s=nomine+gps', postMatch: TURNO_MATCH, hostHint: 'benevento',
        // pagina con l'elenco di tutti i PDF dei bollettini (indicata dall'utente): li prendo tutti
        // piattaforma dei bollettini (pagina con i turni; il bollettino si legge nella pagina, non è un PDF)
        // il sito risponde 403 ai server di GitHub: provo anche vie alternative (togliendo proxyFallback per spegnerle)
        proxyFallback: true,
        piattaforma: 'https://www.uspbenevento.it/uat/wp-content/VARIE_SITO/PUBBLICAZIONE_SUPPLENZE/index.php',
        listUrls: ['https://www.mim.gov.it/web/miur-usr-campania/uat-benevento'] },
  CE: { nome: 'Caserta', searchUrl: 'https://www.uat-caserta.it/?s=nomine+gps', postMatch: TURNO_MATCH },
  NA: { nome: 'Napoli', searchUrl: 'https://www.uat-napoli.it/?s=nomine+gps', postMatch: TURNO_MATCH },
  // Salerno pubblica sul portale del Ministero (mim.gov.it), che non ha una
  // ricerca interna paragonabile: mi affido solo a Orizzonte Scuola.
  // I link di Orizzonte Scuola per Salerno puntano a documenti sbagliati (organigrammi,
  // contatti): uso solo la pagina dell'ufficio sul portale del Ministero.
  SA: { nome: 'Salerno', senzaAggregatore: true, listUrls: ['https://www.mim.gov.it/web/miur-usr-campania/uat-salerno'] },
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

// Ricerca tramite l'API di WordPress (se il sito la lascia aperta): restituisce le
// pagine pubblicate quest'anno scolastico che parlano di \"bollettino\", \"nomine gps\"
// o \"fase\", anche quando il titolo non contiene la parola \"turno\".
async function wpDiscover(base) {
  const out = new Set();
  for (const term of ['bollettino', 'nomine gps', 'fase']) {
    for (let page = 1; page <= 3; page++) {
      const url = `${base}/wp-json/wp/v2/posts?search=${encodeURIComponent(term)}&per_page=100&page=${page}&after=${SEASON_START}T00:00:00&_fields=link,date`;
      try {
        const arr = JSON.parse(await fetchText(url));
        if (!Array.isArray(arr) || !arr.length) break;
        arr.forEach(p => { if (p.link && /\/20\d\d\/\d\d\/\d\d\//.test(p.link)) out.add(p.link.split('#')[0]); });
        if (arr.length < 100) break;
      } catch (e) { break; }
    }
  }
  return [...out];
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
  // portale del Ministero (Campania): "7° Bollettino", "II Bollettino", "settimo bollettino"
  m = /(\d{1,2})\s*[°ºª]\s*bollettin/i.exec(text);
  if (m) return parseInt(m[1], 10);
  m = /\b([ivx]{1,4})\s+bollettin/i.exec(text);
  if (m && ROMANI[m[1].toLowerCase()]) return ROMANI[m[1].toLowerCase()];
  m = /\b(primo|secondo|terzo|quarto|quinto|sesto|settimo|ottavo|nono|decimo)\s+bollettin/i.exec(text);
  if (m) return ORDINALI[m[1].toLowerCase()];
  m = /bollettin[oi]\s*(?:n\.?|numero|n°)\s*(\d{1,2})(?![\d/]|\s*(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre))/i.exec(text);
  if (m) return parseInt(m[1], 10);
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
// Data scritta nel nome del file (es. bollettino_17-09-2026.pdf, 2026-09-17, 17092026)
function guessDateFromName(url) {
  let u = url; try { u = decodeURIComponent(url); } catch (e) {}
  u = u.replace(/\?.*$/, '').replace(/^.*\//, '');
  const ok = (y, m, d) => y >= 2026 && y <= 2027 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
  let m = /(20\d{2})[-_.](\d{2})[-_.](\d{2})/.exec(u);
  if (m && ok(+m[1], +m[2], +m[3])) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(\d{2})[-_.](\d{2})[-_.](20\d{2})/.exec(u);
  if (m && ok(+m[3], +m[2], +m[1])) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /(?:^|\D)(\d{2})(\d{2})(20\d{2})(?:\D|$)/.exec(u);
  if (m && ok(+m[3], +m[2], +m[1])) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}
// I documenti del portale del Ministero (Salerno) non hanno la data nell'indirizzo:
// c'è però l'istante di caricamento del file (t=<millisecondi>), che coincide con
// il giorno del bollettino. È una data ricavata, non scritta: la scrivo nel log.
function guessDateFromMimTimestamp(url) {
  if (!/mim\.gov\.it\/documents\//i.test(url)) return null;
  const m = /[?&]t=(\d{13})\b/.exec(url);
  return m ? new Date(parseInt(m[1], 10)).toISOString().slice(0, 10) : null;
}
// Indirizzo che punta già al documento (PDF o portale del Ministero), non a una pagina
function isDirectDoc(url) { return !!piattaformaMap[url] || /\.pdf(?:[?#]|$)/i.test(url) || /mim\.gov\.it\/documents\//i.test(url); }
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
  const fromAgg = cfg.senzaAggregatore ? [] : (aggregatorLinks[code] || []);
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
  // Piattaforma di Benevento: leggo l'elenco dei turni e aggiungo ogni turno come candidato
  if (cfg.piattaforma) {
    try {
      const html = cfg.proxyFallback ? await fetchBn(cfg.piattaforma, 'elenco') : await fetchText(cfg.piattaforma);
      const turni = trovaTurniBenevento(html, cfg.piattaforma);
      console.log('piattaforma Benevento:', turni.length, 'turni trovati (pagina di', html.length, 'caratteri)');
      for (const t of turni) {
        console.log('   - turno', t.turno, '| pagina:', t.pageUrl ? t.pageUrl.slice(-80) : 'nessuna', '| csv:', t.csvUrl ? t.csvUrl.slice(-60) : 'nessuno');
        const url = t.pageUrl || t.csvUrl; if (!url) continue;
        piattaformaMap[url] = t; labelByUrl[url] = 'Turno ' + t.turno;
        candidates.push({ url, fromAggregator: false });
      }
      if (!turni.length) console.log('   (nessun riquadro "Turno Supplenze N" riconosciuto nella pagina)');
    } catch (e) { console.warn('piattaforma non raggiungibile:', e.message); }
  }
  // Pagina dell'ufficio con l'elenco dei documenti (es. portale del Ministero per la Campania):
  // prendo i collegamenti che parlano di bollettino/nomine/turno e ne stampo i primi nel log.
  for (const lu of (cfg.listUrls || [])) {
    try {
      const html = await fetchText(lu);
      const re = /<a\b[^>]*\bhref=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      const trovati = []; let m;
      while ((m = re.exec(html))) {
        const testo = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        let url; try { url = new URL(decodeEntities(m[1]), lu).href; } catch (e) { continue; }
        if (/\.(zip|7z|rar)(?:[\/?#]|$)/i.test(url) || /archivio/i.test(testo)) continue; // archivi di anni passati
        const tuttiPdf = (cfg.listTuttiPdf || []).includes(lu) && /\.pdf(?:[?#]|$)/i.test(url);
        let urlDec = url; try { urlDec = decodeURIComponent(url); } catch (e) {}
        if (tuttiPdf) { if (DOC_NON_BOLLETTINO.test(urlDec.replace(/^https?:\/\/[^/]+/, '') + ' ' + testo)) continue; }
        else if (!SEMBRA_BOLLETTINO.test(testo + ' ' + urlDec.slice(-120)) && !/nomin/i.test(testo)) continue;
        if (!trovati.some(t => t.url === url)) trovati.push({ url, testo });
      }
      console.log('collegamenti dalla pagina elenco', lu, ':', trovati.length, '(pagina di', html.length, 'caratteri)');
      trovati.slice(0, 12).forEach(t => console.log('   -', t.testo.slice(0, 70), '|', t.url.slice(-90)));
      trovati.slice(0, 80).forEach(t => { candidates.push({ url: t.url, fromAggregator: false }); if (!labelByUrl[t.url]) labelByUrl[t.url] = t.testo; });
    } catch (e) { console.warn('pagina elenco non riuscita:', lu, e.message); }
  }
  // Ricerca \"bollettino\" sul sito: pagine con altri nomi (\"fase\", allegati con nome diverso)
  for (const ex of (cfg.searchExtra || [])) {
    try {
      const html = await fetchText(ex.url);
      const found = discoverPosts(html, ex.url, ex.match).slice(0, 30);
      console.log('pagine candidate dalla ricerca \"bollettino\":', found.length);
      found.forEach(url => candidates.push({ url, fromAggregator: false }));
    } catch (e) { console.warn('ricerca \"bollettino\" non riuscita:', e.message); }
  }
  if (cfg.searchUrl) {
    const wp = await wpDiscover(new URL(cfg.searchUrl).origin);
    console.log('pagine candidate dall\'API WordPress:', wp.length);
    wp.forEach(url => candidates.push({ url, fromAggregator: false }));
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
  let unreadDates = []; // date dei bollettini di turno non leggibili
  const turniVisti = new Set(); // numeri di turno trovati sul sito (letti o no)
  let letti = 0, nonLetti = 0, errs = 0;
  for (const postUrl of posts) {
    let kind = 'turno';
    try {
      // riepiloghi (es. "Specchietto riassuntivo" di Roma): non sono bollettini
      { let u0 = postUrl; try { u0 = decodeURIComponent(postUrl); } catch (e) {}
        if (/specchietto|riassuntiv/i.test(u0 + ' ' + (labelByUrl[postUrl] || ''))) { console.log('  riepilogo (specchietto), non è un bollettino: ignoro', postUrl.slice(-70)); continue; } }
      const direct = isDirectDoc(postUrl);
      const postHtml = direct ? '' : await fetchText(postUrl);
      const title = direct ? ((labelByUrl[postUrl] || '').trim() || 'Bollettino nomine') : guessTitle(postHtml);
      // per il numero del turno mi fido per primo dell'etichetta di Orizzonte
      // Scuola (di solito è la più chiara), poi del titolo della pagina, poi
      // dell'indirizzo.
      const turno = guessTurno(labelByUrl[postUrl]) ?? guessTurno(title) ?? guessTurno(postUrl);
      const mimDate = guessDateFromMimTimestamp(postUrl);
      const dataCerta = guessDateFromUrl(postUrl) || (direct ? null : guessDateFromHtml(postHtml)) || mimDate || (direct ? guessDateFromName(postUrl) : null);
      let data = dataCerta || new Date().toISOString().slice(0, 10);
      if (mimDate && data === mimDate) console.log('  data ricavata dal caricamento del file:', mimDate);
      if (data < SEASON_START) { console.log('  anno scolastico precedente, salto:', postUrl); continue; }
      const txt = (labelByUrl[postUrl] || '') + ' ' + title + ' ' + (() => { try { return decodeURIComponent(postUrl); } catch (e) { return postUrl; } })();
      // solo i bollettini di turno servono per i punteggi: rettifiche, nomine
      // finalizzate al ruolo, conferme di sostegno e semplici disponibilità no
      const txtR = txt.replace(/rettific\w*[\s-]+((dei|ai|di)[\s-]+)?posti[\s-]*orario/gi, ' ');
      if (/rettific|annull|errata/i.test(txtR)) kind = 'rett';
      else if (/finalizzat|al-ruolo|al ruolo|continuit|conferm|posti orario|posti-orario|deroga/i.test(txtR)) kind = 'altro';
      else if (/dispon/i.test(txtR) && !/esiti|bollettin/i.test(txtR)) kind = 'altro';
      let id = code + '-' + (turno ?? data);
      let docList = direct
        ? [{ href: postUrl, url: postUrl, text: '', kind: 'pdf', i: 0 }]
        : findDocLinks(postHtml).map(d => ({ ...d, url: /^https?:/i.test(d.href) ? d.href : new URL(d.href, postUrl).href }));
      if (!direct && !docList.length && kind === 'turno' && /mim\.gov\.it\/web\/.+-\d+\/?$/.test(postUrl)) {
        // prova: alcune pagine duplicate ("...-1") non hanno gli allegati, l'originale sì
        const alt = postUrl.replace(/-\d+\/?$/, '');
        try {
          const h2 = await fetchText(alt);
          const d2 = findDocLinks(h2).map(d => ({ ...d, url: /^https?:/i.test(d.href) ? d.href : new URL(d.href, alt).href }));
          console.log('  prova senza suffisso:', alt.slice(-80), '->', d2.length, 'allegati');
          if (d2.length) docList = d2;
        } catch (e) { console.log('  prova senza suffisso non riuscita:', e.message); }
      }
      if (!direct && !docList.length && kind === 'turno' && /mim\.gov\.it\/web\//.test(postUrl)) {
        // ultima prova: gli allegati potrebbero essere caricati dal JavaScript della pagina
        try {
          const hb = await htmlConBrowser(postUrl);
          const db = findDocLinks(hb).map(d => ({ ...d, url: /^https?:/i.test(d.href) ? d.href : new URL(d.href, postUrl).href }));
          console.log('  prova con il browser:', db.length, 'allegati');
          if (db.length) { docList = db; }
        } catch (e) { console.log('  prova con il browser non riuscita:', String(e.message).slice(0, 80)); }
      }
      if (!direct) {
        const prima = docList.length;
        for (let i = docList.length - 1; i >= 0; i--) {
          let nm = docList[i].url; try { nm = decodeURIComponent(nm); } catch (e) {}
          if (DOC_NON_BOLLETTINO.test(nm.replace(/\?.*$/, '').replace(/^https?:\/\/[^/]+/, '') + ' ' + (docList[i].text || ''))) docList.splice(i, 1);
        }
        if (docList.length < prima) console.log('  scartati ' + (prima - docList.length) + ' allegati generici (contatti, organigramma...)');
        // decreti di pubblicazione: testo senza tabelle, a meno che il nome non parli di bollettino/nomine
        let decretiScartati = 0;
        for (let i = docList.length - 1; i >= 0; i--) {
          let nm = docList[i].url; try { nm = decodeURIComponent(nm); } catch (e) {}
          const nome = nm.replace(/\?.*$/, '').replace(/^https?:\/\/[^/]+/, '') + ' ' + (docList[i].text || '');
          if (DECRETO.test(nome) && !DECRETO_MA_BOLLETTINO.test(nome)) { docList.splice(i, 1); decretiScartati++; }
        }
        if (decretiScartati) console.log('  scartati ' + decretiScartati + ' decreti (non sono bollettini)');
        // nessun allegato: la tabella potrebbe essere scritta nella pagina stessa
        if (!docList.length && kind === 'turno') {
          try {
            const tab = parseTabellaBollettino(tabellaDaHtml(postHtml));
            if (tab.rows.some(r => r.tipo === 'GPS')) {
              const key = postUrl + '#tabella';
              htmlTabs[key] = tab;
              docList = [{ href: postUrl, url: key, text: '', kind: 'html', i: 0 }];
              console.log('  tabella trovata nella pagina: ' + tab.rows.length + ' righe');
            }
          } catch (e) {}
        }
        if (!docList.length && kind === 'turno' && decretiScartati) { console.log('  la pagina ha solo decreti: ignoro', postUrl.slice(-80)); continue; }
        // nessun allegato riconoscibile: stampo i collegamenti a documenti della pagina, per capire com'è fatta
        if (!docList.length && kind === 'turno') {
          const hrefs = []; const reH = /href=["']([^"']*(?:\/documents\/|download|get_file|\.pdf|\.zip|\.xlsx?)[^"']*)["']/gi; let mh;
          while ((mh = reH.exec(postHtml)) && hrefs.length < 12) hrefs.push(decodeEntities(mh[1]).slice(-110));
          console.log('  pagina senza allegato riconoscibile (' + postHtml.length + ' caratteri); collegamenti a documenti:', hrefs.length ? '' : 'nessuno');
          hrefs.forEach(h => console.log('     ~', h));
        }
      }
      if (!docList.length && kind === 'turno' && !SEMBRA_BOLLETTINO.test(txt)) { console.log('  non sembra un bollettino, ignoro:', postUrl); continue; }
      if (!docList.length) { console.log('  nessun PDF o foglio trovato in', postUrl); if (kind === 'turno') { if (turno != null) turniVisti.add(turno); if (manDates.has(data)) letti++; else { nonLetti++; unreadDates.push(data); report.nonLetti.push({ provincia: code, turno, data, url: postUrl, nota: 'nessun PDF o foglio trovato nella pagina' }); } } continue; }
      // provo i documenti della pagina (al massimo 5) finché uno contiene righe GPS
      let pdfUrl = null, calibrated = false, nomine = 0, skippedN = 0, agg = {}, ocrRes = null, strRes = null, lastMod = null, pdfDateRes = null;
      for (const cand of docList.slice(0, 5)) {
        if (seenPdf.has(cand.url)) { console.log('  stesso documento già trovato in questo giro, salto:', cand.url); continue; }
        console.log('  scarico', cand.url);
        try {
          let res;
          if (cand.kind === 'sheet') {
            // i fogli Google possono cambiare: nessuna memoria
            const sm = /spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(cand.url), gm = /[?#&]gid=(\d+)/.exec(cand.url);
            const csvUrl = 'https://docs.google.com/spreadsheets/d/' + sm[1] + '/export?format=csv' + (gm ? '&gid=' + gm[1] : '');
            res = parseCsvBulletin(await fetchText(csvUrl));
            res.nomine = res.rows.filter(r => r.tipo === 'GPS').length; res.skippedN = res.skipped.length; res.agg = aggregate(res.rows);
          } else if (cand.kind === 'html') {
            res = { ...htmlTabs[cand.url], ocr: null, struttura: null, lm: null, pdfDate: null };
            res.nomine = res.rows.filter(r => r.tipo === 'GPS').length; res.skippedN = res.skipped.length; res.agg = aggregate(res.rows);
          } else if (piattaformaMap[cand.url]) {
            // turno letto dalla piattaforma: nessuna memoria (la pagina può cambiare)
            res = await leggiTurnoBenevento(piattaformaMap[cand.url], cfg.proxyFallback ? fetchBn : fetchText);
            res.nomine = res.rows.filter(r => r.tipo === 'GPS').length; res.skippedN = res.skipped.length; res.agg = aggregate(res.rows);
            res.lm = res.dataIso || null; res.ocr = null; res.struttura = null;
          } else {
            const c = cache[cand.url];
            cacheVisti.add(cand.url);
            if (c && (c.ok || Date.now() - c.t < NON_LETTI_RIPROVA_MS)) {
              console.log('    dalla memoria:', c.ok ? 'letto' : 'non letto', '(righe GPS=' + c.nomine + ')');
              res = { calibrated: c.calibrated, nomine: c.nomine, skippedN: c.skippedN, agg: c.agg, ocr: c.ocr || null, struttura: c.struttura || null, lm: c.lm || null, pdfDate: c.pdfDate || null };
            } else {
              const fr = await getWithFallback(cand.url);
              const buf = Buffer.from(await fr.arrayBuffer());
              const lmH = fr.headers && fr.headers.get ? fr.headers.get('last-modified') : null;
              res = await parseBulletin(buf);
              res.lm = lmH && !isNaN(new Date(lmH)) ? new Date(lmH).toISOString().slice(0, 10) : null;
              res.pdfDate = await dataCreazionePdf(buf);
              res.nomine = res.rows.filter(r => r.tipo === 'GPS').length; res.skippedN = res.skipped.length; res.agg = aggregate(res.rows);
              // nessuna riga GPS: se ci sono pagine scansionate le leggo con l'OCR
              // (il risultato va solo nel file da verificare, non colora la mappa)
              res.ocr = null; res.struttura = null;
              if (res.nomine === 0) {
                try {
                  res.ocr = await ocrBulletin(buf);
                  if (res.ocr.nota) console.log('    OCR non eseguito:', res.ocr.nota);
                  else if (res.ocr.eseguito) console.log('    OCR: pagine scansionate=' + res.ocr.pagineOcr, 'righe GPS lette=' + res.ocr.righe.length, 'righe illeggibili=' + res.ocr.illeggibili.length);
                  else console.log('    OCR: nessuna pagina scansionata nel documento');
                } catch (e) { console.warn('    OCR non riuscito:', e.message); }
                // struttura senza dati personali, per correggere il lettore
                try { res.struttura = await strutturaPdf(buf); } catch (e) { console.warn('    struttura non estratta:', e.message); }
              }
              cache[cand.url] = { t: Date.now(), ok: !!(res.calibrated && res.skippedN === 0 && res.nomine > 0), calibrated: res.calibrated, nomine: res.nomine, skippedN: res.skippedN, agg: res.agg, ocr: res.ocr, struttura: res.struttura, lm: res.lm, pdfDate: res.pdfDate };
            }
          }
          const prendi = () => { pdfUrl = cand.url; calibrated = res.calibrated; nomine = res.nomine; skippedN = res.skippedN; agg = res.agg; lastMod = res.lm || null; pdfDateRes = res.pdfDate || null; };
          if (!pdfUrl) { prendi(); ocrRes = res.ocr || null; strRes = res.struttura || null; }
          if (res.nomine > 0) { prendi(); ocrRes = null; strRes = null; break; }
          if (res.ocr && res.ocr.righe.length) { prendi(); ocrRes = res.ocr; strRes = res.struttura || null; }
        } catch (e) { console.warn('    documento non leggibile:', cand.url, e.message); }
      }
      if (!pdfUrl) { console.log('  nessun PDF utilizzabile in', postUrl); if (kind === 'turno') { if (turno != null) turniVisti.add(turno); if (manDates.has(data)) letti++; else { nonLetti++; unreadDates.push(data); report.nonLetti.push({ provincia: code, turno, data, url: postUrl, nota: 'documento non leggibile' }); } } continue; }
      // documento di testo (decreto, lettera) senza tabelle: non è un bollettino
      if (kind === 'turno' && !calibrated && nomine === 0 && strRes && strRes.tipoDocumento === 'decreto' && !(ocrRes && ocrRes.righe.length)) {
        console.log('  documento di tipo decreto, non è un bollettino: ignoro', (pdfUrl || '').slice(-70));
        report.decretiIgnorati.push({ provincia: code, turno, data, url: pdfUrl, pagine: strRes.pagine }); continue;
      }
      // pagina senza data (portale del Ministero): la data del bollettino è quella di
      // caricamento dell'allegato scelto, non quella di oggi
      if (!dataCerta) {
        const dMim = guessDateFromMimTimestamp(pdfUrl);
        const d2 = dMim || guessDateFromName(pdfUrl) || lastMod || pdfDateRes;
        if (d2) {
          data = d2; id = code + '-' + (turno ?? data);
          console.log('  data ricavata ' + (dMim ? 'dal caricamento dell\'allegato' : (piattaformaMap[pdfUrl] ? 'dalla data di produzione del bollettino' : guessDateFromName(pdfUrl) ? 'dal nome del file' : (lastMod ? 'dall\'intestazione Last-Modified del server (meno sicura)' : 'dai metadati del PDF, data di creazione (meno sicura)'))) + ':', d2);
          if (data < SEASON_START) { console.log('  anno scolastico precedente, salto:', postUrl); continue; }
        }
      }
      seenPdf.add(pdfUrl);
      let nomeDoc = pdfUrl; try { nomeDoc = decodeURIComponent(pdfUrl); } catch (e) {}
      if (kind === 'turno' && !calibrated && nomine === 0 && !SEMBRA_BOLLETTINO.test(txt + ' ' + nomeDoc)) { console.log('  non sembra un bollettino, ignoro:', postUrl); continue; }
      // Nessuna riga GPS letta = NON letto: potrebbe essere una scansione o un formato che
      // non riconosco. Per dichiararlo letto serve una conferma nel file manuale (stessa data).
      const dubbio = (!calibrated || skippedN > 0 || nomine === 0) && !manDates.has(data); // coperto dal file manuale = non dubbio
      prov.bollettini.push({ id, turno, data, titolo: title, nomine, url: postUrl, pdfUrl, dubbio });
      if (kind === 'turno' && turno != null) turniVisti.add(turno);
      if (kind === 'turno' && dubbio) {
        const base = { provincia: code, turno, data, url: pdfUrl };
        if (ocrRes && ocrRes.righe.length) report.ocr.push({ ...base, pagineOcr: ocrRes.pagineOcr, righeIllegibili: ocrRes.illeggibili.length, righe: ocrRes.righe.map(r => ({ classe: r.code, fascia: r.fascia, posizione: r.pos, punteggio: r.pts, riga: r.riga })) });
        else if (nomine === 0 && calibrated && skippedN === 0) report.zeroRighe.push({ ...base, nota: 'nessuna riga GPS: se quel giorno non ci sono state nomine GPS, confermalo nel file manuale con soglie vuote' });
        else report.nonLetti.push({ ...base, nota: !calibrated ? 'formato non riconosciuto' : 'righe GPS non leggibili: ' + skippedN });
        if (strRes && !(ocrRes && ocrRes.righe.length) && strutture.length < 100 && strutture.filter(x => x.provincia === code).length < 2) strutture.push({ ...base, struttura: strRes });
      }
      if (kind === 'turno') {
        if (dubbio) { nonLetti++; unreadDates.push(data); } else letti++;
        // punteggio più basso nominato finora, per classe e fascia: è l'"ultimo
        // punteggio" con cui confrontarsi (le nomine scendono lungo la graduatoria)
        for (const [cdc, byFascia] of Object.entries(agg)) {
          prov.soglie[cdc] = prov.soglie[cdc] || {};
          for (const [f, v] of Object.entries(byFascia)) {
            const cur = prov.soglie[cdc][f];
            if (!cur || v.p < cur.p || (v.p === cur.p && data > (cur.dt || ''))) prov.soglie[cdc][f] = { p: v.p, n: v.n, t: turno, dt: data };
          }
        }
      }
      console.log('    ok [' + kind + ']: calibrato=' + calibrated, 'righe GPS=' + nomine, 'scartate=' + skippedN);
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
  // Bollettini non leggibili PRECEDENTI al primo bollettino letto (circolari, avvisi di
  // agosto): non possono contenere punteggi più bassi di quelli letti dopo, li ignoro.
  const primoLetto = prov.bollettini.filter(b => !b.dubbio && b.nomine > 0).map(b => b.data).sort()[0];
  if (primoLetto) {
    const prima = unreadDates.filter(d => d < primoLetto);
    if (prima.length) {
      nonLetti -= prima.length;
      unreadDates = unreadDates.filter(d => d >= primoLetto);
      for (const k of ['nonLetti', 'zeroRighe']) report[k] = report[k].filter(x => !(x.provincia === code && x.data && x.data < primoLetto));
      console.log('  ignorati ' + prima.length + ' documenti non leggibili precedenti al primo bollettino letto (' + primoLetto + ')');
    }
  }
  // Turni numerati sul sito che non ho trovato (es. si passa dal turno 8 al 10): non so
  // cosa contengano, quindi la provincia non può dirsi completa. Non conta come mancante
  // un turno coperto dal file manuale (stesso numero) né un buco in cui ci sono bollettini
  // senza numero (es. \"fase\" al posto di \"turno\"): lì il numero non si può verificare.
  const manNum = new Set(manuali.filter(m => m.turno != null).map(m => m.turno));
  if (turniVisti.size >= 2) {
    const nums = [...turniVisti].sort((x, y) => x - y);
    const senzaNumero = prov.bollettini.filter(b => b.turno == null).map(b => b.data);
    const dataDi = n => prov.bollettini.filter(b => b.turno === n).map(b => b.data).sort()[0];
    for (let n = nums[0] + 1; n < nums[nums.length - 1]; n++) {
      if (turniVisti.has(n) || manNum.has(n)) continue;
      const prima = [...nums].filter(x => x < n).pop(), dopo = nums.find(x => x > n);
      const d1 = dataDi(prima), d2 = dataDi(dopo);
      if (d1 && d2 && senzaNumero.some(d => d > d1 && d < d2)) { console.log('  turno', n, 'non trovato, ma ci sono bollettini senza numero nel periodo: non lo conto'); continue; }
      const next = d2 || '9999';
      nonLetti++; unreadDates.push(next);
      report.turniMancanti.push({ provincia: code, turno: n, nota: 'bollettino non trovato (si passa dal turno ' + prima + ' al ' + dopo + ')' });
      console.log('  TURNO MANCANTE:', n);
    }
  }
  const completo = nonLetti === 0 && letti > 0;
  Object.values(prov.soglie).forEach(byF => Object.values(byF).forEach(e => { e.d = unreadDates.some(d => d > (e.dt || '')); }));
  prov.stato = { turniLetti: letti, turniNonLetti: nonLetti };
  console.log('  turni letti=' + letti, 'non letti=' + nonLetti, completo ? '-> provincia completa' : '-> da verificare');
  prov.v = 5;
  // I dati non devono mai peggiorare da un giro all'altro: se non ho trovato
  // pagine (fonte che non risponde, es. Orizzonte Scuola) o ho letto MENO turni
  // di prima, tengo i dati precedenti (solo se prodotti da questa stessa versione).
  if (old && old.v === 5 && old.bollettini && old.bollettini.length &&
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
  // memoria dei PDF già letti (si azzera se è cambiata la versione del lettore)
  if (fs.existsSync(CACHE_PATH)) {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      if (c.versione === PARSER_VERSION) cache = c.voci || {}; else console.log('lettore cambiato: la memoria dei PDF viene rifatta');
    } catch (e) {}
  }
  if (FILTRO.length) console.log('GIRO MIRATO solo su:', FILTRO.join(', '));
  const aggregatorLinks = await fetchAggregatorLinks();
  const senza = Object.keys(PROVINCE).filter(c => !(aggregatorLinks[c] && aggregatorLinks[c].length));
  console.log('Province CON link su Orizzonte Scuola:', Object.keys(PROVINCE).length - senza.length, '| SENZA link:', senza.join(' ') || '-');
  for (const [code, cfg] of Object.entries(PROVINCE)) {
    if (FILTRO.length && !FILTRO.includes(code)) continue;
    try { await updateProvince(code, cfg, store, aggregatorLinks); }
    catch (e) { console.error('Provincia', code, 'non aggiornata:', e.message); }
  }
  store.aggiornato = new Date().toISOString();
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  await chiudiBrowser();
  fs.writeFileSync(DATA_PATH, JSON.stringify(store));
  // memoria PDF: in un giro completo tengo solo i PDF visti; in un giro mirato conservo tutto
  if (!FILTRO.length) for (const k of Object.keys(cache)) if (!cacheVisti.has(k)) delete cache[k];
  fs.writeFileSync(CACHE_PATH, JSON.stringify({ versione: PARSER_VERSION, voci: cache }));
  // in un giro mirato mantengo le voci del report delle altre province
  let strutAll = strutture;
  if (FILTRO.length) {
    try {
      const prev = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
      for (const k of Object.keys(report)) report[k] = (prev[k] || []).filter(x => !FILTRO.includes(x.provincia)).concat(report[k]);
    } catch (e) {}
    try {
      const prevS = JSON.parse(fs.readFileSync(STRUTTURA_PATH, 'utf8'));
      // le strutture salvate da una versione precedente del lettore non si riusano (potevano non essere mascherate)
      if (prevS.versione === PARSER_VERSION) strutAll = (prevS.strutture || []).filter(x => !FILTRO.includes(x.provincia)).concat(strutture);
    } catch (e) {}
  }
  fs.writeFileSync(REPORT_PATH, JSON.stringify({ aggiornato: store.aggiornato, ...report }, null, 1));
  fs.writeFileSync(STRUTTURA_PATH, JSON.stringify({ aggiornato: store.aggiornato, versione: PARSER_VERSION, nota: 'Struttura (senza dati personali) dei PDF non letti: servono a correggere il lettore', strutture: strutAll.slice(0, 110) }));
  console.log('RIEPILOGO DA VERIFICARE: letti con OCR=' + report.ocr.length, '| zero righe=' + report.zeroRighe.length, '| non letti=' + report.nonLetti.length, '| turni mancanti=' + report.turniMancanti.length);
  console.log('Scritto', DATA_PATH);
}
main();
