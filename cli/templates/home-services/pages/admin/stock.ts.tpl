// GET /admin/stock: what each branch holds (#813). `stock.read` opens it. The picker lists the branches the user
// belongs to (`?branch=<id>`; the active one when none; a branch they do not belong to is a 404), then the parts
// the branch holds or has a minimum for: SKU, name, unit, on hand, minimum, average cost and value (never
// negative), a "Low" mark when on hand is under the minimum; `?low=1` keeps those, `?q=` searches the SKU and both
// names; the value of every branch the user may read is totalled under the table. `stock.move` holders get three
// forms, each posting the branch it was shown for (checked again on the server against the branches the user
// holds): ?/receive (kind in, reference manual), ?/adjust (the counted quantity; the move stores the difference and
// the count in its reason; needs the user's recent second factor, like `settings.write`, for this form only) and
// ?/transfer (to another branch the user may move stock in; two moves, one transfer id, the sender's average cost
// for the receiver). An invalid form is a 422 naming the fields; a move that would take the sender under zero, and a
// count equal to the books, are 422s too. Only lib/stock.ts writes the stock tables.
import { redirect, type ActionContext, type LoaderContext } from "@renoxium/sdk";

import { stepUp } from "../../lib/admin";
import { check } from "../../lib/forms";
import { invalid } from "../../lib/invalid";
import { shell } from "../../lib/page";
import { listParts } from "../../lib/parts";
import { adjustStock, branchValue, heldBranches, listStock, qtyText, receiveStock, transferStock, type HeldBranch } from "../../lib/stock";
import { adjustSchema, receiveSchema, transferSchema } from "../../lib/stock-forms";

export const guard = { action: "stock.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const SAVED = ["received", "adjusted", "transferred"];

type Ctx = LoaderContext | ActionContext;

/** The branch to show: the one asked for if the user may read it, else (nothing asked) the active one, else the first. */
function pick(held: readonly HeldBranch[], wanted: string, activeOrg: unknown): HeldBranch | null {
  const readable = held.filter((b) => b.can_read);
  if (wanted !== "") return readable.find((b) => b.id === wanted) ?? null;
  return readable.find((b) => b.org_id === activeOrg) ?? readable[0] ?? null;
}

/** Everything the page shows for one branch; the action's 422 renders the same page with it. */
async function view(ctx: Ctx, wanted: string) {
  const page = await shell(ctx);
  const held = await heldBranches(ctx);
  const sel = pick(held, wanted, ctx.principal?.attrs.org);
  if (sel === null) return null;
  const ar = page.locale === "ar";
  const nameOf = (b: { name_en: string; name_ar: string }): string => (ar ? b.name_ar : b.name_en);
  const q = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const low = ctx.url.searchParams.get("low") === "1";
  const lines = await listStock(ctx.db, sel.id, { q, lowOnly: low });
  const readable = held.filter((b) => b.can_read);
  const dests = held.filter((b) => b.can_move && b.id !== sel.id).map((b) => ({ id: b.id, name: nameOf(b) }));
  const saved = ctx.url.searchParams.get("saved") ?? "";
  const parts = sel.can_move ? (await listParts(ctx.db, { activeOnly: true, perPage: 100_000 })).rows : [];
  return {
    ...page,
    saved: SAVED.includes(saved) ? saved : "",
    sel_id: sel.id,
    sel_name: nameOf(sel),
    can_move: sel.can_move,
    q,
    low,
    branches: await Promise.all(readable.map(async (b) => ({ id: b.id, name: nameOf(b), current: b.id === sel.id, href: `/admin/stock?branch=${b.id}`, value: (await branchValue(ctx.db, b.id)) / 100 }))),
    lines: lines.map((l) => ({
      id: l.part.id,
      sku: l.part.sku,
      name: ar ? l.part.name_ar : l.part.name_en,
      unit: l.part.unit,
      qty: qtyText(l.qty),
      min: qtyText(l.part.min_stock),
      avg: l.avg_cost_fils / 100,
      value: l.value_fils / 100,
      low: l.low,
      negative: l.negative,
      href: `/admin/stock/${l.part.id}?branch=${sel.id}`,
    })),
    parts: parts.map((p) => ({ id: p.id, label: `${p.sku}: ${ar ? p.name_ar : p.name_en}`, unit: p.unit })),
    multi: readable.length > 1,
    has_dests: dests.length > 0,
    no_dests: dests.length === 0,
    dests,
    values: {},
  };
}

export async function load(ctx: LoaderContext) {
  const shown = await view(ctx, (ctx.url.searchParams.get("branch") ?? "").trim());
  return shown ?? plain(404, "Branch not found");
}

/** The branch a form was shown for: a branch the user holds and may move stock in; 404 for any other, 403 when they only read it. */
async function target(ctx: ActionContext): Promise<{ held: HeldBranch[]; branch: HeldBranch } | Response> {
  const held = await heldBranches(ctx);
  const raw = ctx.form.get("branch");
  const id = typeof raw === "string" ? raw.trim() : "";
  const branch = id === "" ? (held.find((b) => b.org_id === ctx.principal?.attrs.org) ?? null) : (held.find((b) => b.id === id) ?? null);
  if (branch === null) return plain(404, "Branch not found");
  if (!branch.can_move) return plain(403, "Forbidden");
  return { held, branch };
}

/** The 422 of a form: the page again with its errors and the values as typed; `form` names which form they belong to. */
async function refused(ctx: ActionContext, branch: HeldBranch, errors: Record<string, string>, which: "receive" | "adjust" | "transfer") {
  const shown = await view(ctx, branch.id);
  if (shown === null) return plain(404, "Branch not found");
  return { ...shown, ...invalid(shown.locale, ctx.form, errors, which) };
}

const back = (branch: HeldBranch, saved: string): Response => redirect.safe(`/admin/stock?branch=${branch.id}&saved=${saved}`, { status: 303, fallback: "/admin/stock" });

export const actions = {
  async receive(ctx: ActionContext) {
    const t = await target(ctx);
    if (t instanceof Response) return t;
    const input = await check(ctx.form, receiveSchema);
    if ("errors" in input) return refused(ctx, t.branch, input.errors, "receive");
    const done = await receiveStock(ctx, { branch: t.branch.id, part: input.value.part, qty: input.value.qty, unitCostFils: input.value.unit_cost_fils, reason: input.value.reason });
    if (!done.ok) return refused(ctx, t.branch, { part: "stock.err.part" }, "receive");
    return back(t.branch, "received");
  },

  async adjust(ctx: ActionContext) {
    const t = await target(ctx);
    if (t instanceof Response) return t;
    // The second factor is asked for on this form only: `stock.move` as a whole is not in `sensitive`, so a receive
    // or a transfer does not need it. Nothing has been written when the person is sent to the verification page.
    const stepped = await stepUp(`/admin/stock?branch=${t.branch.id}`);
    if (stepped !== null) return stepped;
    const input = await check(ctx.form, adjustSchema);
    if ("errors" in input) return refused(ctx, t.branch, input.errors, "adjust");
    const done = await adjustStock(ctx, { branch: t.branch.id, part: input.value.part, counted: input.value.counted, reason: input.value.reason });
    if (!done.ok) return refused(ctx, t.branch, { [done.error === "part" ? "part" : "counted"]: done.error === "part" ? "stock.err.part" : "stock.err.no_change" }, "adjust");
    return back(t.branch, "adjusted");
  },

  async transfer(ctx: ActionContext) {
    const t = await target(ctx);
    if (t instanceof Response) return t;
    const input = await check(ctx.form, transferSchema);
    if ("errors" in input) return refused(ctx, t.branch, input.errors, "transfer");
    // The receiving branch is one the user holds and may move stock in, never an id taken on trust.
    const to = t.held.find((b) => b.id === input.value.to_branch && b.can_move) ?? null;
    if (to === null || to.id === t.branch.id) return refused(ctx, t.branch, { to_branch: "stock.err.to_branch" }, "transfer");
    const done = await transferStock(ctx, { from: t.branch.id, to: to.id, part: input.value.part, qty: input.value.qty, reason: input.value.reason });
    if (!done.ok) return refused(ctx, t.branch, done.error === "part" ? { part: "stock.err.part" } : { qty: "stock.err.short" }, "transfer");
    return back(t.branch, "transferred");
  },
};
