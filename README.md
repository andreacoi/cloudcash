# CloudCash

**La tua contabilità personale in partita doppia, sul web, gratis e solo tua.**

CloudCash è un clone semplificato di [GnuCash](https://gnucash.org): piano dei conti, registro dei movimenti, saldi,
import/export dei file `.gnucash`. Funziona nel browser (anche da iPhone e iPad) ed è protetto da username e password.

Non esiste un servizio "ufficiale" a cui iscriversi: **ognuno installa la propria copia** sul proprio account
Cloudflare. I tuoi dati restano nel tuo account, nessun altro li vede. Con il piano gratuito di Cloudflare non
paghi niente (per un uso personale i limiti gratuiti sono ampiamente sufficienti).

## Cosa sa fare

- **Piano dei conti** ad albero, con tutti i tipi di conto di GnuCash (banca, contanti, carte, mutui, entrate, spese…),
  sottoconti, conti segnaposto/nascosti, colori, codici, note e limiti di saldo.
- **Registro** di ogni conto con saldo progressivo, riga di inserimento rapido sempre pronta, ordinamento delle colonne.
- **Serie di movimenti**: i movimenti con lo stesso *N.* sono collegati (per esempio un prelievo e il relativo deposito)
  e ne vedi il riepilogo.
- **Dettagli** a testo ricco (grassetto, elenchi, link) su ogni movimento.
- **Import ed export `.gnucash`** (apribile in GnuCash desktop), export **Excel** (un foglio per conto) e
  **backup/ripristino JSON** completo.
- **Temi** (GnuCash, Bootstrap, Tokyo Night, Habamax, Gruvbox, Nord, Catppuccin) e **modalità notte** anche automatica.
- **Calcolatrice** integrata, comoda mentre inserisci un movimento.
- **Ricordami**, blocco automatico per inattività e **recupero password** con codice di recupero.
- Pensato anche per il telefono: puoi aggiungerlo alla schermata Home come se fosse un'app.

**Cosa non fa (per ora):** una sola valuta (euro), niente titoli/azioni, niente movimenti pianificati, un solo utente per installazione.

---

## Installazione su Cloudflare (gratis), passo per passo

Ci vogliono circa 15 minuti. Non servono competenze di programmazione: basta copiare e incollare i comandi.

### Cosa ti serve prima di cominciare

1. Un **account Cloudflare gratuito**: registrati su [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
   (non serve una carta di credito né un dominio).
2. **Node.js** (versione 20 o più recente): scaricalo da [nodejs.org](https://nodejs.org) (scegli la versione "LTS").
3. **Git**: [git-scm.com](https://git-scm.com/downloads). Se preferisci, puoi invece scaricare il progetto come file ZIP da GitHub.
4. Un **terminale**: "Terminale" su macOS e Linux, "PowerShell" su Windows.

### 1. Scarica il progetto

```bash
git clone https://github.com/andreacoi/cloudcash.git
cd cloudcash
npm install
```

### 2. Collega il terminale al tuo account Cloudflare

```bash
npx wrangler login
```

Si apre il browser: accedi a Cloudflare e conferma con "Allow". Wrangler è lo strumento ufficiale di Cloudflare
che installa l'app per te.

### 3. Crea il database

```bash
npx wrangler d1 create cloudcash
```

Il comando stampa qualcosa di simile a questo:

```
[[d1_databases]]
binding = "DB"
database_name = "cloudcash"
database_id = "8f3c2a1e-0b7d-4c55-9a41-2d6e5b7c9f10"
```

**Copia il valore di `database_id`** (la sequenza di lettere e numeri): ti serve al passo successivo.

### 4. Prepara il file di configurazione

Il progetto contiene un modello con tutte le istruzioni in italiano, `wrangler.example.toml`. Fanne una copia
chiamata `wrangler.toml`:

```bash
cp wrangler.example.toml wrangler.toml      # su Windows: copy wrangler.example.toml wrangler.toml
```

Apri `wrangler.toml` con un editor di testo qualsiasi (Blocco Note va benissimo) e sostituisci
`INCOLLA-QUI-IL-DATABASE-ID` con l'id copiato prima, **lasciando le virgolette**. Se vuoi, cambia anche `name`
(sarà l'inizio dell'indirizzo del sito). Salva.

> `wrangler.toml` contiene i dati del tuo account ed è già escluso da Git: non finirà su GitHub per sbaglio.

### 5. Crea le tabelle del database

```bash
npm run db:remote
```

### 6. Pubblica

```bash
npm run deploy
```

Alla prima volta Cloudflare potrebbe chiederti di scegliere un sottodominio gratuito `workers.dev`
(per esempio `mario`). Alla fine il comando stampa l'indirizzo della tua app:

```
https://cloudcash.mario.workers.dev
```

> Se il browser dice che la connessione non è sicura, aspetta un paio di minuti e riprova: il certificato
> di un indirizzo nuovo ha bisogno di un po' di tempo.

### 7. Crea il tuo utente

Apri l'indirizzo: al primo avvio ti viene chiesto di scegliere **username** e **password** (almeno 8 caratteri).
Subito dopo compare il **codice di recupero**: **salvalo in un posto sicuro** (gestore di password, foglio stampato).
È l'unico modo per reimpostare la password se la dimentichi, e viene mostrato una sola volta.

> Per sicurezza, la creazione dell'utente funziona **solo finché non ne esiste uno**. Dopo di te nessuno può registrarsi.

Fatto. Da qui in poi puoi creare i conti a mano oppure usare **File → Importa** per caricare un file di GnuCash.

---

## Usarlo ogni giorno

- **Da telefono o tablet:** apri l'indirizzo in Safari (iPhone/iPad) o Chrome (Android) e scegli
  *Condividi → Aggiungi alla schermata Home*. Si apre a schermo intero come un'app.
- **Ricordami:** spuntalo al login per restare connesso 30 giorni. Se non lo spunti, in
  *Impostazioni → Sicurezza* puoi scegliere dopo quanti minuti di inattività uscire (1–10 minuti oppure mai).
- **Password dimenticata?** Nella pagina di login c'è il link *Password dimenticata?*: ti servono username e codice
  di recupero. Dopo l'uso ti viene dato un codice nuovo. Puoi generarne uno nuovo in qualsiasi momento da
  *Impostazioni → Sicurezza* (con la password attuale).

### Importare da GnuCash

In GnuCash salva il file in formato **XML compresso** (è quello predefinito per i file `.gnucash` "classici"; i file
in formato SQLite non sono supportati). Poi in CloudCash: **File → Importa…**.

> ⚠️ L'import **sostituisce** tutti i dati presenti. Fai prima un backup se hai già inserito dei movimenti.

### Backup (fallo ogni tanto!)

I dati sono nel tuo account Cloudflare, ma un backup tuo è sempre una buona idea:

- **File → Esporta GnuCash**: un file `.gnucash` apribile in GnuCash desktop.
- **File → Backup JSON**: copia completa di CloudCash (include anche i *Dettagli* e le impostazioni); si ripristina con *Importa*.
- **File → Esporta XLSX**: un foglio Excel con un foglio per ogni conto.

---

## Aggiornare CloudCash

Quando esce una nuova versione:

```bash
git pull
npm install
npm run deploy
```

Alcune versioni cambiano il database. Se hai installato CloudCash **prima** di una di queste modifiche, esegui
**una sola volta** il file corrispondente (per le installazioni nuove non serve, il passo 5 le include già):

| File                        | Cosa aggiunge                                         |
|-----------------------------|-------------------------------------------------------|
| `migrate-001-details.sql`   | il campo *Dettagli* sui movimenti                     |
| `migrate-002-accounts.sql`  | i campi avanzati dei conti (codice, note, colore…)    |
| `migrate-003-auth.sql`      | Ricordami, blocco per inattività, codice di recupero  |

```bash
npx wrangler d1 execute cloudcash --remote --file=migrate-003-auth.sql
```

Se compare l'errore `duplicate column name`, quella modifica è già presente: non devi fare nulla.
**Esegui le migrazioni prima del `deploy`**, in ordine di numero, saltando quelle già fatte.

## Provarlo sul tuo computer (facoltativo)

```bash
npm run db:local     # crea le tabelle del database locale
npm run dev          # apri http://localhost:8787
```

Il database locale è separato da quello online: serve per provare, non tocca i dati veri.

---

## Sicurezza e privacy

- Le password non sono mai salvate in chiaro: si usa PBKDF2‑SHA256 con sale casuale.
- Il codice di recupero e i token di sessione sono salvati solo come hash.
- Il cookie di sessione è `HttpOnly` e `SameSite=Strict`, e viaggia solo su HTTPS.
- I dati stanno nel database D1 del *tuo* account Cloudflare. Il progetto non invia nulla a terzi
  (le librerie dell'editor di testo vengono caricate dalla CDN `cdnjs.cloudflare.com`).
- Per la modalità notte automatica CloudCash usa la posizione approssimativa che Cloudflare ricava dall'indirizzo IP
  per calcolare alba e tramonto: non chiede permessi e non la salva sul server.
- Se trovi un problema di sicurezza, apri una *Issue* su GitHub senza includere dati personali.

## Problemi comuni

| Problema                                              | Soluzione                                                                                   |
|-------------------------------------------------------|---------------------------------------------------------------------------------------------|
| `wrangler: command not found`                         | Usa sempre `npx wrangler …` (come negli esempi) dopo aver eseguito `npm install`.          |
| Errore sul `database_id` al deploy                    | Controlla `wrangler.toml`: l'id va tra virgolette e non deve restare il testo di esempio.   |
| Il sito dà errore di connessione appena pubblicato    | Attendi 2–3 minuti: il certificato HTTPS del nuovo indirizzo si sta creando.                |
| "no such table" o "no such column"                    | Mancano le tabelle (`npm run db:remote`) oppure una migrazione (vedi *Aggiornare*).         |
| Ho perso password **e** codice di recupero            | Da Cloudflare (dashboard → Storage & Databases → D1) puoi cancellare la riga in `users` ed eseguire di nuovo il primo avvio, **ma** i movimenti restano. |

## Come è fatto (per chi vuole contribuire)

- **Server:** [Hono](https://hono.dev) su Cloudflare Workers, TypeScript (`src/`). Database D1 (SQLite), schema in `schema.sql`.
- **Pagina web:** JavaScript puro, senza build (`public/app.js`, `style.css`, `index.html`).
- Gli importi sono interi in centesimi; un importo positivo in uno *split* è un addebito (dare).
- `npm run typecheck` controlla i tipi TypeScript.

I contributi sono benvenuti: apri una *Issue* o una *Pull Request*.

## Licenza

CloudCash è software libero, rilasciato con licenza **[GNU AGPL‑3.0 o successiva](LICENSE)**.
Puoi usarlo, studiarlo, modificarlo e condividerlo. Se pubblichi una versione modificata, anche solo come servizio
online, devi rendere disponibile il codice della tua versione con la stessa licenza.

Copyright © 2026 Andrea Coi.
CloudCash è un progetto indipendente e non è affiliato né approvato dal progetto GnuCash.
