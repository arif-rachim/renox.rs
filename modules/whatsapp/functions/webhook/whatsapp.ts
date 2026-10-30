// <mount>/webhook/whatsapp (#290): the Cloud API webhook. GET is Meta's
// verification handshake (`hub.verify_token` against WHATSAPP_VERIFY_TOKEN,
// answered with `hub.challenge`); POST carries messages and status
// updates, signed with `X-Hub-Signature-256` (HMAC-SHA-256 of the raw body
// with WHATSAPP_APP_SECRET, compared in constant time). The body limit is
// the gateway's, as for every function route.
import * as api from "../../lib/cloud-api.ts";
import * as core from "../../lib/core.ts";

type Ctx = core.WaCtx & { url: URL; req: Request };

export async function GET(ctx: Ctx): Promise<Response> {
  const q = ctx.url.searchParams;
  const expected = ctx.secrets.WHATSAPP_VERIFY_TOKEN ?? "";
  const token = q.get("hub.verify_token") ?? "";
  if (q.get("hub.mode") !== "subscribe" || expected === "" || !api.sameString(token, expected)) return new Response("forbidden", { status: 403 });
  const challenge = q.get("hub.challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(challenge)) return new Response("bad challenge", { status: 400 });
  return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

export async function POST(ctx: Ctx): Promise<Response> {
  const raw = await ctx.req.text();
  if (!(await api.verifySignature(ctx.secrets.WHATSAPP_APP_SECRET ?? "", raw, ctx.req.headers.get("x-hub-signature-256")))) {
    ctx.log.warn("whatsapp: webhook signature refused");
    return new Response("invalid signature", { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("not json", { status: 400 });
  }
  const ids = await core.receive(ctx, api.parseWebhook(body));
  return Response.json({ received: ids.length });
}
