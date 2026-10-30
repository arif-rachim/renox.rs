// POST <mount>/oauth/register: RFC 7591 dynamic registration of a public
// agent client (no secret; PKCE S256 required at /authorize) (#286).
import { registerClient } from "../../lib/agents.ts";
import type { AuthCtx } from "../../lib/core.ts";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

export async function POST(ctx: AuthCtx & { req: Request }): Promise<Response> {
  let body: unknown;
  try {
    body = await ctx.req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_client_metadata", error_description: "the body is not JSON" }), { status: 400, headers: JSON_HEADERS });
  }
  const r = await registerClient(ctx, (body ?? {}) as { client_name?: unknown; redirect_uris?: unknown });
  if ("error" in r) return new Response(JSON.stringify(r), { status: 400, headers: JSON_HEADERS });
  return new Response(
    JSON.stringify({ ...r, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
    { status: 201, headers: JSON_HEADERS },
  );
}
