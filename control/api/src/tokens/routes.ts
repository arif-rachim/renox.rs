import type { Hono } from "hono";
import { operation } from "../audit.ts";
import { tenantAuth, tenantId } from "../auth/middleware.ts";
import { covers, createTenantToken } from "../auth/tokens.ts";
import { invalid, notFound } from "../errors.ts";
import { jsonBody, pathParam } from "../http.ts";
import { num, numOrNull } from "../db/db.ts";
import type { Deps, Env } from "../context.ts";

export function registerTokens(app: Hono<Env>, deps: Deps): void {
  const { db } = deps;

  app.post("/v1/tokens", operation(deps, "createToken"), tenantAuth(deps, "tokens:write"), async (c) => {
    const body = await jsonBody<{ name: string; scopes: string[]; expires_in_days: number }>(c, "CreateTokenRequest");
    const principal = c.get("principal");
    const held = principal?.kind === "tenant" ? principal.scopes : [];
    const stronger = body.scopes.find((s) => !covers(held, s));
    if (stronger !== undefined) throw invalid("scopes", `the calling token does not hold ${stronger}`);
    const token = await createTenantToken(db, tenantId(c), body.name, body.scopes, body.expires_in_days, deps.now());
    return c.json(token, 201);
  });

  app.get("/v1/tokens", operation(deps, "listTokens"), tenantAuth(deps, "tokens:write"), async (c) => {
    const rows = await db.query<Record<string, unknown>>(
      "select id, name, scopes, created_at, expires_at, last_used_at, revoked_at from tokens where tenant_id = $1 order by created_at",
      [tenantId(c)],
    );
    return c.json({
      tokens: rows.map((r) => ({
        id: r.id,
        name: r.name,
        scopes: r.scopes,
        created_at: num(r.created_at),
        expires_at: num(r.expires_at),
        last_used_at: numOrNull(r.last_used_at),
        revoked_at: numOrNull(r.revoked_at),
      })),
    });
  });

  app.delete("/v1/tokens/:token_id", operation(deps, "revokeToken"), tenantAuth(deps, "tokens:write"), async (c) => {
    const id = pathParam(c, "token_id", "TokenId");
    const rows = await db.query(
      "update tokens set revoked_at = coalesce(revoked_at, $1) where id = $2 and tenant_id = $3 returning id",
      [deps.now(), id, tenantId(c)],
    );
    if (rows.length === 0) throw notFound();
    return c.body(null, 204);
  });
}

