// The reports module's handlers (#333): billing's money events into the
// cash ledger (events need no dependency; the event id keeps a redelivery
// from counting twice).
import { record, type Db } from "./lib/cash.ts";

interface Event {
  id: string;
  payload: { invoice_id?: string; amount?: number };
}

export const on = {
  async "billing.payment_received"(ctx: { db: Db }, e: Event) {
    await record(ctx.db, `received:${e.id}`, "received", e.payload.invoice_id ?? "", e.payload.amount ?? 0);
  },
  async "billing.refunded"(ctx: { db: Db }, e: Event) {
    await record(ctx.db, `refunded:${e.id}`, "refunded", e.payload.invoice_id ?? "", e.payload.amount ?? 0);
  },
};
