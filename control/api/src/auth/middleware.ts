// Authentication middleware for the three callers (deploy-api.md section 2).
// 401 for anything that is not a valid, live token of the right kind; 403 for
// a valid token without the scope; the tenant id always comes from the token.

import type { MiddlewareHandler } from "hono";
import { ApiError } from "../errors.ts";
import { num } from "../db/db.ts";
import type { Deps, Env } from "../context.ts";
import { allows, parseBearer, sameDigest, sha256hex, type Action } from "./tokens.ts";

const unauthenticated = (): ApiError => new ApiError("RENOX_UNAUTHENTICATED");

/** A tenant token holding `action` (on the `{app}` path parameter, if any). */
export function tenantAuth(deps: Deps, action: Action): MiddlewareHandler<Env> {
  return async (c, next) => {
    const bearer = parseBearer(c.req.header("authorization"));
    if (bearer === null || bearer.kind !== "pat") throw unauthenticated();
    const rows = await deps.db.query<{ id: string; tenant_id: string; scopes: string[]; expires_at: unknown; revoked_at: unknown }>(
      "select id, tenant_id, scopes, expires_at, revoked_at from tokens where token_sha256 = $1",
      [sha256hex(bearer.value)],
    );
    const token = rows[0];
    const now = deps.now();
    if (token === undefined || token.revoked_at !== null || num(token.expires_at) <= now) throw unauthenticated();
    c.set("principal", { kind: "tenant", tenantId: token.tenant_id, tokenId: token.id, scopes: token.scopes });
    if (!allows(token.scopes, action, c.req.param("app"))) throw new ApiError("RENOX_TOKEN_SCOPE");
    await deps.db.query("update tokens set last_used_at = $1 where id = $2", [now, token.id]);
    await next();
  };
}

/** A node token; `{node_id}` in the path, when present, must be the token's node. */
export function nodeAuth(deps: Deps): MiddlewareHandler<Env> {
  return async (c, next) => {
    const bearer = parseBearer(c.req.header("authorization"));
    if (bearer === null || bearer.kind !== "node") throw unauthenticated();
    const rows = await deps.db.query<{ node_id: string }>(
      "select node_id from node_tokens where token_sha256 = $1 and revoked_at is null",
      [sha256hex(bearer.value)],
    );
    const node = rows[0];
    if (node === undefined) throw unauthenticated();
    c.set("principal", { kind: "node", nodeId: node.node_id });
    const pathNode = c.req.param("node_id");
    if (pathNode !== undefined && pathNode !== node.node_id) throw new ApiError("RENOX_TOKEN_SCOPE");
    await next();
  };
}

/** The operator token, compared in constant time against the configured digest. */
export function operatorAuth(deps: Deps): MiddlewareHandler<Env> {
  return async (c, next) => {
    const bearer = parseBearer(c.req.header("authorization"));
    const expected = deps.config.operatorTokenSha256;
    if (bearer === null || bearer.kind !== "op" || expected === null || !sameDigest(sha256hex(bearer.value), expected)) {
      throw unauthenticated();
    }
    c.set("principal", { kind: "operator" });
    await next();
  };
}

/** The tenant principal set by tenantAuth. */
export function tenantId(c: { get(key: "principal"): Env["Variables"]["principal"] }): string {
  const p = c.get("principal");
  if (p?.kind !== "tenant") throw unauthenticated();
  return p.tenantId;
}

/** The node principal set by nodeAuth. */
export function nodeId(c: { get(key: "principal"): Env["Variables"]["principal"] }): string {
  const p = c.get("principal");
  if (p?.kind !== "node") throw unauthenticated();
  return p.nodeId;
}
