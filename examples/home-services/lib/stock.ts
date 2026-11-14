// Stock per branch and its moves (#813, wave D). THIS MODULE IS THE ONLY CODE THAT WRITES `app__stock` AND
// `app__stock_moves` (a grep for them in an insert, update or delete finds only this file): the number on hand is
// never edited, it is the result of moves, each with who, why and the balance after.
//
// `move(tx, ...)` is the one write. It runs in the caller's transaction and opens none of its own: the visit's part
// line (#814: `kind: "out"`, `ref: { kind: "visit", id }`), the purchase order's receiving (#815: `kind: "in"`,
// `unitCost`, `ref: { kind: "purchase", id }`) and the import (#816: `kind: "in"`, `ref: { kind: "manual" }`) call it
// inside their own. It returns the id of the move it inserted and throws `StockError` when a rule refuses it (a
// throw ends the caller's transaction, so nothing is half done). Both tables are owned by branch: every statement
// goes through `branchDb`, which adds the `branch_id` predicate.
//
// The rules: an `in` or a `transfer_in` with a unit cost updates the average cost (the cost when nothing was on hand);
// `out`, `adjust` and `transfer_out` leave it; an `out` may take the balance below zero (a technician used what the
// books did not have: the books are wrong, not the visit, and the move shows as negative in the list); an `adjust`
// and a `transfer_out` may not. Quantities have at most three decimals; costs are in fils.
import type { DbStatements } from "@renoxium/sdk";
import { audit, org } from "renox:modules";

import { getPart, type PartRow } from "./parts";
import { branchDb, type Scopable } from "./scope";

export const MOVE_KINDS = ["in", "out", "adjust", "transfer_out", "transfer_in"] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];
export const REF_KINDS = ["visit", "purchase", "transfer", "manual"] as const;
export type RefKind = (typeof REF_KINDS)[number];
export type MoveRef = { kind: RefKind; id?: string };
export const MOVES_PAGE_SIZE = 50;

export interface MoveInput {
  /** The branch id: the fence. Never a form value that was not checked against the branches the user holds. */
  branch: string;
  part: string;
  kind: MoveKind;
  /** The absolute amount, more than zero, at most three decimals. */
  qty: number;
  /** Fils per unit. An `in` / `transfer_in` with one updates the average cost; any other move records it as given. */
  unitCost?: number | null;
  /** Needed by an `adjust` only: whether the counted quantity is above (`up`) or below (`down`) what the books had. */
  direction?: "up" | "down";
  reason?: string;
  ref?: MoveRef;
  /** The user (or `system`) the move is for. */
  by: string;
}

export type StockErrorCode = "qty" | "cost" | "kind" | "negative" | "ref";
export class StockError extends Error {
  constructor(readonly code: StockErrorCode, message: string) {
    super(message);
    this.name = "StockError";
  }
}

export type StockLevel = { qty: number; avg_cost_fils: number };
export type MoveRow = {
  id: string;
  branch_id: string;
  part_id: string;
  kind: MoveKind;
  qty: number;
  unit_cost_fils: number | null;
  reason: string;
  ref_kind: RefKind | null;
  ref_id: string | null;
  balance_after: number;
  created_by: string;
  created_at: number;
};

const now = (): number => Math.floor(Date.now() / 1000);
const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}`;
/** Quantities are kept to three decimals, so a sum of them never drifts (0.1 + 0.2). */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;
/** A quantity as the page shows it: no trailing zeros. */
export const qtyText = (n: number): string => String(round3(n));
/** What `qty` units at `avg_cost_fils` are worth: never negative. */
export const valueFils = (level: StockLevel): number => (level.qty > 0 ? Math.round(level.qty * level.avg_cost_fils) : 0);

const validQty = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 9_999_999 && Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;

/** The branch's balance and average cost of one part (zero and zero when it never held it). */
export async function levelOf(db: Scopable, branch: string, part: string): Promise<StockLevel> {
  const row = await branchDb(db, branch).queryOne<StockLevel>("select qty, avg_cost_fils from app__stock where part_id = ?", [part]);
  return row ?? { qty: 0, avg_cost_fils: 0 };
}

/**
 * Applies one move in the caller's transaction: updates the branch's stock row (creating it), inserts the move and
 * returns its id. `balance_after` is the balance once this move is in. Throws `StockError`: `qty` (not more than
 * zero, or more than three decimals), `cost` (a unit cost that is no whole number of fils), `kind` (an `adjust`
 * without a direction), `negative` (an `adjust` or a `transfer_out` that would take the balance under zero).
 */
export async function move(tx: Scopable, input: MoveInput): Promise<string> {
  if (!validQty(input.qty)) throw new StockError("qty", "a quantity is more than zero and has at most three decimals");
  const cost = input.unitCost ?? null;
  if (cost !== null && (!Number.isInteger(cost) || cost < 0)) throw new StockError("cost", "a unit cost is a whole number of fils");
  if (!(MOVE_KINDS as readonly string[]).includes(input.kind)) throw new StockError("kind", `unknown kind ${input.kind}`);
  if (input.kind === "adjust" && input.direction !== "up" && input.direction !== "down") throw new StockError("kind", "an adjust says whether the count is above or below the books");
  const ref = input.ref ?? null;
  if (ref !== null && !(REF_KINDS as readonly string[]).includes(ref.kind)) throw new StockError("ref", `unknown reference ${ref.kind}`);

  const sdb = branchDb(tx, input.branch);
  const held = await sdb.queryOne<StockLevel>("select qty, avg_cost_fils from app__stock where part_id = ?", [input.part]);
  const before = held?.qty ?? 0;
  const avgBefore = held?.avg_cost_fils ?? 0;
  const delta = input.kind === "in" || input.kind === "transfer_in" || (input.kind === "adjust" && input.direction === "up") ? input.qty : -input.qty;
  const balance = round3(before + delta);
  if (balance < 0 && (input.kind === "adjust" || input.kind === "transfer_out")) throw new StockError("negative", "this move would take the stock under zero");

  // The average moves only when stock comes in at a known cost; on hand at or under zero, the cost is the average.
  let avg = avgBefore;
  if ((input.kind === "in" || input.kind === "transfer_in") && cost !== null) avg = before <= 0 ? cost : Math.round((before * avgBefore + input.qty * cost) / (before + input.qty));

  const at = now();
  if (held === null) await sdb.execute("insert into app__stock (branch_id, part_id, qty, avg_cost_fils, updated_at) values (?, ?, ?, ?, ?)", [input.branch, input.part, balance, avg, at]);
  else await sdb.execute("update app__stock set qty = ?, avg_cost_fils = ?, updated_at = ? where part_id = ?", [balance, avg, at, input.part]);
  const id = newId("sm");
  await sdb.execute("insert into app__stock_moves (id, branch_id, part_id, kind, qty, unit_cost_fils, reason, ref_kind, ref_id, balance_after, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, input.branch, input.part, input.kind, input.qty, cost ?? (input.kind === "in" || input.kind === "transfer_in" ? null : avgBefore), input.reason ?? "", ref?.kind ?? null, ref?.id ?? null, balance, input.by, at]);
  return id;
}

// ------------------------------------------------------------------ reading

export type StockLine = { part: PartRow; qty: number; avg_cost_fils: number; value_fils: number; low: boolean; negative: boolean };

/**
 * The parts a branch holds or has a minimum for (a part with neither is not listed), by SKU. `low` is on hand under
 * the minimum; `q` matches the SKU and both names (case-insensitive for Latin letters); `lowOnly` keeps the low ones.
 */
export async function listStock(db: Scopable, branch: string, opts: { q?: string; lowOnly?: boolean } = {}): Promise<StockLine[]> {
  const levels = new Map((await branchDb(db, branch).query<StockLevel & { part_id: string }>("select part_id, qty, avg_cost_fils from app__stock", [])).map((r) => [r.part_id, r]));
  const parts = await db.query<PartRow>("select id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at from app__parts order by sku", []);
  const q = (opts.q ?? "").trim().toLowerCase();
  const lines: StockLine[] = [];
  for (const part of parts) {
    const level = levels.get(part.id);
    if (level === undefined && part.min_stock <= 0) continue;
    if (level === undefined && part.active === 0) continue;
    if (q !== "" && !`${part.sku} ${part.name_en} ${part.name_ar}`.toLowerCase().includes(q)) continue;
    const qty = level?.qty ?? 0;
    const avg = level?.avg_cost_fils ?? 0;
    const low = qty < part.min_stock;
    if (opts.lowOnly === true && !low) continue;
    lines.push({ part, qty, avg_cost_fils: avg, value_fils: valueFils({ qty, avg_cost_fils: avg }), low, negative: qty < 0 });
  }
  return lines;
}

/** The value of everything a branch holds, in fils (a negative balance counts as nothing). */
export async function branchValue(db: Scopable, branch: string): Promise<number> {
  const rows = await branchDb(db, branch).query<StockLevel>("select qty, avg_cost_fils from app__stock", []);
  return rows.reduce((sum, r) => sum + valueFils(r), 0);
}

export type MoveLine = MoveRow & { signed: number; flagged: boolean };
export type MovesListing = { rows: MoveLine[]; total: number; page: number; pages: number };

/**
 * One part's moves in a branch, newest first, 50 to a page. `signed` is the change of the balance (an `adjust`
 * has no sign of its own: it is the difference to the move before); `flagged` is a balance under zero after the move.
 */
export async function listMoves(db: Scopable, branch: string, part: string, opts: { page?: number; perPage?: number } = {}): Promise<MovesListing> {
  const sdb = branchDb(db, branch);
  const perPage = opts.perPage ?? MOVES_PAGE_SIZE;
  const total = (await sdb.queryOne<{ n: number }>("select count(*) as n from app__stock_moves where part_id = ?", [part]))?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pages);
  // One more than the page: the move before the oldest shown gives its sign when it is an adjust.
  const rows = await sdb.query<MoveRow>("select id, branch_id, part_id, kind, qty, unit_cost_fils, reason, ref_kind, ref_id, balance_after, created_by, created_at from app__stock_moves where part_id = ? order by created_at desc, rowid desc limit ? offset ?", [part, perPage + 1, (page - 1) * perPage]);
  const shown = rows.slice(0, perPage);
  const lines = shown.map((r, i): MoveLine => {
    const earlier = rows[i + 1]?.balance_after ?? 0;
    const signed = r.kind === "in" || r.kind === "transfer_in" ? r.qty : r.kind === "adjust" ? round3(r.balance_after - earlier) : -r.qty;
    return { ...r, signed, flagged: r.balance_after < 0 };
  });
  return { rows: lines, total, page, pages };
}

/** The ids of the moves of a visit or purchase order (what #814 and #815 show), newest first. */
export async function movesOfRef(db: Scopable, branch: string, ref: { kind: RefKind; id: string }): Promise<MoveRow[]> {
  return branchDb(db, branch).query<MoveRow>("select id, branch_id, part_id, kind, qty, unit_cost_fils, reason, ref_kind, ref_id, balance_after, created_by, created_at from app__stock_moves where ref_kind = ? and ref_id = ? order by created_at desc, rowid desc", [ref.kind, ref.id]);
}

// -------------------------------------------------------------- the branches

export type HeldBranch = { id: string; org_id: string; name_en: string; name_ar: string; can_read: boolean; can_move: boolean };

/** The roles that read and that move stock in a branch, as renox.toml gives them (tests/stock.test.ts pins the two lists to it). */
export const STOCK_READ_ROLES = ["owner", "branch_manager", "dispatcher", "accountant"] as const;
export const STOCK_MOVE_ROLES = ["owner", "branch_manager"] as const;

type Who = {
  readonly db: DbStatements;
  readonly principal: { readonly id: string; readonly roles: readonly { readonly role: string; readonly scope_type: string; readonly scope_id: string | null }[]; readonly attrs: Readonly<Record<string, unknown>> } | null;
  readonly authz: { can(action: string): Promise<boolean> };
};

/**
 * The branches the signed-in user belongs to (their `org` memberships), each with whether their role there reads and
 * moves stock. The policy decides for the active branch; for another one the user's roles for that organisation (a
 * global assignment or one scoped to it) are read, because the policy only knows the active organisation. A branch
 * the user does not belong to is not in the list: it is never reachable by an id in a form or a query.
 */
export async function heldBranches(ctx: Who): Promise<HeldBranch[]> {
  const principal = ctx.principal;
  if (principal === null) return [];
  const orgs = new Set(((await org.listOrgs(principal.id)) as { id: string }[]).map((o) => o.id));
  const branches = await ctx.db.query<{ id: string; org_id: string; name_en: string; name_ar: string }>("select id, org_id, name_en, name_ar from app__branches order by created_at, id", []);
  const active = principal.attrs.org;
  const out: HeldBranch[] = [];
  for (const b of branches) {
    if (!orgs.has(b.org_id)) continue;
    if (b.org_id === active) {
      out.push({ ...b, can_read: await ctx.authz.can("stock.read"), can_move: await ctx.authz.can("stock.move") });
      continue;
    }
    const roles = new Set(principal.roles.filter((r) => r.scope_type === "global" || (r.scope_type === "org" && r.scope_id === b.org_id)).map((r) => r.role));
    out.push({ ...b, can_read: STOCK_READ_ROLES.some((r) => roles.has(r)), can_move: STOCK_MOVE_ROLES.some((r) => roles.has(r)) });
  }
  return out;
}

// ------------------------------------------------- the three forms' operations

/** An action, job or handler context: its `db` is already the transaction, so a refusal that throws undoes it all. */
type Writer = { readonly db: Scopable; readonly principal: { readonly id: string } | null };
const actor = (ctx: Writer) => ({ kind: "user" as const, id: ctx.principal?.id ?? "unknown" });
const who = (ctx: Writer): string => ctx.principal?.id ?? "unknown";

export type StockResult = { ok: true; id: string } | { ok: false; error: "part" | "no_change" | "short" };

/** Receives `qty` at `unitCostFils` into the branch: kind `in`, reference `manual`. */
export async function receiveStock(ctx: Writer, input: { branch: string; part: string; qty: number; unitCostFils: number; reason: string }): Promise<StockResult> {
  if ((await getPart(ctx.db, input.part)) === null) return { ok: false, error: "part" };
  const id = await move(ctx.db, { branch: input.branch, part: input.part, kind: "in", qty: input.qty, unitCost: input.unitCostFils, reason: input.reason, ref: { kind: "manual" }, by: who(ctx) });
  return { ok: true, id };
}

/**
 * Sets the branch's count of a part to what was counted: one `adjust` move of the difference, its direction and the
 * count in the reason ("count: was 7, is 5: <reason>"). `no_change` when the count is what the books say. Audited.
 */
export async function adjustStock(ctx: Writer, input: { branch: string; part: string; counted: number; reason: string }): Promise<StockResult> {
  if ((await getPart(ctx.db, input.part)) === null) return { ok: false, error: "part" };
  const was = (await levelOf(ctx.db, input.branch, input.part)).qty;
  const diff = round3(input.counted - was);
  if (diff === 0) return { ok: false, error: "no_change" };
  const reason = `count: was ${qtyText(was)}, is ${qtyText(input.counted)}: ${input.reason}`;
  const id = await move(ctx.db, { branch: input.branch, part: input.part, kind: "adjust", direction: diff > 0 ? "up" : "down", qty: Math.abs(diff), reason, ref: { kind: "manual" }, by: who(ctx) });
  await audit.record({ action: "stock.adjust", actor: actor(ctx), resource: { type: "Part", id: input.part }, details: { branch: input.branch, was, counted: input.counted, move: id } });
  return { ok: true, id };
}

/**
 * Moves `qty` of a part from one branch to another: a `transfer_out` and a `transfer_in` with one transfer id as the
 * reference, in the caller's transaction; the receiving branch takes the sender's average cost as its unit cost.
 * `short` when the sender has less than `qty`. Audited.
 */
export async function transferStock(ctx: Writer, input: { from: string; to: string; part: string; qty: number; reason: string }): Promise<StockResult | { ok: false; error: "same" }> {
  if (input.from === input.to) return { ok: false, error: "same" };
  if ((await getPart(ctx.db, input.part)) === null) return { ok: false, error: "part" };
  const level = await levelOf(ctx.db, input.from, input.part);
  if (round3(level.qty - input.qty) < 0) return { ok: false, error: "short" };
  const transfer = newId("tr");
  const ref = { kind: "transfer", id: transfer } as const;
  const id = await move(ctx.db, { branch: input.from, part: input.part, kind: "transfer_out", qty: input.qty, unitCost: level.avg_cost_fils, reason: input.reason, ref, by: who(ctx) });
  await move(ctx.db, { branch: input.to, part: input.part, kind: "transfer_in", qty: input.qty, unitCost: level.avg_cost_fils, reason: input.reason, ref, by: who(ctx) });
  await audit.record({ action: "stock.transfer", actor: actor(ctx), resource: { type: "Part", id: input.part }, details: { from: input.from, to: input.to, qty: input.qty, transfer } });
  return { ok: true, id };
}
