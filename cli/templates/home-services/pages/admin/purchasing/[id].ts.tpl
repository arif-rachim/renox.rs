// GET /admin/purchasing/<id>: one purchase order of the active branch (#815): header, lines with their amounts, totals
// (net, VAT at each part's rate, gross) and the actions its state allows. `purchase.read` opens it; `purchase.write`
// changes it. An order of another branch is a 404: the branch-scoped database does not find it.
//   draft            ?/add_line (an active part, quantity, unit cost: blank is the part's), ?/remove_line, ?/send, ?/cancel
//   sent             ?/receive, ?/cancel, the PDF
//   partly_received  ?/receive, the PDF
//   received         the PDF
// ?/send marks the order sent (it needs a line). The platform's email module cannot attach a file yet, so nothing is
// mailed: the page offers the PDF to download and send (see lib/purchasing.ts for the state rules).
// ?/receive takes one quantity (0 to the outstanding) and one unit cost per line; each received line is one `in`
// move of the order's own branch through lib/stock.ts, all in one transaction. A broken rule or form is a 422.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { check } from "../../../lib/forms";
import { invalid } from "../../../lib/invalid";
import { shell } from "../../../lib/page";
import { listParts, type PartRow } from "../../../lib/parts";
import { addLine, cancelPo, dayOf, findPo, isPoId, lineSchema, linesOf, parseReceipt, priced, receivePo, removeLine, sendPo, totalsOf, type PoRow } from "../../../lib/purchasing";
import { branchOf, noBranch, scopedDb, type Branch } from "../../../lib/scope";
import { qtyText } from "../../../lib/stock";
import { getSupplier } from "../../../lib/suppliers";

export const guard = { action: "purchase.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const SAVED = ["created", "line_added", "line_removed", "sent", "received", "cancelled"];

type Ctx = LoaderContext | ActionContext;

async function view(ctx: Ctx, branch: Branch, po: PoRow) {
  const page = await shell(ctx);
  const ar = page.locale === "ar";
  const sdb = scopedDb(ctx.db, branch);
  const supplier = await getSupplier(ctx.db, po.supplier_id);
  const lines = await priced(ctx.db, await linesOf(sdb, po.id));
  const sum = totalsOf(lines);
  const draft = po.status === "draft";
  const receivable = po.status === "sent" || po.status === "partly_received";
  const nameOf = (p: PartRow | null): string => (p === null ? "" : ar ? p.name_ar : p.name_en);
  const parts = draft ? (await listParts(ctx.db, { activeOnly: true, perPage: 100_000 })).rows : [];
  const saved = ctx.url.searchParams.get("saved") ?? "";
  const shownLines = lines.map((l, i) => ({
    i,
    id: l.id,
    sku: l.part?.sku ?? "",
    name: nameOf(l.part),
    unit: l.part?.unit ?? "piece",
    qty: qtyText(l.qty),
    unit_cost: l.unit_cost_fils / 100,
    vat_rate: l.vat_rate,
    net: l.net_fils / 100,
    vat: l.vat_fils / 100,
    total: l.total_fils / 100,
    received: qtyText(l.received_qty),
    outstanding: qtyText(l.qty - l.received_qty),
    open: qtyText(l.qty - l.received_qty) !== "0",
    rq: qtyText(l.qty - l.received_qty),
    rp: (l.unit_cost_fils / 100).toFixed(2),
    err_qty: "",
    err_price: "",
  }));
  return {
    ...page,
    saved: SAVED.includes(saved) ? saved : "",
    po: { id: po.id, number: po.number, status: po.status, language: po.language, expected_on: po.expected_on ?? "", notes: po.notes, created_at: dayOf(po.created_at), sent_at: po.sent_at === null ? "" : dayOf(po.sent_at), closed_at: po.closed_at === null ? "" : dayOf(po.closed_at), net: sum.net_fils / 100, vat: sum.vat_fils / 100, total: sum.total_fils / 100 },
    supplier: supplier === null ? null : { id: supplier.id, name: supplier.name, trn: supplier.trn ?? "", phone: supplier.phone, email: supplier.email, address: supplier.address },
    branch_name: ar ? branch.name_ar : branch.name_en,
    lines: shownLines,
    receive_lines: shownLines.filter((l) => l.open),
    is_draft: draft,
    can_send: draft && lines.length > 0,
    can_cancel: draft || po.status === "sent",
    can_receive: receivable,
    parts: parts.map((p) => ({ id: p.id, label: `${p.sku}: ${nameOf(p)}`, cost: (p.cost_fils / 100).toFixed(2) })),
    values: {},
  };
}

/** The order of the URL in the active branch, with the branch; or the response to return. */
async function open(ctx: Ctx): Promise<{ branch: Branch; po: PoRow } | Response> {
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const po = isPoId(ctx.params.id) ? await findPo(scopedDb(ctx.db, branch), ctx.params.id) : null;
  return po === null ? plain(404, "Purchase order not found") : { branch, po };
}

export async function load(ctx: LoaderContext) {
  const found = await open(ctx);
  if (found instanceof Response) return found;
  return view(ctx, found.branch, found.po);
}

/** The order for a change: 403 without `purchase.write`, 404 for an order of another branch. */
async function target(ctx: ActionContext): Promise<{ branch: Branch; po: PoRow } | Response> {
  if (!(await ctx.authz.can("purchase.write"))) return plain(403, "Forbidden");
  return open(ctx);
}

const back = (po: PoRow, saved: string): Response => new Response(null, { status: 303, headers: { location: `/admin/purchasing/${po.id}?saved=${saved}`, "cache-control": "no-store" } });

/** The 422: the page again with what is wrong; `which` names the form the typed values belong to. */
async function refused(ctx: ActionContext, t: { branch: Branch; po: PoRow }, errors: Record<string, string>, which?: "line" | "receive") {
  const shown = await view(ctx, t.branch, t.po);
  const bad = invalid(shown.locale, ctx.form, errors, which);
  // The receive form's rows keep what was typed and carry their own errors.
  const typed = (k: string, fallback: string): string => (which === "receive" && typeof ctx.form.get(k) === "string" ? (ctx.form.get(k) as string) : fallback);
  const lines = shown.lines.map((l) => ({ ...l, rq: typed(`qty_${l.i}`, l.rq), rp: typed(`price_${l.i}`, l.rp), err_qty: bad.errors[`qty_${l.i}`] ?? "", err_price: bad.errors[`price_${l.i}`] ?? "" }));
  return { ...shown, ...bad, lines, receive_lines: lines.filter((l) => l.open) };
}

const STATE_ERROR = { form: "purchasing.err.state" };

export const actions = {
  async add_line(ctx: ActionContext) {
    const t = await target(ctx);
    if (t instanceof Response) return t;
    const input = await check(ctx.form, lineSchema);
    if ("errors" in input) return refused(ctx, t, input.errors, "line");
    const done = await addLine(ctx, t.po, input.value);
    if (!done.ok) return refused(ctx, t, done.error === "part" ? { part: "stock.err.part" } : STATE_ERROR, "line");
    return back(t.po, "line_added");
  },

  async remove_line(ctx: ActionContext) {
    const t = await target(ctx);
    if (t instanceof Response) return t;
    const raw = ctx.form.get("line");
    const id = typeof raw === "string" && /^\d{1,9}$/u.test(raw.trim()) ? Number(raw.trim()) : 0;
    const done = await removeLine(ctx, t.po, id);
    if (done === "state") return refused(ctx, t, STATE_ERROR);
    if (done === "missing") return plain(404, "Line not found");
    return back(t.po, "line_removed");
  },

  async send(ctx: ActionContext) {
    const t = await target(ctx);
    if (t instanceof Response) return t;
    const done = await sendPo(ctx, t.po);
    if (!done.ok) return refused(ctx, t, done.error === "empty" ? { lines: "purchasing.err.empty" } : STATE_ERROR);
    return back(t.po, "sent");
  },

  async receive(ctx: ActionContext) {
    const t = await target(ctx);
    if (t instanceof Response) return t;
    if (t.po.status !== "sent" && t.po.status !== "partly_received") return refused(ctx, t, STATE_ERROR, "receive");
    const lines = await linesOf(scopedDb(ctx.db, t.branch), t.po.id);
    const raw: Record<string, unknown> = {};
    for (const [k, v] of ctx.form.entries()) if (typeof v === "string") raw[k] = v;
    const parsed = parseReceipt(raw, lines);
    if ("errors" in parsed) return refused(ctx, t, parsed.errors, "receive");
    const done = await receivePo(ctx, t.po, parsed.value);
    if (!done.ok) return refused(ctx, t, STATE_ERROR, "receive");
    return back(t.po, "received");
  },

  async cancel(ctx: ActionContext) {
    const t = await target(ctx);
    if (t instanceof Response) return t;
    const done = await cancelPo(ctx, t.po);
    if (!done.ok) return refused(ctx, t, STATE_ERROR);
    return back(t.po, "cancelled");
  },
};
