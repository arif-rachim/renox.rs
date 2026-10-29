import { defineServices } from "renox";
import type { ModuleCtx } from "../../.renox/types/modules";

export const { chargeUser } = defineServices({
  async chargeUser(ctx: ModuleCtx<"billing">, userId: string, amount: number): Promise<string> {
    const user = await ctx.services.auth.getUser(userId);
    if (user === null) throw new Error("no such user");
    return ctx.events.emit("billing.invoice_paid", { invoice_id: "inv_1", user_id: user.id, amount });
  },
});
