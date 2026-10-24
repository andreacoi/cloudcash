import { XMLParser } from "fast-xml-parser";

export interface Account {
  id: string; parent_id: string | null; name: string; type: string;
  description: string; placeholder: number; hidden: number;
}
export interface Split { id: string; tx_id: string; account_id: string; amount: number; memo: string; reconciled: string }
export interface Tx { id: string; date_posted: string; date_entered: string; num: string; description: string; notes: string }
export interface Book { accounts: Account[]; transactions: Tx[]; splits: Split[] }

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: unknown): string => (v === undefined || v === null ? "" : String(typeof v === "object" ? (v as any)["#text"] ?? "" : v));

// "835/100" (denominatore qualsiasi) -> centesimi
function fracToCents(s: string): number {
  const [n, d] = s.split("/").map(Number);
  if (!d) return Math.round(n * 100);
  return Math.round((n * 100) / d);
}

async function gunzipIfNeeded(buf: ArrayBuffer): Promise<string> {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }
  return new TextDecoder().decode(u8);
}

function slotValue(slots: any, key: string): string | undefined {
  for (const s of arr<any>(slots?.slot)) if (txt(s["slot:key"]) === key) return txt(s["slot:value"]);
  return undefined;
}

export async function parseGnucash(buf: ArrayBuffer): Promise<Book> {
  const xml = await gunzipIfNeeded(buf);
  if (!xml.includes("<gnc-v2")) throw new Error("File non valido: non è un file GnuCash XML");
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false, trimValues: true });
  const doc = p.parse(xml)["gnc-v2"];
  const book = arr<any>(doc["gnc:book"])[0];
  if (!book) throw new Error("Nessun book trovato");

  const accounts: Account[] = [];
  for (const a of arr<any>(book["gnc:account"])) {
    accounts.push({
      id: txt(a["act:id"]),
      parent_id: a["act:parent"] ? txt(a["act:parent"]) : null,
      name: txt(a["act:name"]),
      type: txt(a["act:type"]),
      description: txt(a["act:description"]),
      placeholder: slotValue(a["act:slots"], "placeholder") === "true" ? 1 : 0,
      hidden: slotValue(a["act:slots"], "hidden") === "true" ? 1 : 0,
    });
  }
  const accIds = new Set(accounts.map((a) => a.id));

  const transactions: Tx[] = [];
  const splits: Split[] = [];
  for (const t of arr<any>(book["gnc:transaction"])) {
    const id = txt(t["trn:id"]);
    const posted = txt(t["trn:date-posted"]?.["ts:date"]).slice(0, 10);
    const gdate = slotValue(t["trn:slots"], "date-posted");
    const entered = txt(t["trn:date-entered"]?.["ts:date"]);
    transactions.push({
      id,
      date_posted: gdate?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? posted,
      date_entered: entered ? entered.replace(" +0000", "Z").replace(" ", "T") : new Date().toISOString(),
      num: txt(t["trn:num"]),
      description: txt(t["trn:description"]),
      notes: slotValue(t["trn:slots"], "notes") ?? "",
    });
    for (const s of arr<any>(t["trn:splits"]?.["trn:split"])) {
      const acc = txt(s["split:account"]);
      if (!accIds.has(acc)) throw new Error(`Split su conto sconosciuto ${acc}`);
      splits.push({
        id: txt(s["split:id"]), tx_id: id, account_id: acc,
        amount: fracToCents(txt(s["split:value"])),
        memo: txt(s["split:memo"]),
        reconciled: txt(s["split:reconciled-state"]) || "n",
      });
    }
  }
  return { accounts, transactions, splits };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const guid = (id: string) => id.replace(/-/g, "");
const cur = `<cmdty:space>CURRENCY</cmdty:space>\n<cmdty:id>EUR</cmdty:id>`;
const NS = ["gnc","act","book","cd","cmdty","price","slot","split","sx","trn","ts","fs","bgt","recurrence","lot","addr","billterm","bt-days","bt-prox","cust","employee","entry","invoice","job","order","owner","taxtable","tte","vendor"]
  .map((n) => `xmlns:${n}="http://www.gnucash.org/XML/${n}"`).join("\n     ");

function slotXml(key: string, type: string, value: string) {
  return `<slot><slot:key>${key}</slot:key><slot:value type="${type}">${value}</slot:value></slot>`;
}

export async function exportGnucash(book: Book, bookId: string): Promise<Uint8Array> {
  const o: string[] = [];
  o.push(`<?xml version="1.0" encoding="utf-8" ?>\n<gnc-v2\n     ${NS}>`);
  o.push(`<gnc:count-data cd:type="book">1</gnc:count-data>\n<gnc:book version="2.0.0">`);
  o.push(`<book:id type="guid">${guid(bookId)}</book:id>`);
  o.push(`<gnc:count-data cd:type="commodity">1</gnc:count-data>`);
  o.push(`<gnc:count-data cd:type="account">${book.accounts.length}</gnc:count-data>`);
  o.push(`<gnc:count-data cd:type="transaction">${book.transactions.length}</gnc:count-data>`);
  o.push(`<gnc:commodity version="2.0.0">\n<cmdty:space>CURRENCY</cmdty:space>\n<cmdty:id>EUR</cmdty:id>\n<cmdty:get_quotes/>\n<cmdty:quote_source>currency</cmdty:quote_source>\n<cmdty:quote_tz/>\n</gnc:commodity>`);

  // i genitori prima dei figli
  const byParent = new Map<string | null, Account[]>();
  for (const a of book.accounts) (byParent.get(a.parent_id) ?? byParent.set(a.parent_id, []).get(a.parent_id)!).push(a);
  const walk = (pid: string | null): Account[] => (byParent.get(pid) ?? []).flatMap((a) => [a, ...walk(a.id)]);
  for (const a of walk(null)) {
    const slots: string[] = [];
    if (a.placeholder) slots.push(slotXml("placeholder", "string", "true"));
    if (a.hidden) slots.push(slotXml("hidden", "string", "true"));
    o.push(`<gnc:account version="2.0.0">
<act:name>${esc(a.name)}</act:name>
<act:id type="guid">${guid(a.id)}</act:id>
<act:type>${a.type}</act:type>
<act:commodity>${cur}</act:commodity>
<act:commodity-scu>100</act:commodity-scu>${a.description ? `\n<act:description>${esc(a.description)}</act:description>` : ""}${slots.length ? `\n<act:slots>${slots.join("")}</act:slots>` : ""}${a.parent_id ? `\n<act:parent type="guid">${guid(a.parent_id)}</act:parent>` : ""}
</gnc:account>`);
  }

  const splitsByTx = new Map<string, Split[]>();
  for (const s of book.splits) (splitsByTx.get(s.tx_id) ?? splitsByTx.set(s.tx_id, []).get(s.tx_id)!).push(s);
  const ts = (iso: string) => iso.slice(0, 19).replace("T", " ") + " +0000";
  for (const t of book.transactions) {
    const slots = [slotXml("date-posted", "gdate", `<gdate>${t.date_posted}</gdate>`)];
    if (t.notes) slots.push(slotXml("notes", "string", esc(t.notes)));
    o.push(`<gnc:transaction version="2.0.0">
<trn:id type="guid">${guid(t.id)}</trn:id>
<trn:currency>${cur}</trn:currency>${t.num ? `\n<trn:num>${esc(t.num)}</trn:num>` : ""}
<trn:date-posted><ts:date>${t.date_posted} 10:59:00 +0000</ts:date></trn:date-posted>
<trn:date-entered><ts:date>${ts(t.date_entered)}</ts:date></trn:date-entered>
<trn:description>${esc(t.description)}</trn:description>
<trn:slots>${slots.join("")}</trn:slots>
<trn:splits>
${(splitsByTx.get(t.id) ?? []).map((s) => `<trn:split>
<split:id type="guid">${guid(s.id)}</split:id>${s.memo ? `\n<split:memo>${esc(s.memo)}</split:memo>` : ""}
<split:reconciled-state>${s.reconciled}</split:reconciled-state>
<split:value>${s.amount}/100</split:value>
<split:quantity>${s.amount}/100</split:quantity>
<split:account type="guid">${guid(s.account_id)}</split:account>
</trn:split>`).join("\n")}
</trn:splits>
</gnc:transaction>`);
  }
  o.push(`</gnc:book>\n</gnc-v2>\n`);
  const stream = new Blob([o.join("\n")]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
