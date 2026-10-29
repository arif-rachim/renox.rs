// The app's own code: renox:modules and a typed ctx.
import { auth, billing } from "renox:modules";
import type { ModuleCtx } from "./.renox/types/modules";

export async function load(ctx: ModuleCtx): Promise<{ email: string | null; invoice: string }> {
  const user = await auth.getUser("u1");
  const invoice: string = await billing.chargeUser("u1", 4200);
  const same = await ctx.services.auth.currentUser();
  return { email: user?.email ?? same?.email ?? null, invoice };
}
