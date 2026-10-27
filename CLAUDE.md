# CLAUDE.md

Indicazioni per lavorare su CloudCash con Claude Code. Per l'uso e l'installazione vedi `README.md`.

## Cos'è

Clone semplificato di GnuCash (contabilità in partita doppia) che gira su Cloudflare Workers + D1.
Un'installazione = un utente = un database. Interfaccia e messaggi sono **in italiano**; commenti, messaggi di commit
e testi UI vanno scritti in italiano.

## Comandi

```bash
npm install
npm run dev          # wrangler dev su http://localhost:8787
npm run db:local     # crea le tabelle nel database D1 locale (schema.sql)
npm run db:remote    # crea le tabelle nel database D1 online
npm run deploy       # wrangler deploy
npm run typecheck    # tsc --noEmit (unico controllo automatico: non ci sono test)
```

Prima di dichiarare finito un cambiamento al server esegui `npm run typecheck`.

## Struttura

- `src/index.ts` — app Hono: autenticazione, API REST `/api/*` (conti, registro, serie, transazioni, split,
  import/export/backup). Le route non-API cadono su `ASSETS` (`app.notFound`).
- `src/accounts.ts` — regole sui tipi di conto trascritte da GnuCash (tipi padre/figlio, gruppi di tipi, `fullName`).
- `src/gnucash.ts` — import/export del formato `.gnucash` (XML gzip, `fast-xml-parser` + `fflate`).
- `src/xlsx.ts` — export Excel, un foglio per conto.
- `public/` — frontend in JavaScript puro, **senza build** (`app.js`, `style.css`, `index.html`, manifest, icone).
- `schema.sql` — schema completo per le installazioni nuove; `migrate-NNN-*.sql` — migrazioni per quelle esistenti.
- `wrangler.example.toml` — modello di configurazione. `wrangler.toml` è personale e **gitignorato**: non
  committarlo e non metterci l'id del database reale.
- `misc/` — sorgente dell'icona (`icon.xcf`).

## Convenzioni e invarianti

- **Importi**: interi in centesimi. In uno split un importo positivo è un addebito (dare); ogni transazione deve
  bilanciare. Solo EUR.
- **Modifiche al database**: aggiorna `schema.sql` **e** aggiungi `migrate-NNN-*.sql` (numerazione progressiva),
  poi aggiorna la tabella delle migrazioni nel README (sezione "Aggiornare CloudCash"). Le migrazioni vanno
  eseguite prima del `deploy`.
- **Import/ripristino**: `replaceBook` è condiviso tra import GnuCash e ripristino JSON e applica tutto in un
  batch atomico. `/api/restore` valida bilanciamento, riferimenti e albero dei conti. Se aggiungi campi a conti o
  transazioni, estendi anche export/import `.gnucash`, backup/ripristino JSON ed export XLSX.
- **Regole sui conti** come GnuCash: tipi padre/figlio compatibili, nome completo unico, tipo cambiabile solo
  dentro lo stesso gruppo se ci sono movimenti. Modificale solo in `src/accounts.ts`.
- **Sicurezza**: password con PBKDF2‑SHA256 e sale; codice di recupero e token di sessione salvati solo come hash;
  cookie `HttpOnly` + `SameSite=Strict`; `/api/setup` funziona solo finché non esiste un utente. Il middleware su
  `/api/*` protegge tutto ciò che è dichiarato dopo di esso: le route pubbliche stanno sopra.
- **Frontend**: niente bundler né framework. Layout mobile senza scroll orizzontale (registro a colonne fisse,
  menu hamburger); su desktop/tablet barra dei menu stile macOS. Temi e modalità notte (sì/no/auto, via
  alba/tramonto dalla posizione IP di Cloudflare) sono salvati come impostazioni sul server (`/api/settings`).
- **Dipendenze esterne a runtime**: solo l'editor di testo ricco (Quill) da `cdnjs.cloudflare.com`. Non
  aggiungere altro che invii dati a terzi.
- Licenza AGPL‑3.0 o successiva.

## Git

- Messaggi di commit in italiano, oggetto breve all'imperativo/descrittivo, eventuale elenco puntato nel corpo.
- I commit fatti con Claude terminano con la riga `Co-Authored-By: Claude ... <noreply@anthropic.com>`.
