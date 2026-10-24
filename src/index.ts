import { Hono, Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { parseGnucash, exportGnucash, Book } from "./gnucash";

type Env = { Bindings: { DB: D1Database; ASSETS: Fetcher }; Variables: { userId: number } };
const app = new Hono<Env>();

const SESSION_DAYS = 30;
const PBKDF2_ITER = 100_000; // massimo consentito da Workers

// ---------- util ----------
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b as ArrayBuffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
const newGuid = () => crypto.randomUUID().replace(/-/g, "");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

async function hashPw(pw: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256));
}
const safeEq = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

async function startSession(c: Context<Env>, userId: number) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const exp = Date.now() + SESSION_DAYS * 864e5;
  await c.env.DB.prepare("INSERT INTO sessions VALUES (?,?,?)").bind(await sha256(token), userId, exp).run();
  setCookie(c, "sid", token, { httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Strict", path: "/", maxAge: SESSION_DAYS * 86400 });
}

// ---------- auth ----------
app.get("/api/status", async (c) => {
  const n = await c.env.DB.prepare("SELECT COUNT(*) n FROM users").first<{ n: number }>();
  return c.json({ needsSetup: !n!.n });
});

// Creazione del primo (e unico) utente: funziona solo finché non esiste nessun utente.
app.post("/api/setup", async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  if (!username || !password || password.length < 8) return c.json({ error: "Username e password (min. 8 caratteri) obbligatori" }, 400);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const pw_hash = await hashPw(password, salt);
  // INSERT condizionale atomico: evita race tra due richieste di setup
  const r = await c.env.DB.prepare("INSERT INTO users (username,pw_hash,pw_salt) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM users)")
    .bind(username, pw_hash, hex(salt)).run();
  if (!r.meta.changes) return c.json({ error: "Setup già eseguito" }, 403);
  const u = await c.env.DB.prepare("SELECT id FROM users WHERE username=?").bind(username).first<{ id: number }>();
  await startSession(c, u!.id);
  return c.json({ ok: true });
});

app.post("/api/login", async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  const u = await c.env.DB.prepare("SELECT id,pw_hash,pw_salt FROM users WHERE username=?").bind(username ?? "").first<any>();
  // calcolo comunque l'hash per non rivelare se lo username esiste
  const h = await hashPw(password ?? "", u ? unhex(u.pw_salt) : new Uint8Array(16));
  if (!u || !safeEq(h, u.pw_hash)) return c.json({ error: "Credenziali errate" }, 401);
  await startSession(c, u.id);
  return c.json({ ok: true });
});

app.post("/api/logout", async (c) => {
  const t = getCookie(c, "sid");
  if (t) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(t)).run();
  deleteCookie(c, "sid", { path: "/" });
  return c.json({ ok: true });
});

app.use("/api/*", async (c, next) => {
  if (["/api/status", "/api/setup", "/api/login", "/api/logout"].includes(c.req.path)) return next();
  const t = getCookie(c, "sid");
  const s = t && (await c.env.DB.prepare("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?").bind(await sha256(t), Date.now()).first<{ user_id: number }>());
  if (!s) return c.json({ error: "Non autenticato" }, 401);
  c.set("userId", s.user_id);
  await next();
});

app.get("/api/me", (c) => c.json({ ok: true }));

app.post("/api/password", async (c) => {
  const { current, next } = await c.req.json<{ current: string; next: string }>();
  if (!next || next.length < 8) return c.json({ error: "Nuova password troppo corta (min. 8)" }, 400);
  const u = await c.env.DB.prepare("SELECT pw_hash,pw_salt FROM users WHERE id=?").bind(c.get("userId")).first<any>();
  if (!safeEq(await hashPw(current ?? "", unhex(u.pw_salt)), u.pw_hash)) return c.json({ error: "Password attuale errata" }, 403);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET pw_hash=?,pw_salt=? WHERE id=?").bind(await hashPw(next, salt), hex(salt), c.get("userId")),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").bind(c.get("userId"), await sha256(getCookie(c, "sid")!)),
  ]);
  return c.json({ ok: true });
});

// ---------- impostazioni (uguali su ogni dispositivo) ----------
const SETTING_KEYS = ["accSort", "regSort", "showHidden", "showRec"];

app.get("/api/settings", async (c) => {
  const r = await c.env.DB.prepare("SELECT key,value FROM settings").all<{ key: string; value: string }>();
  return c.json(Object.fromEntries(r.results.map((x) => [x.key, JSON.parse(x.value)])));
});

app.put("/api/settings/:key", async (c) => {
  const key = c.req.param("key");
  if (!SETTING_KEYS.includes(key)) return c.json({ error: "Impostazione sconosciuta" }, 400);
  const value = JSON.stringify(await c.req.json());
  if (value.length > 2000) return c.json({ error: "Valore troppo lungo" }, 400);
  await c.env.DB.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
  return c.json({ ok: true });
});

// ---------- conti ----------
const ACC_TYPES = ["ASSET", "BANK", "CASH", "CREDIT", "LIABILITY", "STOCK", "MUTUAL", "RECEIVABLE", "PAYABLE", "INCOME", "EXPENSE", "EQUITY", "TRADING"];

app.get("/api/accounts", async (c) => {
  const [accs, bal] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM accounts"),
    c.env.DB.prepare("SELECT account_id, SUM(amount) balance, COUNT(*) n FROM splits GROUP BY account_id"),
  ]);
  const b = new Map((bal.results as any[]).map((r) => [r.account_id, r]));
  return c.json((accs.results as any[]).map((a) => ({ ...a, balance: b.get(a.id)?.balance ?? 0, n: b.get(a.id)?.n ?? 0 })));
});

async function validateAccount(c: Context<Env>, body: any, selfId?: string) {
  if (!body.name?.trim()) return "Nome obbligatorio";
  if (!ACC_TYPES.includes(body.type)) return "Tipo conto non valido";
  if (!body.parent_id) return "Conto padre obbligatorio";
  const p = await c.env.DB.prepare("SELECT id FROM accounts WHERE id=?").bind(body.parent_id).first();
  if (!p) return "Conto padre inesistente";
  // evita cicli: il padre non può essere un discendente di se stesso
  for (let cur: string | null = body.parent_id; selfId && cur; ) {
    if (cur === selfId) return "Il padre non può essere un discendente del conto";
    cur = (await c.env.DB.prepare("SELECT parent_id p FROM accounts WHERE id=?").bind(cur).first<{ p: string | null }>())?.p ?? null;
  }
  return null;
}

app.post("/api/accounts", async (c) => {
  const b = await c.req.json<any>();
  const err = await validateAccount(c, b);
  if (err) return c.json({ error: err }, 400);
  const id = newGuid();
  await c.env.DB.prepare("INSERT INTO accounts VALUES (?,?,?,?,?,?,?)")
    .bind(id, b.parent_id, b.name.trim(), b.type, b.description ?? "", b.placeholder ? 1 : 0, b.hidden ? 1 : 0).run();
  return c.json({ id });
});

app.put("/api/accounts/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<any>();
  const cur = await c.env.DB.prepare("SELECT type FROM accounts WHERE id=?").bind(id).first<{ type: string }>();
  if (!cur) return c.json({ error: "Conto inesistente" }, 404);
  if (cur.type === "ROOT") return c.json({ error: "Il conto radice non è modificabile" }, 400);
  const err = await validateAccount(c, b, id);
  if (err) return c.json({ error: err }, 400);
  await c.env.DB.prepare("UPDATE accounts SET parent_id=?,name=?,type=?,description=?,placeholder=?,hidden=? WHERE id=?")
    .bind(b.parent_id, b.name.trim(), b.type, b.description ?? "", b.placeholder ? 1 : 0, b.hidden ? 1 : 0, id).run();
  return c.json({ ok: true });
});

// Eliminazione: se il conto ha movimenti/figli bisogna indicare dove spostarli (come in GnuCash).
app.delete("/api/accounts/:id", async (c) => {
  const id = c.req.param("id");
  const moveTo = c.req.query("moveTo");
  const a = await c.env.DB.prepare("SELECT type FROM accounts WHERE id=?").bind(id).first<{ type: string }>();
  if (!a) return c.json({ error: "Conto inesistente" }, 404);
  if (a.type === "ROOT") return c.json({ error: "Il conto radice non è eliminabile" }, 400);
  const info = await c.env.DB.prepare("SELECT (SELECT COUNT(*) FROM splits WHERE account_id=?1) s, (SELECT COUNT(*) FROM accounts WHERE parent_id=?1) k").bind(id).first<{ s: number; k: number }>();
  if ((info!.s || info!.k) && !moveTo) return c.json({ error: "Il conto contiene movimenti o sottoconti: indica dove spostarli", splits: info!.s, children: info!.k }, 409);
  if (moveTo) {
    if (moveTo === id) return c.json({ error: "Destinazione non valida" }, 400);
    for (let cur: string | null = moveTo; cur; ) { // la destinazione non può stare sotto il conto eliminato
      if (cur === id) return c.json({ error: "Destinazione non valida" }, 400);
      cur = (await c.env.DB.prepare("SELECT parent_id p FROM accounts WHERE id=?").bind(cur).first<{ p: string | null }>())?.p ?? null;
    }
    if (!(await c.env.DB.prepare("SELECT 1 FROM accounts WHERE id=?").bind(moveTo).first())) return c.json({ error: "Destinazione inesistente" }, 400);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE splits SET account_id=? WHERE account_id=?").bind(moveTo, id),
      c.env.DB.prepare("UPDATE accounts SET parent_id=? WHERE parent_id=?").bind(moveTo, id),
      c.env.DB.prepare("DELETE FROM accounts WHERE id=?").bind(id),
    ]);
  } else await c.env.DB.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
  return c.json({ ok: true });
});

// ---------- registro ----------
app.get("/api/accounts/:id/register", async (c) => {
  const id = c.req.param("id");
  // Per ogni split del conto: altri split della stessa transazione (per mostrare il "trasferimento")
  const rows = (await c.env.DB.prepare(
    `SELECT s.id split_id, s.amount, s.reconciled, s.memo, t.id tx_id, t.date_posted, t.num, t.description,
            (SELECT COUNT(*) FROM splits o WHERE o.tx_id=t.id AND o.id<>s.id) others,
            (SELECT o.account_id FROM splits o WHERE o.tx_id=t.id AND o.id<>s.id LIMIT 1) other_account,
            (t.details<>'') has_details,
            (CASE WHEN t.num='' THEN 0 ELSE (SELECT COUNT(*) FROM transactions x WHERE x.num=t.num COLLATE NOCASE) END) series_n
       FROM splits s JOIN transactions t ON t.id=s.tx_id
      WHERE s.account_id=? ORDER BY t.date_posted, t.date_entered, s.id`).bind(id).all<any>()).results;
  let run = 0;
  return c.json(rows.map((r) => ({ ...r, balance: (run += r.amount) })));
});

// ---------- serie (movimenti con lo stesso N.) ----------
app.get("/api/series", async (c) => {
  const r = await c.env.DB.prepare("SELECT num, COUNT(*) n FROM transactions WHERE num<>'' GROUP BY num COLLATE NOCASE ORDER BY num COLLATE NOCASE").all();
  return c.json(r.results);
});

app.get("/api/series/:num", async (c) => {
  const num = c.req.param("num");
  const [t, s] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT id,date_posted,description FROM transactions WHERE num=? COLLATE NOCASE ORDER BY date_posted,date_entered").bind(num),
    c.env.DB.prepare(`SELECT s.tx_id, s.account_id, s.amount FROM splits s JOIN transactions t ON t.id=s.tx_id
                       WHERE t.num=? COLLATE NOCASE ORDER BY s.rowid`).bind(num),
  ]);
  const byTx = new Map<string, any[]>();
  const net = new Map<string, number>();
  for (const r of s.results as any[]) {
    (byTx.get(r.tx_id) ?? byTx.set(r.tx_id, []).get(r.tx_id)!).push({ account_id: r.account_id, amount: r.amount });
    net.set(r.account_id, (net.get(r.account_id) ?? 0) + r.amount);
  }
  return c.json({
    num,
    transactions: (t.results as any[]).map((x) => ({ ...x, splits: byTx.get(x.id) ?? [] })),
    net: [...net].map(([account_id, amount]) => ({ account_id, amount })),
  });
});

// ---------- transazioni ----------
interface TxIn { date_posted: string; num?: string; description: string; notes?: string; details?: string; splits: { account_id: string; amount: number; memo?: string; reconciled?: string }[] }

async function validateTx(c: Context<Env>, t: TxIn) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date_posted ?? "")) return "Data non valida";
  if ((t.details ?? "").length > 100_000) return "Il campo dettagli è troppo lungo";
  if (!Array.isArray(t.splits) || t.splits.length < 2) return "Servono almeno due split";
  let sum = 0;
  for (const s of t.splits) {
    if (!Number.isInteger(s.amount)) return "Importo non valido";
    sum += s.amount;
  }
  if (sum !== 0) return `La transazione non è bilanciata (differenza ${(sum / 100).toFixed(2)})`;
  const ids = [...new Set(t.splits.map((s) => s.account_id))];
  const found = await c.env.DB.prepare(`SELECT id,type,placeholder FROM accounts WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<any>();
  if (found.results.length !== ids.length) return "Conto inesistente in uno split";
  if (found.results.some((a: any) => a.type === "ROOT" || a.placeholder)) return "Non si può registrare su conti radice o segnaposto";
  return null;
}

const txStmts = (c: Context<Env>, id: string, entered: string, t: TxIn) => [
  c.env.DB.prepare("INSERT INTO transactions (id,date_posted,date_entered,num,description,notes,details) VALUES (?,?,?,?,?,?,?)").bind(id, t.date_posted, entered, t.num ?? "", t.description ?? "", t.notes ?? "", t.details ?? ""),
  ...t.splits.map((s) => c.env.DB.prepare("INSERT INTO splits VALUES (?,?,?,?,?,?)").bind(newGuid(), id, s.account_id, s.amount, s.memo ?? "", ["n", "c", "y"].includes(s.reconciled ?? "") ? s.reconciled : "n")),
];

app.get("/api/transactions/:id", async (c) => {
  const id = c.req.param("id");
  const [t, s] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM transactions WHERE id=?").bind(id),
    c.env.DB.prepare("SELECT account_id,amount,memo,reconciled FROM splits WHERE tx_id=? ORDER BY rowid").bind(id),
  ]);
  if (!t.results.length) return c.json({ error: "Transazione inesistente" }, 404);
  return c.json({ ...(t.results[0] as object), splits: s.results });
});

app.post("/api/transactions", async (c) => {
  const t = await c.req.json<TxIn>();
  const err = await validateTx(c, t);
  if (err) return c.json({ error: err }, 400);
  const id = newGuid();
  await c.env.DB.batch(txStmts(c, id, new Date().toISOString(), t));
  return c.json({ id });
});

app.put("/api/transactions/:id", async (c) => {
  const id = c.req.param("id");
  const t = await c.req.json<TxIn>();
  const old = await c.env.DB.prepare("SELECT date_entered FROM transactions WHERE id=?").bind(id).first<{ date_entered: string }>();
  if (!old) return c.json({ error: "Transazione inesistente" }, 404);
  const err = await validateTx(c, t);
  if (err) return c.json({ error: err }, 400);
  await c.env.DB.batch([c.env.DB.prepare("DELETE FROM transactions WHERE id=?").bind(id), ...txStmts(c, id, old.date_entered, t)]);
  return c.json({ ok: true });
});

app.delete("/api/transactions/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM transactions WHERE id=?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

app.patch("/api/splits/:id/reconcile", async (c) => {
  const { state } = await c.req.json<{ state: string }>();
  if (!["n", "c", "y"].includes(state)) return c.json({ error: "Stato non valido" }, 400);
  await c.env.DB.prepare("UPDATE splits SET reconciled=? WHERE id=?").bind(state, c.req.param("id")).run();
  return c.json({ ok: true });
});

// ---------- import / export ----------
app.post("/api/import", async (c) => {
  let book: Book;
  try { book = await parseGnucash(await c.req.arrayBuffer()); }
  catch (e: any) { return c.json({ error: e.message }, 400); }
  if (!book.accounts.some((a) => a.type === "ROOT")) return c.json({ error: "Nessun conto radice nel file" }, 400);
  const db = c.env.DB;
  // i dettagli rich text non esistono nel formato GnuCash: li conservo per le transazioni con lo stesso id
  const keep = new Map(((await db.prepare("SELECT id,details FROM transactions WHERE details<>''").all<any>()).results).map((r) => [r.id, r.details]));
  // FK disattivabili solo per statement; svuoto in ordine sicuro e reinserisco genitori prima dei figli
  const byParent = new Map<string | null, typeof book.accounts>();
  for (const a of book.accounts) (byParent.get(a.parent_id) ?? byParent.set(a.parent_id, []).get(a.parent_id)!).push(a);
  const ordered = (function walk(p: string | null): typeof book.accounts { return (byParent.get(p) ?? []).flatMap((a) => [a, ...walk(a.id)]); })(null);
  const stmts = [
    db.prepare("DELETE FROM splits"), db.prepare("DELETE FROM transactions"),
    db.prepare("UPDATE accounts SET parent_id=NULL"), db.prepare("DELETE FROM accounts"),
    ...ordered.map((a) => db.prepare("INSERT INTO accounts VALUES (?,?,?,?,?,?,?)").bind(a.id, a.parent_id, a.name, a.type, a.description, a.placeholder, a.hidden)),
    ...book.transactions.map((t) => db.prepare("INSERT INTO transactions (id,date_posted,date_entered,num,description,notes,details) VALUES (?,?,?,?,?,?,?)").bind(t.id, t.date_posted, t.date_entered, t.num, t.description, t.notes, keep.get(t.id) ?? "")),
    ...book.splits.map((s) => db.prepare("INSERT INTO splits VALUES (?,?,?,?,?,?)").bind(s.id, s.tx_id, s.account_id, s.amount, s.memo, s.reconciled)),
  ];
  // D1 esegue ogni batch in transazione; per atomicità totale uso un unico batch (limite ~ migliaia di statement ok per libri personali)
  await db.batch(stmts);
  return c.json({ accounts: book.accounts.length, transactions: book.transactions.length });
});

app.get("/api/export", async (c) => {
  const db = c.env.DB;
  const [a, t, s] = await db.batch([
    db.prepare("SELECT * FROM accounts"), db.prepare("SELECT * FROM transactions ORDER BY date_posted, date_entered"), db.prepare("SELECT * FROM splits ORDER BY rowid"),
  ]);
  const gz = await exportGnucash({ accounts: a.results as any, transactions: t.results as any, splits: s.results as any }, newGuid());
  return new Response(gz, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="cloudcash-${new Date().toISOString().slice(0, 10)}.gnucash"` } });
});

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));
export default app;
