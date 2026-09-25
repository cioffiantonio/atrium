// Legge la pagina di Orizzonte Scuola aggiornata ogni giorno con i link ai
// bollettini di ogni provincia, ed estrae per ciascuna provincia configurata
// l'elenco dei link ai turni (in ordine di lettura, quindi cronologico).
// Non serve indovinare come ogni singolo sito USP scrive i titoli: qui basta
// riconoscere il nome della regione e della provincia nel testo dell'articolo.

// Nomi provincia come compaiono nel testo dell'articolo -> sigla usata in PROVINCE.
export const PROVINCE_NAMES = {
  // Emilia-Romagna
  'Bologna': 'BO', 'Ferrara': 'FE', 'Forlì Cesena': 'FC', 'Forlì-Cesena': 'FC',
  'Modena': 'MO', 'Parma': 'PR', 'Piacenza': 'PC', 'Ravenna': 'RA',
  'Reggio Emilia': 'RE', 'Rimini': 'RN',
  // Campania
  'Avellino': 'AV', 'Benevento': 'BN', 'Caserta': 'CE', 'Napoli': 'NA', 'Salerno': 'SA',
};

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

// Restituisce { PR_CODE: [{label,url}, ...], ... } nell'ordine trovato nel testo.
export function extractProvinceLinks(text) {
  const tokens = tokenize(text);
  const out = {};
  let curProv = null;
  function noteProvinceIn(str) {
    const s = str.replace(/\s+/g, ' ').trim();
    for (const name of Object.keys(PROVINCE_NAMES)) {
      // il nome provincia può comparire come ultima "parola" prima di un trattino,
      // per esempio "... Ferrara Bologna – [I turno...", quindi cerchiamo il nome
      // più vicino alla fine del pezzo di testo.
      const idx = s.lastIndexOf(name);
      if (idx >= 0) return PROVINCE_NAMES[name];
    }
    return null;
  }
  for (const tok of tokens) {
    if (tok.t === 'region') { curProv = null; continue; }
    if (tok.t === 'text') {
      const p = noteProvinceIn(tok.v);
      if (p) curProv = p;
      continue;
    }
    if (tok.t === 'link') {
      const p = PROVINCE_NAMES[tok.label];
      if (p) { curProv = p; out[p] = out[p] || []; out[p].push({ label: tok.label, url: tok.url }); continue; }
      if (curProv) { out[curProv] = out[curProv] || []; out[curProv].push({ label: tok.label, url: tok.url }); }
    }
  }
  return out;
}
