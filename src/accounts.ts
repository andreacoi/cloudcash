// Regole sui tipi di conto, trascritte da GnuCash (libgnucash/engine/Account.cpp):
// xaccParentAccountTypesCompatibleWith e xaccAccountTypesCompatibleWith.
export const ASSET_LIKE = ["BANK", "CASH", "ASSET", "STOCK", "MUTUAL", "CURRENCY", "CREDIT", "LIABILITY", "RECEIVABLE", "PAYABLE"];
// Tipi che CloudCash sa gestire (solo EUR: niente titoli, fondi, trading)
export const SELECTABLE_TYPES = ["BANK", "CASH", "CREDIT", "ASSET", "LIABILITY", "RECEIVABLE", "PAYABLE", "INCOME", "EXPENSE", "EQUITY"];
export const ACC_TYPES = [...new Set([...SELECTABLE_TYPES, ...ASSET_LIKE, "TRADING"])];
export const CREDIT_NORMAL = new Set(["INCOME", "LIABILITY", "EQUITY", "CREDIT", "PAYABLE"]);

/** Tipi ammessi per un conto figlio, dato il tipo del padre. */
export function childTypes(parent: string): string[] {
  if (parent === "ROOT") return [...ASSET_LIKE, "INCOME", "EXPENSE", "EQUITY", "TRADING"];
  if (ASSET_LIKE.includes(parent)) return ASSET_LIKE;
  if (parent === "INCOME" || parent === "EXPENSE") return ["INCOME", "EXPENSE"];
  if (parent === "EQUITY") return ["EQUITY"];
  if (parent === "TRADING") return ["TRADING"];
  return [];
}

/** Con movimenti esistenti il tipo si può cambiare solo dentro lo stesso gruppo. */
export function typeGroup(t: string): string {
  if (["STOCK", "MUTUAL", "CURRENCY"].includes(t)) return "security";
  if (["RECEIVABLE", "PAYABLE", "TRADING"].includes(t)) return t;
  return "general";
}

export const fullName = (id: string, byId: Map<string, { name: string; parent_id: string | null; type: string }>): string => {
  const a = byId.get(id)!;
  return a.parent_id && byId.get(a.parent_id)?.type !== "ROOT" ? fullName(a.parent_id, byId) + ":" + a.name : a.name;
};
