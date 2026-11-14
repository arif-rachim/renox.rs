// Purchase orders (#815, wave D): the office orders parts from a supplier with a numbered order (`PO-000001`, drawn
// from `app__po_numbers` like a quotation's number), sends it as a PDF, and books what arrives into the branch's stock
// at the price paid. A purchase order and its lines belong to one branch: every statement of theirs goes through the
// branch-fenced Db of lib/scope.ts. The state rules, all enforced here:
//   draft            lines are added and removed; `send` needs at least one line; `cancel` is allowed
//   sent             the supplier has it; no line changes; `receive` and `cancel` are allowed
//   partly_received  some of the lines came in; `receive` is allowed; `cancel` is not (stock moved)
//   received         every line in full (`closed_at` set); nothing more
//   cancelled        nothing more
// Receiving writes stock ONLY through `move` of lib/stock.ts, in the caller's transaction (an action's `db` is its
// transaction), so a refusal half way leaves no move behind. Money is in fils; quantities have at most three decimals.
import type { DbStatements } from "@renoxium/sdk";
import { audit } from "renox:modules";

import { schema, text } from "./forms";
import { filsOf, getPart, isPartId, quantityOf, setPartCost, type PartRow } from "./parts";
import { branchDb, type Scopable } from "./scope";
import { move, round3 } from "./stock";
import { isSupplierId } from "./suppliers";

export const PO_STATUSES = ["draft", "sent", "partly_received", "received", "cancelled"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
export const PO_PAGE_SIZE = 25;

export type PoRow = {
  id: string;
  branch_id: string;
  supplier_id: string;
  number: string;
  status: PoStatus;
  language: "en" | "ar";
  expected_on: string | null;
  notes: string;
  created_by: string;
  created_at: number;
  sent_at: number | null;
  closed_at: number | null;
};

export type PoLineRow = {
  id: number;
  po_id: string;
  branch_id: string;
  part_id: string;
  qty: number;
  unit_cost_fils: number;
  received_qty: number;
};

const COLUMNS = "id, branch_id, supplier_id, number, status, language, expected_on, notes, created_by, created_at, sent_at, closed_at";
const LINE_COLUMNS = "id, po_id, branch_id, part_id, qty, unit_cost_fils, received_qty";

const now = (): number => Math.floor(Date.now() / 1000);
const newId = (): string => `po_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}`;

/** The id shape `newId` makes: what a URL or a form's id must match before it reaches a statement. */
export const isPoId = (value: unknown): value is string => typeof value === "string" && /^po_[0-9a-f]{16}$/u.test(value);

/** `YYYY-MM-DD` of unix seconds in the company's time zone (UTC+4, no daylight saving). */
export const dayOf = (seconds: number): string => new Date((seconds + 4 * 3600) * 1000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ the forms

export interface PoInput {
  supplier: string;
  language: "en" | "ar";
  expected_on: string | null;
  notes: string;
}

/** A real calendar date `YYYY-MM-DD`. */
const validDate = (raw: string): boolean => /^\d{4}-\d{2}-\d{2}$/u.test(raw) && new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) === raw;

/** The "New purchase order" form: the error values are i18n keys (`purchasing.err.*`), the paths are the field names. */
export const poSchema = schema<PoInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const supplier = text(raw, "supplier", 40);
  const language = text(raw, "language", 5) || "en";
  const expected = text(raw, "expected_on", 10);
  const notes = text(raw, "notes", 1000);
  if (!isSupplierId(supplier)) errors.supplier = "purchasing.err.supplier";
  if (language !== "en" && language !== "ar") errors.language = "customers.err.language";
  if (expected !== "" && !validDate(expected)) errors.expected_on = "purchasing.err.expected_on";
  if (notes.length > 1000) errors.notes = "suppliers.err.notes";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { supplier, language: language as "en" | "ar", expected_on: expected === "" ? null : expected, notes } };
});

export interface LineInput {
  part: string;
  qty: number;
  /** Null when the form left it blank: the part's cost is used. */
  unit_cost_fils: number | null;
}

/** The "add a line" form. */
export const lineSchema = schema<LineInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const part = text(raw, "part", 40);
  const qty = quantityOf(text(raw, "qty", 12));
  const costText = text(raw, "unit_cost", 12);
  const cost = costText === "" ? null : filsOf(costText);
  if (!isPartId(part)) errors.part = "stock.err.part";
  if (qty === null || qty <= 0) errors.qty = "stock.err.qty";
  if (costText !== "" && cost === null) errors.unit_cost = "stock.err.unit_cost";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { part, qty: qty as number, unit_cost_fils: cost } };
});

export interface ReceiptLine {
  line: PoLineRow;
  qty: number;
  unit_cost_fils: number;
}

/**
 * The receive form: one row per line, in the order of `lines` (field names `qty_<i>` and `price_<i>`). A blank
 * quantity is zero, a blank cost is the line's; a quantity is 0 to what is outstanding; at least one is above zero.
 * Lines with nothing outstanding are not on the form and are skipped.
 */
export function parseReceipt(raw: Record<string, unknown>, lines: readonly PoLineRow[]): { value: ReceiptLine[] } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const out: ReceiptLine[] = [];
  for (const [i, line] of lines.entries()) {
    const outstanding = round3(line.qty - line.received_qty);
    if (outstanding <= 0) continue;
    const qtyText = text(raw, `qty_${i}`, 12);
    const costText = text(raw, `price_${i}`, 12);
    const qty = qtyText === "" ? 0 : quantityOf(qtyText);
    const cost = costText === "" ? line.unit_cost_fils : filsOf(costText);
    if (qty === null || qty > outstanding) errors[`qty_${i}`] = "purchasing.err.receive_qty";
    if (cost === null) errors[`price_${i}`] = "stock.err.unit_cost";
    if (qty !== null && qty > 0 && cost !== null && qty <= outstanding) out.push({ line, qty, unit_cost_fils: cost });
  }
  if (Object.keys(errors).length === 0 && out.length === 0) errors.lines = "purchasing.err.receive_none";
  return Object.keys(errors).length > 0 ? { errors } : { value: out };
}

// ------------------------------------------------------------------ reading

export type PoListing = { rows: (PoRow & { total_fils: number })[]; total: number; page: number; pages: number };

/** The branch's orders, newest first, 25 to a page, optionally of one status and one supplier. `sdb` is fenced to the branch; `plain` reads the company-wide parts. */
export async function listPos(sdb: DbStatements, plain: DbStatements, opts: { status?: string; supplier?: string; page?: number } = {}): Promise<PoListing> {
  const status = (PO_STATUSES as readonly string[]).includes(opts.status ?? "") ? (opts.status as string) : "";
  const supplier = isSupplierId(opts.supplier) ? opts.supplier : "";
  const filter = [status, status, supplier, supplier];
  const where = "(? = '' or status = ?) and (? = '' or supplier_id = ?)";
  const total = (await sdb.queryOne<{ n: number }>(`select count(*) as n from app__purchase_orders where ${where}`, filter))?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / PO_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pages);
  const rows = await sdb.query<PoRow>(`select ${COLUMNS} from app__purchase_orders where ${where} order by created_at desc, number desc limit ? offset ?`, [...filter, PO_PAGE_SIZE, (page - 1) * PO_PAGE_SIZE]);
  const out = [];
  for (const po of rows) out.push({ ...po, total_fils: totalsOf(await priced(plain, await linesOf(sdb, po.id))).total_fils });
  return { rows: out, total, page, pages };
}

export async function findPo(sdb: DbStatements, id: unknown): Promise<PoRow | null> {
  return isPoId(id) ? sdb.queryOne<PoRow>(`select ${COLUMNS} from app__purchase_orders where id = ?`, [id]) : null;
}

export async function linesOf(sdb: DbStatements, po: string): Promise<PoLineRow[]> {
  return sdb.query<PoLineRow>(`select ${LINE_COLUMNS} from app__purchase_order_lines where po_id = ? order by id`, [po]);
}

export type PricedPoLine = PoLineRow & { part: PartRow | null; vat_rate: number; net_fils: number; vat_fils: number; total_fils: number };

/** A line's net: quantity (three decimals) times the unit cost, rounded half up to a fil. */
export const netOf = (qty: number, unitFils: number): number => Math.floor((Math.round(qty * 1000) * unitFils + 500) / 1000);

/** The lines with their part and amounts: VAT at the part's rate (5 when the part is gone, which a foreign key prevents). `plain` reads the company-wide parts. */
export async function priced(db: DbStatements, lines: readonly PoLineRow[]): Promise<PricedPoLine[]> {
  const parts = new Map<string, PartRow | null>();
  for (const l of lines) if (!parts.has(l.part_id)) parts.set(l.part_id, await getPart(db, l.part_id));
  return lines.map((l) => {
    const part = parts.get(l.part_id) ?? null;
    const vat_rate = part?.vat_rate ?? 5;
    const net = netOf(l.qty, l.unit_cost_fils);
    const vat = Math.floor((net * vat_rate + 50) / 100);
    return { ...l, part, vat_rate, net_fils: net, vat_fils: vat, total_fils: net + vat };
  });
}

/** The order's totals: the sums of its lines. */
export function totalsOf(lines: readonly { net_fils: number; vat_fils: number; total_fils: number }[]): { net_fils: number; vat_fils: number; total_fils: number } {
  return { net_fils: lines.reduce((n, l) => n + l.net_fils, 0), vat_fils: lines.reduce((n, l) => n + l.vat_fils, 0), total_fils: lines.reduce((n, l) => n + l.total_fils, 0) };
}

// ------------------------------------------------------------------ writing

/** An action context: its `db` is already the transaction, so a throw undoes everything. */
type Writer = { readonly db: Scopable; readonly principal: { readonly id: string } | null };
const who = (ctx: Writer): string => ctx.principal?.id ?? "unknown";
const actor = (ctx: Writer) => ({ kind: "user" as const, id: who(ctx) });

/** Stores a draft order in the branch with the next number; returns its id. */
export async function createPo(ctx: Writer, branch: string, input: PoInput): Promise<string> {
  const id = newId();
  const n = await ctx.db.execute("insert into app__po_numbers (po_id) values (?)", [id]);
  const number = `PO-${String(Number(n.lastInsertRowid)).padStart(6, "0")}`;
  await branchDb(ctx.db, branch).execute(`insert into app__purchase_orders (${COLUMNS}) values (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, null, null)`, [id, branch, input.supplier, number, input.language, input.expected_on, input.notes, who(ctx), now()]);
  return id;
}

export type LineResult = { ok: true } | { ok: false; error: "state" | "part" };

/** Adds a line to a draft; the cost is the part's when none was given. `part` is an active part. */
export async function addLine(ctx: Writer, po: PoRow, input: LineInput): Promise<LineResult> {
  if (po.status !== "draft") return { ok: false, error: "state" };
  const part = await getPart(ctx.db, input.part);
  if (part === null || part.active !== 1) return { ok: false, error: "part" };
  await branchDb(ctx.db, po.branch_id).execute("insert into app__purchase_order_lines (po_id, branch_id, part_id, qty, unit_cost_fils, received_qty) values (?, ?, ?, ?, ?, 0)", [po.id, po.branch_id, part.id, input.qty, input.unit_cost_fils ?? part.cost_fils]);
  return { ok: true };
}

/** Removes a line of a draft; `state` when the order is no draft, `missing` when it has no such line. */
export async function removeLine(ctx: Writer, po: PoRow, lineId: number): Promise<"ok" | "state" | "missing"> {
  if (po.status !== "draft") return "state";
  const won = await branchDb(ctx.db, po.branch_id).execute("delete from app__purchase_order_lines where id = ? and po_id = ?", [lineId, po.id]);
  return won.changes === 1 ? "ok" : "missing";
}

export type StateResult = { ok: true } | { ok: false; error: "state" | "empty" };

/** draft to sent: needs at least one line. Audited. */
export async function sendPo(ctx: Writer, po: PoRow): Promise<StateResult> {
  if (po.status !== "draft") return { ok: false, error: "state" };
  const sdb = branchDb(ctx.db, po.branch_id);
  const lines = await linesOf(sdb, po.id);
  if (lines.length === 0) return { ok: false, error: "empty" };
  const won = await sdb.execute("update app__purchase_orders set status = 'sent', sent_at = ? where id = ? and status = 'draft'", [now(), po.id]);
  if (won.changes !== 1) return { ok: false, error: "state" };
  const sum = totalsOf(await priced(ctx.db, lines));
  await audit.record({ action: "purchase.send", actor: actor(ctx), resource: { type: "PurchaseOrder", id: po.id }, details: { number: po.number, supplier: po.supplier_id, lines: lines.length, total_fils: sum.total_fils } });
  return { ok: true };
}

/** draft or sent (nothing received) to cancelled; after a receipt the order stays. Audited. */
export async function cancelPo(ctx: Writer, po: PoRow): Promise<StateResult> {
  if (po.status !== "draft" && po.status !== "sent") return { ok: false, error: "state" };
  const won = await branchDb(ctx.db, po.branch_id).execute("update app__purchase_orders set status = 'cancelled', closed_at = ? where id = ? and status in ('draft', 'sent')", [now(), po.id]);
  if (won.changes !== 1) return { ok: false, error: "state" };
  await audit.record({ action: "purchase.cancel", actor: actor(ctx), resource: { type: "PurchaseOrder", id: po.id }, details: { number: po.number, was: po.status } });
  return { ok: true };
}

/**
 * Books the received lines into the order's branch: one `in` move per line through lib/stock.ts (reference `purchase`
 * and the order's id, reason the order's number, the cost actually paid), raises `received_qty`, sets each part's cost
 * to the last cost paid, and moves the order to `partly_received`, or to `received` (with `closed_at`) when every line
 * is in full. In the caller's transaction. Audited. `receipt` comes from `parseReceipt`.
 */
export async function receivePo(ctx: Writer, po: PoRow, receipt: readonly ReceiptLine[]): Promise<StateResult> {
  if (po.status !== "sent" && po.status !== "partly_received") return { ok: false, error: "state" };
  const sdb = branchDb(ctx.db, po.branch_id);
  const moves: string[] = [];
  for (const r of receipt) {
    // The branch is the order's own, never a form value.
    moves.push(await move(ctx.db, { branch: po.branch_id, part: r.line.part_id, kind: "in", qty: r.qty, unitCost: r.unit_cost_fils, reason: po.number, ref: { kind: "purchase", id: po.id }, by: who(ctx) }));
    await sdb.execute("update app__purchase_order_lines set received_qty = ? where id = ? and po_id = ?", [round3(r.line.received_qty + r.qty), r.line.id, po.id]);
    await setPartCost(ctx.db, r.line.part_id, r.unit_cost_fils);
  }
  const after = await linesOf(sdb, po.id);
  const complete = after.every((l) => round3(l.qty - l.received_qty) <= 0);
  if (complete) await sdb.execute("update app__purchase_orders set status = 'received', closed_at = ? where id = ?", [now(), po.id]);
  else await sdb.execute("update app__purchase_orders set status = 'partly_received' where id = ?", [po.id]);
  await audit.record({ action: "purchase.receive", actor: actor(ctx), resource: { type: "PurchaseOrder", id: po.id }, details: { number: po.number, lines: receipt.length, complete, moves } });
  return { ok: true };
}
