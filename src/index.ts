import { Hono, Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { parseGnucash, exportGnucash, Book } from "./gnucash";
import { buildXlsx } from "./xlsx";
import { ACC_TYPES, CREDIT_NORMAL, childTypes, typeGroup, fullName } from "./accounts";

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

// posizione approssimativa del client (da Cloudflare), usata per alba/tramonto della modalità notte automatica
app.get("/api/location", (c) => {
  const cf = (c.req.raw as { cf?: { latitude?: string; longitude?: string } }).cf;
  const lat = parseFloat(cf?.latitude ?? ""), lon = parseFloat(cf?.longitude ?? "");
  return c.json(Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : { lat: null, lon: null });
});

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
const SETTING_KEYS = ["accSort", "regSort", "showHidden", "showRec", "theme", "colorMode"];
const SETTING_ENUMS: Record<string, string[]> = { theme: ["gnucash", "bs5", "tokyonight", "habamax", "gruvbox", "nord", "catppuccin"], colorMode: ["yes", "no", "auto"] };
const settingOk = (k: string, v: unknown) => !SETTING_ENUMS[k] || SETTING_ENUMS[k].includes(v as string);

app.get("/api/settings", async (c) => {
  const r = await c.env.DB.prepare("SELECT key,value FROM settings").all<{ key: string; value: string }>();
  return c.json(Object.fromEntries(r.results.map((x) => [x.key, JSON.parse(x.value)])));
});

app.put("/api/settings/:key", async (c) => {
  const key = c.req.param("key");
  if (!SETTING_KEYS.includes(key)) return c.json({ error: "Impostazione sconosciuta" }, 400);
  const parsed = await c.req.json();
  if (!settingOk(key, parsed)) return c.json({ error: "Valore non valido" }, 400);
  const value = JSON.stringify(parsed);
  if (value.length > 2000) return c.json({ error: "Valore troppo lungo" }, 400);
  await c.env.DB.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
  return c.json({ ok: true });
});

// ---------- conti ----------
const ACC_COLS = "id,parent_id,name,type,description,placeholder,hidden,code,notes,color,tax_related,opening_balance,limit_high,limit_low,limit_subs";
const ACC_PH = ACC_COLS.split(",").map(() => "?").join(",");
const accRow = (a: any) => [a.id, a.parent_id ?? null, a.name, a.type, a.description ?? "", a.placeholder ? 1 : 0, a.hidden ? 1 : 0, a.code ?? "", a.notes ?? "",
  a.color ?? "", a.tax_related ? 1 : 0, a.opening_balance ? 1 : 0, a.limit_high ?? null, a.limit_low ?? null, a.limit_subs ? 1 : 0];

app.get("/api/accounts", async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const [accs, bal] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM accounts"),
    // balance_today: solo movimenti fino a oggi (serve ai limiti di saldo, come GnuCash)
    c.env.DB.prepare("SELECT s.account_id, SUM(s.amount) balance, COUNT(*) n, SUM(CASE WHEN t.date_posted<=? THEN s.amount ELSE 0 END) balance_today FROM splits s JOIN transactions t ON t.id=s.tx_id GROUP BY s.account_id").bind(today),
  ]);
  const b = new Map((bal.results as any[]).map((r) => [r.account_id, r]));
  return c.json((accs.results as any[]).map((a) => ({ ...a, balance: b.get(a.id)?.balance ?? 0, balance_today: b.get(a.id)?.balance_today ?? 0, n: b.get(a.id)?.n ?? 0 })));
});

const isCents = (v: any) => v === null || v === undefined || Number.isInteger(v);

// Validazioni equivalenti a gnc_common_ok di GnuCash (dialog-account.c). Restituisce il messaggio d'errore, oppure null.
async function validateAccount(c: Context<Env>, b: any, selfId?: string) {
  const all = (await c.env.DB.prepare("SELECT id,parent_id,name,type,opening_balance FROM accounts").all<any>()).results;
  const byId = new Map(all.map((a: any) => [a.id, a]));
  b.name = String(b.name ?? "").trim();
  if (!b.name) return "L'account deve avere un nome";
  if (b.name.includes(":")) return "Il nome non può contenere il carattere «:»";
  if (!ACC_TYPES.includes(b.type)) return "Tipo conto non valido";
  const parent = byId.get(b.parent_id);
  if (!b.parent_id || !parent) return "Conto padre inesistente";
  for (let cur: string | null = b.parent_id; selfId && cur; cur = byId.get(cur)?.parent_id ?? null)
    if (cur === selfId) return "Il padre non può essere un discendente del conto";
  if (!childTypes(parent.type).includes(b.type)) return `Un conto di tipo «${b.type}» non può stare sotto un conto di tipo «${parent.type}»`;
  // nome completo unico
  const candidate = (parent.type === "ROOT" ? "" : fullName(parent.id, byId) + ":") + b.name;
  for (const a of all) if (a.id !== selfId && a.type !== "ROOT" && fullName(a.id, byId).toLowerCase() === candidate.toLowerCase()) return "Esiste già un conto con questo nome completo";
  b.code = String(b.code ?? "").trim(); b.notes = String(b.notes ?? ""); b.description = String(b.description ?? "");
  if (b.code.length > 50 || b.description.length > 500 || b.notes.length > 5000) return "Testo troppo lungo";
  b.color = b.color ? String(b.color).toLowerCase() : "";
  if (b.color && !/^#[0-9a-f]{6}$/.test(b.color)) return "Colore non valido";
  if (!isCents(b.limit_high) || !isCents(b.limit_low)) return "Limite di saldo non valido";
  b.limit_high ??= null; b.limit_low ??= null;
  if (b.limit_high !== null && b.limit_low !== null && b.limit_low >= b.limit_high) return "Il limite inferiore deve essere minore di quello superiore";
  if (b.opening_balance) {
    if (b.type !== "EQUITY") return "Solo un conto Patrimonio netto può contenere i saldi di apertura";
    if (all.some((a: any) => a.opening_balance && a.id !== selfId)) return "Esiste già un conto dei saldi di apertura";
  }
  return null;
}

// Il saldo iniziale di GnuCash: una transazione tra il nuovo conto e il conto Saldi di apertura (o un altro conto).
async function openingStatements(c: Context<Env>, id: string, b: any, stmts: D1PreparedStatement[]) {
  const o = b.opening;
  if (!o || !o.amount) return null;
  if (!Number.isInteger(o.amount)) return "Saldo iniziale non valido";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date ?? "")) return "Data del saldo iniziale non valida";
  if (b.type === "EQUITY") return "Un conto Patrimonio netto non può avere un saldo iniziale";
  if (b.placeholder) return "Un conto segnaposto non può avere un saldo iniziale";
  let counter: string;
  if (o.mode === "account") {
    const t = await c.env.DB.prepare("SELECT type,placeholder FROM accounts WHERE id=?").bind(o.transfer_id).first<any>();
    if (!t || t.type === "ROOT" || t.placeholder) return "Conto di trasferimento non valido";
    counter = o.transfer_id;
  } else {
    // conto Saldi di apertura: quello marcato, altrimenti uno con nome noto, altrimenti lo creo alla radice
    const eq = (await c.env.DB.prepare("SELECT id,name,opening_balance,parent_id FROM accounts WHERE type='EQUITY'").all<any>()).results;
    const found = eq.find((a: any) => a.opening_balance) ?? eq.find((a: any) => /^(saldi|bilanci|saldo) d'apertura$|^opening balances?$/i.test(a.name));
    if (found) counter = found.id;
    else {
      const root = await c.env.DB.prepare("SELECT id FROM accounts WHERE type='ROOT'").first<{ id: string }>();
      counter = newGuid();
      stmts.push(c.env.DB.prepare(`INSERT INTO accounts (${ACC_COLS}) VALUES (${ACC_PH})`).bind(...accRow({ id: counter, parent_id: root!.id, name: "Saldi di apertura", type: "EQUITY", opening_balance: 1 })));
    }
  }
  // il saldo è nel segno mostrato: per i conti "creditori" (passività, entrate...) positivo = avere
  const amount = o.amount * (CREDIT_NORMAL.has(b.type) ? -1 : 1);
  const tx = newGuid();
  stmts.push(
    c.env.DB.prepare("INSERT INTO transactions (id,date_posted,date_entered,num,description,notes,details) VALUES (?,?,?,?,?,?,?)").bind(tx, o.date, new Date().toISOString(), "", "Saldo di apertura", "", ""),
    c.env.DB.prepare("INSERT INTO splits VALUES (?,?,?,?,?,?)").bind(newGuid(), tx, id, amount, "", "n"),
    c.env.DB.prepare("INSERT INTO splits VALUES (?,?,?,?,?,?)").bind(newGuid(), tx, counter, -amount, "", "n"),
  );
  return null;
}

app.post("/api/accounts", async (c) => {
  const b = await c.req.json<any>();
  const err = await validateAccount(c, b);
  if (err) return c.json({ error: err }, 400);
  const id = newGuid();
  const stmts = [c.env.DB.prepare(`INSERT INTO accounts (${ACC_COLS}) VALUES (${ACC_PH})`).bind(...accRow({ ...b, id }))];
  const oerr = await openingStatements(c, id, b, stmts);
  if (oerr) return c.json({ error: oerr }, 400);
  await c.env.DB.batch(stmts);
  return c.json({ id });
});

app.put("/api/accounts/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<any>();
  const cur = await c.env.DB.prepare("SELECT type,placeholder FROM accounts WHERE id=?").bind(id).first<{ type: string; placeholder: number }>();
  if (!cur) return c.json({ error: "Conto inesistente" }, 404);
  if (cur.type === "ROOT") return c.json({ error: "Il conto radice non è modificabile" }, 400);
  const err = await validateAccount(c, b, id);
  if (err) return c.json({ error: err }, 400);

  const nSplits = (await c.env.DB.prepare("SELECT COUNT(*) n FROM splits WHERE account_id=?").bind(id).first<{ n: number }>())!.n;
  if (nSplits && typeGroup(cur.type) !== typeGroup(b.type)) return c.json({ error: "Il conto contiene movimenti: il tipo può cambiare solo tra tipi compatibili" }, 400);
  if (nSplits && b.placeholder && !cur.placeholder) return c.json({ error: "Il conto contiene movimenti e non può diventare segnaposto" }, 400);

  // sottoconti incompatibili con il nuovo tipo: GnuCash chiede conferma e li converte (set_children_types)
  const all = (await c.env.DB.prepare("SELECT id,parent_id,type FROM accounts").all<any>()).results;
  const kids = new Map<string, any[]>();
  for (const a of all) (kids.get(a.parent_id) ?? kids.set(a.parent_id, []).get(a.parent_id)!).push(a);
  const retype: string[] = [];
  (function walk(pid: string, ptype: string) {
    for (const k of kids.get(pid) ?? []) {
      const t = childTypes(ptype).includes(k.type) ? k.type : (retype.push(k.id), ptype);
      walk(k.id, t);
    }
  })(id, b.type);
  if (retype.length && !b.retype_children) return c.json({ error: `${retype.length} sottoconti hanno un tipo incompatibile con il nuovo tipo`, retype: retype.length }, 409);
  const stmts = [c.env.DB.prepare(`UPDATE accounts SET parent_id=?,name=?,type=?,description=?,placeholder=?,hidden=?,code=?,notes=?,color=?,tax_related=?,opening_balance=?,limit_high=?,limit_low=?,limit_subs=? WHERE id=?`)
    .bind(...accRow({ ...b, id }).slice(1), id)];
  if (retype.length) stmts.push(c.env.DB.prepare(`UPDATE accounts SET type=? WHERE id IN (${retype.map(() => "?").join(",")})`).bind(b.type, ...retype));
  await c.env.DB.batch(stmts);
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
// Sostituisce l'intero libro in un unico batch (D1 lo esegue in transazione: o tutto o niente)
async function replaceBook(db: D1Database, book: Book, details: (txId: string) => string) {
  const byParent = new Map<string | null, Book["accounts"]>();
  for (const a of book.accounts) (byParent.get(a.parent_id) ?? byParent.set(a.parent_id, []).get(a.parent_id)!).push(a);
  const ordered = (function walk(p: string | null): Book["accounts"] { return (byParent.get(p) ?? []).flatMap((a) => [a, ...walk(a.id)]); })(null);
  if (ordered.length !== book.accounts.length) throw new Error("Albero dei conti non valido (cicli o genitori mancanti)");
  await db.batch([
    db.prepare("DELETE FROM splits"), db.prepare("DELETE FROM transactions"),
    db.prepare("UPDATE accounts SET parent_id=NULL"), db.prepare("DELETE FROM accounts"),
    ...ordered.map((a) => db.prepare(`INSERT INTO accounts (${ACC_COLS}) VALUES (${ACC_PH})`).bind(...accRow(a))),
    ...book.transactions.map((t) => db.prepare("INSERT INTO transactions (id,date_posted,date_entered,num,description,notes,details) VALUES (?,?,?,?,?,?,?)").bind(t.id, t.date_posted, t.date_entered, t.num, t.description, t.notes, details(t.id))),
    ...book.splits.map((s) => db.prepare("INSERT INTO splits VALUES (?,?,?,?,?,?)").bind(s.id, s.tx_id, s.account_id, s.amount, s.memo, s.reconciled)),
  ]);
}

app.post("/api/import", async (c) => {
  let book: Book;
  try { book = await parseGnucash(await c.req.arrayBuffer()); }
  catch (e: any) { return c.json({ error: e.message }, 400); }
  if (!book.accounts.some((a) => a.type === "ROOT")) return c.json({ error: "Nessun conto radice nel file" }, 400);
  const db = c.env.DB;
  // i dettagli rich text non esistono nel formato GnuCash: li conservo per le transazioni con lo stesso id
  const keep = new Map(((await db.prepare("SELECT id,details FROM transactions WHERE details<>''").all<any>()).results).map((r) => [r.id, r.details]));
  try { await replaceBook(db, book, (id) => keep.get(id) ?? ""); }
  catch (e: any) { return c.json({ error: e.message }, 400); }
  return c.json({ accounts: book.accounts.length, transactions: book.transactions.length });
});

// ---------- backup / ripristino JSON (include i dettagli e le impostazioni) ----------
app.get("/api/backup", async (c) => {
  const db = c.env.DB;
  const [a, t, sp, st] = await db.batch([
    db.prepare("SELECT * FROM accounts"), db.prepare("SELECT * FROM transactions ORDER BY date_posted, date_entered"),
    db.prepare("SELECT * FROM splits ORDER BY rowid"), db.prepare("SELECT key,value FROM settings"),
  ]);
  const settings = Object.fromEntries((st.results as any[]).map((r) => [r.key, JSON.parse(r.value)]));
  const body = JSON.stringify({ app: "cloudcash", version: 1, exported_at: new Date().toISOString(), accounts: a.results, transactions: t.results, splits: sp.results, settings }, null, 1);
  return new Response(body, { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="cloudcash-backup-${new Date().toISOString().slice(0, 10)}.json"` } });
});

app.post("/api/restore", async (c) => {
  let d: any;
  try { d = await c.req.json(); } catch { return c.json({ error: "JSON non valido" }, 400); }
  const str = (v: any) => typeof v === "string";
  const err = (m: string) => c.json({ error: "Backup non valido: " + m }, 400);
  if (d?.app !== "cloudcash" || d.version !== 1 || !Array.isArray(d.accounts) || !Array.isArray(d.transactions) || !Array.isArray(d.splits)) return err("formato non riconosciuto");
  const accIds = new Set<string>(), txIds = new Set<string>();
  let roots = 0;
  for (const a of d.accounts) {
    if (!str(a.id) || !str(a.name) || ![...ACC_TYPES, "ROOT"].includes(a.type) || !(a.parent_id === null || str(a.parent_id))) return err("conto malformato");
    if (accIds.has(a.id)) return err("conto duplicato");
    accIds.add(a.id); if (a.type === "ROOT") roots++;
    a.description = str(a.description) ? a.description : ""; a.placeholder = a.placeholder ? 1 : 0; a.hidden = a.hidden ? 1 : 0;
    for (const k of ["code", "notes", "color"]) a[k] = str(a[k]) ? a[k] : ""; // backup più vecchi non hanno questi campi
    for (const k of ["limit_high", "limit_low"]) a[k] = Number.isInteger(a[k]) ? a[k] : null;
    a.tax_related = a.tax_related ? 1 : 0; a.opening_balance = a.opening_balance ? 1 : 0; a.limit_subs = a.limit_subs ? 1 : 0;
  }
  if (roots !== 1) return err("serve esattamente un conto radice");
  if (d.accounts.some((a: any) => a.parent_id !== null && !accIds.has(a.parent_id))) return err("genitore inesistente");
  for (const t of d.transactions) {
    if (!str(t.id) || !/^\d{4}-\d{2}-\d{2}$/.test(t.date_posted ?? "") || txIds.has(t.id)) return err("transazione malformata");
    txIds.add(t.id);
    t.date_entered = str(t.date_entered) ? t.date_entered : new Date().toISOString();
    for (const k of ["num", "description", "notes", "details"]) t[k] = str(t[k]) ? t[k] : "";
  }
  const sums = new Map<string, number>();
  for (const s of d.splits) {
    if (!str(s.id) || !txIds.has(s.tx_id) || !accIds.has(s.account_id) || !Number.isInteger(s.amount)) return err("split malformato");
    s.memo = str(s.memo) ? s.memo : ""; s.reconciled = ["n", "c", "y"].includes(s.reconciled) ? s.reconciled : "n";
    sums.set(s.tx_id, (sums.get(s.tx_id) ?? 0) + s.amount);
  }
  if ([...sums.values()].some((v) => v !== 0) || txIds.size !== sums.size) return err("transazioni sbilanciate o senza split");
  const details = new Map<string, string>(d.transactions.map((t: any) => [t.id, t.details]));
  try { await replaceBook(c.env.DB, d as Book, (id) => details.get(id) ?? ""); }
  catch (e: any) { return c.json({ error: e.message }, 400); }
  // impostazioni (solo chiavi note)
  const sets = Object.entries(d.settings ?? {}).filter(([k, v]) => SETTING_KEYS.includes(k) && settingOk(k, v));
  if (sets.length) await c.env.DB.batch(sets.map(([k, v]) => c.env.DB.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(k, JSON.stringify(v))));
  return c.json({ accounts: d.accounts.length, transactions: d.transactions.length });
});

app.get("/api/export", async (c) => {
  const db = c.env.DB;
  const [a, t, s] = await db.batch([
    db.prepare("SELECT * FROM accounts"), db.prepare("SELECT * FROM transactions ORDER BY date_posted, date_entered"), db.prepare("SELECT * FROM splits ORDER BY rowid"),
  ]);
  const gz = await exportGnucash({ accounts: a.results as any, transactions: t.results as any, splits: s.results as any }, newGuid());
  return new Response(gz, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="cloudcash-${new Date().toISOString().slice(0, 10)}.gnucash"` } });
});

app.get("/api/export.xlsx", async (c) => {
  const db = c.env.DB;
  const [a, t, s] = await db.batch([db.prepare("SELECT * FROM accounts"), db.prepare("SELECT * FROM transactions"), db.prepare("SELECT * FROM splits")]);
  const xlsx = buildXlsx(a.results as any, t.results as any, s.results as any);
  return new Response(xlsx, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="cloudcash-${new Date().toISOString().slice(0, 10)}.xlsx"` } });
});

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));
export default app;
