// Estrae la STRUTTURA della prima pagina di un bollettino che il lettore non riesce
// a leggere: intestazione e prime righe, con le posizioni dei testi. Serve a capire
// il formato e correggere il lettore, SENZA copiare nel repository (pubblico) i dati
// personali dei candidati.
//
// Regola di sicurezza: nelle righe dei dati restano solo numeri, date, asterischi,
// codici (classe, scuola) e poche parole di servizio (GPS, GUI, F1...). Ogni altra
// parola (nomi, cognomi, scuole, descrizioni) diventa "xxxx". Le intestazioni, che
// sono etichette di colonna, restano intere.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_RIGHE_DATI = 5;
const MAX_RIGHE_TOTALI = 40;
const ROW_TOL = 2; // punti: voci con y vicina stanno nella stessa riga

const CODICE_CLASSE = /^([A-Z]\d{3}|[A-Z]{2}\d{2}|EEEE|AAAA|AD[A-Z]{2}|PPPP)$/;
const CODICE_SCUOLA = /^(?=.*\d)[A-Z0-9]{8,11}$/;
const NUMERICA = /^[\d.,/:*+-]+$/;
const SERVIZIO = new Set(['GPS', 'GUI', 'GAE', 'GM', 'F1', 'F2', 'N', 'S', '-', '–', '/']);

// Parole che possono comparire in chiaro: etichette di colonna e valori di servizio.
// Tutto il resto (nomi, cognomi, scuole, testi liberi) diventa "xxxx", ANCHE nelle
// intestazioni: alcuni PDF hanno le tabelle ruotate, con i nomi sotto le "etichette".
const LESSICO = new Set(`classe concorso di tipo graduatoria fascia elenco aggiuntivo origine codice posizione
  punteggio inclusione con riserva ordine nomina titoli scuola denominazione contratto ore spezzone cattedra posto
  cognome aspirante nome numero preferenza soddisfatta data produzione bollettino cdc cd pos punti grad gradu atoria
  cod mecc fiscale spezz ultimo ultimi nominato nominati su da a posto intero turno report totale nomine specchietto
  riassuntivo gps gae gui gm interna esterna normale sostegno psicofisico automatica annuale comune
  ia l ed i ii iii iv v vi vii viii ix x primo secondo terzo quarto quinto sesto settimo ottavo nono decimo del e`.split(/\s+/));
function maschera(testo) {
  return testo.split(/(\s+)/).map(w => {
    if (!w.trim()) return w;
    if (NUMERICA.test(w) || CODICE_CLASSE.test(w) || CODICE_SCUOLA.test(w) || SERVIZIO.has(w.toUpperCase())) return w;
    if (LESSICO.has(w.toLowerCase().replace(/[^a-zà-ú]/g, ''))) return w;
    return 'x'.repeat(Math.min(w.length, 12));
  }).join('');
}
const MAX_VOCI_PER_RIGA = 40; // le tabelle ruotate hanno centinaia di voci per riga

// Una riga è "di dati" se il suo primo testo inizia con un codice classe (es. "A060 - ...")
function primoCodice(items) {
  const first = items.slice().sort((a, b) => a.x - b.x)[0];
  if (!first) return false;
  const w = first.s.trim().split(/\s+/)[0];
  return CODICE_CLASSE.test(w);
}

// Restituisce { pagine, scansione, righe: [ { dati: bool, voci: [{x, y, s}] } ] }
export async function strutturaPdf(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true }).promise;
  const pg = await doc.getPage(1);
  const tc = await pg.getTextContent();
  const items = tc.items
    .filter(it => it.str && it.str.trim())
    .map(it => ({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), s: it.str.replace(/\s+/g, ' ').trim() }));
  const out = { pagine: doc.numPages, scansione: items.length < 8, righe: [] };
  // tipo di documento, deciso sul testo vero (prima del mascheramento): una lettera/decreto
  // parla di "decreta", "visto", "il dirigente" e non ha colonne Posizione/Punteggio
  // Si guardano tutte le pagine (fino a 30): un decreto può avere la tabella in allegato, dopo la
  // prima pagina. È "decreto" solo se in nessuna pagina compaiono le colonne Posizione e Punteggio,
  // né righe del tipo "GPS F1 12 105".
  const paginaTesto = [items.map(it => it.s).join(' ')];
  for (let p = 2; p <= Math.min(doc.numPages, 30); p++) {
    try { const tc2 = await (await doc.getPage(p)).getTextContent(); paginaTesto.push(tc2.items.map(it => it.str || '').join(' ')); } catch (e) { break; }
  }
  const tutto = paginaTesto.join(' ').toLowerCase();
  const haTabella = (/posizione|\bpos\./.test(tutto) && /punteggio|\bpunti\b/.test(tutto)) || /\bgps\s*-?\s*f[12]\s+\d/.test(tutto);
  out.tipoDocumento = !haTabella && /decret|\bvist[oae]\b|il dirigente|il direttore/.test(tutto) ? 'decreto' : 'altro';
  if (out.scansione) return out;
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of items) {
    const r = rows.find(r => Math.abs(r.y - it.y) <= ROW_TOL);
    if (r) r.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  let dati = 0;
  for (const r of rows) {
    if (out.righe.length >= MAX_RIGHE_TOTALI) break;
    const isDati = primoCodice(r.items);
    if (isDati) { if (dati >= MAX_RIGHE_DATI) break; dati++; }
    const dopoPrimaRigaDati = dati > 0;
    out.righe.push({
      dati: isDati || dopoPrimaRigaDati,
      voci: r.items.sort((a, b) => a.x - b.x).slice(0, MAX_VOCI_PER_RIGA).map(it => ({ x: it.x, y: it.y, s: maschera(it.s) })),
    });
  }
  return out;
}

// Data di creazione indicata nei metadati del PDF (es. "D:20261023143015+02'00'"): serve come
// ultima risorsa per datare un bollettino quando né l'indirizzo, né il nome, né il server
// dicono quando è stato pubblicato. Restituisce "AAAA-MM-GG" oppure null.
export async function dataCreazionePdf(buf) {
  try {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true }).promise;
    const meta = await doc.getMetadata();
    const raw = (meta && meta.info && (meta.info.CreationDate || meta.info.ModDate)) || '';
    const m = /D:(\d{4})(\d{2})(\d{2})/.exec(raw);
    if (!m) return null;
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    return iso >= '2026-08-01' && iso <= new Date(Date.now() + 86400000).toISOString().slice(0, 10) ? iso : null;
  } catch (e) { return null; }
}
