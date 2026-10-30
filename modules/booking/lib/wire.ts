// The booking module's ctx with its neighbours (#334): deposits through
// billing.createCheckout. Kept out of lib/core.ts so the core stays testable
// without the module broker.
import { billing } from "renox:modules";

import type { BookingCtx } from "./core.ts";

/** A ctx with `deposit` (the platform's ctx is frozen: a new object over it, never a write to it). */
export function wired<C extends BookingCtx>(ctx: C): C {
  if (ctx.deposit !== undefined) return ctx;
  const deposit = async (o: { order_id: string; customer_id: string; amount: number; description: string }) => (await billing.createCheckout(o)) as { url: string };
  return Object.assign(Object.create(ctx) as C, { deposit });
}
