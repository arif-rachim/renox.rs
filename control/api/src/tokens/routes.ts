// Tenant tokens (deploy-api.md section 2; #113). A token is created by a
// token or by a signed-in user, never with more than its creator holds: the
// creating token's scopes, and the creating user's role. Developers see and
// revoke their own tokens; owners, admins and tokens no user created see all
// of the tenant's.

import type { Hono } from "hono";
import { operation } from "../audit.ts";
import { tenantAuth } from "../auth/middleware.ts";
import { ACTIONS, covers, createTenantToken, DAY_MS, newTokenValue, parseScope, sha256hex, type CreatedToken } from "../auth/tokens.ts";
import { ApiError, invalid, notFound } from "../errors.ts";
import { jsonBody, pathParam } from "../http.ts";
import { jsonb, num, numOrNull } from "../db/db.ts";
import { ulid } from "../ids.ts";
import type { Deps, Env, Principal } from "../context.ts";
import { roleAllows, seesAllTokens, type Role } from "../tenancy/roles.ts";
import { crossTenant, tenantDb } from "../tenancy/scope.ts";
import { notifyTokenCreated } from "../auth/notify.ts";

/** Why `principal` may not hand out `scope`, or null when it may. */
export function refusal(principal: Principal & { kind: "tenant" }, scope: string): string | null {
  if (principal.via === "token" && !covers(principal.scopes, scope)) return `the calling token does not hold ${scope}`;
  const role: Role | null = principal.role;
  if (role === null) return null;
  const parsed = parseScope(scope);
  const actions = scope === "*" ? ACTIONS : parsed === null ? [] : [parsed.action];
  if (actions.length === 0) return `${scope} is not a scope`;
  const missing = actions.find((a) => !roleAllows(role, a));
  return missing === undefined ? null : `the ${role} role does not hold ${missing}`;
}

/** deploy-api.md section 17: the scope of the operator actions. */
export const OPS_SCOPE = "ops:write";

/**
 * A `renox_op_` token with `ops:write` alone (deploy-api.md sections 2 and
 * 17): only for a user whose account is flagged `operator`, whatever their
 * role, and never mixed with tenant scopes. 403 `RENOX_TOKEN_SCOPE` for a
 * token no user created, or an account without the flag.
 */
/** The operator scope sets a token may hold (deploy-api.md sections 2 and 17; 0.4, #310). */
const OPERATOR_SCOPE_SETS = [["ops:write"], ["ops:read"], ["ops:impersonate"], ["ops:impersonate", "ops:read"]];
export const isOperatorScope = (s: string): boolean => s === "ops:write" || s === "ops:read" || s === "ops:impersonate";

async function createOperatorToken(deps: Deps, principal: Principal & { kind: "tenant" }, body: { name: string; scopes: string[]; expires_in_days: number }): Promise<CreatedToken> {
  const scopes = [...body.scopes].sort().reverse();
  if (!OPERATOR_SCOPE_SETS.some((set) => set.length === scopes.length && set.every((s) => scopes.includes(s)))) {
    throw invalid("scopes", "an operator token holds ops:write, ops:read, or ops:impersonate (with ops:read at most), never a tenant scope");
  }
  if (scopes.includes("ops:impersonate") && body.expires_in_days > 1) throw invalid("expires_in_days", "an ops:impersonate token lasts at most 1 day");
  if (principal.userId === null) throw new ApiError("RENOX_TOKEN_SCOPE", [{ field: "scopes", reason: `only an operator account creates ${OPS_SCOPE} tokens` }]);
  const db = crossTenant(deps.db, "an operator account and its tokens belong to no tenant");
  const rows = await db.query<{ operator: boolean }>("select operator from users where id = $1", [principal.userId]);
  if (rows[0]?.operator !== true) throw new ApiError("RENOX_TOKEN_SCOPE", [{ field: "scopes", reason: `only an operator account creates ${OPS_SCOPE} tokens` }]);
  const now = deps.now();
  const value = newTokenValue("op");
  const id = `tok_${ulid(now)}`;
  const expires = now + body.expires_in_days * DAY_MS;
  await db.query(
    "insert into operator_tokens (id, user_id, name, token_sha256, scopes, created_at, expires_at) values ($1, $2, $3, $4, $5::text::jsonb, $6, $7)",
    [id, principal.userId, body.name, sha256hex(value), jsonb(scopes), now, expires],
  );
  deps.log.info("operator token created", { token_id: id, user_id: principal.userId, scopes: scopes.join(" ") });
  return { id, name: body.name, token: value, scopes, created_at: now, expires_at: expires };
}

/** Restricts a token query to the caller's own tokens unless their role sees all. */
const ownOnly = (p: Principal & { kind: "tenant" }): string | null => (p.role === null || seesAllTokens(p.role) ? null : p.userId);

export function registerTokens(app: Hono<Env>, deps: Deps): void {
  app.post("/v1/tokens", operation(deps, "createToken"), tenantAuth(deps, "tokens:write"), async (c) => {
    const db = tenantDb(deps, c);
    const principal = c.get("principal") as Principal & { kind: "tenant" };
    const body = await jsonBody<{ name: string; scopes: string[]; expires_in_days: number }>(c, "CreateTokenRequest");
    if (body.scopes.some(isOperatorScope)) {
      const op = await createOperatorToken(deps, principal, body);
      c.set("auditTarget", { token_id: op.id, scope: op.scopes.join(" ") });
      return c.json(op, 201);
    }
    for (const s of body.scopes) {
      const why = refusal(principal, s);
      if (why !== null) throw invalid("scopes", why);
    }
    const token = await createTenantToken(db, db.tenantId, body.name, body.scopes, body.expires_in_days, deps.now(), principal.userId);
    c.set("auditTarget", { token_id: token.id });
    await notifyTokenCreated(deps, principal.userId, db.tenantId, token);
    return c.json(token, 201);
  });

  app.get("/v1/tokens", operation(deps, "listTokens"), tenantAuth(deps, "tokens:write"), async (c) => {
    const db = tenantDb(deps, c);
    const own = ownOnly(c.get("principal") as Principal & { kind: "tenant" });
    const rows = await db.query<Record<string, unknown>>(
      "select id, name, scopes, created_at, expires_at, last_used_at, revoked_at from tokens where tenant_id = $1 and ($2::text is null or user_id = $2) order by created_at",
      [db.tenantId, own],
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
    const db = tenantDb(deps, c);
    const own = ownOnly(c.get("principal") as Principal & { kind: "tenant" });
    const id = pathParam(c, "token_id", "TokenId");
    const rows = await db.query(
      "update tokens set revoked_at = coalesce(revoked_at, $2) where tenant_id = $1 and id = $3 and ($4::text is null or user_id = $4) returning id",
      [db.tenantId, deps.now(), id, own],
    );
    if (rows.length === 0) throw notFound();
    return c.body(null, 204);
  });
}
