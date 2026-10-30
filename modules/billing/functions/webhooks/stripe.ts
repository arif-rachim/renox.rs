// Stripe's events for the app's own customers (#329): verified by the
// platform (ops.md 1.7.0 section 22: Stripe-Signature, 300 s, the event id
// de-duplicated before this runs), normalised by the adapter, then applied.
import * as core from "../../lib/core.ts";

export const provider = "stripe";

export async function POST(ctx: core.BillingCtx & { req: Request; webhook: { verify(r: Request, o: { provider: "stripe" }): Promise<{ payload: unknown }> } }) {
  const e = await ctx.webhook.verify(ctx.req, { provider: "stripe" });
  return Response.json({ result: await core.applyEvent(ctx, e.payload) });
}
