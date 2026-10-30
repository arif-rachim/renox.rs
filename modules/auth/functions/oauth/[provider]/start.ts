// GET <mount>/oauth/<provider>/start?next=…: a 302 to the provider with
// `state`, PKCE (Google, Microsoft) and a nonce (OIDC), kept in the
// short-lived `__Host-renox_oauth` cookie. A provider that is not set up: 404.
import { credentials, flowCookie, providerFor, type ProviderName, startFlow } from "../../../lib/oauth.ts";

interface Ctx {
  url: URL;
  params: { provider?: string };
  config: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, string>>;
}

export async function GET(ctx: Ctx): Promise<Response> {
  const name = String(ctx.params.provider ?? "") as ProviderName;
  const p = providerFor(ctx, name);
  const creds = p ? credentials(ctx, name) : null;
  if (!p || creds === null) return new Response("Not found", { status: 404 });
  const next = ctx.url.searchParams.get("next") ?? "/";
  const redirectUri = `${ctx.url.origin}${ctx.url.pathname.replace(/\/start$/u, "/callback")}`;
  const { url, flow } = await startFlow(p, creds.clientId, redirectUri, next);
  return new Response(null, { status: 302, headers: { location: url, "set-cookie": flowCookie(flow), "cache-control": "no-store" } });
}
