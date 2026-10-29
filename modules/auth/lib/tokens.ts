// One-time tokens of the auth module (#240; docs/24-threat-model.md F4,
// "Magic link and reset token replay"): 32 random bytes, only the SHA-256
// is stored, 15 minutes by default, single use (consumed with one
// conditional UPDATE), bound to the user agent family of the request that
// asked for it.

import { type AuthCtx, normalizeEmail, randomHex, sha256Hex, startSession, type User } from "./core.ts";

export type Purpose = "magic" | "reset";

export const TOKEN_TTL_SECONDS = 15 * 60;

const now = (): number => Math.floor(Date.now() / 1000);

/** The user agent family, as stored with sessions (`Chrome`, `Firefox`, ...). */
export function uaFamily(headers: Headers): string {
  const ua = headers.get("user-agent") ?? "";
  for (const f of ["Edg", "Firefox", "Chrome", "Safari", "curl"]) if (ua.includes(f)) return f === "Edg" ? "Edge" : f;
  return ua ? "Other" : "Unknown";
}

/** Create a token for `userId`; returns the raw token (only for the mail; never logged). */
export async function createToken(ctx: AuthCtx, purpose: Purpose, userId: string, ttl = TOKEN_TTL_SECONDS): Promise<string> {
  const token = randomHex(32);
  const t = now();
  await ctx.db.execute(
    "insert into auth__tokens (id, purpose, token_hash, user_id, user_agent, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    [randomHex(16), purpose, await sha256Hex(token), userId, uaFamily(ctx.headers), t + ttl, t],
  );
  return token;
}

/**
 * Consume `token` once: the user id when it is a live token of `purpose`
 * asked for from the same user agent family, else null. A second use, an
 * expired token, and another browser family all get null.
 */
export async function consumeToken(ctx: AuthCtx, purpose: Purpose, token: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/u.test(token)) return null;
  const hash = await sha256Hex(token);
  const t = now();
  const r = await ctx.db.execute(
    "update auth__tokens set used_at = ? where token_hash = ? and purpose = ? and used_at is null and expires_at > ? and user_agent = ?",
    [t, hash, purpose, t, uaFamily(ctx.headers)],
  );
  if (r.changes !== 1) return null;
  const row = await ctx.db.queryOne<{ user_id: string | null }>("select user_id from auth__tokens where token_hash = ?", [hash]);
  return row?.user_id ?? null;
}

/** Sends through the `auth.send_mail` hook: the app (or a mail module) fills it. */
export interface Mail {
  to: string;
  template: "magic_link" | "password_reset";
  args: { url: string; expires_minutes: number; display_name: string };
}

export const SEND_LIMIT = 5;
const SEND_WINDOW = 15 * 60;

/** The module's base path (`login_path` without `/login`). */
export function mountOf(ctx: Pick<AuthCtx, "config">): string {
  const p = typeof ctx.config.login_path === "string" && ctx.config.login_path.startsWith("/") ? ctx.config.login_path : "/auth/login";
  return p.replace(/\/login\/?$/u, "");
}

/** The answer to every request for a link, whether or not the email has an account. */
export const SENT = "If an account exists for that email, a link is on its way. It works once, for 15 minutes.";

/** 5 sends per email per 15 minutes; past it nothing is sent (the answer stays the same). */
async function sendAllowed(ctx: AuthCtx, email: string): Promise<boolean> {
  const key = `send:${email}`;
  const t = now();
  const row = await ctx.db.queryOne<{ count: number; window_start: number }>("select count, window_start from auth__attempts where bucket = ?", [key]);
  if (row === null || t - row.window_start >= SEND_WINDOW) {
    await ctx.db.execute("insert or replace into auth__attempts (bucket, count, window_start) values (?, 1, ?)", [key, t]);
    return true;
  }
  if (row.count >= SEND_LIMIT) return false;
  await ctx.db.execute("update auth__attempts set count = count + 1 where bucket = ?", [key]);
  return true;
}

/**
 * A magic link or a reset link for `email`: a token and one mail through
 * `auth.send_mail` when the account exists and the bucket allows it. The
 * result is the same in every case (no enumeration).
 */
export async function sendLink(ctx: AuthCtx & { url: URL }, purpose: Purpose, rawEmail: string): Promise<string> {
  const email = normalizeEmail(rawEmail);
  if (!(await sendAllowed(ctx, email))) return SENT;
  const user = await ctx.db.queryOne<User>("select id, email, display_name, created_at from auth__users where email = ?", [email]);
  if (user === null) return SENT;
  const token = await createToken(ctx, purpose, user.id);
  const path = purpose === "magic" ? `${mountOf(ctx)}/magic/${token}` : `${mountOf(ctx)}/reset/confirm?token=${token}`;
  const mail: Mail = { to: user.email, template: purpose === "magic" ? "magic_link" : "password_reset", args: { url: `${ctx.url.origin}${path}`, expires_minutes: TOKEN_TTL_SECONDS / 60, display_name: user.display_name } };
  await ctx.hooks.run("auth.send_mail", mail);
  return SENT;
}

const intConfig = (ctx: AuthCtx, key: string, fallback: number): number => {
  const v = ctx.config[key];
  return typeof v === "number" && Number.isSafeInteger(v) ? v : fallback;
};

/**
 * `GET <mount>/magic/<token>`: the token once, then `auth.after_login`, a new
 * session (the browser's previous one revoked), and `auth.login`. A halting
 * filler answers instead and no session starts.
 */
export async function signInWithMagic(ctx: AuthCtx, token: string): Promise<{ ok: true; cookie: string; halt?: Response } | { ok: false }> {
  const userId = await consumeToken(ctx, "magic", token);
  if (userId === null) return { ok: false };
  // The link proves the mailbox: mark the email verified.
  await ctx.db.execute("update auth__users set email_verified_at = coalesce(email_verified_at, ?) where id = ?", [now(), userId]);
  const hook = await ctx.hooks.run("auth.after_login", { user_id: userId });
  if (hook.halt) return { ok: true, cookie: "", halt: hook.response };
  const session = await startSession(ctx, userId);
  await ctx.events.emit("auth.login", { user_id: userId, at: now() });
  return { ok: true, cookie: session.cookie };
}

/**
 * The reset confirm: the token once, the new password, every session of
 * the user revoked, a new one for this browser, and `auth.password_changed`.
 */
export async function confirmReset(ctx: AuthCtx, token: string, password: string): Promise<{ ok: true; cookie: string } | { ok: false; error: string }> {
  const min = intConfig(ctx, "password_min_length", 12);
  if (password.length < min) return { ok: false, error: `Use a password of at least ${min} characters.` };
  if (new TextEncoder().encode(password).length > 1024) return { ok: false, error: "That password is too long." };
  const userId = await consumeToken(ctx, "reset", token);
  if (userId === null) return { ok: false, error: "This link has expired or was already used. Ask for a new one." };
  const t = now();
  await ctx.db.execute("update auth__users set password_hash = ?, updated_at = ? where id = ?", [await ctx.password.hash(password), t, userId]);
  await ctx.db.execute("update auth__sessions set revoked_at = ? where user_id = ? and revoked_at is null", [t, userId]);
  const session = await startSession(ctx, userId);
  await ctx.events.emit("auth.password_changed", { user_id: userId, at: t });
  return { ok: true, cookie: session.cookie };
}
