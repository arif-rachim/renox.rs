// The company's parts (#812, wave D): `app__parts` is company-wide (no branch), kept from /admin/parts. This module
// is the one place that reads and writes it: list and search, get, create, update and switch on or off, with the
// SKU normalised (upper case, `[A-Z0-9-]{1,32}`) and every form checked. Stock per branch, a visit's part lines and
// purchase orders build on `getPart`, `listParts` and `PART_UNITS`. A part is never deleted: `active = 0` keeps its
// history and a visit or a purchase order does not offer it (`listParts({ activeOnly: true })`).
import type { DbStatements } from "@renoxium/sdk";
import { audit } from "renox:modules";

import { schema, text } from "./forms";

export const PART_UNITS = ["piece", "metre", "litre", "kg", "box"] as const;
export type PartUnit = (typeof PART_UNITS)[number];
export const PART_PAGE_SIZE = 25;

export type PartRow = {
  id: string;
  sku: string;
  name_en: string;
  name_ar: string;
  unit: PartUnit;
  cost_fils: number;
  sell_fils: number;
  vat_rate: number;
  min_stock: number;
  active: number;
  created_at: number;
};

const now = (): number => Math.floor(Date.now() / 1000);
const newId = (): string => `pt_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}`;

/** The id shape `newId` makes: what a form's `id` or `?edit=` must match before it reaches a statement. */
export const isPartId = (value: unknown): value is string => typeof value === "string" && /^pt_[0-9a-f]{16}$/u.test(value);

/** A SKU as stored: trimmed and upper-cased. Whether it is valid is `validSku`'s question. */
export const normaliseSku = (raw: string): string => raw.trim().toUpperCase();
export const validSku = (sku: string): boolean => /^[A-Z0-9-]{1,32}$/u.test(sku);

export interface PartInput {
  sku: string;
  name_en: string;
  name_ar: string;
  unit: PartUnit;
  cost_fils: number;
  sell_fils: number;
  vat_rate: 0 | 5;
  min_stock: number;
}

/** "120" or "120.50" (at most 2 decimals, at most 7 digits before the point) in fils; null when it is neither. */
export function filsOf(raw: string): number | null {
  if (!/^\d{1,7}(\.\d{1,2})?$/u.test(raw)) return null;
  return Math.round(Number(raw) * 100);
}

/** A quantity of at most 3 decimals and 7 digits before the point; null when it is not. */
export function quantityOf(raw: string): number | null {
  return /^\d{1,7}(\.\d{1,3})?$/u.test(raw) ? Number(raw) : null;
}

/** The form of a part: the error values are i18n keys (`parts.err.*`), the paths are the form's field names. */
export const partSchema = schema<PartInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const sku = normaliseSku(text(raw, "sku", 40));
  const nameEn = text(raw, "name_en", 120);
  const nameAr = text(raw, "name_ar", 120);
  const unit = text(raw, "unit", 10);
  const cost = filsOf(text(raw, "cost", 12) || "0");
  const sell = filsOf(text(raw, "sell", 12) || "0");
  const vat = text(raw, "vat_rate", 3) || "5";
  const min = quantityOf(text(raw, "min_stock", 12) || "0");
  if (!validSku(sku)) errors.sku = "parts.err.sku";
  if (nameEn === "" || nameEn.length > 120) errors.name_en = "parts.err.name_en";
  if (nameAr === "" || nameAr.length > 120) errors.name_ar = "parts.err.name_ar";
  if (!(PART_UNITS as readonly string[]).includes(unit)) errors.unit = "parts.err.unit";
  if (cost === null) errors.cost = "parts.err.cost";
  if (sell === null) errors.sell = "parts.err.sell";
  if (vat !== "0" && vat !== "5") errors.vat_rate = "parts.err.vat_rate";
  if (min === null) errors.min_stock = "parts.err.min_stock";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { sku, name_en: nameEn, name_ar: nameAr, unit: unit as PartUnit, cost_fils: cost as number, sell_fils: sell as number, vat_rate: Number(vat) as 0 | 5, min_stock: min as number } };
});

export type PartsListing = { rows: PartRow[]; total: number; page: number; pages: number; q: string };

/** `%`, `_` and the escape itself are plain characters of a search text. */
const likeOf = (q: string): string => `%${q.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;

/**
 * The parts ordered by SKU, 25 to a page. `q` matches the SKU and both names (case-insensitive for Latin letters);
 * `activeOnly` is what a visit or a purchase order picks from. A page past the last one is the last.
 */
export async function listParts(db: DbStatements, opts: { q?: string; page?: number; perPage?: number; activeOnly?: boolean } = {}): Promise<PartsListing> {
  const q = (opts.q ?? "").trim().slice(0, 80);
  const perPage = opts.perPage ?? PART_PAGE_SIZE;
  const like = likeOf(q);
  const only = opts.activeOnly === true ? 1 : 0;
  // With no search text the first test of the filter is true and the three patterns are not looked at.
  const filter = [q, like, like, like, only];
  const total = (await db.queryOne<{ n: number }>("select count(*) as n from app__parts where (? = '' or sku like ? escape '\\' or name_en like ? escape '\\' or name_ar like ? escape '\\') and (? = 0 or active = 1)", filter))?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pages);
  const rows = await db.query<PartRow>("select id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at from app__parts where (? = '' or sku like ? escape '\\' or name_en like ? escape '\\' or name_ar like ? escape '\\') and (? = 0 or active = 1) order by sku limit ? offset ?", [...filter, perPage, (page - 1) * perPage]);
  return { rows, total, page, pages, q };
}

export async function getPart(db: DbStatements, id: unknown): Promise<PartRow | null> {
  return isPartId(id) ? db.queryOne<PartRow>("select id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at from app__parts where id = ?", [id]) : null;
}

export async function findPartBySku(db: DbStatements, sku: string): Promise<PartRow | null> {
  return db.queryOne<PartRow>("select id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at from app__parts where sku = ?", [normaliseSku(sku)]);
}

type Writer = { readonly db: DbStatements; readonly principal?: { readonly id: string } | null };
const actor = (ctx: Writer) => ({ kind: "user" as const, id: ctx.principal?.id ?? "unknown" });

/** Adds a part; `{ ok: false }` names the part that already holds the SKU. */
export async function createPart(ctx: Writer, input: PartInput): Promise<{ ok: true; id: string } | { ok: false; taken: PartRow }> {
  const held = await findPartBySku(ctx.db, input.sku);
  if (held !== null) return { ok: false, taken: held };
  const id = newId();
  await ctx.db.execute("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)", [id, input.sku, input.name_en, input.name_ar, input.unit, input.cost_fils, input.sell_fils, input.vat_rate, input.min_stock, now()]);
  await audit.record({ action: "part.create", actor: actor(ctx), resource: { type: "Part", id }, details: { sku: input.sku } });
  return { ok: true, id };
}

/** Changes a part's fields (not its active flag). `taken: null` is "no such part"; a SKU another part holds names that part. */
export async function updatePart(ctx: Writer, id: string, input: PartInput): Promise<{ ok: true } | { ok: false; taken: PartRow | null }> {
  if ((await getPart(ctx.db, id)) === null) return { ok: false, taken: null };
  const held = await findPartBySku(ctx.db, input.sku);
  if (held !== null && held.id !== id) return { ok: false, taken: held };
  await ctx.db.execute("update app__parts set sku = ?, name_en = ?, name_ar = ?, unit = ?, cost_fils = ?, sell_fils = ?, vat_rate = ?, min_stock = ? where id = ?", [input.sku, input.name_en, input.name_ar, input.unit, input.cost_fils, input.sell_fils, input.vat_rate, input.min_stock, id]);
  await audit.record({ action: "part.update", actor: actor(ctx), resource: { type: "Part", id }, details: { sku: input.sku } });
  return { ok: true };
}

/** Sets a part's cost to the last cost paid (a purchase order's receipt, #815); false when there is no such part. The receipt is what is audited. */
export async function setPartCost(db: DbStatements, id: string, costFils: number): Promise<boolean> {
  const won = await db.execute("update app__parts set cost_fils = ? where id = ?", [costFils, id]);
  return won.changes === 1;
}

/** Switches a part on or off; false when there is no such part. The history of a deactivated part stays. */
export async function setPartActive(ctx: Writer, id: string, active: boolean): Promise<boolean> {
  const part = await getPart(ctx.db, id);
  if (part === null) return false;
  await ctx.db.execute("update app__parts set active = ? where id = ?", [active ? 1 : 0, id]);
  await audit.record({ action: active ? "part.activate" : "part.deactivate", actor: actor(ctx), resource: { type: "Part", id }, details: { sku: part.sku } });
  return true;
}
