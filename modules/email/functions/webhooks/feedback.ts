// Bounces and complaints (#328): the provider's notifications, relayed with a
// generic HMAC-SHA256 signature in X-Email-Signature (ops.md 1.7.0 section
// 22), suppress the address. A duplicate delivery ends with 200 before here.
import * as core from "../../lib/core.ts";

export async function POST(ctx: core.EmailCtx & { webhook: { verify(req: Request, o: { secret: string; header: string }): Promise<{ payload: unknown }> }; req: Request }) {
  const e = await ctx.webhook.verify(ctx.req, { secret: ctx.secrets.EMAIL_WEBHOOK_SECRET ?? "", header: "X-Email-Signature" });
  return Response.json(await core.recordFeedback(ctx, e.payload));
}
