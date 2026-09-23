# Atrium — pubblicazione online e icona su iPhone

## 1. Cosa c'è in questa cartella
- `index.html` — l'app (Atrium v5 + le modifiche di questo turno).
- `apple-touch-icon.png` — l'icona (la "a" con il tocco) per la schermata Home.
- `data/bollettini.json` — i punteggi minimi letti dai bollettini, provincia per provincia. Oggi contiene solo Modena, generato per davvero dal bollettino che mi hai caricato.
- `scripts/` — il programma che legge i bollettini PDF ed estrae i punteggi (`parse-lib.mjs`) e quello che li scarica dal sito dell'USP (`fetch-province.mjs`).
- `.github/workflows/aggiorna-bollettini.yml` — l'orario automatico (ogni 6 ore) che rilancia lo script e salva il risultato.
- `package.json` — elenca la sola libreria necessaria (pdfjs-dist, per leggere i PDF).

## 2. Pubblicare l'app su Netlify (per l'icona sull'iPhone)
1. Vai su netlify.com, crea un account gratuito.
2. Trascina l'intera cartella (non solo `index.html`) nella pagina "Deploy manually" di Netlify.
3. Netlify ti dà un indirizzo tipo `nome-a-caso.netlify.app`. Puoi cambiarlo da "Site settings" in un nome meno indovinabile.
4. Apri quell'indirizzo su iPhone con Safari, tocca Condividi e poi "Aggiungi alla schermata Home". Comparirà l'icona di Atrium, e si aprirà a schermo intero.

## 3. Aggiornamento automatico dei bollettini
Per farlo funzionare **da solo** (senza il tuo computer acceso) serve che il progetto stia anche su GitHub, collegato a Netlify:
1. Crea un repository su GitHub e carica questa cartella (con `git` o trascinando i file dall'interfaccia web).
2. Su Netlify, invece del trascinamento manuale, collega il sito a quel repository ("Import from Git"): da quel momento Netlify pubblica da solo ogni volta che il repository cambia.
3. Su GitHub, vai nella scheda "Actions" del repository e abilita i workflow, se te lo chiede.
4. Da quel momento, ogni 6 ore GitHub scarica i bollettini nuovi, li legge e aggiorna `data/bollettini.json`; Netlify pubblica da solo la versione aggiornata. Lo trovi anche a mano nella scheda "Actions", con il pulsante "Run workflow".

## 4. Cosa è stato verificato davvero, e cosa no
- **La lettura dei punteggi dal PDF** l'ho collaudata sul bollettino vero di Modena (1° turno): individua da sola le colonne della tabella (non dipende da un formato fisso), e sulla classe AM48 dà lo stesso risultato (48 punti, posizione 144) che avevamo controllato a mano insieme in chat.
- **La ricerca automatica dei bollettini sul sito dell'USP di Modena** (`fetch-province.mjs`) è scritta seguendo la struttura reale del sito (WordPress, ricerca interna), ma non ho potuto provarla dal vivo da qui, perché questo ambiente non ha accesso a internet per gli script. Al primo avvio su GitHub Actions, controlla nella scheda "Actions" che il log mostri dei bollettini trovati; se il sito ha una struttura diversa da quella prevista, il log lo segnala chiaramente (nessun bollettino trovato) invece di inventare numeri.
- **Oggi sono configurate le 9 province dell'Emilia-Romagna** (Modena, Ferrara, Reggio Emilia, Bologna, Forlì-Cesena, Parma, Piacenza, Ravenna, Rimini): condividono lo stesso sito. Di Modena, Ferrara e Reggio Emilia ho controllato che il sito esiste davvero e ha questa struttura; delle altre sei ho solo dedotto l'indirizzo dallo stesso schema, senza verificarlo uno per uno.
- **Le altre regioni non sono ancora incluse.** Ogni USP provinciale fuori dall'Emilia-Romagna ha un proprio sito, spesso diverso: per ognuna bisogna trovarne l'indirizzo e controllare come pubblica i bollettini, poi aggiungere una voce nell'elenco `PROVINCE` dentro `scripts/fetch-province.mjs`. Dimmi quali province ti servono per prime (una regione alla volta è più sicuro) e le aggiungo, verificandole quando riesco a controllarle davvero.
- Se in futuro un bollettino non viene letto bene, l'app lo segnala con "Da verificare" invece di mostrare un numero sbagliato, e resta sempre possibile correggere il punteggio a mano.
