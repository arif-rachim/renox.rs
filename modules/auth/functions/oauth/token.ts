// POST <mount>/oauth/token: authorization_code + PKCE S256 for an agent
// token (`renox_agt_`, one hour, no refresh token) (#286; RFC 6749 section
// 4.1.3, RFC 7636).
import { exchange } from "../../lib/agents.ts";
import type { AuthCtx } from "../../lib/core.ts";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" };

export async function POST(ctx: AuthCtx & { req: Request }): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await ctx.req.text());
  } catch {
    return new Response(JSON.stringify({ error: "invalid_request" }), { status: 400, headers: JSON_HEADERS });
  }
  const r = await exchange(ctx, form);
  if ("error" in r) return new Response(JSON.stringify(r), { status: 400, headers: JSON_HEADERS });
  return new Response(JSON.stringify(r), { status: 200, headers: JSON_HEADERS });
}
