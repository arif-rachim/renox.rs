// Dashboard sessions (#113): `__Host-` cookie, absolute expiry 30 days, idle
// expiry 24 hours, revocable one by one or all at once. Only the SHA-256 of
// the cookie value is stored.

import { randomBytes } from "node:crypto";
import { num, type Db } from "../db/db.ts";
import { base32, ulid } from "../ids.ts";
import { sameDigest, sha256hex } from "./tokens.ts";

export const SESSION_COOKIE = "__Host-renox_session";
export const DEVICE_COOKIE = "__Host-renox_device";
export const CSRF_HEADER = "x-renox-csrf";

export const SESSION_ABSOLUTE_MS = 30 * 86_400_000;
export const SESSION_IDLE_MS = 86_400_000;
/** last_seen_at is written at most this often per session. */
const TOUCH_MS = 60_000;

export const newSessionValue = (): string => `renox_ses_${base32(randomBytes(20))}`;
export const newDeviceValue = (): string => base32(randomBytes(20));
/** A random single-use value (email links, invitations, device codes): 160 bits, base32. */
export const newOneTimeValue = (): string => base32(randomBytes(20));

/** The CSRF value of a session: derived from the cookie, so nothing more is stored. */
export const csrfOf = (sessionValue: string): string => sha256hex(`renox-csrf\0${sessionValue}`);
export const csrfMatches = (sessionValue: string, header: string | undefined): boolean =>
  header !== undefined && /^[0-9a-f]{64}$/u.test(header) && sameDigest(header, csrfOf(sessionValue));

export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** `__Host-` cookies: Secure, Path=/, no Domain (RFC 6265bis). */
export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export interface SessionRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  /** #293: `verify` or `enrol` while the second factor is outstanding. */
  mfa_state: "verify" | "enrol" | null;
}

/** `mfaState` (#293, src/auth/mfa.ts): `verify` until the second factor is given, `enrol` until one is set up. */
export async function createSession(db: Db, userId: string, tenantId: string | null, now: number, ip: string | null, userAgent: string | null, mfaState: "verify" | "enrol" | null = null): Promise<{ id: string; value: string }> {
  const value = newSessionValue();
  const id = `ses_${ulid(now)}`;
  await db.query(
    "insert into sessions (id, user_id, tenant_id, token_sha256, created_at, last_seen_at, expires_at, ip, user_agent, mfa_state) values ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)",
    [id, userId, tenantId, sha256hex(value), now, now + SESSION_ABSOLUTE_MS, ip, userAgent === null ? null : userAgent.slice(0, 256), mfaState],
  );
  return { id, value };
}

/** The live session for a cookie value, or null (unknown, revoked, past its absolute or idle expiry). */
export async function findSession(db: Db, value: string, now: number): Promise<SessionRow | null> {
  if (!/^renox_ses_[a-z2-7]{32}$/u.test(value)) return null;
  const rows = await db.query<Record<string, unknown>>(
    "select id, user_id, tenant_id, created_at, last_seen_at, expires_at, revoked_at, mfa_state from sessions where token_sha256 = $1",
    [sha256hex(value)],
  );
  const r = rows[0];
  if (r === undefined || r.revoked_at !== null) return null;
  const s: SessionRow = {
    id: r.id as string,
    user_id: r.user_id as string,
    tenant_id: (r.tenant_id as string | null) ?? null,
    created_at: num(r.created_at),
    last_seen_at: num(r.last_seen_at),
    expires_at: num(r.expires_at),
    mfa_state: (r.mfa_state as "verify" | "enrol" | null) ?? null,
  };
  if (s.expires_at <= now || s.last_seen_at + SESSION_IDLE_MS <= now) return null;
  if (now - s.last_seen_at >= TOUCH_MS) await db.query("update sessions set last_seen_at = $1 where id = $2", [now, s.id]);
  return s;
}

export async function revokeSessions(db: Db, userId: string, now: number, onlyId?: string): Promise<number> {
  const rows = await db.query(
    `update sessions set revoked_at = $1 where user_id = $2 and revoked_at is null${onlyId === undefined ? "" : " and id = $3"} returning id`,
    onlyId === undefined ? [now, userId] : [now, userId, onlyId],
  );
  return rows.length;
}
