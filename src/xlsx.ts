import { zipSync, strToU8 } from "fflate";
import type { Account, Split, Tx } from "./gnucash";

// Scrittore XLSX minimale (stringhe inline, 4 stili) per un foglio per conto.
const CREDIT_NORMAL = new Set(["INCOME", "LIABILITY", "EQUITY", "CREDIT", "PAYABLE"]);
const TYPE_IT: Record<string, string> = { ASSET: "Attività", BANK: "Banca", CASH: "Contanti", CREDIT: "Carta di credito", LIABILITY: "Passività", STOCK: "Azioni", MUTUAL: "Fondo", RECEIVABLE: "Crediti", PAYABLE: "Debiti", INCOME: "Entrate", EXPENSE: "Spese", EQUITY: "Patrimonio netto", TRADING: "Trading" };

type Cell = string | number | { date: string } | { money: number } | { head: string } | null;

const esc = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const col = (i: number) => { let s = ""; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s += String.fromCharCode(65 + ((i - 1) % 26)); return s; };
const serial = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd) / 864e5 + 25569; };
// stili: 1 intestazione, 2 data, 3 importo, 4 testo a capo
function cellXml(v: Cell, r: number, c: number): string {
  const ref = col(c) + (r + 1);
  if (v === null || v === "") return "";
  if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
  if (typeof v === "string") return `<c r="${ref}" t="inlineStr" s="4"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  if ("date" in v) return `<c r="${ref}" s="2"><v>${serial(v.date)}</v></c>`;
  if ("money" in v) return `<c r="${ref}" s="3"><v>${v.money / 100}</v></c>`;
  return `<c r="${ref}" t="inlineStr" s="1"><is><t>${esc(v.head)}</t></is></c>`;
}
function sheetXml(rows: Cell[][], widths: number[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, c) => cellXml(v, i, c)).join("")}</row>`).join("")}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00;[Red]\\-#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD8D8D8"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>
</styleSheet>`;

const htmlToText = (h: string) => h.replace(/<\/(p|h[1-6]|li|blockquote)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();

function sheetName(name: string, used: Set<string>): string {
  const base = (name.replace(/[\[\]:*?\/\\]/g, "-").replace(/^'+|'+$/g, "").slice(0, 31).trim() || "Conto");
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) { const suf = ` (${i++})`; n = base.slice(0, 31 - suf.length) + suf; }
  used.add(n.toLowerCase());
  return n;
}

export function buildXlsx(accounts: Account[], txs: (Tx & { details?: string })[], splits: Split[]): Uint8Array {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const full = (a: Account): string => { const p = a.parent_id ? byId.get(a.parent_id) : undefined; return p && p.type !== "ROOT" ? full(p) + ":" + a.name : a.name; };
  const splitsByTx = new Map<string, Split[]>();
  for (const s of splits) (splitsByTx.get(s.tx_id) ?? splitsByTx.set(s.tx_id, []).get(s.tx_id)!).push(s);
  const orderedTx = [...txs].sort((a, b) => a.date_posted.localeCompare(b.date_posted) || a.date_entered.localeCompare(b.date_entered));

  const perAcc = new Map<string, Cell[][]>();
  const sums = new Map<string, number>();
  const run = new Map<string, number>();
  for (const t of orderedTx) {
    const sp = splitsByTx.get(t.id) ?? [];
    for (const s of sp) {
      const a = byId.get(s.account_id); if (!a) continue;
      const others = sp.filter((o) => o !== s);
      const other = others.length === 1 ? full(byId.get(others[0].account_id)!) : others.length ? "-- Split --" : "";
      const sg = CREDIT_NORMAL.has(a.type) ? -1 : 1;
      const bal = (run.get(a.id) ?? 0) + s.amount; run.set(a.id, bal); sums.set(a.id, bal);
      (perAcc.get(a.id) ?? perAcc.set(a.id, []).get(a.id)!).push([
        { date: t.date_posted }, t.num, t.description, other,
        s.amount > 0 ? { money: s.amount } : null, s.amount < 0 ? { money: -s.amount } : null, { money: bal * sg },
        t.notes, htmlToText(t.details ?? ""),
      ]);
    }
  }

  // foglio riepilogo + un foglio per ogni conto con movimenti (ordinati per nome completo)
  const list = accounts.filter((a) => a.type !== "ROOT" && perAcc.has(a.id)).sort((a, b) => full(a).localeCompare(full(b), "it"));
  const used = new Set<string>(["conti"]);
  const sheets: { name: string; xml: string }[] = [];
  const idx: Cell[][] = [[{ head: "Conto" }, { head: "Tipo" }, { head: "Movimenti" }, { head: "Saldo" }, { head: "Foglio" }]];
  const bodies: { name: string; xml: string }[] = [];
  for (const a of list) {
    const nm = sheetName(full(a).split(":").pop()!, used);
    const sg = CREDIT_NORMAL.has(a.type) ? -1 : 1;
    idx.push([full(a), TYPE_IT[a.type] ?? a.type, perAcc.get(a.id)!.length, { money: (sums.get(a.id) ?? 0) * sg }, nm]);
    const head: Cell[] = ["Data", "N.", "Descrizione", "Trasferimento", "Dare", "Avere", "Saldo", "Note", "Dettagli"].map((h) => ({ head: h }));
    bodies.push({ name: nm, xml: sheetXml([head, ...perAcc.get(a.id)!], [12, 10, 38, 34, 13, 13, 14, 28, 50]) });
  }
  sheets.push({ name: "Conti", xml: sheetXml(idx, [44, 18, 11, 14, 28]) }, ...bodies);

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(STYLES),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(s.xml)));
  return zipSync(files);
}
