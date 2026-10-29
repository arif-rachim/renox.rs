// An event emitted without a required payload field fails tsc.
import type { ModuleCtx } from "../.renox/types/modules";

export const emit = (ctx: ModuleCtx<"billing">) => ctx.events.emit("billing.invoice_paid", { invoice_id: "inv_1" });
