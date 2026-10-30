// GET <mount>/invoices: every customer's invoices with what was refunded
// (billing.manage: admin and finance by default). POST ?/refund (invoice_id,
// amount): billing.refund (admin by default; sensitive, so audited).
import * as core from "../lib/core.ts";
import { day, guarded, money, type Page } from "../lib/page.ts";

async function view(ctx: Page, notice: string | null) {
  await ctx.authz.require("billing.manage");
  const rows = await ctx.db.query<{ id: string; customer_id: string; amount: number; currency: string; status: string; refunded: number; paid_at: number | null; created_at: number }>(
    "select id, customer_id, amount, currency, status, refunded, paid_at, created_at from billing__invoices order by created_at desc limit 200",
  );
  return {
    invoices: rows.map((r) => ({ id: r.id, customer: r.customer_id, amount: money(r.amount, r.currency), refunded: money(r.refunded, r.currency), status: r.status, date: day(r.paid_at ?? r.created_at), refundable: r.status === "paid" && r.refunded < r.amount })),
    notice,
  };
}

export const guard = { action: "billing.manage" };

export const load = guarded((ctx) => view(ctx, null));

export const actions = {
  refund: guarded(async (ctx) => {
    await core.refund(ctx, ctx.form.get("invoice_id"), Number(ctx.form.get("amount")));
    return view(ctx, "refunded");
  }),
};
