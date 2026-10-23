// Legge la pagina di Orizzonte Scuola aggiornata ogni giorno con i link ai
// bollettini di ogni provincia, ed estrae per ciascuna provincia l'elenco dei
// link ai turni (in ordine di lettura, quindi cronologico).
// Non serve indovinare come ogni singolo sito USP scrive i titoli: qui basta
// riconoscere il nome della regione e della provincia nel testo dell'articolo.
import { PROVINCE_ITALIA } from './province-italia.mjs';

// Confronto "morbido": minuscole, senza accenti né punteggiatura (così
// "Forlì-Cesena", "Forlì Cesena" e "forli cesena" sono la stessa cosa).
export function norm(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['’`\-–—.,;:()]/g, ' ').replace(/\s+/g, ' ').trim();
}

// nome normalizzato -> sigla (tutte le varianti di tutte le province)
const NAMES = [];
for (const [code, p] of Object.entries(PROVINCE_ITALIA)) for (const n of p.nomi) NAMES.push({ name: norm(n), code });
NAMES.sort((a, b) => b.name.length - a.name.length); // prima i nomi lunghi (Reggio Emilia prima di Reggio)

// Sigla della provincia citata PER ULTIMA in un pezzo di testo (a parola intera),
// oppure null. Esempio: "... Ferrara Bologna – " -> BO.
export function lastProvinceIn(str) {
  const s = ' ' + norm(str) + ' ';
  let best = null;
  for (const { name, code } of NAMES) {
    const idx = s.lastIndexOf(' ' + name + ' ');
    if (idx >= 0 && (!best || idx + name.length > best.end)) best = { code, end: idx + name.length };
  }
  return best ? best.code : null;
}

// Per compatibilità: nome esatto -> sigla
export const PROVINCE_NAMES = Object.fromEntries(NAMES.map(n => [n.name, n.code]));

// Divide il testo in una sequenza ordinata di "pezzi": testo semplice,
// intestazioni di regione (**REGIONE**) e link ([etichetta](url)).
function tokenize(text) {
  const tokens = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) tokens.push({ t: 'text', v: text.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ t: 'region', v: m[1].trim() });
    else tokens.push({ t: 'link', label: m[2].trim(), url: m[3].trim() });
    last = re.lastIndex;
  }
  if (last < text.length) tokens.push({ t: 'text', v: text.slice(last) });
  return tokens;
}

// Restituisce { SIGLA: [{label,url}, ...], ... } nell'ordine trovato nel testo.
export function extractProvinceLinks(text) {
  const tokens = tokenize(text);
  const out = {};
  let curProv = null;
  for (const tok of tokens) {
    if (tok.t === 'region') { curProv = null; continue; }
    if (tok.t === 'text') {
      const p = lastProvinceIn(tok.v);
      if (p) curProv = p;
      continue;
    }
    if (tok.t === 'link') {
      // un link la cui etichetta è proprio il nome di una provincia la "apre"
      const exact = NAMES.find(n => n.name === norm(tok.label));
      if (exact) { curProv = exact.code; out[curProv] = out[curProv] || []; out[curProv].push({ label: tok.label, url: tok.url }); continue; }
      if (curProv) { out[curProv] = out[curProv] || []; out[curProv].push({ label: tok.label, url: tok.url }); }
    }
  }
  return out;
}
