// GET <mount>/oauth/<provider>/callback?code&state: `state` checked against
// the flow cookie (constant time) before anything else, the code exchanged
// with the PKCE verifier, the ID token verified (OIDC) or the GitHub profile
// read, then the identity rules (lib/oauth.ts, userOfProfile) and a new
// session. Every refusal is the same generic page; the reason goes to the
// log without the code, the token, or the secret.
import { type AuthCtx, GENERIC_LOGIN_ERROR, redirectWith } from "../../../lib/core.ts";
import {
  checkCallback,
  clearFlowCookie,
  credentials,
  exchange,
  finishSignIn,
  OAuthError,
  PROVIDERS,
  profileOf,
  type ProviderName,
  readFlow,
  userOfProfile,
} from "../../../lib/oauth.ts";

type Ctx = AuthCtx & {
  url: URL;
  params: { provider?: string };
  secrets: Readonly<Record<string, string>>;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  log: { warn(message: string, fields?: Record<string, unknown>): void };
};

const refused = (): Response =>
  new Response(`<!doctype html><title>Sign-in failed</title><p>${GENERIC_LOGIN_ERROR}</p>`, {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": clearFlowCookie() },
  });

export async function GET(ctx: Ctx): Promise<Response> {
  const name = String(ctx.params.provider ?? "") as ProviderName;
  const p = PROVIDERS[name];
  const creds = p ? credentials(ctx, name) : null;
  if (!p || creds === null) return new Response("Not found", { status: 404 });
  try {
    const flow = checkCallback(readFlow(ctx.headers), name, ctx.url.searchParams.get("state"), ctx.url.searchParams.get("code"));
    const redirectUri = `${ctx.url.origin}${ctx.url.pathname}`;
    const tokens = await exchange(ctx.fetch, p, { ...creds, code: ctx.url.searchParams.get("code") as string, redirectUri, verifier: flow.verifier });
    const profile = await profileOf(ctx.fetch, p, tokens, { clientId: creds.clientId, nonce: flow.nonce });
    const who = await userOfProfile(ctx, name, profile);
    if (!who.ok) {
      ctx.log.warn("oauth sign-in refused", { provider: name, reason: "email_not_verified" });
      return refused();
    }
    const done = await finishSignIn(ctx, who.user);
    if (done.halt) return done.halt;
    return redirectWith(flow.next, [done.cookie, clearFlowCookie()]);
  } catch (e) {
    ctx.log.warn("oauth sign-in refused", { provider: name, reason: e instanceof OAuthError ? e.reason : "error" });
    return refused();
  }
}
