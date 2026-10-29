// GET <mount>/magic/<token>: the link of the mail, once. A new session and
// a 303 to the app's root; an expired, used, or foreign link: 400.
import { redirectWith } from "../../lib/core.ts";
import type { AuthCtx } from "../../lib/core.ts";
import { signInWithMagic } from "../../lib/tokens.ts";

export async function load(ctx: AuthCtx & { params: { token?: string } }) {
  const r = await signInWithMagic(ctx, String(ctx.params.token ?? ""));
  if (!r.ok) {
    return new Response("<!doctype html><title>Link expired</title><p>This link has expired or was already used. Ask for a new one.</p>", {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return r.halt ?? redirectWith("/", [r.cookie]);
}
