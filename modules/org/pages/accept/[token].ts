// GET <mount>/accept/<token>: the invitation of the mail, shown to the
// signed-in user (signed out: the login hop, coming back here). POST
// ?/accept: joins once, then a 303 to the members page. An expired, used,
// withdrawn, or foreign invitation: 400.
import * as core from "../../lib/core.ts";
import { guarded, type Page, redirect, toLogin } from "../../lib/page.ts";

const invalid = (): Response =>
  new Response(`<!doctype html><title>Invitation</title><p>${core.INVITE_INVALID}</p>`, {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

export const load = guarded(async (ctx) => {
  if ((await core.session()) === null) return toLogin(ctx);
  const inv = await core.peekInvite(ctx, String(ctx.params.token ?? ""));
  return inv === null ? invalid() : { invite: inv };
});

export const actions = {
  accept: guarded(async (ctx) => {
    const r = await core.acceptInvite(ctx, String(ctx.params.token ?? ""));
    return r.ok ? redirect(`${core.basePath(ctx)}/members`) : invalid();
  }),
};
