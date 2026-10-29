// Authentication middleware for the deploy API's callers (deploy-api.md
// section 2) and the accounts of #113. 401 for anything that is not a valid,
// live credential of the right kind; 403 for a valid one without the
// permission; the tenant id always comes from the credential.
//
// A tenant request is either a `renox_pat_` token or a session cookie. A
// token acts with its scopes, and, when a user created it, with at most that
// user's current role. A session acts with the user's role in the tenant the
// session is bound to. The permission each operation needs is the table
// ROUTE_PERMISSIONS (src/tenancy/roles.ts).

import type { Context, MiddlewareHandler } from "hono";
import { ApiError } from "../errors.ts";
import { num } from "../db/db.ts";
import type { Deps, Env, Principal } from "../context.ts";
import { isRole, isTokenPermission, roleAllows, ROUTE_PERMISSIONS, type Permission, type Role } from "../tenancy/roles.ts";
import { requestScope } from "../tenancy/scope.ts";
import { bucketsOf, RULES } from "./buckets.ts";
import { clientIp } from "./ip.ts";
import { CSRF_HEADER, csrfMatches, findSession, readCookie, SESSION_COOKIE } from "./sessions.ts";
import { allows, parseBearer, sameDigest, sha256hex } from "./tokens.ts";

const unauthenticated = (): ApiError => new ApiError("RENOX_UNAUTHENTICATED");
const forbidden = (field?: string, reason?: string): ApiError =>
  new ApiError("RENOX_TOKEN_SCOPE", field === undefined ? undefined : [{ field, reason: reason ?? "" }]);

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * deploy-api.md section 2 (proposed numbers; docs/24-threat-model.md E,
 * "Deploy API abuse"): every request of a token takes from its bucket, an
 * upload also from its upload bucket; 429 `RENOX_RATE_LIMITED` with
 * `Retry-After` when either is empty.
 */
function limitToken(deps: Deps, c: Context<Env>, tokenId: string): void {
  const takes: [typeof RULES.token, string][] = [[RULES.token, `token:${tokenId}`]];
  if (c.get("action") === "uploadDeployment") takes.push([RULES.tokenUpload, `upload:${tokenId}`]);
  for (const [rule, key] of takes) {
    const r = bucketsOf(deps).take(rule, key);
    if (!r.ok) throw new ApiError("RENOX_RATE_LIMITED", undefined, { retryAfter: r.retryAfter });
  }
}

/** The operation's row in ROUTE_PERMISSIONS must be `expected`: a route registered with another permission is a bug. */
function assertTable(c: Context<Env>, expected: string): void {
  const action = c.get("action");
  if (action === undefined || ROUTE_PERMISSIONS[action] !== expected) {
    throw new Error(`route ${c.req.routePath} (${action ?? "no operation"}) is registered with ${expected}, the table says ${action === undefined ? "nothing" : String(ROUTE_PERMISSIONS[action])}`);
  }
}

/** The user's role in `tenantId` and whether their email is verified; null when not a member. */
async function membership(deps: Deps, tenantId: string, userId: string): Promise<{ role: Role; verified: boolean } | null> {
  const rows = await deps.db.query<{ role: string; email_verified_at: unknown }>(
    "select m.role, u.email_verified_at from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.user_id = $2",
    [tenantId, userId],
  );
  const r = rows[0];
  return r === undefined || !isRole(r.role) ? null : { role: r.role, verified: r.email_verified_at !== null };
}

/** A tenant principal from a `renox_pat_` token, or 401. */
async function fromToken(deps: Deps, c: Context<Env>, value: string): Promise<{ principal: Principal & { kind: "tenant"; via: "token" }; verified: boolean }> {
  const rows = await deps.db.query<{ id: string; tenant_id: string; scopes: string[]; expires_at: unknown; revoked_at: unknown; user_id: string | null }>(
    "select id, tenant_id, scopes, expires_at, revoked_at, user_id from tokens where token_sha256 = $1",
    [sha256hex(value)],
  );
  const token = rows[0];
  if (token === undefined) throw unauthenticated();
  c.set("attempt", { tenantId: token.tenant_id, actor: `token:${token.id}` });
  if (token.revoked_at !== null || num(token.expires_at) <= deps.now()) throw unauthenticated();
  let role: Role | null = null;
  let verified = true;
  if (token.user_id !== null) {
    // A token outlives nothing: once its user leaves the tenant, it stops working.
    const m = await membership(deps, token.tenant_id, token.user_id);
    if (m === null) throw unauthenticated();
    role = m.role;
    verified = m.verified;
  }
  return {
    principal: { kind: "tenant", via: "token", tenantId: token.tenant_id, tokenId: token.id, scopes: token.scopes, userId: token.user_id, role },
    verified,
  };
}

/** The session of the cookie, with CSRF checked on mutating requests; null when there is no live session. */
async function sessionOf(deps: Deps, c: Context<Env>): Promise<{ id: string; userId: string; tenantId: string | null } | null> {
  const value = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (value === null) return null;
  const s = await findSession(deps.db, value, deps.now());
  if (s === null) return null;
  c.set("attempt", { tenantId: s.tenant_id, actor: `user:${s.user_id}` });
  // SameSite=Strict is the first defence; the header is the second.
  if (MUTATING.has(c.req.method) && !csrfMatches(value, c.req.header(CSRF_HEADER))) throw forbidden(CSRF_HEADER, "missing or wrong");
  return { id: s.id, userId: s.user_id, tenantId: s.tenant_id };
}

/** A principal of the tenant holding `permission` (on the `{app}` path parameter, if any). */
export function tenantAuth(deps: Deps, permission: Permission): MiddlewareHandler<Env> {
  return async (c, next) => {
    assertTable(c, permission);
    const header = c.req.header("authorization");
    let principal: Principal & { kind: "tenant" };
    let verified: boolean;
    if (header !== undefined) {
      const bearer = parseBearer(header);
      if (bearer === null || bearer.kind !== "pat") throw unauthenticated();
      const t = await fromToken(deps, c, bearer.value);
      ({ principal, verified } = t);
      const p = t.principal;
      c.set("principal", p);
      limitToken(deps, c, p.tokenId);
      if (!isTokenPermission(permission) || !allows(p.scopes, permission, c.req.param("app"))) throw forbidden();
      if (p.role !== null && !roleAllows(p.role, permission)) throw forbidden("role", p.role);
      await deps.db.query("update tokens set last_used_at = $1, last_used_ip = $2 where id = $3", [deps.now(), clientIp(c), p.tokenId]);
    } else {
      const s = await sessionOf(deps, c);
      if (s === null) throw unauthenticated();
      c.set("principal", { kind: "user", userId: s.userId, sessionId: s.id, tenantId: s.tenantId });
      if (s.tenantId === null) throw forbidden("tenant", "the session has no tenant");
      const m = await membership(deps, s.tenantId, s.userId);
      if (m === null) throw forbidden("tenant", "not a member");
      principal = { kind: "tenant", via: "session", tenantId: s.tenantId, sessionId: s.id, userId: s.userId, role: m.role };
      verified = m.verified;
      c.set("principal", principal);
      if (!roleAllows(m.role, permission)) throw forbidden("role", m.role);
    }
    // #113: the email address is verified before the first deploy.
    if (permission === "deploy" && !verified) throw forbidden("email", "verify the email address before deploying");
    await requestScope.run({ tenantId: principal.tenantId, scoped: false }, next);
  };
}

/** A signed-in user (session cookie), whatever their tenant and role. */
export function accountAuth(deps: Deps): MiddlewareHandler<Env> {
  return async (c, next) => {
    assertTable(c, "account");
    const s = await sessionOf(deps, c);
    if (s === null) throw unauthenticated();
    c.set("principal", { kind: "user", userId: s.userId, sessionId: s.id, tenantId: s.tenantId });
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

/** The node principal set by nodeAuth. */
export function nodeId(c: { get(key: "principal"): Env["Variables"]["principal"] }): string {
  const p = c.get("principal");
  if (p?.kind !== "node") throw unauthenticated();
  return p.nodeId;
}

/** The user principal set by accountAuth or tenantAuth on a session. */
export function sessionUser(c: { get(key: "principal"): Env["Variables"]["principal"] }): { userId: string; sessionId: string; tenantId: string | null } {
  const p = c.get("principal");
  if (p?.kind === "user") return p;
  if (p?.kind === "tenant" && p.via === "session") return p;
  throw unauthenticated();
}
