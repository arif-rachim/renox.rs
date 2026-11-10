// Token values, hashes, and scopes (docs/contracts/deploy-api.md section 2).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { base32, ulid } from "../ids.ts";
import { jsonb, type Db } from "../db/db.ts";

export type TokenKind = "pat" | "node" | "op";

const BEARER = /^Bearer (renox_(pat|node|op)_[a-z2-7]{32})$/u;

/** A new token value: renox_<kind>_ + 32 base32 characters (160 random bits). */
export const newTokenValue = (kind: TokenKind): string => `renox_${kind}_${base32(randomBytes(20))}`;

export const sha256hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/** The token in an Authorization header, or null when absent or malformed. */
export function parseBearer(header: string | undefined): { kind: TokenKind; value: string } | null {
  const m = header === undefined ? null : BEARER.exec(header);
  return m === null ? null : { kind: m[2] as TokenKind, value: m[1] as string };
}

/** Constant-time comparison of two hex digests. */
export function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export const ACTIONS = [
  "apps:read",
  "apps:write",
  "deploy",
  "logs:read",
  "secrets:read",
  "secrets:write",
  "domains:write",
  "tokens:write",
  // deploy-api.md 0.5 section 19: the module registry.
  "registry:read",
  "registry:publish",
  // deploy-api.md 0.7 section 3 (#536): deleteApp and restoreApp.
  "apps:delete",
] as const;
export type Action = (typeof ACTIONS)[number];

/** True when `scopes` allow `action`, on `app` if the operation names one. */
export function allows(scopes: readonly string[], action: Action, app?: string): boolean {
  return scopes.some((s) => s === "*" || s === action || (app !== undefined && s === `${action}:${app}`));
}

/** Splits `<action>` or `<action>:<app>`; null for `*` or anything else. */
export function parseScope(scope: string): { action: Action; app?: string } | null {
  for (const action of ACTIONS) {
    if (scope === action) return { action };
    if (scope.startsWith(`${action}:`)) return { action, app: scope.slice(action.length + 1) };
  }
  return null;
}

/** True when a holder of `held` may hand out `wanted` (no token creates a stronger one). */
export function covers(held: readonly string[], wanted: string): boolean {
  if (held.includes("*")) return true;
  const parsed = parseScope(wanted);
  if (parsed === null) return false;
  return allows(held, parsed.action, parsed.app);
}

export const DAY_MS = 86_400_000;

export interface CreatedToken {
  id: string;
  name: string;
  token: string;
  scopes: string[];
  created_at: number;
  expires_at: number;
}

/** Inserts a tenant token; the value is returned here and never stored. `userId`: the user it acts for (at most their role). */
export async function createTenantToken(
  db: Db,
  tenantId: string,
  name: string,
  scopes: string[],
  days: number,
  now: number,
  userId: string | null = null,
  familyId: string | null = null,
  ttlMs: number = days * DAY_MS,
): Promise<CreatedToken> {
  const value = newTokenValue("pat");
  const id = `tok_${ulid(now)}`;
  const expires = now + ttlMs;
  await db.query(
    "insert into tokens (id, tenant_id, name, token_sha256, scopes, created_at, expires_at, user_id, family_id) values ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8, $9)",
    [id, tenantId, name, sha256hex(value), jsonb(scopes), now, expires, userId, familyId],
  );
  return { id, name, token: value, scopes, created_at: now, expires_at: expires };
}

/** The life of a refresh token (RFC 6749 section 6; docs/20-ai-agents-mcp.md 1b, "Sessions: refresh tokens"). */
export const REFRESH_TTL_MS = 30 * DAY_MS;

/**
 * Revokes the token `id` of the tenant and everything of its family: the other
 * access tokens and the refresh tokens of the same OAuth connection. A row
 * without a family is its own family. `userId`: only a token of that user (the
 * members' own-token rule of the token API). False when there is no such row.
 */
export async function revokeTokenFamily(db: Db, tenantId: string, id: string, now: number, userId: string | null = null): Promise<boolean> {
  const rows = await db.query<{ id: string; family_id: string | null }>("select id, family_id from tokens where tenant_id = $1 and id = $2 and ($3::text is null or user_id = $3)", [tenantId, id, userId]);
  const row = rows[0];
  if (row === undefined) return false;
  await db.query("update tokens set revoked_at = $2 where tenant_id = $1 and revoked_at is null and (id = $3 or family_id = $3)", [tenantId, now, row.family_id ?? row.id]);
  return true;
}
