// The booking module's handlers (#334): a deposit paid through billing
// confirms its booking (and so schedules its reminders).
import * as core from "./lib/core.ts";

interface Event {
  payload: { order_id?: string };
}

export const on = {
  async "billing.checkout_completed"(ctx: core.BookingCtx, e: Event) {
    const order = e.payload.order_id ?? "";
    if (!order.startsWith("booking:")) return;
    const b = await ctx.db.queryOne<{ id: string; status: string }>("select id, status from booking__bookings where deposit_order = ?", [order]);
    // A deposit paid after its hold expired still confirms: the customer paid for that slot.
    if (b !== null && b.status !== "cancelled") await core.confirm(ctx, b.id, 0);
  },
};
