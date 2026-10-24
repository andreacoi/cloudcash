# CloudCash

Clone minimale di GnuCash: partita doppia, piano dei conti, registro, import/export `.gnucash`.
Gira su Cloudflare Workers + D1 (SQLite), piano gratuito, protetto da login.

## Sviluppo locale
    npm install
    npm run db:local     # crea le tabelle nel D1 locale
    npm run dev          # http://localhost:8787 (al primo accesso crei username/password)

## Deploy (gratis)
    npx wrangler login
    npx wrangler d1 create cloudcash        # copia il database_id in wrangler.toml
    npm run db:remote                       # crea le tabelle in produzione
    npm run deploy                          # ti restituisce https://cloudcash.<tuo-account>.workers.dev

Apri subito l'URL e crea l'utente: il setup è possibile solo finché non esiste nessun utente.
Poi usa **Importa** per caricare `bin/bilancio.gnucash`; **Esporta** scarica un `.gnucash` apribile in GnuCash desktop (backup).
