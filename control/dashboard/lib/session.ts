// Who is signed in to the dashboard (ADR D23): the user's own control-API
// token, kept per platform session (`ctx.session.id`) in `app__sessions`.
//
// The user signs in with a tenant token (`renox_pat_…`, from `renox login` or
// `renox tokens create`). The dashboard never proxies the API's password
// login: the API's per-IP sign-in buckets would see the node's address for
// every user (D23, Consequences). The token is stored only encrypted:
// AES-256-GCM under a key derived (HKDF-SHA-256) from the `DASHBOARD_KEY`
// secret, with the session id as associated data, so a row copied to another
// session does not decrypt. A token is never logged, rendered, or returned.
//
// Expiry follows the API's own sessions (control/api/src/auth/sessions.ts):
// 24 hours idle, 30 days absolute; the token's own expiry applies as well,
// since the API refuses an expired token.

import type { DbStatements, Secrets } from "renox";

export const IDLE_MS = 24 * 3600 * 1000;
export const ABSOLUTE_MS = 30 * 24 * 3600 * 1000;
/** `seen_at` is written at most this often, so most page views do not write. */
const TOUCH_MS = 5 * 60 * 1000;

/** The tenant token format (control/api/src/auth/tokens.ts). */
export const TOKEN_PATTERN = /^renox_pat_[a-z2-7]{32}$/u;

/** The secret the key is derived from: at least 32 characters. */
export const KEY_SECRET = "DASHBOARD_KEY";

const encoder = new TextEncoder();

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Why signing in or reading a sign-in is not possible right now. */
export class SessionKeyMissing extends Error {
  constructor() {
    super(`the ${KEY_SECRET} secret is not set (at least 32 characters)`);
  }
}

async function key(secrets: Secrets): Promise<CryptoKey> {
  const raw = secrets[KEY_SECRET];
  if (raw === undefined || raw.length < 32) throw new SessionKeyMissing();
  const base = await crypto.subtle.importKey("raw", encoder.encode(raw), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("renox-dashboard"), info: encoder.encode("app__sessions token v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Stores `token` for `sessionId`, replacing an earlier sign-in of the same session. */
export async function signIn(db: DbStatements, secrets: Secrets, sessionId: string, token: string, now: number): Promise<void> {
  if (!TOKEN_PATTERN.test(token)) throw new Error("not a tenant token");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(sessionId) }, await key(secrets), encoder.encode(token)),
  );
  await db.execute(
    `insert into app__sessions (session_id, token_iv, token_ct, created_at, seen_at) values (?1, ?2, ?3, ?4, ?4)
     on conflict (session_id) do update set token_iv = excluded.token_iv, token_ct = excluded.token_ct, created_at = excluded.created_at, seen_at = excluded.seen_at`,
    [sessionId, b64(iv), b64(ct), now],
  );
}

export async function signOut(db: DbStatements, sessionId: string): Promise<void> {
  await db.execute("delete from app__sessions where session_id = ?", [sessionId]);
}

/**
 * The token of `sessionId`, or null when the session is not signed in, has
 * expired (the row is deleted), or does not decrypt (a changed key: deleted).
 */
export async function currentToken(db: DbStatements, secrets: Secrets, sessionId: string, now: number): Promise<string | null> {
  const row = await db.queryOne<{ token_iv: string; token_ct: string; created_at: number; seen_at: number }>(
    "select token_iv, token_ct, created_at, seen_at from app__sessions where session_id = ?",
    [sessionId],
  );
  if (row === null) return null;
  if (now - row.seen_at > IDLE_MS || now - row.created_at > ABSOLUTE_MS) {
    await signOut(db, sessionId);
    return null;
  }
  let token: string;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(row.token_iv), additionalData: encoder.encode(sessionId) },
      await key(secrets),
      unb64(row.token_ct),
    );
    token = new TextDecoder().decode(plain);
  } catch (e) {
    if (e instanceof SessionKeyMissing) throw e;
    await signOut(db, sessionId);
    return null;
  }
  if (now - row.seen_at > TOUCH_MS) await db.execute("update app__sessions set seen_at = ? where session_id = ?", [now, sessionId]);
  return token;
}
