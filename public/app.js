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
const COLS = { BANK: ["Deposito", "Prelievo"], CASH: ["Ricevuta", "Spesa"], EXPENSE: ["Spesa", "Rimborso"], INCOME: ["Addebito", "Entrata"], ASSET: ["Aumento", "Diminuzione"], LIABILITY: ["Pagamento", "Aumento"], CREDIT: ["Pagamento", "Addebito"], EQUITY: ["Decremento", "Aumento"] };
const sign = (a) => (CREDIT_NORMAL.has(a.type) ? -1 : 1);

async function loadAccounts() {
  accounts = await j("/accounts");
  byId = new Map(accounts.map((a) => [a.id, a]));
  const kids = new Map();
  for (const a of accounts) (kids.get(a.parent_id) ?? kids.set(a.parent_id, []).get(a.parent_id)).push(a);
  for (const l of kids.values()) l.sort((a, b) => a.name.localeCompare(b.name, "it"));
  const calc = (a) => (a.total = a.balance + (kids.get(a.id) ?? []).reduce((s, k) => s + calc(k), 0));
  accounts.filter((a) => !a.parent_id).forEach(calc);
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
  app.innerHTML = `<form class="card login" id="lf"><h1>CloudCash</h1>
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

async function shell() {
  await loadSettings();
  app.innerHTML = `<header><h1 id="home">CloudCash</h1><span class="sp"></span>
    <button id="bi">Importa</button><button id="be">Esporta</button><button id="bx" class="hide-sm">Esporta XLSX</button><button id="bj" class="hide-sm">Backup JSON</button><button id="bp" class="hide-sm">Password</button><button id="bo">Esci</button></header>
    <main id="main"></main><input type="file" id="file" accept=".gnucash,.xml,.gz,.json" hidden>`;
  $("#home").onclick = () => (location.hash = "");
  $("#bo").onclick = async () => { await api("/logout", { method: "POST" }); renderLogin(); };
  $("#be").onclick = () => (location.href = "/api/export");
  $("#bx").onclick = () => (location.href = "/api/export.xlsx");
  $("#bj").onclick = () => (location.href = "/api/backup");
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
  $("#bp").onclick = changePassword;
}

function changePassword() {
  dlg.innerHTML = `<form method="dialog" id="pf"><h3>Cambia password</h3>
    <label>Password attuale</label><input name="current" type="password" autocomplete="current-password" required>
    <label>Nuova password (min. 8)</label><input name="next" type="password" autocomplete="new-password" required minlength="8">
    <div class="err" id="pe"></div><div class="foot"><span class="sp"></span><button type="button" id="px">Annulla</button><button class="primary">Salva</button></div></form>`;
  dlg.showModal();
  $("#px").onclick = () => dlg.close();
  $("#pf").onsubmit = async (e) => {
    e.preventDefault();
    try { await api("/password", { json: Object.fromEntries(new FormData(e.target)) }); dlg.close(); alert("Password aggiornata"); }
    catch (err) { $("#pe").textContent = err.message; }
  };
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
    const key = { name: (x) => x.name, type: (x) => TYPE_IT[x.type] ?? x.type, total: (x) => x.total * sign(x), balance: (x) => x.balance * sign(x) }[accSort.key];
    for (const k of [...a.kids].sort((x, y) => cmp(key(x), key(y)) * accSort.dir)) {
      if (k.hidden && !showHidden) continue;
      rows.push(`<tr class="click ${k.hidden ? "hid" : ""}" data-id="${k.id}"><td style="padding-left:${10 + depth * 18}px">${esc(k.name)}${k.placeholder ? ' <span class="mut">·segnaposto</span>' : ""}</td>
        <td class="hide-sm">${TYPE_IT[k.type] ?? k.type}</td>
        <td class="hide-md">${esc(k.description)}</td>
        <td class="num hide-md ${k.balance * sign(k) < 0 ? "neg" : ""}">${k.placeholder && !k.balance ? "" : money(k.balance * sign(k))}</td>
        <td class="num ${k.total * sign(k) < 0 ? "neg" : ""}">${money(k.total * sign(k))}</td>
        <td class="num"><button class="link" data-edit="${k.id}">modifica</button></td></tr>`);
      walk(k, depth + 1);
    }
  })(root(), 0);
  $("#main").innerHTML = `<div class="bar"><h2>Piano dei conti</h2>
      <label class="mut"><input type="checkbox" id="sh" style="width:auto" ${showHidden ? "checked" : ""}> nascosti</label>
      <button class="primary" id="na">Nuovo conto</button></div>
    <div class="card"><table><thead><tr>${sortTh("Conto", "name", accSort)}${sortTh("Tipo", "type", accSort, "hide-sm")}<th class="hide-md">Descrizione</th>${sortTh("Saldo", "balance", accSort, "num hide-md")}${sortTh("Totale", "total", accSort, "num")}<th></th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="6" class="mut">Nessun conto. Importa un file .gnucash o creane uno.</td></tr>'}</tbody></table></div>`;
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
  const a = acc ?? { name: "", type: "EXPENSE", parent_id: root().id, description: "", placeholder: 0, hidden: 0 };
  dlg.innerHTML = `<form method="dialog" id="af"><h3>${isNew ? "Nuovo conto" : "Modifica conto"}</h3>
    <label>Nome</label><input name="name" value="${esc(a.name)}" required>
    <div class="row"><div><label>Tipo</label><select name="type">${Object.keys(TYPE_IT).filter((t) => t !== "ROOT").map((t) => `<option value="${t}" ${t === a.type ? "selected" : ""}>${TYPE_IT[t]}</option>`).join("")}</select></div>
    <div><label>Conto padre</label><select name="parent_id">${accountOptions(a.parent_id, { exclude: acc?.id })}</select></div></div>
    <label>Descrizione</label><input name="description" value="${esc(a.description)}">
    <label><input type="checkbox" name="placeholder" style="width:auto" ${a.placeholder ? "checked" : ""}> Segnaposto (non accetta movimenti)</label>
    <label><input type="checkbox" name="hidden" style="width:auto" ${a.hidden ? "checked" : ""}> Nascosto</label>
    <div class="err" id="ae"></div>
    <div class="foot">${isNew ? "" : '<button type="button" class="danger" id="ad">Elimina</button>'}<span class="sp"></span><button type="button" id="ax">Annulla</button><button class="primary">Salva</button></div></form>`;
  dlg.showModal();
  $("#ax").onclick = () => dlg.close();
  $("#af").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { name: f.get("name"), type: f.get("type"), parent_id: f.get("parent_id"), description: f.get("description"), placeholder: f.has("placeholder"), hidden: f.has("hidden") };
    try { await api(isNew ? "/accounts" : "/accounts/" + acc.id, { json: body, method: isNew ? "POST" : "PUT" }); dlg.close(); route(); }
    catch (err) { $("#ae").textContent = err.message; }
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
    <div class="card" style="overflow-x:auto"><table><thead><tr>${sortTh("Data", "date", regSort)}${sortTh("N.", "num", regSort, "hide-sm")}${sortTh("Descrizione", "description", regSort)}${sortTh("Trasferimento", "other", regSort, "hide-sm")}${showRec ? sortTh("R", "rec", regSort, "num") : ""}
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
    <label>Dettagli</label><div id="ed" style="background:#fff;height:160px"></div>
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
      <td><input data-i="${i}" data-f="memo" value="${esc(s.memo)}"></td>
      <td><input class="num" inputmode="decimal" data-i="${i}" data-f="d" value="${s.amount > 0 ? (s.amount / 100).toFixed(2).replace(".", ",") : ""}"></td>
      <td><input class="num" inputmode="decimal" data-i="${i}" data-f="c" value="${s.amount < 0 ? (-s.amount / 100).toFixed(2).replace(".", ",") : ""}"></td>
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
