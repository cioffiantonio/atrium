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
import { parseBulletin, parseCsvBulletin, aggregate, diagnosiFasce, riepilogoClassi } from './parse-lib.mjs';
import { extractProvinceLinks } from './discover-orizzonte.mjs';
import { PROVINCE_ITALIA } from './province-italia.mjs';
import { ocrBulletin } from './ocr-lib.mjs';
import { strutturaPdf, dataCreazionePdf } from './struttura-lib.mjs';
import { trovaTurniBenevento, leggiTurnoBenevento, scaricaConFallback, chiudiBrowser, VALIDA_BN, tabellaDaHtml, parseTabellaBollettino, htmlConBrowser } from './web-lib.mjs';
import { righeDaExcel, righeDaZip, dataDaXlsx, leggiAuto } from './formati-lib.mjs';
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
const report = { ocr: [], zeroRighe: [], nonLetti: [], turniMancanti: [], decretiIgnorati: [], pagineSoloDecreti: [], fasciaNonRiconosciuta: [] };

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
  for (const f of ['parse-lib.mjs', 'ocr-lib.mjs', 'struttura-lib.mjs', 'formati-lib.mjs', 'web-lib.mjs']) { try { h.update(fs.readFileSync(new URL('./' + f, import.meta.url))); } catch (e) {} }
  return h.digest('hex').slice(0, 10);
})();
let cache = {};
const cacheVisti = new Set();
// Download per la piattaforma di Benevento: accesso diretto e, se il sito blocca GitHub (403),
// vie alternative (vedi web-lib.mjs). tipo: 'elenco' | 'pagina' | 'csv'
const fetchBn = (url, tipo) => scaricaConFallback(url, fetchText, VALIDA_BN[tipo] || null, console.log, tipo);
// Piattaforma di Benevento: indirizzo del turno -> sorgenti (pagina del turno, CSV)
const piattaformaMap = {};
// Albo pretorio (plugin WordPress): indirizzo dell'atto -> oggetto dell'atto
const alboLabel = {};
const testoPulito = h => decodeEntities(String(h).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
// Elenca gli atti "Nomine a tempo determinato" dell'anno nelle liste dell'albo (le pagine sono
// ordinate dal più recente: si smette quando una pagina non ha più atti dell'anno).
async function scopriAlbo(albo) {
  const out = new Map();
  for (const lista of albo.liste) {
    for (let pag = 1; pag <= (albo.maxPagine || 12); pag++) {
      const url = pag === 1 ? lista : lista + (lista.includes('?') ? '&' : '?') + 'Pag=' + pag;
      let html; try { html = await fetchText(url); } catch (e) { console.log('  albo: pagina non letta', url.slice(-50), e.message); break; }
      let atti = 0, nuovi = 0, righe = 0;
      for (const m of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        righe++;
        const riga = decodeEntities(m[1]);   // il sito può scrivere & come &amp; o &#038;
        const id = /action=visatto&id=(\d+)/i.exec(riga); if (!id) continue;
        const celle = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(c => testoPulito(c[1]));
        if (!new RegExp('/' + albo.anno + '$').test((celle[0] || '').trim())) continue;
        atti++;
        const oggetto = celle[1] || '', categoria = celle[3] || '';
        if (!/nomine a tempo determinato/i.test(categoria)) continue;
        if (/\bATA\b|DSGA|direttore dei servizi|personale ata/i.test(oggetto)) continue;
        const hm = /href=["']([^"']*action=visatto[^"']*)["']/i.exec(riga); if (!hm) continue;
        let u; try { u = new URL(decodeEntities(hm[1]), url).href; } catch (e) { continue; }
        if (!out.has(id[1])) { out.set(id[1], { url: u, oggetto, numero: celle[0] }); nuovi++; }
      }
      console.log('  albo: ' + url.slice(-45) + ' -> righe tabella=' + righe + ', atti ' + albo.anno + '=' + atti + ', nomine nuove=' + nuovi + (righe === 0 ? ' | pagina senza tabella, inizio: ' + testoPulito(html).slice(0, 160) : ''));
      if (atti === 0 || nuovi === 0 && pag > 1) break;
    }
  }
  return [...out.values()];
}
// Data di pubblicazione dell'atto nell'albo ("Data inizio Pubblicazione 27/10/2026")
function guessDateFromAlbo(html) {
  const t = testoPulito(html);
  const m = /Data inizio Pubblicazione\s*(\d{2})\/(\d{2})\/(20\d{2})/i.exec(t) || /Data di registrazione\s*(\d{2})\/(\d{2})\/(20\d{2})/i.exec(t);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
// "Forma" dei collegamenti di condivisione presenti in una pagina (SharePoint, cloud, Drive...):
// host e percorso con i codici lunghi nascosti, per capire come sono fatti senza mostrare chiavi.
function formaCollegamenti(html) {
  const out = new Map(); let m; const re = /href=["'](https?:\/\/[^"'\s]+)["']/gi;
  while ((m = re.exec(html || ''))) {
    if (!/sharepoint|onedrive|cloud\.|drive\.google|docs\.google|dropbox|mega\.nz|wetransfer|nextcloud|owncloud/i.test(m[1])) continue;
    let u; try { u = new URL(decodeEntities(m[1])); } catch (e) { continue; }
    const forma = u.host + u.pathname.replace(/[A-Za-z0-9_%.-]{14,}/g, '…').slice(0, 70) + (u.search ? '?' + u.search.slice(1).split('&').map(x => x.split('=')[0]).join('&').slice(0, 30) : '');
    out.set(forma, (out.get(forma) || 0) + 1);
  }
  return [...out.entries()].slice(0, 6).map(([f, n]) => f + ' ×' + n);
}
// I bollettini 2026/27 usano i codici nuovi delle lingue straniere (DM 255/2023), l'app quelli
// vecchi (AB25 = inglese I grado, AB24 = inglese II grado...). Tabella di corrispondenza ufficiale
// (allegato 1-bis, DM 22/12/2023): AM2x = ex A?25 (I grado), AS2x = ex A?24 (II grado).
const CLASSI_ALIAS = {
  AM2A: 'AA25', AM2B: 'AB25', AM2C: 'AC25', AM2D: 'AD25',
  AS2A: 'AA24', AS2B: 'AB24', AS2C: 'AC24', AS2D: 'AD24', AS2E: 'AE24', AS2F: 'AF24',
  AS2G: 'AG24', AS2H: 'AH24', AS2I: 'AI24', AS2J: 'AJ24', AS2K: 'AK24', AS2L: 'AL24',
};
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
const DOC_NON_BOLLETTINO = /brochure|locandina|vademecum|posti[+_\s-]*restituit|feed-reader|funzionigramma|contatti|organigramma|(^|[\/_+ -])cv[_+ -]|curriculum|informativa|accessibilit|modulo|istanza/i;
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
  // Vicenza: la pagina di ogni turno rimanda all'atto dell'albo (\"Decreto ... e Albo n. ...\"), dove il
  // bollettino è tra gli \"Allegati\" (file in /AllegatiAttiAlboPretorio/). Le pagine dei turni si trovano
  // nella categoria \"Docenti - nomine a tempo determinato\".
  VI: { nome: 'Vicenza', seguiAlbo: true, escludiUrl: /\/category\/|orizzontescuola\.it|avviso-conferimento-incarichi/i, listUrls: [
    'https://vicenza.istruzioneveneto.gov.it/category/docenti-nomine-a-tempo-determinato/',
    'https://vicenza.istruzioneveneto.gov.it/category/docenti-nomine-a-tempo-determinato/page/2/',
    'https://vicenza.istruzioneveneto.gov.it/category/docenti-nomine-a-tempo-determinato/page/3/'] },
  // Ancona: allegati tramite il plugin "download-attachments" (download.php?id=...), senza .pdf nell'indirizzo
  AN: { nome: 'Ancona' },
  // Monza: l'albo pretorio del portale MIM elenca tutti i bollettini; l'8° scorrimento (29/10) indicato a mano
  MB: { nome: 'Monza e Brianza', listUrls: ['https://www.mim.gov.it/web/monza-brianza/albo-pretorio'],
    pagineExtra: ['https://www.mim.gov.it/documents/9081736/0/Bollettino_TotaleNomine+_8%C2%B0+scorrimento.pdf/e0b81692-4f78-c1fe-770c-05f67f777bc5?t=1793280557055'] },
  // Pavia: pagina del 9° turno indicata a mano (gli indirizzi di Orizzonte arrivano solo ai numeri dispari)
  PV: { nome: 'Pavia', listUrls: ['https://www.mim.gov.it/web/pavia/albo-pretorio'], pagineExtra: ['https://www.mim.gov.it/web/pavia/-/pubblicazione-esiti-individuazione-del-personale-docente-di-ogni-ordine-e-grado-ed-educativo-destinatario-di-contratto-a-tempo-determinato-per-l-an-18'] },
  // Province sul portale MIM: l'albo pretorio elenca gli atti con i bollettini allegati (come Monza)
  BG: { nome: 'Bergamo', listUrls: ['https://www.mim.gov.it/web/bergamo/albo-pretorio'] },
  BS: { nome: 'Brescia', listUrls: ['https://www.mim.gov.it/web/brescia/albo-pretorio'] },
  CO: { nome: 'Como', listUrls: ['https://www.mim.gov.it/web/como/albo-pretorio'] },
  CR: { nome: 'Cremona', listUrls: ['https://www.mim.gov.it/web/cremona/albo-pretorio'] },
  LC: { nome: 'Lecco', listUrls: ['https://www.mim.gov.it/web/lecco/albo-pretorio'] },
  LO: { nome: 'Lodi', listUrls: ['https://www.mim.gov.it/web/lodi/albo-pretorio'] },
  MN: { nome: 'Mantova', listUrls: ['https://www.mim.gov.it/web/mantova/albo-pretorio'] },
  MI: { nome: 'Milano', listUrls: ['https://www.mim.gov.it/web/milano/albo-pretorio'] },
  SO: { nome: 'Sondrio', listUrls: ['https://www.mim.gov.it/web/sondrio/albo-pretorio'] },
  VA: { nome: 'Varese', listUrls: ['https://www.mim.gov.it/web/varese/albo-pretorio'] },
  CB: { nome: 'Campobasso', listUrls: ['https://www.mim.gov.it/web/campobasso/albo-pretorio'] },
  IS: { nome: 'Isernia', listUrls: ['https://www.mim.gov.it/web/isernia/albo-pretorio'] },
  // Belluno: il turno 8 (28/10) non era tra i link di Orizzonte; le pagine dei turni stanno nelle notizie "Nomine a tempo determinato"
  BL: { nome: 'Belluno', escludiUrl: /\/category\/|orizzontescuola\.it/i, listUrls: [
    'https://belluno.istruzioneveneto.gov.it/category/news/area-amministrativa/nomine/',
    'https://belluno.istruzioneveneto.gov.it/category/news/area-amministrativa/nomine/page/2/'] },
  // Venezia pubblica i bollettini nell'albo pretorio (atti "Nomine a tempo determinato"): pagina di
  // dettaglio con decreto firmato e allegato "BOLLETTINO N° TURNO.pdf". Le pagine dei turni non hanno allegati.
  VE: { nome: 'Venezia', senzaAggregatore: true, albo: {
    liste: ['https://venezia.istruzioneveneto.gov.it/albo-pretorio-in-corso/', 'https://venezia.istruzioneveneto.gov.it/albo-pretorio-scaduti/'],
    anno: 2026, maxPagine: 14 } },
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
    else if (/sharepoint\.com|1drv\.ms|onedrive\.live\.com|cloud\.pubblica\.istruzione\.it|drive\.google\.com\/file\/d\//i.test(href) && !/\/(SitePages|_layouts|_catalogs|_forms)\b|\.aspx(?:[?#]|$)|login|signin|logout/i.test(href)) add(href, m[2], 'auto');
    else if (/\.xlsx(?:[/?#]|$)/i.test(href)) add(href, m[2], 'xlsx');
    else if (/\.zip(?:[/?#]|$)/i.test(href)) add(href, m[2], 'zip');
    else if (/\.pdf(?:[/?#]|$)/i.test(href) || /[?&]download=\d+/i.test(href) || /download-attachments\/includes\/download\.php\?id=\d+/i.test(href)) add(href, m[2], 'pdf');
  }
  const reP = /(?:src|data)=["']([^"']+?\.pdf)(?:[?#][^"']*)?["']/gi;
  while ((m = reP.exec(html))) add(m[1], '', 'pdf');
  const reS = /https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+[^\s"'<>)]*/gi;
  while ((m = reS.exec(html))) add(m[0], '', 'sheet');
  const nameOf = d => { let u = d.href; try { u = decodeURIComponent(u); } catch (e) {} return u.replace(/^.*\//, '').replace(/\?.*$/, '') + ' ' + d.text; };
  const bad = d => /dispon|dipon|decret|rettific|avviso|sedi|posti/i.test(nameOf(d));
  const decree = d => /(^|\s)m_pi[.\s]|registro.?ufficiale|^disp[._-]/i.test(nameOf(d));
  const strong = d => d.kind === 'sheet' || d.kind === 'xlsx' || /bollettin|totale.?nomin|allegat/i.test(nameOf(d));
  const weak = d => /nomin|turno/i.test(nameOf(d));
  // 0 = bollettino vero, 1 = sembra un bollettino, 2 = altro, 3 = disponibilità/decreti
  const score = d => bad(d) ? 3 : (strong(d) && !decree(d) ? 0 : (weak(d) && !decree(d) ? 1 : (decree(d) ? 3 : 2)));
  return out.sort((a, b) => score(a) - score(b) || a.i - b.i);
}
// Riconosce il numero del turno scritto in cifre ("2° turno"), in numeri
// romani ("I turno", "IV turno") o in parole ("primo turno", "quarto turno").
const ROMANI = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20 };
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
  // \"Turno di nomina n. 10\", \"Bollettino n. 8\" anche con l'errore \"Bolletino\" e nei titoli scritti con i trattini degli indirizzi
  m = /turno[-\s]+di[-\s]+nomina[-\s]+(?:n\.?|numero)?[-\s]*(\d{1,2})(?!\d)(?![-./]\d{1,2}[-./](?:20)?\d{2})/i.exec(text);
  if (m) return parseInt(m[1], 10);
  m = /boll?ett?in[oi][-\s]+(?:n\.?|numero|n°)?[-\s]*(\d{1,2})(?![\d/]|[-\s]*(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre))(?![-./]\d{1,2}[-./](?:20)?\d{2})/i.exec(text);
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
// Data scritta all'inizio del nome dell'allegato come AAAAMMGGhhmm (es. Ancona: "202610261224 ... XIII BOLLETTINO")
function guessDateFromStamp(text) {
  const m = /(?<!\d)(20\d{2})(\d{2})(\d{2})([01]\d|2[0-3])([0-5]\d)(?!\d)/.exec(text || '');
  if (!m) return null;
  const mo = +m[2], d = +m[3];
  return (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) ? `${m[1]}-${m[2]}-${m[3]}` : null;
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
function isDirectDoc(url) { return !!piattaformaMap[url] || /\.(?:pdf|xlsx)(?:[?#]|$)/i.test(url) || /mim\.gov\.it\/documents\//i.test(url); }
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
  // Albo pretorio (Venezia): atti di nomine con decreto e bollettino allegati
  if (cfg.albo) {
    try {
      const atti = await scopriAlbo(cfg.albo);
      console.log('albo pretorio:', atti.length, 'atti di nomine a tempo determinato del', cfg.albo.anno);
      atti.slice(0, 40).forEach(a => { alboLabel[a.url] = a.oggetto; candidates.push({ url: a.url, fromAggregator: false }); });
    } catch (e) { console.warn('albo pretorio non raggiungibile:', e.message); }
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
  (cfg.pagineExtra || []).forEach(url => candidates.push({ url, fromAggregator: false }));  // pagine o PDF indicati a mano
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
  const morti = []; // indirizzi inesistenti (404) di turni numerati: si decide a fine provincia se il turno è stato letto da altre pagine
  const unreadInfo = []; // per il log: quale documento ha prodotto ogni data non leggibile
  const unreadPush = (src, d) => { unreadDates.push(d); unreadInfo.push(d + '  ' + String(src).slice(-95)); };
  const turniVisti = new Set(); // numeri di turno trovati sul sito (letti o no)
  let letti = 0, nonLetti = 0, errs = 0;
  for (const postUrl of posts) {
    let kind = 'turno';
    try {
      // riepiloghi (es. "Specchietto riassuntivo" di Roma): non sono bollettini
      { let u0 = postUrl; try { u0 = decodeURIComponent(postUrl); } catch (e) {}
        if (/specchietto|riassuntiv/i.test(u0 + ' ' + (labelByUrl[postUrl] || ''))) { console.log('  riepilogo (specchietto), non è un bollettino: ignoro', postUrl.slice(-70)); continue; } }
      // pagine di elenco o articoli aggregatori raccolti per errore (menu del sito, Orizzonte Scuola): non sono bollettini
      if ((cfg.escludiUrl || /\/category\/|orizzontescuola\.it/i).test(postUrl)) { console.log('  pagina di elenco o avviso, non è un bollettino: ignoro', postUrl.slice(-70)); continue; }
      const direct = isDirectDoc(postUrl);
      let postHtml = direct ? '' : await fetchText(postUrl);
      if (!direct && cfg.seguiAlbo) {
        // la pagina del turno rimanda all'atto dell'albo: il bollettino è allegato lì
        const ma = /href=["']([^"']*action=visatto[^"']*)["']/i.exec(postHtml);
        if (ma) {
          try {
            const aUrl = new URL(decodeEntities(ma[1]), postUrl).href;
            const aHtml = await fetchText(aUrl);
            alboLabel[postUrl] = guessTitle(postHtml);   // titolo della pagina del turno (ha il numero)
            console.log('  seguo l\'atto dell\'albo:', aUrl.slice(-70));
            postHtml = aHtml;
          } catch (e) { console.log('  atto dell\'albo non letto:', e.message); }
        }
      }
      const title = direct ? ((labelByUrl[postUrl] || '').trim() || 'Bollettino nomine') : (alboLabel[postUrl] || guessTitle(postHtml));
      // per il numero del turno mi fido per primo dell'etichetta di Orizzonte
      // Scuola (di solito è la più chiara), poi del titolo della pagina, poi
      // dell'indirizzo.
      const turno = guessTurno(labelByUrl[postUrl]) ?? guessTurno(title) ?? guessTurno(postUrl);
      const mimDate = guessDateFromMimTimestamp(postUrl);
      const dataCerta = (alboLabel[postUrl] ? guessDateFromAlbo(postHtml) : null) || guessDateFromUrl(postUrl) || (direct ? null : guessDateFromHtml(postHtml)) || mimDate || (direct ? guessDateFromName(postUrl) : null);
      let data = dataCerta || new Date().toISOString().slice(0, 10);
      if (mimDate && data === mimDate) console.log('  data ricavata dal caricamento del file:', mimDate);
      if (data < SEASON_START) { console.log('  anno scolastico precedente, salto:', postUrl); continue; }
      const txt = (labelByUrl[postUrl] || '') + ' ' + title + ' ' + (() => { try { return decodeURIComponent(postUrl); } catch (e) { return postUrl; } })();
      // pagina di un altro anno scolastico (es. "a-s-2025-2026-decimo-bollettino" nell'albo): non conta
      if (/(?<!\d)(?:2024[-_/]?2025|2025[-_/]?2026|2024[-_/]25|2025[-_/]26)(?!\d)|a-?s-?(?:24-25|25-26)(?!\d)/i.test(txt) && !/(?<!\d)(?:2026[-_/]?2027|2026[-_/]27|26-27)(?!\d)/i.test(txt)) { console.log('  pagina di un altro anno scolastico, salto:', postUrl.slice(-80)); continue; }
      // solo i bollettini di turno servono per i punteggi: rettifiche, nomine
      // finalizzate al ruolo, conferme di sostegno e semplici disponibilità no
      const txtR = txt.replace(/rettific\w*[\s-]+((dei|ai|di)[\s-]+)?posti[\s-]*orario/gi, ' ');
      if (/rettific|annull|errata/i.test(txtR)) kind = 'rett';
      else if (/finalizzat|al-ruolo|al ruolo|continuit|conferm|posti orario|posti-orario|deroga/i.test(txtR)) kind = 'altro';
      else if (/dispon/i.test(txtR) && !/esiti|bollettin/i.test(txtR)) kind = 'altro';
      else if (/mobilit|interpell|residuat|posti[\s-]+vacanti/i.test(txtR) || (/\bata\b|collaboratori[\s-]+scolastici|assistenti[\s-]+(amministrativ|tecnic)/i.test(txtR) && !/docent/i.test(txtR))) kind = 'altro';  // mobilità, interpelli e personale ATA: non sono bollettini GPS dei docenti
      let id = code + '-' + (turno ?? data);
      let docList = direct
        ? [{ href: postUrl, url: postUrl, text: '', kind: /\.xlsx(?:[?#]|$)/i.test(postUrl) ? 'xlsx' : 'pdf', i: 0 }]
        : findDocLinks(postHtml).map(d => ({ ...d, url: /^https?:/i.test(d.href) ? d.href : new URL(d.href, postUrl).href }));
      if (!direct && !docList.length && kind === 'turno' && /mim\.gov\.it\/web\/.+-\d+\/?$/.test(postUrl)) {
        // prova: alcune pagine duplicate ("...-1") non hanno gli allegati, l'originale sì
        // Pavia: le pagine con numero pari (…-18) hanno gli allegati, quelle con il numero dispari che arriva da Orizzonte (…-19) no
        const nSuf = +/-(\d+)\/?$/.exec(postUrl)[1];
        const alts = [];
        if (nSuf > 1) alts.push(postUrl.replace(/-\d+(\/?)$/, '-' + (nSuf - 1) + '$1'));
        alts.push(postUrl.replace(/-\d+\/?$/, ''));
        for (const alt of alts) {
          try {
            const h2 = await fetchText(alt);
            const d2 = findDocLinks(h2).map(d => ({ ...d, url: /^https?:/i.test(d.href) ? d.href : new URL(d.href, alt).href }));
            console.log('  prova con indirizzo alternativo:', alt.slice(-80), '->', d2.length, 'allegati');
            if (d2.length) { docList = d2; break; }
          } catch (e) { console.log('  prova con indirizzo alternativo non riuscita:', e.message); }
        }
      }
      if (!direct && !docList.length && kind === 'turno' && /mim\.gov\.it\/web\//.test(postUrl)) {
        // ultima prova: gli allegati potrebbero essere caricati dal JavaScript della pagina
        try {
          const hb = await htmlConBrowser(postUrl);
          const db = findDocLinks(hb).map(d => ({ ...d, url: /^https?:/i.test(d.href) ? d.href : new URL(d.href, postUrl).href }));
          console.log('  prova con il browser:', db.length, 'allegati');
          if (db.length) { docList = db; }
          else {
            // diagnosi (solo struttura, niente nomi di persone): cosa c'è davvero nella pagina?
            const hr = [...hb.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].map(m => decodeEntities(m[1]));
            const util = hr.filter(h => /\/documents\/|download|allegat|\.(pdf|xlsx?|csv|zip)(?:[/?#]|$)|drive\.google|sharepoint|dropbox/i.test(h));
            console.log('     diagnosi pagina: ' + hr.length + ' link totali, ' + util.length + ' verso documenti/allegati');
            util.slice(0, 8).forEach(h => console.log('       - ' + h.slice(0, 150)));
            const tx = testoPulito(hb);
            // altri punti dove può stare il documento: riquadri incorporati e link ad atti/albo
            const emb = [...hb.matchAll(/<(?:iframe|embed|object)\b[^>]*(?:src|data)=["']([^"']+)["']/gi)].map(m => decodeEntities(m[1])).filter(u => !/googletagmanager|youtube|facebook|twitter/i.test(u));
            console.log('     riquadri incorporati: ' + emb.length); emb.slice(0, 5).forEach(u => console.log('       ~ ' + u.slice(0, 150)));
            const post = [...hb.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi)].map(m => [decodeEntities(m[1]), testoPulito(m[2])])
              .filter(([h, t]) => /\/web\/[^/]+\/-\//.test(h) && /scorriment|bollettin|turno|individuazion|esit|nomin|algoritm/i.test(h + ' ' + t));
            const uniq = [...new Map(post.map(x => [x[0], x])).values()];
            console.log('     link a possibili pagine dei turni: ' + uniq.length); uniq.slice(0, 14).forEach(([h, t]) => console.log('       > ' + h.replace(/^https?:\/\/www\.mim\.gov\.it/, '').slice(0, 130) + ' | ' + t.slice(0, 50)));
            const att = [...hb.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)].map(m => [decodeEntities(m[1]), testoPulito(m[2])]).filter(([h, t]) => /\batto\b|albo|pubblicit|bacheca|apri|visualizza|scarica/i.test(h + ' ' + t) && !/^#|javascript:/i.test(h));
            console.log('     link ad atti/albo/scarica: ' + att.length); att.slice(0, 6).forEach(([h, t]) => console.log('       @ ' + h.slice(0, 120) + ' | ' + t.slice(0, 40)));
            // Lombardia (portale MIM): la pagina rimanda alla pubblicazione vera ("Pubblicazione Albo n. ...", "Pubblicato atto n. ...") dove stanno gli allegati
            const segui = [];
            for (const m of hb.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi)) {
              const t = testoPulito(m[2]); if (!/\balbo\s*n|\batto\s*n|pubblicazione albo|pubblicato atto/i.test(t)) continue;
              let h; try { h = new URL(decodeEntities(m[1]), postUrl).href; } catch (e) { continue; }
              if (/#/.test(h)) h = h.replace(/#.*/, '');
              if (!/mim\.gov\.it\/web\//.test(h) || h === postUrl || /comunicazioni\?p_p_id/.test(h) || segui.some(x => x[0] === h)) continue;
              segui.push([h, t]);
            }
            for (const [h, t] of segui.slice(0, 3)) {
              try {
                const h2 = await htmlConBrowser(h);
                const d2 = findDocLinks(h2).map(d => ({ ...d, url: /^https?:/i.test(d.href) ? d.href : new URL(d.href, h).href }));
                console.log('     seguo "' + t.slice(0, 45) + '" -> ' + d2.length + ' allegati (' + h.slice(-70) + ')');
                d2.slice(0, 6).forEach(d => console.log('       + ' + d.url.slice(-100) + ' | ' + (d.text || '').slice(0, 40)));
                if (d2.length) { docList = d2; postHtml = h2; break; }
              } catch (e) { console.log('     seguo "' + t.slice(0, 45) + '" non riuscito: ' + e.message); }
            }
            console.log('     blocco anti-robot nel testo: ' + /captcha|request unsuccessful|incapsula|access denied|verifica/i.test(tx.slice(0, 4000)));
            let n = 0; for (const mm of tx.matchAll(/.{0,60}(bollettin|allegat|scarica|elenco dei destinatari|esiti?).{0,80}/gi)) { if (n++ >= 4) break; console.log('     testo: ' + mm[0].replace(/\s+/g, ' ').slice(0, 150)); }
          }
        } catch (e) { console.log('  prova con il browser non riuscita:', String(e.message).slice(0, 80)); }
      }
      if (!direct) {
        const prima = docList.length;
        for (let i = docList.length - 1; i >= 0; i--) {
          let nm = docList[i].url; try { nm = decodeURIComponent(nm); } catch (e) {}
          if (DOC_NON_BOLLETTINO.test(nm.replace(/\?.*$/, '').replace(/^https?:\/\/[^/]+/, '') + ' ' + (docList[i].text || ''))) docList.splice(i, 1);
        }
        if (cfg.seguiAlbo && alboLabel[postUrl]) docList = docList.filter(d => /\/AllegatiAttiAlboPretorio\//i.test(d.url));
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
        if (!docList.length && kind === 'turno' && decretiScartati) {
          console.log('  la pagina ha solo decreti: ignoro', postUrl.slice(-80));
          // cosa c'è accanto ai decreti? elenco (solo indirizzi) di fogli, Drive, archivi e pagine collegate
          const link = []; const reL = /href=["']([^"']+)["']/gi; let ml;
          while ((ml = reL.exec(postHtml || '')) && link.length < 14) {
            const h = decodeEntities(ml[1]);
            if (/drive\.google|docs\.google|\.xlsx?(?:[?#\/]|$)|\.zip|\.csv|\.ods|download|bollettin|esiti|nomin|elenc|allegat/i.test(h) && !/\.pdf(?:[?#\/]|$)/i.test(h)) link.push(h.slice(-110));
          }
          link.forEach(h => console.log('     ~', h));
          formaCollegamenti(postHtml).forEach(f => console.log('     collegamento di condivisione (forma):', f));
          if (report.pagineSoloDecreti.filter(x => x.provincia === code).length < 3) report.pagineSoloDecreti.push({ provincia: code, turno, data, url: postUrl, altriLink: link });
          continue;
        }
        // nessun allegato riconoscibile: stampo i collegamenti a documenti della pagina, per capire com'è fatta
        if (!docList.length && kind === 'turno') {
          const hrefs = []; const reH = /href=["']([^"']*(?:\/documents\/|download|get_file|\.pdf|\.zip|\.xlsx?)[^"']*)["']/gi; let mh;
          while ((mh = reH.exec(postHtml)) && hrefs.length < 12) hrefs.push(decodeEntities(mh[1]).slice(-110));
          console.log('  pagina senza allegato riconoscibile (' + postHtml.length + ' caratteri); collegamenti a documenti:', hrefs.length ? '' : 'nessuno');
          hrefs.forEach(h => console.log('     ~', h));
          // siti esterni e contenuti incorporati: i bollettini potrebbero stare altrove (Drive, fogli, iframe)
          try {
            const host0 = new URL(postUrl).host, hosts = new Map(); let mh2; const reAll = /(?:href|src)=["'](https?:\/\/[^"'\s]+)["']/gi;
            while ((mh2 = reAll.exec(postHtml || ''))) { try { const h = new URL(decodeEntities(mh2[1])).host; if (h !== host0 && !/^(www\.)?(facebook|twitter|instagram|youtube|google-analytics|googletagmanager|fonts\.g|cdn|gstatic|w3\.org|schema\.org)/i.test(h)) hosts.set(h, (hosts.get(h) || 0) + 1); } catch (e) {} }
            const ifr = []; const reIf = /<(?:iframe|embed|object)\b[^>]*\b(?:src|data)=["']([^"']+)["']/gi; let mi;
            while ((mi = reIf.exec(postHtml || '')) && ifr.length < 4) ifr.push(decodeEntities(mi[1]).slice(0, 100));
            console.log('     siti esterni nella pagina:', [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h, n]) => h + '(' + n + ')').join(', ') || 'nessuno');
            ifr.forEach(x => console.log('     incorporato:', x));
            formaCollegamenti(postHtml).forEach(f => console.log('     collegamento di condivisione (forma):', f));
            // forma dei collegamenti di condivisione presenti (solo host e percorso, senza parametri)
            const cond = []; const reC = /href=["'](https?:\/\/[^"'\s]*(?:sharepoint\.com|cloud\.pubblica|drive\.google|onedrive|dropbox|wetransfer|we\.tl)[^"'\s]*)["']/gi; let mc;
            while ((mc = reC.exec(postHtml || '')) && cond.length < 4) { try { const u = new URL(decodeEntities(mc[1])); cond.push((u.host + u.pathname).slice(0, 110)); } catch (e) {} }
            cond.forEach(x => console.log('     condivisione:', x));
          } catch (e) {}
        }
      }
      if (!docList.length && kind === 'turno' && !SEMBRA_BOLLETTINO.test(txt)) { console.log('  non sembra un bollettino, ignoro:', postUrl); continue; }
      if (!docList.length) { console.log('  nessun PDF o foglio trovato in', postUrl); if (kind === 'turno') { if (turno != null) turniVisti.add(turno); if (manDates.has(data)) letti++; else { nonLetti++; unreadPush(postUrl, data); report.nonLetti.push({ provincia: code, turno, data, url: postUrl, nota: 'nessun PDF o foglio trovato nella pagina' }); } } continue; }
      // provo i documenti della pagina (al massimo 5) finché uno contiene righe GPS
      let pdfUrl = null, calibrated = false, nomine = 0, skippedN = 0, agg = {}, ocrRes = null, strRes = null, lastMod = null, pdfDateRes = null, fasceRes = null, classiRes = null, totRes = null;
      let giaVisti = 0;
      for (const cand of docList.slice(0, 5)) {
        if (seenPdf.has(cand.url)) { giaVisti++; console.log('  stesso documento già trovato in questo giro, salto:', cand.url); continue; }
        console.log('  scarico', cand.url);
        try {
          let res;
          if (cand.kind === 'sheet') {
            // i fogli Google possono cambiare: nessuna memoria
            const sm = /spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(cand.url), gm = /[?#&]gid=(\d+)/.exec(cand.url);
            const csvUrl = 'https://docs.google.com/spreadsheets/d/' + sm[1] + '/export?format=csv' + (gm ? '&gid=' + gm[1] : '');
            res = parseCsvBulletin(await fetchText(csvUrl));
            res.nomine = res.rows.filter(r => r.tipo === 'GPS').length; res.skippedN = res.skipped.length; res.agg = aggregate(res.rows); res.fasce = diagnosiFasce(res.rows); res.classi = riepilogoClassi(res.rows); res.tot = res.rows.length;
          } else if (cand.kind === 'auto') {
            // collegamento di condivisione: ricavo l'indirizzo di scaricamento e riconosco il tipo dal contenuto
            const cu = cand.url; let dl = cu;
            if (/sharepoint\.com/i.test(cu)) dl = /[?&]download=1/.test(cu) ? cu : cu + (cu.includes('?') ? '&' : '?') + 'download=1';
            else if (/cloud\.pubblica\.istruzione\.it/i.test(cu)) {
              const tk = /\/s\/([A-Za-z0-9]+)/.exec(cu) || /[?&]t=([A-Za-z0-9]+)/.exec(cu);
              dl = /\/s\/[A-Za-z0-9]+/.test(cu) ? cu.replace(/[?#].*$/, '').replace(/\/+(download)?$/, '') + '/download' : (tk ? new URL(cu).origin + '/public.php?service=files&t=' + tk[1] + '&download' : cu);
            }
            else { const gm = /\/file\/d\/([\w-]+)/.exec(cu); if (gm) dl = 'https://drive.google.com/uc?export=download&id=' + gm[1]; }
            const c = cache[cand.url];
            cacheVisti.add(cand.url);
            if (c && (c.ok || Date.now() - c.t < NON_LETTI_RIPROVA_MS) && (c.nomine > 0 || c.tot !== undefined)) {
              console.log('    dalla memoria:', c.ok ? 'letto' : 'non letto', '(righe GPS=' + c.nomine + ')');
              res = { calibrated: c.calibrated, nomine: c.nomine, skippedN: c.skippedN, agg: c.agg, fasce: c.fasce || null, classi: c.classi || null, tot: c.tot == null ? null : c.tot, ocr: null, struttura: null, lm: c.lm || null, pdfDate: c.pdfDate || null };
            } else {
              const fr = await getWithFallback(dl);
              const buf = Buffer.from(await fr.arrayBuffer());
              res = await leggiAuto(buf, console.log);
              console.log('    collegamento di condivisione (' + new URL(cu).host + new URL(cu).pathname.slice(0, 60) + '): tipo ' + res.tipo + ', ' + buf.length + ' byte, righe lette=' + res.rows.length);
              const lmH = fr.headers && fr.headers.get ? fr.headers.get('last-modified') : null;
              res.nomine = res.rows.filter(r => r.tipo === 'GPS').length; res.skippedN = res.skipped.length; res.agg = aggregate(res.rows); res.fasce = diagnosiFasce(res.rows); res.classi = riepilogoClassi(res.rows); res.tot = res.rows.length;
              res.lm = lmH && !isNaN(new Date(lmH)) ? new Date(lmH).toISOString().slice(0, 10) : null;
              res.pdfDate = res.data || null; res.ocr = null; res.struttura = null;
              cache[cand.url] = { t: Date.now(), ok: !!(res.calibrated && res.skippedN === 0 && res.nomine > 0), calibrated: res.calibrated, nomine: res.nomine, skippedN: res.skippedN, agg: res.agg, fasce: res.fasce, classi: res.classi, tot: res.tot, ocr: null, struttura: null, lm: res.lm, pdfDate: res.pdfDate };
            }
          } else if (cand.kind === 'xlsx' || cand.kind === 'zip') {
            // Excel o archivio zip: stessa memoria dei PDF
            let nz = cand.url; try { nz = decodeURIComponent(cand.url); } catch (e) {}
            if (cand.kind === 'zip' && !/2026/.test(nz)) { console.log('    zip di un altro anno scolastico, salto:', nz.slice(-70)); continue; }
            const c = cache[cand.url];
            cacheVisti.add(cand.url);
            if (c && (c.ok || Date.now() - c.t < NON_LETTI_RIPROVA_MS) && (c.nomine > 0 || c.tot !== undefined)) {
              console.log('    dalla memoria:', c.ok ? 'letto' : 'non letto', '(righe GPS=' + c.nomine + ')');
              res = { calibrated: c.calibrated, nomine: c.nomine, skippedN: c.skippedN, agg: c.agg, fasce: c.fasce || null, classi: c.classi || null, tot: c.tot == null ? null : c.tot, ocr: null, struttura: null, lm: c.lm || null, pdfDate: c.pdfDate || null };
            } else {
              const fr = await getWithFallback(cand.url);
              const buf = Buffer.from(await fr.arrayBuffer());
              const lmH = fr.headers && fr.headers.get ? fr.headers.get('last-modified') : null;
              res = cand.kind === 'xlsx' ? await righeDaExcel(buf) : await righeDaZip(buf, console.log);
              res.nomine = res.rows.filter(r => r.tipo === 'GPS').length; res.skippedN = res.skipped.length; res.agg = aggregate(res.rows); res.fasce = diagnosiFasce(res.rows); res.classi = riepilogoClassi(res.rows); res.tot = res.rows.length;
              res.lm = lmH && !isNaN(new Date(lmH)) ? new Date(lmH).toISOString().slice(0, 10) : null;
              res.pdfDate = cand.kind === 'xlsx' ? await dataDaXlsx(buf) : (res.data || null);
              res.ocr = null; res.struttura = null;
              cache[cand.url] = { t: Date.now(), ok: !!(res.calibrated && res.skippedN === 0 && res.nomine > 0), calibrated: res.calibrated, nomine: res.nomine, skippedN: res.skippedN, agg: res.agg, fasce: res.fasce, classi: res.classi, tot: res.tot, ocr: null, struttura: null, lm: res.lm, pdfDate: res.pdfDate };
            }
          } else if (cand.kind === 'html') {
            res = { ...htmlTabs[cand.url], ocr: null, struttura: null, lm: null, pdfDate: null };
            res.nomine = res.rows.filter(r => r.tipo === 'GPS').length; res.skippedN = res.skipped.length; res.agg = aggregate(res.rows); res.fasce = diagnosiFasce(res.rows); res.classi = riepilogoClassi(res.rows); res.tot = res.rows.length;
          } else if (piattaformaMap[cand.url]) {
            // turno letto dalla piattaforma: nessuna memoria (la pagina può cambiare)
            res = await leggiTurnoBenevento(piattaformaMap[cand.url], cfg.proxyFallback ? fetchBn : fetchText);
            res.nomine = res.rows.filter(r => r.tipo === 'GPS').length; res.skippedN = res.skipped.length; res.agg = aggregate(res.rows); res.fasce = diagnosiFasce(res.rows); res.classi = riepilogoClassi(res.rows); res.tot = res.rows.length;
            res.lm = res.dataIso || null; res.ocr = null; res.struttura = null;
          } else {
            const c = cache[cand.url];
            cacheVisti.add(cand.url);
            if (c && (c.ok || Date.now() - c.t < NON_LETTI_RIPROVA_MS) && (c.nomine > 0 || c.tot !== undefined) && !(c.fasce && c.fasce.senza > 0 && !c.struttura)) {
              console.log('    dalla memoria:', c.ok ? 'letto' : 'non letto', '(righe GPS=' + c.nomine + ')');
              res = { calibrated: c.calibrated, nomine: c.nomine, skippedN: c.skippedN, agg: c.agg, fasce: c.fasce || null, classi: c.classi || null, tot: c.tot == null ? null : c.tot, ocr: c.ocr || null, struttura: c.struttura || null, lm: c.lm || null, pdfDate: c.pdfDate || null };
            } else {
              const fr = await getWithFallback(cand.url);
              const buf = Buffer.from(await fr.arrayBuffer());
              const lmH = fr.headers && fr.headers.get ? fr.headers.get('last-modified') : null;
              res = await parseBulletin(buf);
              res.lm = lmH && !isNaN(new Date(lmH)) ? new Date(lmH).toISOString().slice(0, 10) : null;
              res.pdfDate = await dataCreazionePdf(buf);
              res.nomine = res.rows.filter(r => r.tipo === 'GPS').length; res.skippedN = res.skipped.length; res.agg = aggregate(res.rows); res.fasce = diagnosiFasce(res.rows); res.classi = riepilogoClassi(res.rows); res.tot = res.rows.length;
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
              } else if (res.fasce && res.fasce.senza > 0) {
                // righe GPS con fascia non riconosciuta: tengo un campione mascherato del formato
                try { res.struttura = await strutturaPdf(buf, res.fasce.pagSenza || 1); } catch (e) { console.warn('    struttura non estratta:', e.message); }
              }
              cache[cand.url] = { t: Date.now(), ok: !!(res.calibrated && res.skippedN === 0 && res.nomine > 0), calibrated: res.calibrated, nomine: res.nomine, skippedN: res.skippedN, agg: res.agg, fasce: res.fasce, classi: res.classi, tot: res.tot, ocr: res.ocr, struttura: res.struttura, lm: res.lm, pdfDate: res.pdfDate };
            }
          }
          const prendi = () => { pdfUrl = cand.url; calibrated = res.calibrated; nomine = res.nomine; skippedN = res.skippedN; agg = res.agg; fasceRes = res.fasce || null; classiRes = res.classi || null; totRes = res.tot == null ? null : res.tot; lastMod = res.lm || null; pdfDateRes = res.pdfDate || null; };
          if (!pdfUrl) { prendi(); ocrRes = res.ocr || null; strRes = res.struttura || null; }
          if (res.nomine > 0) { prendi(); ocrRes = null; strRes = (res.fasce && res.fasce.senza > 0) ? (res.struttura || null) : null; break; }
          if (res.ocr && res.ocr.righe.length) { prendi(); ocrRes = res.ocr; strRes = res.struttura || null; }
        } catch (e) { console.warn('    documento non leggibile:', cand.url, e.message); }
      }
      // la stessa pubblicazione raggiunta da due pagine (elenco dell'albo e pagina del turno): i documenti li ho già letti, la pagina non va contata come non leggibile
      if (!pdfUrl && giaVisti > 0 && giaVisti === Math.min(docList.length, 5)) { console.log('  tutti i documenti di questa pagina sono già stati letti in questo giro: non la conto tra i non leggibili:', postUrl.slice(-70)); continue; }
      if (!pdfUrl) { console.log('  nessun PDF utilizzabile in', postUrl); if (kind === 'turno') { if (turno != null) turniVisti.add(turno); if (manDates.has(data)) letti++; else { nonLetti++; unreadPush(postUrl, data); report.nonLetti.push({ provincia: code, turno, data, url: postUrl, nota: 'documento non leggibile' }); } } continue; }
      // documento di testo (decreto, lettera) senza tabelle: non è un bollettino
      if (kind === 'turno' && !calibrated && nomine === 0 && strRes && strRes.tipoDocumento === 'decreto' && !(ocrRes && ocrRes.righe.length)) {
        console.log('  documento di tipo decreto, non è un bollettino: ignoro', (pdfUrl || '').slice(-70));
        report.decretiIgnorati.push({ provincia: code, turno, data, url: pdfUrl, pagine: strRes.pagine }); continue;
      }
      // pagina senza data (portale del Ministero): la data del bollettino è quella di
      // caricamento dell'allegato scelto, non quella di oggi
      if (!dataCerta) {
        const dMim = guessDateFromMimTimestamp(pdfUrl);
        const dStamp = guessDateFromStamp((docList.find(d => d.url === pdfUrl) || {}).text);
        if (dStamp) console.log('  data ricavata dal nome dell\'allegato:', dStamp);
        const d2 = dMim || dStamp || guessDateFromName(pdfUrl) || lastMod || pdfDateRes;
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
      // 0 righe GPS con altre righe riconosciute (es. solo GUI/GAE) = bollettino letto, senza nomine GPS; 0 righe in tutto = non letto
      const soloAltreRighe = nomine === 0 && totRes != null && totRes > 0 && calibrated && skippedN === 0;
      const dubbio = (!calibrated || skippedN > 0 || (nomine === 0 && !soloAltreRighe)) && !manDates.has(data);
      if (soloAltreRighe && kind === 'turno') console.log('    nessuna riga GPS, ma ' + totRes + ' righe di altri tipi (GUI/GAE): bollettino letto, senza nomine GPS'); // coperto dal file manuale = non dubbio
      prov.bollettini.push({ id, turno, data, titolo: title, nomine, url: postUrl, pdfUrl, dubbio });
      if (kind === 'turno' && fasceRes) {
        console.log('    fasce GPS: F1=' + fasceRes.F1 + ' F2=' + fasceRes.F2 + (fasceRes.senza ? ' NON RICONOSCIUTA=' + fasceRes.senza + ' valori: ' + JSON.stringify(fasceRes.valori || {}) : ''));
        if (classiRes) console.log('    classi GPS (classe:fascia=righe): ' + classiRes);
        if (fasceRes.senza > 0 && strRes && strutture.length < 110 && strutture.filter(x => x.provincia === code).length < 2) strutture.push({ provincia: code, turno, data, url: pdfUrl, motivo: 'fascia non riconosciuta', struttura: strRes });
        if (fasceRes.senza > 0) report.fasciaNonRiconosciuta.push({ provincia: code, turno, data, url: pdfUrl, righeSenzaFascia: fasceRes.senza, righeConFascia: fasceRes.F1 + fasceRes.F2, valori: fasceRes.valori || {} });
      }
      if (kind === 'turno' && turno != null) turniVisti.add(turno);
      if (kind === 'turno' && dubbio) {
        const base = { provincia: code, turno, data, url: pdfUrl };
        if (ocrRes && ocrRes.righe.length) report.ocr.push({ ...base, pagineOcr: ocrRes.pagineOcr, righeIllegibili: ocrRes.illeggibili.length, righe: ocrRes.righe.map(r => ({ classe: r.code, fascia: r.fascia, posizione: r.pos, punteggio: r.pts, riga: r.riga })) });
        else if (nomine === 0 && calibrated && skippedN === 0) report.zeroRighe.push({ ...base, nota: 'nessuna riga GPS: se quel giorno non ci sono state nomine GPS, confermalo nel file manuale con soglie vuote' });
        else report.nonLetti.push({ ...base, nota: !calibrated ? 'formato non riconosciuto' : 'righe GPS non leggibili: ' + skippedN });
        if (strRes && !(ocrRes && ocrRes.righe.length) && strutture.length < 100 && strutture.filter(x => x.provincia === code).length < 2) strutture.push({ ...base, struttura: strRes });
      }
      if (kind === 'turno') {
        if (dubbio) { nonLetti++; unreadPush(pdfUrl || postUrl, data); } else letti++;
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
      if (kind === 'turno' && /turno|fase|bollettin|nomin/i.test((labelByUrl[postUrl] || '') + postUrl)) {
        let tx = (labelByUrl[postUrl] || '') + ' ' + postUrl; try { tx = decodeURIComponent(tx); } catch (e2) {}
        const tErr = guessTurno(tx);
        if (/HTTP (404|410)\b/.test(e.message) && tErr != null) morti.push({ turno: tErr, src: postUrl });   // link morto di un turno numerato: lo decido a fine provincia
        else { nonLetti++; unreadPush(postUrl + ' (errore, data ignota)', '9999'); } // dopo un errore non so la data: la considero la più recente
      }
    }
  }
  // link morti (404) di un turno numerato: se quel turno è stato letto da un'altra pagina non è un buco, altrimenti resta un bollettino non trovato
  for (const m of morti) {
    if (turniVisti.has(m.turno)) console.log('  indirizzo inesistente (404) del turno', m.turno, 'ma il turno è stato letto da altre pagine: ignoro', m.src.slice(-70));
    else { nonLetti++; unreadPush(m.src + ' (404, turno ' + m.turno + ' mai letto)', '9999'); }
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
  // decreto o nota con numero di protocollo non leggibile, con la stessa data di un bollettino letto: è il documento di accompagnamento, non un bollettino
  for (let i = prov.bollettini.length - 1; i >= 0; i--) {
    const b = prov.bollettini[i];
    if (!b.dubbio || !/REGISTRO[+%\s_-]*UFFICIALE/i.test(b.pdfUrl || '')) continue;
    if (!prov.bollettini.some(x => x !== b && x.data === b.data && !x.dubbio && x.nomine > 0)) continue;
    const k = unreadDates.indexOf(b.data); if (k >= 0) unreadDates.splice(k, 1);
    prov.bollettini.splice(i, 1);
    console.log('  scartato documento di accompagnamento non leggibile del ' + b.data + ': esiste un bollettino letto con la stessa data');
  }
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
      nonLetti++; unreadPush('turno mancante ' + n + ' (prima del ' + dopo + ')', next);
      report.turniMancanti.push({ provincia: code, turno: n, nota: 'bollettino non trovato (si passa dal turno ' + prima + ' al ' + dopo + ')' });
      console.log('  TURNO MANCANTE:', n);
    }
  }
  const completo = nonLetti === 0 && letti > 0;
  if (unreadDates.length) { console.log('  non leggibili che pesano sulle strisce (' + unreadDates.length + '):'); unreadInfo.filter(x => unreadDates.includes(x.split('  ')[0])).slice(0, 12).forEach(x => console.log('     · ' + x)); }
  Object.values(prov.soglie).forEach(byF => Object.values(byF).forEach(e => { e.d = unreadDates.some(d => d > (e.dt || '')); }));
  // stessa soglia anche sotto il codice che usa l'app (se ci sono entrambi, vale la più bassa)
  for (const [nuovo, vecchio] of Object.entries(CLASSI_ALIAS)) {
    if (!prov.soglie[nuovo]) continue;
    prov.soglie[vecchio] = prov.soglie[vecchio] || {};
    for (const [f, e] of Object.entries(prov.soglie[nuovo])) {
      const cur = prov.soglie[vecchio][f];
      if (!cur || e.p < cur.p) prov.soglie[vecchio][f] = { ...e };
    }
  }
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
