// GET <mount>/mine: the signed-in customer's own bookings (no one else's).
// POST ?/cancel (id): cancels one of them.
import * as core from "../lib/core.ts";
import { guarded, type Page } from "../lib/page.ts";

async function view(ctx: Page, notice: string | null) {
  const me = (ctx.principal as { id: string }).id;
  const rows = await ctx.db.query<{ id: string; service: string; start_at: number; status: string }>(
    "select b.id, s.name as service, b.start_at, b.status from booking__bookings b join booking__services s on s.id = b.service_id where b.customer = ? and b.status != 'cancelled' order by b.start_at",
    [me],
  );
  const off = ctx.utcOffsetMinutes ?? 240;
  return { bookings: rows.map((r) => ({ id: r.id, service: r.service, when: new Date(r.start_at + off * 60_000).toISOString().replace("T", " ").slice(0, 16), status: r.status })), notice };
}

export const load = guarded((ctx: Page) => view(ctx, null));

export const actions = {
  cancel: guarded(async (ctx: Page) => {
    await core.cancel(ctx, ctx.form.get("id"), { customer: (ctx.principal as { id: string }).id });
    return view(ctx, "cancelled");
  }),
};
