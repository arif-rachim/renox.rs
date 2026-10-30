// GET <mount>/oauth/authorize: the authorization request of an agent client
// (#286). A bad client or redirect URI answers 400 here (never a redirect to
// an unchecked URI); other errors go back to the client; a valid request
// goes to the consent page (sign-in first, coming back here).
import { checkAuthorize } from "../../lib/agents.ts";
import { type AuthCtx, currentSession } from "../../lib/core.ts";

export async function GET(ctx: AuthCtx & { url: URL }): Promise<Response> {
  const r = await checkAuthorize(ctx, ctx.url.searchParams);
  if ("error" in r) {
    if (r.redirect) return new Response(null, { status: 302, headers: { location: r.redirect, "cache-control": "no-store" } });
    return new Response(`${r.error}: ${r.description}\n`, { status: 400, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  const mount = ctx.url.pathname.replace(/\/oauth\/authorize\/?$/u, "");
  const consent = `${mount}/oauth/consent?${ctx.url.searchParams.toString()}`;
  if ((await currentSession(ctx)) === null) {
    return new Response(null, { status: 303, headers: { location: `${mount}/login?next=${encodeURIComponent(consent)}`, "cache-control": "no-store" } });
  }
  return new Response(null, { status: 303, headers: { location: consent, "cache-control": "no-store" } });
}
