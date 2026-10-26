// CloudCash - frontend (vanilla JS, nessun build)
const $ = (s) => document.querySelector(s);
const app = $("#app"), dlg = $("#dlg");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });
const money = (cents) => eur.format(cents / 100);
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => d.split("-").reverse().join("/");

// parsing importi stile italiano: "1.234,56" / "12,5" / "12.50"
function parseAmount(s) {
  s = String(s ?? "").trim().replace(/\s|€/g, "");
  if (!s) return 0;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  if (!/^-?\d*\.?\d+$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}

async function api(path, opts = {}) {
  const o = { credentials: "same-origin", ...opts };
  if (o.json !== undefined) { o.method ??= "POST"; o.headers = { "content-type": "application/json" }; o.body = JSON.stringify(o.json); }
  const r = await fetch("/api" + path, o);
  if (r.status === 401 && !path.match(/login|setup|status/)) { renderLogin(); throw new Error("Sessione scaduta"); }
  if (!r.ok) { const e = new Error((await r.json().catch(() => ({}))).error || r.statusText); e.status = r.status; throw e; }
  return r;
}
const j = async (path, opts) => (await api(path, opts)).json();

// ---------- dati / helper conti ----------
let accounts = [], byId = new Map();
const CREDIT_NORMAL = new Set(["INCOME", "LIABILITY", "EQUITY", "CREDIT", "PAYABLE"]);
const TYPE_IT = { ROOT: "Radice", ASSET: "Attività", BANK: "Banca", CASH: "Contanti", CREDIT: "Carta di credito", LIABILITY: "Passività", STOCK: "Azioni", MUTUAL: "Fondo", RECEIVABLE: "Crediti", PAYABLE: "Debiti", INCOME: "Entrate", EXPENSE: "Spese", EQUITY: "Patrimonio netto", TRADING: "Trading" };
const ASSET_LIKE = ["BANK", "CASH", "ASSET", "STOCK", "MUTUAL", "CURRENCY", "CREDIT", "LIABILITY", "RECEIVABLE", "PAYABLE"];
const SELECTABLE_TYPES = ["BANK", "CASH", "CREDIT", "ASSET", "LIABILITY", "RECEIVABLE", "PAYABLE", "INCOME", "EXPENSE", "EQUITY"];
function childTypes(parent) {
  if (parent === "ROOT") return [...ASSET_LIKE, "INCOME", "EXPENSE", "EQUITY", "TRADING"];
  if (ASSET_LIKE.includes(parent)) return ASSET_LIKE;
  if (parent === "INCOME" || parent === "EXPENSE") return ["INCOME", "EXPENSE"];
  return parent === "EQUITY" ? ["EQUITY"] : parent === "TRADING" ? ["TRADING"] : [];
}
const centsStr = (c) => (c === null || c === undefined ? "" : (c / 100).toFixed(2).replace(".", ","));
const COLS = { BANK: ["Deposito", "Prelievo"], CASH: ["Ricevuta", "Spesa"], EXPENSE: ["Spesa", "Rimborso"], INCOME: ["Addebito", "Entrata"], ASSET: ["Aumento", "Diminuzione"], LIABILITY: ["Pagamento", "Aumento"], CREDIT: ["Pagamento", "Addebito"], EQUITY: ["Decremento", "Aumento"] };
const sign = (a) => (CREDIT_NORMAL.has(a.type) ? -1 : 1);

async function loadAccounts() {
  accounts = await j("/accounts");
  byId = new Map(accounts.map((a) => [a.id, a]));
  const kids = new Map();
  for (const a of accounts) (kids.get(a.parent_id) ?? kids.set(a.parent_id, []).get(a.parent_id)).push(a);
  for (const l of kids.values()) l.sort((a, b) => a.name.localeCompare(b.name, "it"));
  const calc = (a) => (a.total = a.balance + (kids.get(a.id) ?? []).reduce((s, k) => s + calc(k), 0));
  const calcToday = (a) => (a.total_today = a.balance_today + (kids.get(a.id) ?? []).reduce((s, k) => s + calcToday(k), 0));
  accounts.filter((a) => !a.parent_id).forEach((a) => { calc(a); calcToday(a); });
  for (const a of accounts) a.kids = kids.get(a.id) ?? [];
  const full = (a) => (a.parent_id && byId.get(a.parent_id).type !== "ROOT" ? full(byId.get(a.parent_id)) + ":" : "") + a.name;
  for (const a of accounts) a.full = a.type === "ROOT" ? "" : full(a);
}
const root = () => accounts.find((a) => a.type === "ROOT");

// ---------- login / shell ----------
async function boot() {
  const { needsSetup } = await (await fetch("/api/status")).json();
  if (needsSetup) return renderLogin(true);
  try { await api("/me"); await shell(); route(); } catch { renderLogin(); }
}

function renderLogin(setup = false) {
  app.innerHTML = `<form class="card login" id="lf"><h1><img class="logo" src="/assets/logo-128.png" alt="">CloudCash</h1>
    ${setup ? `<p class="mut">Primo avvio: scegli username e password (min. 8 caratteri).</p>` : ""}
    <label>Username</label><input name="username" autocomplete="username" required autofocus>
    <label>Password</label><input name="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}" required>
    <div class="err" id="le"></div><button class="primary" style="width:100%">${setup ? "Crea account" : "Accedi"}</button></form>`;
  $("#lf").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api(setup ? "/setup" : "/login", { json: f }); await shell(); route(); }
    catch (err) { $("#le").textContent = err.message; }
  };
}

// ---- calcolatrice: pannello flottante non modale, resta usabile sopra le finestre di dialogo ----
function calcEval(src) {
  const t = src.replace(/\s/g, "").replace(/,/g, ".").replace(/×/g, "*").replace(/[÷:]/g, "/").replace(/[−–]/g, "-");
  let i = 0;
  const num = () => {
    const m = /^\d*\.?\d+|^\d+\.?/.exec(t.slice(i));
    if (!m) throw 0;
    i += m[0].length; return parseFloat(m[0]);
  };
  const atom = () => {
    let v;
    if (t[i] === "-") { i++; return -atom(); }
    if (t[i] === "+") { i++; return atom(); }
    if (t[i] === "(") { i++; v = sum(); if (t[i++] !== ")") throw 0; } else v = num();
    while (t[i] === "%") { i++; v /= 100; }
    return v;
  };
  const prod = () => {
    let v = atom();
    while (t[i] === "*" || t[i] === "/") { const o = t[i++], r = atom(); if (o === "/" && r === 0) throw 0; v = o === "*" ? v * r : v / r; }
    return v;
  };
  const sum = () => {
    let v = prod();
    while (t[i] === "+" || t[i] === "-") { const o = t[i++], r = prod(); v = o === "+" ? v + r : v - r; }
    return v;
  };
  const v = sum();
  if (i < t.length || !isFinite(v)) throw 0;
  return Math.round(v * 1e9) / 1e9;
}

const CALC_KEYS = ["C", "⌫", "%", "÷", "7", "8", "9", "×", "4", "5", "6", "−", "1", "2", "3", "+", "0", ",", "(", ")"];
let calcEl = null;

function toggleCalc() {
  if (calcEl) { calcEl.remove(); calcEl = null; return; }
  calcEl = document.createElement("div");
  calcEl.id = "calc";
  calcEl.innerHTML = `<div class="calc-h"><span>Calcolatrice</span><button type="button" class="link" id="calc-x" aria-label="Chiudi">✕</button></div>
    <input id="calc-in" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="Espressione">
    <div class="calc-r" id="calc-r">&nbsp;</div>
    <div class="calc-g">${CALC_KEYS.map((k) => `<button type="button" data-k="${k}">${k}</button>`).join("")}
      <button type="button" data-k="copy" title="Copia il risultato">⧉</button><button type="button" class="primary calc-eq" data-k="=">=</button></div>`;
  place();
  const inp = calcEl.querySelector("#calc-in"), res = calcEl.querySelector("#calc-r");
  const fmt = (v) => String(v).replace(".", ",");
  const preview = () => {
    try { res.textContent = inp.value.trim() ? "= " + fmt(calcEval(inp.value)) : " "; res.classList.remove("neg"); }
    catch { res.textContent = "…"; }
  };
  const equals = () => {
    try { inp.value = fmt(calcEval(inp.value)); res.textContent = " "; }
    catch { res.textContent = "Espressione non valida"; res.classList.add("neg"); }
  };
  inp.oninput = preview;
  inp.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); equals(); }
    else if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); toggleCalc(); }
    else if (e.key === "*") { e.preventDefault(); ins("×"); }
    else if (e.key === "/") { e.preventDefault(); ins("÷"); }
  };
  const ins = (s) => {
    const a = inp.selectionStart ?? inp.value.length, b = inp.selectionEnd ?? a;
    inp.value = inp.value.slice(0, a) + s + inp.value.slice(b);
    inp.setSelectionRange(a + s.length, a + s.length); preview();
  };
  calcEl.querySelector(".calc-g").onclick = (e) => {
    const k = e.target.closest("[data-k]")?.dataset.k;
    if (!k) return;
    if (k === "C") { inp.value = ""; preview(); }
    else if (k === "⌫") { inp.value = inp.value.slice(0, -1); preview(); }
    else if (k === "=") equals();
    else if (k === "copy") { try { navigator.clipboard.writeText(inp.value.trim() ? fmt(calcEval(inp.value)) : ""); } catch {} }
    else ins(k);
    inp.focus();
  };
  calcEl.querySelector("#calc-x").onclick = toggleCalc;
  // trascinamento dall'intestazione
  const h = calcEl.querySelector(".calc-h");
  h.onpointerdown = (e) => {
    if (e.target.closest("button")) return;
    const r = calcEl.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    h.setPointerCapture(e.pointerId);
    h.onpointermove = (m) => {
      calcEl.style.left = Math.max(0, Math.min(innerWidth - r.width, m.clientX - dx)) + "px";
      calcEl.style.top = Math.max(0, Math.min(innerHeight - 40, m.clientY - dy)) + "px";
      calcEl.style.right = calcEl.style.bottom = "auto"; calcEl.style.transform = "none";
    };
    h.onpointerup = () => { h.onpointermove = h.onpointerup = null; };
  };
  inp.focus();
}

// una dialog modale rende inerte tutto il resto: la calcolatrice vi si sposta dentro finché è aperta
function place() {
  if (!calcEl) return;
  const host = dlg.open ? dlg : document.body;
  if (calcEl.parentNode !== host) host.append(calcEl);
}
new MutationObserver(place).observe(dlg, { childList: true });
dlg.addEventListener("close", place);

async function shell() {
  await loadSettings();
  app.innerHTML = `<header><h1 id="home"><img class="logo" src="/assets/logo-128.png" alt="">CloudCash</h1><nav id="menu">
      <div class="mg"><button class="mt" aria-haspopup="true">File</button><div class="mp">
        <button id="bi">Importa…</button><button id="be">Esporta GnuCash</button><button id="bx">Esporta XLSX</button><button id="bj">Backup JSON</button><hr><button id="bo">Esci</button></div></div>
      <div class="mg"><button class="mt" aria-haspopup="true">Strumenti</button><div class="mp">
        <button id="bcm">Calcolatrice</button><button id="bp">Impostazioni…</button></div></div>
    </nav><span class="sp"></span>
    <button id="bc" title="Calcolatrice" aria-label="Calcolatrice"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px"><rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M8.5 7h7"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01"/></svg></button><button id="bm" class="burger" aria-label="Menu" aria-expanded="false" aria-controls="menu"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="vertical-align:-4px"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button></header>
    <main id="main"></main><input type="file" id="file" accept=".gnucash,.xml,.gz,.json" hidden>`;
  $("#home").onclick = () => (location.hash = "");
  $("#bo").onclick = async () => { await api("/logout", { method: "POST" }); renderLogin(); };
  $("#be").onclick = () => (location.href = "/api/export");
  $("#bx").onclick = () => (location.href = "/api/export.xlsx");
  $("#bj").onclick = () => (location.href = "/api/backup");
  $("#bc").onclick = toggleCalc;
  const menu = $("#menu"), groups = [...menu.querySelectorAll(".mg")];
  const setMenu = (o) => { menu.classList.toggle("open", o); $("#bm")?.setAttribute("aria-expanded", o); };
  const closeGroups = (except) => groups.forEach((g) => g !== except && g.classList.remove("on"));
  $("#bm").onclick = (e) => { e.stopPropagation(); setMenu(!menu.classList.contains("open")); };
  groups.forEach((g) => {
    const t = g.querySelector(".mt");
    t.onclick = (e) => { e.stopPropagation(); closeGroups(g); g.classList.toggle("on"); };
    t.onmouseenter = () => { if (groups.some((x) => x.classList.contains("on"))) { closeGroups(g); g.classList.add("on"); } }; // stile barra dei menu: passando sopra si cambia menu
  });
  menu.onclick = (e) => { if (e.target.closest(".mp")) { closeGroups(); setMenu(false); } else e.stopPropagation(); };
  $("#bcm").onclick = toggleCalc;
  document.onclick = () => { if (menu.isConnected) { closeGroups(); setMenu(false); } };
  document.onkeydown = (e) => { if (e.key === "Escape" && menu.isConnected) { closeGroups(); setMenu(false); } };
  $("#bi").onclick = () => $("#file").click();
  $("#file").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f || !confirm("L'import SOSTITUISCE tutti i dati attuali con quelli del file. Continuare?")) return;
    const json = f.name.toLowerCase().endsWith(".json"); // backup JSON di CloudCash (con dettagli) oppure file GnuCash
    try {
      const r = await j(json ? "/restore" : "/import", { method: "POST", body: await f.arrayBuffer(), headers: { "content-type": json ? "application/json" : "application/octet-stream" } });
      alert(`${json ? "Ripristinati" : "Importati"} ${r.accounts} conti e ${r.transactions} transazioni.`);
      if (json) await loadSettings();
      location.hash = ""; route();
    } catch (err) { alert("Import fallito: " + err.message); }
  };
  $("#bp").onclick = settingsDialog;
}

// ---------- router ----------
window.addEventListener("hashchange", () => $("#main") && route());
async function route() {
  const m = $("#main"); if (!m) return;
  await loadAccounts();
  const reg = location.hash.match(/^#\/a\/(\w+)/);
  if (reg && byId.has(reg[1])) return viewRegister(byId.get(reg[1]));
  viewAccounts();
}

// ---------- impostazioni: salvate sul server (valgono su ogni dispositivo), con copia locale di riserva ----------
let settings = {};
const loadLocal = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
function saveSetting(key, value) {
  settings[key] = value;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  api("/settings/" + key, { method: "PUT", json: value }).catch(() => {}); // se fallisce resta la copia locale
}
async function loadSettings() {
  settings = await j("/settings").catch(() => ({}));
  const get = (k, def) => settings[k] ?? loadLocal(k, def);
  Object.assign(accSort, get("accSort", accSort));
  Object.assign(regSort, get("regSort", regSort));
  showHidden = !!get("showHidden", false);
  showRec = !!get("showRec", false);
  settings.theme = get("theme", "gnucash");
  settings.colorMode = get("colorMode", "no");
  applyLook();
}

// ---------- aspetto: tema (GnuCash / Bootstrap 5) e modalità notte (sì / no / auto) ----------
const THEMES = { gnucash: "GnuCash", bs5: "Bootstrap 5" };
const MODES = { no: "No (chiaro)", yes: "Sì (notte)", auto: "Automatica (sistema, altrimenti tramonto)" };
const darkMq = matchMedia("(prefers-color-scheme: dark)");
const lightMq = matchMedia("(prefers-color-scheme: light)");
const deviceHasScheme = () => darkMq.matches || lightMq.matches; // il dispositivo comunica una preferenza chiaro/scuro

// Alba e tramonto (equazione dell'alba, formule NOAA semplificate). Ritorna gli intervalli di luce [alba, tramonto] in ms.
function sunIntervals(lat, lon, now) {
  const R = Math.PI / 180, sin = (x) => Math.sin(x * R), cos = (x) => Math.cos(x * R);
  const jd = now / 86400000 + 2440587.5, out = [];
  for (let k = -1; k <= 1; k++) {
    const n = Math.ceil(jd - 2451545.0 + 0.0008) + k, js = n - lon / 360;
    const M = (357.5291 + 0.98560028 * js) % 360;
    const C = 1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M);
    const lam = (M + C + 180 + 102.9372) % 360;
    const transit = 2451545.0 + js + 0.0053 * sin(M) - 0.0069 * sin(2 * lam);
    const sd = sin(lam) * sin(23.4397), cd = Math.sqrt(1 - sd * sd);
    const x = (sin(-0.833) - sin(lat) * sd) / (cos(lat) * cd);
    if (x >= 1) continue;                                   // notte polare: nessuna luce
    if (x <= -1) return [[-Infinity, Infinity]];            // sole di mezzanotte
    const w = Math.acos(x) / R / 360, ms = (j) => (j - 2440587.5) * 86400000;
    out.push([ms(transit - w), ms(transit + w)]);
  }
  return out;
}
const GEO_DEFAULT = { lat: 41.9, lon: 12.5 }; // Roma, finché non conosciamo la posizione
let geo = null;
try { geo = JSON.parse(localStorage.getItem("geo")); } catch {}
async function ensureGeo() { // posizione approssimativa dalla rete di Cloudflare: niente permessi da chiedere
  if (geo && Date.now() - geo.t < 7 * 864e5) return;
  try { const g = await api("/location"); if (g.lat != null) { geo = { lat: g.lat, lon: g.lon, t: Date.now() }; try { localStorage.setItem("geo", JSON.stringify(geo)); } catch {} applyLook(); } } catch {}
}
function autoDark() {
  if (deviceHasScheme()) return darkMq.matches; // 1) il dispositivo ha la sua modalità automatica: la seguiamo
  const g = geo ?? GEO_DEFAULT, now = Date.now(); // 2) altrimenti: notte = prima dell'alba o dopo il tramonto
  return !sunIntervals(g.lat, g.lon, now).some(([r, s]) => now >= r && now < s);
}
function applyLook() {
  const mode = MODES[settings.colorMode] ? settings.colorMode : "no";
  const root = document.documentElement;
  root.dataset.theme = THEMES[settings.theme] ? settings.theme : "gnucash";
  const dark = mode === "yes" || (mode === "auto" && autoDark());
  root.dataset.dark = dark ? "1" : "0";
  if (mode === "auto") { try { localStorage.setItem("lastDark", dark ? "1" : "0"); } catch {} ensureGeo(); }
}
darkMq.addEventListener("change", applyLook); // in modalità automatica segue il sistema in tempo reale
lightMq.addEventListener("change", applyLook);
setInterval(() => settings.colorMode === "auto" && applyLook(), 60000); // senza preferenza di sistema segue il sole

// schede dentro la modale: pulsanti .tabs [data-t] che mostrano il blocco [data-tab] corrispondente
function bindTabs(onChange) {
  dlg.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
    dlg.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    dlg.querySelectorAll("[data-tab]").forEach((t) => (t.hidden = t.dataset.tab !== b.dataset.t));
    onChange?.(b.dataset.t);
  }));
}

const ACC_SORT_KEYS = { name: "Nome", type: "Tipo", code: "Codice", balance: "Saldo", total: "Totale" };
const REG_SORT_KEYS = { date: "Data", num: "N.", description: "Descrizione", other: "Trasferimento", amount: "Importo", balance: "Saldo" };
const DIRS = { 1: "Crescente (A→Z, dal più vecchio)", "-1": "Decrescente (Z→A, dal più recente)" };

// Un'unica modale per aspetto, ordinamento e password. Le scelte si salvano subito; la pagina sotto si aggiorna alla chiusura.
function settingsDialog() {
  const opts = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${String(k) === String(cur) ? "selected" : ""}>${v}</option>`).join("");
  const regKeys = showRec ? { ...REG_SORT_KEYS, rec: "R (riconciliazione)" } : REG_SORT_KEYS;
  dlg.innerHTML = `<form id="sf"><h3>Impostazioni</h3>
    <div class="tabs"><button type="button" class="on" data-t="a">Aspetto</button><button type="button" data-t="o">Ordinamento</button><button type="button" data-t="p">Password</button></div>

    <div data-tab="a">
      <label>Tema</label><select id="st">${opts(THEMES, settings.theme)}</select>
      <label>Modalità notte</label><select id="sm">${opts(MODES, settings.colorMode)}</select>
    </div>

    <div data-tab="o" hidden>
      <h4 style="margin:12px 0 0">Piano dei conti</h4>
      <div class="row"><div><label>Ordina per</label><select id="ak">${opts(ACC_SORT_KEYS, accSort.key)}</select></div>
      <div><label>Direzione</label><select id="ad2">${opts(DIRS, accSort.dir)}</select></div></div>
      <h4 style="margin:16px 0 0">Registro del conto</h4>
      <div class="row"><div><label>Ordina per</label><select id="rk">${opts(regKeys, regSort.key)}</select></div>
      <div><label>Direzione</label><select id="rd">${opts(DIRS, regSort.dir)}</select></div></div>
      <p class="mut small">Puoi cambiarlo anche cliccando sull'intestazione di una colonna.</p>
    </div>

    <div data-tab="p" hidden>
      <label>Password attuale</label><input id="pc" type="password" autocomplete="current-password">
      <label>Nuova password (min. 8 caratteri)</label><input id="pn" type="password" autocomplete="new-password">
      <label>Ripeti la nuova password</label><input id="pr" type="password" autocomplete="new-password">
      <div class="err" id="pe"></div>
      <button type="button" class="primary" id="pg">Cambia password</button>
    </div>

    <p class="mut small" id="sn">Le scelte sono salvate nel tuo account e valgono su ogni dispositivo.</p>
    <div class="foot"><span class="sp"></span><button type="button" class="primary" id="sx">Chiudi</button></div></form>`;
  dlg.showModal();
  bindTabs((t) => ($("#sn").hidden = t === "p"));

  let resort = false;
  $("#st").onchange = (e) => { settings.theme = e.target.value; saveSetting("theme", settings.theme); applyLook(); };
  $("#sm").onchange = (e) => { settings.colorMode = e.target.value; saveSetting("colorMode", settings.colorMode); applyLook(); };
  const sortBinding = (keyId, dirId, st, name) => {
    const save = () => { st.key = $(keyId).value; st.dir = +$(dirId).value; saveSetting(name, { key: st.key, dir: st.dir }); resort = true; };
    $(keyId).onchange = $(dirId).onchange = save;
  };
  sortBinding("#ak", "#ad2", accSort, "accSort");
  sortBinding("#rk", "#rd", regSort, "regSort");

  const changePassword = async () => {
    const [cur, next, again] = [$("#pc").value, $("#pn").value, $("#pr").value];
    $("#pe").classList.add("neg");
    if (!cur) return ($("#pe").textContent = "Inserisci la password attuale");
    if (next.length < 8) return ($("#pe").textContent = "La nuova password deve avere almeno 8 caratteri");
    if (next !== again) return ($("#pe").textContent = "Le due nuove password non coincidono");
    try {
      await api("/password", { json: { current: cur, next } });
      ["#pc", "#pn", "#pr"].forEach((i) => ($(i).value = ""));
      $("#pe").classList.remove("neg"); $("#pe").textContent = "Password aggiornata ✓";
    } catch (err) { $("#pe").textContent = err.message; }
  };
  $("#pg").onclick = changePassword;
  // Invio nei campi password = cambia password; altrove non deve chiudere la modale
  $("#sf").onsubmit = (e) => { e.preventDefault(); if (!$('[data-tab="p"]').hidden) changePassword(); };
  const close = () => dlg.close();
  $("#sx").onclick = close;
  dlg.addEventListener("close", () => { if (resort) route(); }, { once: true });
}

// ---------- ordinamento ----------
const accSort = { key: "name", dir: 1 };
const regSort = { key: "date", dir: -1 };
let showRec = false;
const cmp = (a, b) => (typeof a === "string" ? a.localeCompare(b, "it") : a - b);
function sortTh(label, key, st, cls = "") {
  const arrow = st.key === key ? (st.dir > 0 ? " ▲" : " ▼") : "";
  return `<th class="${cls}" data-sort="${key}" style="cursor:pointer;user-select:none">${label}${arrow}</th>`;
}
function bindSort(st, name, redraw) {
  document.querySelectorAll("th[data-sort]").forEach((th) => (th.onclick = () => {
    const k = th.dataset.sort;
    st.dir = st.key === k ? -st.dir : (k === "date" || k === "balance" || k === "total" || k === "amount" ? -1 : 1);
    st.key = k;
    saveSetting(name, { key: st.key, dir: st.dir });
    redraw();
  }));
}

// ---------- albero dei conti ----------
let showHidden = false;
function viewAccounts() {
  const rows = [];
  (function walk(a, depth) {
    const key = { name: (x) => x.name, type: (x) => TYPE_IT[x.type] ?? x.type, total: (x) => x.total * sign(x), balance: (x) => x.balance * sign(x), code: (x) => x.code }[accSort.key];
    for (const k of [...a.kids].sort((x, y) => cmp(key(x), key(y)) * accSort.dir)) {
      if (k.hidden && !showHidden) continue;
      // limiti di saldo (come GnuCash): avviso se il saldo di oggi esce dall'intervallo
      const lv = (k.limit_subs ? k.total_today : k.balance_today) * sign(k);
      const warn = (k.limit_high !== null && lv > k.limit_high) || (k.limit_low !== null && lv < k.limit_low);
      rows.push(`<tr class="click ${k.hidden ? "hid" : ""}" data-id="${k.id}"><td style="padding-left:${10 + depth * 18}px">${k.color ? `<span class="sw" style="background:${esc(k.color)}"></span>` : ""}${esc(k.name)}${k.placeholder ? ' <span class="mut">·segnaposto</span>' : ""}</td>
        <td class="hide-sm">${TYPE_IT[k.type] ?? k.type}</td>
        <td class="hide-md mut">${esc(k.code)}</td>
        <td class="hide-md">${esc(k.description)}</td>
        <td class="num hide-md ${k.balance * sign(k) < 0 ? "neg" : ""}">${k.placeholder && !k.balance ? "" : money(k.balance * sign(k))}</td>
        <td class="num ${k.total * sign(k) < 0 || warn ? "neg" : ""}">${warn ? '<span title="Il saldo supera i limiti impostati">⚠ </span>' : ""}${money(k.total * sign(k))}</td>
        <td class="num"><button class="link" data-edit="${k.id}">modifica</button></td></tr>`);
      walk(k, depth + 1);
    }
  })(root(), 0);
  $("#main").innerHTML = `<div class="bar"><h2>Piano dei conti</h2>
      <label class="mut"><input type="checkbox" id="sh" style="width:auto" ${showHidden ? "checked" : ""}> nascosti</label>
      <button class="primary" id="na">Nuovo conto</button></div>
    <div class="card"><table><thead><tr>${sortTh("Conto", "name", accSort)}${sortTh("Tipo", "type", accSort, "hide-sm")}${sortTh("Codice", "code", accSort, "hide-md")}<th class="hide-md">Descrizione</th>${sortTh("Saldo", "balance", accSort, "num hide-md")}${sortTh("Totale", "total", accSort, "num")}<th></th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="7" class="mut">Nessun conto. Importa un file .gnucash o creane uno.</td></tr>'}</tbody></table></div>`;
  bindSort(accSort, "accSort", viewAccounts);
  $("#sh").onchange = (e) => { showHidden = e.target.checked; saveSetting("showHidden", showHidden); viewAccounts(); };
  $("#na").onclick = () => accountDialog();
  document.querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest("button")) location.hash = "#/a/" + tr.dataset.id; }));
  document.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => accountDialog(byId.get(b.dataset.edit))));
}

function accountOptions(selected, { onlyPostable = false, exclude = null } = {}) {
  const banned = new Set();
  if (exclude) (function mark(a) { banned.add(a.id); a.kids.forEach(mark); })(byId.get(exclude));
  return accounts.filter((a) => (a.type !== "ROOT" || !onlyPostable) && !(onlyPostable && a.placeholder) && !banned.has(a.id))
    .sort((a, b) => a.full.localeCompare(b.full, "it"))
    .map((a) => `<option value="${a.id}" ${a.id === selected ? "selected" : ""}>${esc(a.type === "ROOT" ? "(radice)" : a.full)}</option>`).join("");
}

function accountDialog(acc) {
  const isNew = !acc;
  const a = acc ?? { name: "", code: "", type: "EXPENSE", parent_id: root().id, description: "", notes: "", color: "", placeholder: 0, hidden: 0, tax_related: 0, opening_balance: 0, limit_high: null, limit_low: null, limit_subs: 0 };
  let color = a.color;
  const today0 = lastDate ?? today();
  const ck = (v) => (v ? "checked" : "");
  dlg.innerHTML = `<form method="dialog" id="af"><h3 id="at">${isNew ? "Nuovo conto" : "Modifica conto"}</h3>
    <div class="tabs"><button type="button" class="on" data-t="g">Generale</button><button type="button" data-t="m">Altre proprietà</button>${isNew ? '<button type="button" data-t="o">Saldo iniziale</button>' : ""}</div>

    <div data-tab="g">
      <div class="row"><div><label>Nome del conto</label><input name="name" value="${esc(a.name)}" required autocomplete="off"></div>
      <div style="flex:.4"><label>Codice</label><input name="code" value="${esc(a.code)}" autocomplete="off"></div></div>
      <label>Descrizione</label><input name="description" value="${esc(a.description)}">
      <div class="row"><div><label>Conto padre</label><select name="parent_id" size="1">${accountOptions(a.parent_id, { exclude: acc?.id })}</select></div>
      <div><label>Tipo di conto</label><select name="type"></select></div></div>
      <div class="row"><div><label>Colore</label><div class="row" style="align-items:center"><input type="color" id="co" value="${color || "#edeceb"}" style="flex:none;width:56px;padding:1px"><button type="button" id="cd">Predefinito</button></div></div><div></div></div>
      <label>Note</label><textarea name="notes" rows="3">${esc(a.notes)}</textarea>
      <div class="checks">
        <label><input type="checkbox" name="placeholder" ${ck(a.placeholder)}> Segnaposto <span class="mut">(accetta movimenti solo nei sottoconti)</span></label>
        <label><input type="checkbox" name="hidden" ${ck(a.hidden)}> Nascosto</label>
        <label id="obl"><input type="checkbox" name="opening_balance" ${ck(a.opening_balance)}> Conto dei saldi di apertura <span class="mut">(uno solo)</span></label>
        <label><input type="checkbox" name="tax_related" ${ck(a.tax_related)}> Rilevante ai fini fiscali</label>
      </div>
    </div>

    <div data-tab="m" hidden>
      <p class="mut">Mostra un avviso nel piano dei conti quando il saldo di oggi esce dall'intervallo. Lascia vuoto per nessun avviso.</p>
      <div class="row"><div><label>Limite di saldo superiore</label><input name="limit_high" inputmode="decimal" value="${centsStr(a.limit_high)}"></div>
      <div><label>Limite di saldo inferiore</label><input name="limit_low" inputmode="decimal" value="${centsStr(a.limit_low)}"></div></div>
      <div class="checks"><label><input type="checkbox" name="limit_subs" ${ck(a.limit_subs)}> Includi i sottoconti</label></div>
    </div>

    ${isNew ? `<div data-tab="o" hidden>
      <p class="mut" id="onote">Se il conto parte con un saldo, viene registrata una transazione di apertura.</p>
      <div id="ofields"><div class="row"><div><label>Saldo</label><input name="ob" inputmode="decimal" placeholder="0,00"></div>
      <div><label>Data</label><input type="date" name="od" value="${today0}"></div></div>
      <label>Contropartita</label>
      <div class="checks"><label><input type="radio" name="om" value="equity" checked> Usa il conto «Saldi di apertura» (Patrimonio netto)</label>
      <label><input type="radio" name="om" value="account"> Scegli un conto di trasferimento</label></div>
      <select name="ot" disabled><option value="">—</option>${accountOptions(null, { onlyPostable: true })}</select></div>
    </div>` : ""}

    <div class="err" id="ae"></div>
    <div class="foot">${isNew ? "" : '<button type="button" class="danger" id="ad">Elimina</button>'}<span class="sp"></span><button type="button" id="ax">Annulla</button><button class="primary">Salva</button></div></form>`;

  const form = $("#af"), el = (n) => form.elements[n];
  bindTabs();
  // il tipo dipende dal padre (stesse regole di GnuCash); se il tipo attuale non è più ammesso passa al primo valido
  const refreshTypes = () => {
    const ptype = byId.get(el("parent_id").value)?.type ?? "ROOT";
    const ok = childTypes(ptype), cur = el("type").value || a.type;
    const list = SELECTABLE_TYPES.filter((t) => ok.includes(t));
    if (ok.includes(cur) && !list.includes(cur)) list.push(cur); // tipo esistente non selezionabile (es. Azioni)
    el("type").innerHTML = list.map((t) => `<option value="${t}" ${t === cur ? "selected" : ""}>${TYPE_IT[t] ?? t}</option>`).join("");
    refreshFlags();
  };
  const refreshFlags = () => {
    const eq = el("type").value === "EQUITY";
    $("#obl").style.display = eq ? "" : "none";
    if (!eq) el("opening_balance").checked = false;
    if (isNew) {
      const off = eq || el("placeholder").checked;
      $("#ofields").hidden = off;
      $("#onote").textContent = off ? "Un conto Patrimonio netto o segnaposto non può avere un saldo iniziale." : "Se il conto parte con un saldo, viene registrata una transazione di apertura. Il saldo va inserito nel segno mostrato nel piano dei conti.";
    }
  };
  el("parent_id").onchange = refreshTypes;
  el("type").onchange = refreshFlags; el("placeholder").onchange = refreshFlags;
  el("type").value = a.type; refreshTypes();
  $("#co").oninput = (e) => (color = e.target.value);
  $("#cd").onclick = () => { color = ""; $("#co").value = "#edeceb"; };
  if (isNew) form.querySelectorAll("[name=om]").forEach((r) => (r.onchange = () => (el("ot").disabled = form.querySelector("[name=om]:checked").value !== "account")));

  dlg.showModal();
  $("#ax").onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const lim = (n) => (el(n).value.trim() === "" ? null : parseAmount(el(n).value));
    const body = { name: el("name").value, code: el("code").value, description: el("description").value, parent_id: el("parent_id").value, type: el("type").value,
      color, notes: el("notes").value, placeholder: el("placeholder").checked, hidden: el("hidden").checked, tax_related: el("tax_related").checked,
      opening_balance: el("opening_balance").checked, limit_high: lim("limit_high"), limit_low: lim("limit_low"), limit_subs: el("limit_subs").checked };
    if ([body.limit_high, body.limit_low].some(Number.isNaN)) return ($("#ae").textContent = "Limite di saldo non valido");
    if (isNew && !$("#ofields").hidden) {
      const amount = parseAmount(el("ob").value);
      if (Number.isNaN(amount)) return ($("#ae").textContent = "Saldo iniziale non valido");
      if (amount) {
        const mode = form.querySelector("[name=om]:checked").value;
        if (mode === "account" && !el("ot").value) return ($("#ae").textContent = "Scegli il conto di trasferimento");
        body.opening = { amount, date: el("od").value, mode, transfer_id: el("ot").value };
        lastDate = el("od").value;
      }
    }
    try { await api(isNew ? "/accounts" : "/accounts/" + acc.id, { json: body, method: isNew ? "POST" : "PUT" }); }
    catch (err) {
      // sottoconti incompatibili col nuovo tipo: come GnuCash, si chiede conferma e si convertono
      if (err.status === 409 && confirm(err.message + ".\nConvertirli al nuovo tipo?")) {
        try { await api("/accounts/" + acc.id, { json: { ...body, retype_children: true }, method: "PUT" }); } catch (e2) { return ($("#ae").textContent = e2.message); }
      } else return ($("#ae").textContent = err.message);
    }
    dlg.close(); route();
  };
  if (!isNew) $("#ad").onclick = () => deleteAccount(acc);
}

async function deleteAccount(acc) {
  if (!confirm(`Eliminare il conto "${acc.full}"?`)) return;
  try { await api("/accounts/" + acc.id, { method: "DELETE" }); }
  catch (err) {
    if (err.status !== 409) return alert(err.message);
    dlg.innerHTML = `<form method="dialog" id="mf"><h3>Sposta e elimina</h3><p>Il conto contiene movimenti o sottoconti. Scegli il conto in cui spostarli.</p>
      <select name="to">${accountOptions(null, { exclude: acc.id, onlyPostable: false })}</select>
      <div class="foot"><span class="sp"></span><button type="button" id="mx">Annulla</button><button class="danger">Sposta ed elimina</button></div></form>`;
    $("#mx").onclick = () => dlg.close();
    $("#mf").onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/accounts/${acc.id}?moveTo=${new FormData(e.target).get("to")}`, { method: "DELETE" }); dlg.close(); location.hash = ""; route(); }
      catch (e2) { alert(e2.message); }
    };
    return;
  }
  dlg.close(); location.hash = ""; route();
}

// ---------- registro ----------
async function viewRegister(acc) {
  if (!showRec && regSort.key === "rec") regSort.key = "date"; // non si ordina per una colonna nascosta
  const rows = await j(`/accounts/${acc.id}/register`);
  const [cd, cc] = COLS[acc.type] ?? ["Dare", "Avere"];
  const sg = sign(acc);
  const rkey = { date: (r) => r.date_posted, num: (r) => r.num, description: (r) => r.description,
    other: (r) => (r.others > 1 ? "-- Split --" : byId.get(r.other_account)?.full ?? ""), rec: (r) => r.reconciled,
    amount: (r) => r.amount * sg, balance: (r) => r.balance * sg }[regSort.key];
  // sort stabile: a parità di chiave resta l'ordine cronologico del server
  const ordered = rows.map((r, i) => [r, i]).sort((a, b) => cmp(rkey(a[0]), rkey(b[0])) * regSort.dir || (a[1] - b[1]) * regSort.dir).map((x) => x[0]);
  // riga di inserimento sempre pronta, alla "fine" in ordine cronologico (in alto se la data è ordinata dal più recente)
  const entryPos = regSort.key === "date" && regSort.dir < 0 ? "top" : "bottom";
  const entry = acc.placeholder ? "" : `<tr class="entry"><td><input type="date" name="d" value="${lastDate ?? today()}"></td>
    <td class="hide-sm"><input name="n" autocomplete="off"></td>
    <td><input name="ds" list="descs" autocomplete="off" placeholder="Nuova transazione…"></td>
    <td class="hide-sm"><select name="t"><option value="">Trasferimento</option>${accountOptions(null, { onlyPostable: true })}</select></td>${showRec ? "<td></td>" : ""}
    <td><input class="num" name="dr" inputmode="decimal" placeholder="${cd}"></td><td><input class="num" name="cr" inputmode="decimal" placeholder="${cc}"></td><td></td></tr>`;
  const lines = ordered.map((r) => {
    const v = r.amount, other = r.others > 1 ? "-- Split --" : byId.get(r.other_account)?.full ?? "";
    return `<tr class="click" data-tx="${r.tx_id}"><td>${fmtDate(r.date_posted)}</td><td class="hide-sm">${r.num ? `<a href="#" class="ser" data-num="${esc(r.num)}">${esc(r.num)}${r.series_n > 1 ? ` ×${r.series_n}` : ""}</a>` : ""}</td><td>${esc(r.description)}${r.has_details ? ' <span title="Ha dettagli">📝</span>' : ""}${other ? `<div class="only-sm mut small">${esc(other)}</div>` : ""}</td>
      <td class="hide-sm mut">${esc(other)}</td>
      ${showRec ? `<td class="num"><span class="rec" data-split="${r.split_id}" data-st="${r.reconciled}" title="Stato riconciliazione">${r.reconciled}</span></td>` : ""}
      <td class="num hide-sm ${v * sg < 0 ? "neg" : ""}">${v > 0 ? money(v) : ""}</td><td class="num hide-sm ${v * sg < 0 ? "neg" : ""}">${v < 0 ? money(-v) : ""}</td>
      <td class="num only-sm ${v * sg < 0 ? "neg" : ""}">${money(v * sg)}</td>
      <td class="num ${r.balance * sg < 0 ? "neg" : ""}">${money(r.balance * sg)}</td></tr>`;
  });
  $("#main").innerHTML = `<div class="bar"><h2><span class="crumb" id="back">Conti</span> › ${esc(acc.full)}</h2>
      <label class="mut"><input type="checkbox" id="sr" style="width:auto" ${showRec ? "checked" : ""}> colonna R</label>
      <button class="primary" id="nt" ${acc.placeholder ? "disabled" : ""}>Nuova transazione</button></div>
    <div class="card" style="overflow-x:auto"><table class="reg"><thead><tr>${sortTh("Data", "date", regSort)}${sortTh("N.", "num", regSort, "hide-sm")}${sortTh("Descrizione", "description", regSort)}${sortTh("Trasferimento", "other", regSort, "hide-sm")}${showRec ? sortTh("R", "rec", regSort, "num") : ""}
      <th class="num hide-sm" data-sort="amount" style="cursor:pointer">${cd}</th><th class="num hide-sm" data-sort="amount" style="cursor:pointer">${cc}</th>${sortTh("Importo", "amount", regSort, "num only-sm")}${sortTh("Saldo", "balance", regSort, "num")}</tr></thead>
      <tbody>${entryPos === "top" ? entry + lines.join("") : lines.join("") + entry}</tbody></table></div>
    <div class="err" id="ee"></div><datalist id="descs">${[...new Set(rows.map((r) => r.description))].map((d) => `<option value="${esc(d)}">`).join("")}</datalist>`;
  $("#back").onclick = () => (location.hash = "");
  bindSort(regSort, "regSort", () => viewRegister(acc));
  $("#sr").onchange = (e) => { showRec = e.target.checked; saveSetting("showRec", showRec); viewRegister(acc); };
  $("#nt").onclick = () => txDialog(null, acc);
  bindEntry($(".entry"), acc, rows);
  document.querySelectorAll("tr[data-tx]").forEach((tr) => (tr.onclick = (e) => {
    const ser = e.target.closest(".ser");
    if (ser) { e.preventDefault(); return seriesDialog(ser.dataset.num); }
    const rec = e.target.closest(".rec");
    if (rec) return cycleRec(rec, acc);
    txDialog(tr.dataset.tx, acc);
  }));
}

// ---------- riga di inserimento rapido ----------
let lastDate = null; // come GnuCash: la data dell'ultimo inserimento resta come predefinita
function bindEntry(tr, acc, rows) {
  if (!tr) return;
  const g = (n) => tr.querySelector(`[name=${n}]`), err = (m) => ($("#ee").textContent = m);
  // scelta di una descrizione già usata: precompila trasferimento e importo dall'ultima occorrenza
  g("ds").onchange = () => {
    const prev = [...rows].reverse().find((r) => r.description === g("ds").value && r.others === 1);
    if (!prev || g("t").value || g("dr").value || g("cr").value) return;
    g("t").value = prev.other_account;
    (prev.amount > 0 ? g("dr") : g("cr")).value = (Math.abs(prev.amount) / 100).toFixed(2).replace(".", ",");
  };
  async function commit(explicit) {
    if (tr.dataset.busy) return;
    const d = parseAmount(g("dr").value), c = parseAmount(g("cr").value);
    if (Number.isNaN(d) || Number.isNaN(c)) return explicit && err("Importo non valido");
    const amount = d - c;
    if (!g("d").value || !g("t").value || !amount) return explicit && err("Servono data, trasferimento e un importo");
    tr.dataset.busy = 1; err("");
    try {
      await api("/transactions", { json: { date_posted: g("d").value, num: g("n").value, description: g("ds").value,
        splits: [{ account_id: acc.id, amount }, { account_id: g("t").value, amount: -amount }] } });
      lastDate = g("d").value;
      await viewRegister(acc);
      $(".entry [name=ds]")?.focus(); // pronto per la successiva
    } catch (e) { delete tr.dataset.busy; err(e.message); }
  }
  tr.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); commit(true); } });
  // uscendo dalla riga, se è completa viene registrata (e si sposta al suo posto cronologico)
  tr.addEventListener("focusout", (e) => { if (!tr.contains(e.relatedTarget)) commit(false); });
}

// n -> c -> y -> n (come GnuCash: non riconciliato, liquidato, riconciliato)
async function cycleRec(el, acc) {
  const next = { n: "c", c: "y", y: "n" }[el.dataset.st];
  await api(`/splits/${el.dataset.split}/reconcile`, { method: "PATCH", json: { state: next } });
  el.dataset.st = el.textContent = next;
}

// ---------- serie di movimenti con lo stesso N. ----------
async function seriesDialog(num) {
  const d = await j("/series/" + encodeURIComponent(num));
  const nm = (id) => esc(byId.get(id)?.full ?? "?");
  const closed = d.net.every((n) => n.amount === 0);
  dlg.innerHTML = `<div><h3>Serie ${esc(num)} <span class="${closed ? "" : "neg"}" style="font-size:14px">${closed ? "· chiusa ✓" : "· aperta"}</span></h3>
    <table><thead><tr><th>Data</th><th>Descrizione</th><th>Movimenti</th></tr></thead><tbody>
    ${d.transactions.map((t) => `<tr class="click" data-tx="${t.id}"><td>${fmtDate(t.date_posted)}</td><td>${esc(t.description)}</td>
      <td>${t.splits.map((s) => `<div>${nm(s.account_id)} <span class="${s.amount < 0 ? "neg" : ""}">${money(s.amount)}</span></div>`).join("")}</td></tr>`).join("")}</tbody></table>
    <h4>Netto per conto (dare − avere)</h4>
    <table><tbody>${d.net.map((n) => `<tr><td>${nm(n.account_id)}</td><td class="num ${n.amount < 0 ? "neg" : ""}">${money(n.amount)}</td></tr>`).join("")}</tbody></table>
    <div class="foot"><span class="sp"></span><button id="sx" class="primary">Chiudi</button></div></div>`;
  dlg.showModal();
  $("#sx").onclick = () => dlg.close();
  dlg.querySelectorAll("tr[data-tx]").forEach((tr) => (tr.onclick = () => { dlg.close(); txDialog(tr.dataset.tx, null); }));
}

// ---------- editor rich text (Quill, caricato solo quando serve) ----------
const loadScript = (src) => new Promise((ok, ko) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => ko(new Error("Impossibile caricare " + src)); document.head.append(s); });
let libs;
function loadEditorLibs() {
  return (libs ??= (async () => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "https://cdnjs.cloudflare.com/ajax/libs/quill/2.0.2/quill.snow.min.css"; document.head.append(l);
    await Promise.all([loadScript("https://cdnjs.cloudflare.com/ajax/libs/quill/2.0.2/quill.min.js"), loadScript("https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js")]);
  })().catch((e) => { libs = null; throw e; }));
}
// restituisce null se le librerie non sono raggiungibili: il resto del dialog funziona comunque
async function makeEditor(el, html) {
  try { await loadEditorLibs(); } catch { el.textContent = "Editor non disponibile (offline?)"; return null; }
  const q = new Quill(el, { theme: "snow", modules: { toolbar: [[{ header: [2, 3, false] }], ["bold", "italic", "underline", "strike"], [{ list: "ordered" }, { list: "bullet" }], ["blockquote", "link"], ["clean"]] } });
  q.clipboard.dangerouslyPasteHTML(DOMPurify.sanitize(html)); // sempre sanificato prima di mostrarlo
  q.history.clear();
  return q;
}
const editorHtml = (q) => (q ? (q.getText().trim() ? DOMPurify.sanitize(q.getSemanticHTML().replace(/&nbsp;/g, " ")) : "") : undefined);

// ---------- dialog transazione ----------
async function txDialog(id, acc) {
  const t = id ? await j("/transactions/" + id)
    : { date_posted: today(), num: "", description: "", notes: "", splits: [{ account_id: acc.id, amount: 0, memo: "", reconciled: "n" }, { account_id: "", amount: 0, memo: "", reconciled: "n" }] };
  const splits = t.splits.map((s) => ({ ...s }));
  dlg.innerHTML = `<form method="dialog" id="tf"><h3>${id ? "Modifica" : "Nuova"} transazione</h3>
    <div class="row"><div><label>Data</label><input type="date" name="date_posted" value="${t.date_posted}" required></div><div><label>N. (serie)</label><input name="num" value="${esc(t.num)}" list="nums" autocomplete="off"><datalist id="nums"></datalist></div></div>
    <label>Descrizione</label><input name="description" value="${esc(t.description)}" list="descs" autocomplete="off" required>
    <datalist id="descs"></datalist>
    <label>Note</label><input name="notes" value="${esc(t.notes)}">
    <label>Dettagli</label><div id="ed" class="ed"></div>
    <label>Movimenti (Dare = positivo, Avere = negativo nel registro del conto)</label>
    <table class="splits"><thead><tr><th>Conto</th><th>Memo</th><th class="num">Dare</th><th class="num">Avere</th><th></th></tr></thead><tbody id="sp"></tbody></table>
    <button type="button" class="link" id="as">+ split</button>
    <div id="diff" class="mut"></div><div class="err" id="te"></div>
    <div class="foot">${id ? '<button type="button" class="danger" id="td">Elimina</button>' : ""}<span class="sp"></span><button type="button" id="tx">Annulla</button><button class="primary">Salva</button></div></form>`;

  j("/series").then((l) => ($("#nums").innerHTML = l.map((x) => `<option value="${esc(x.num)}">${x.n} movimenti</option>`).join(""))).catch(() => {});
  const quill = await makeEditor($("#ed"), t.details ?? "");
  const touched = new Set();
  const draw = () => {
    $("#sp").innerHTML = splits.map((s, i) => `<tr>
      <td><select data-i="${i}" data-f="account_id"><option value="">—</option>${accountOptions(s.account_id, { onlyPostable: true })}</select></td>
      <td><input data-i="${i}" data-f="memo" placeholder="Memo" value="${esc(s.memo)}"></td>
      <td><input class="num" inputmode="decimal" placeholder="Dare" data-i="${i}" data-f="d" value="${s.amount > 0 ? (s.amount / 100).toFixed(2).replace(".", ",") : ""}"></td>
      <td><input class="num" inputmode="decimal" placeholder="Avere" data-i="${i}" data-f="c" value="${s.amount < 0 ? (-s.amount / 100).toFixed(2).replace(".", ",") : ""}"></td>
      <td>${splits.length > 2 ? `<button type="button" class="link danger" data-rm="${i}">✕</button>` : ""}</td></tr>`).join("");
    diff();
  };
  const diff = () => {
    const sum = splits.reduce((a, s) => a + (s.amount || 0), 0);
    $("#diff").innerHTML = sum ? `Differenza da bilanciare: <b class="neg">${money(sum)}</b>` : "Bilanciata ✓";
  };
  draw();
  $("#sp").onchange = $("#sp").oninput = (e) => {
    const el = e.target, i = +el.dataset.i, f = el.dataset.f; if (f === undefined) return;
    const s = splits[i];
    if (f === "account_id" || f === "memo") { s[f] = el.value; return; }
    const v = parseAmount(el.value);
    if (Number.isNaN(v)) return;
    s.amount = f === "d" ? v : -v;
    touched.add(i);
    // con due split non ancora toccati il secondo si bilancia da solo
    if (splits.length === 2 && !touched.has(1 - i)) {
      splits[1 - i].amount = -s.amount;
      const other = $("#sp").querySelectorAll("tr")[1 - i].querySelectorAll("input.num");
      other[0].value = -s.amount > 0 ? (-s.amount / 100).toFixed(2).replace(".", ",") : "";
      other[1].value = -s.amount < 0 ? (s.amount / 100).toFixed(2).replace(".", ",") : "";
    }
    // svuota il campo opposto della stessa riga (dare/avere sono esclusivi)
    const mine = el.closest("tr").querySelectorAll("input.num");
    if (v !== 0) mine[f === "d" ? 1 : 0].value = "";
    diff();
  };
  $("#sp").onclick = (e) => { const i = e.target.dataset.rm; if (i !== undefined) { splits.splice(+i, 1); draw(); } };
  $("#as").onclick = () => { splits.push({ account_id: "", amount: 0, memo: "", reconciled: "n" }); draw(); };
  $("#tx").onclick = () => dlg.close();
  if (id) $("#td").onclick = async () => { if (confirm("Eliminare la transazione?")) { await api("/transactions/" + id, { method: "DELETE" }); dlg.close(); route(); } };
  $("#tf").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    // split completamente vuoti vengono ignorati
    const used = splits.filter((s) => s.account_id || s.amount);
    if (used.some((s) => !s.account_id)) return ($("#te").textContent = "Seleziona il conto per ogni split con importo");
    const body = { date_posted: f.get("date_posted"), num: f.get("num"), description: f.get("description"), notes: f.get("notes"), details: quill ? editorHtml(quill) : t.details ?? "", splits: used };
    try { await api(id ? "/transactions/" + id : "/transactions", { json: body, method: id ? "PUT" : "POST" }); dlg.close(); route(); }
    catch (err) { $("#te").textContent = err.message; }
  };
  dlg.showModal();
}

boot();
