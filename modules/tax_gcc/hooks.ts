// The tax_gcc module's handlers (#331): billing.invoice_issued stamps the
// tax invoice (once per billing invoice), the buyer named from auth's public
// view. A seller without a TRN configured issues nothing: the event's
// handler fails and the outbox retries it once the TRN is set.
import * as core from "./lib/core.ts";

interface Event {
  payload: { invoice_id: string; customer_id: string; amount: number };
}

export const on = {
  async "billing.invoice_issued"(ctx: core.TaxCtx, e: Event) {
    const u = await ctx.db.queryOne<{ email: string; display_name: string | null }>("select email, display_name from auth__public_users_v1 where id = ?", [e.payload.customer_id]);
    await core.stampFromBilling(ctx, e.payload, { name: u?.display_name || u?.email || e.payload.customer_id });
  },
};
