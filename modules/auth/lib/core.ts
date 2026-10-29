// The auth module's logic, shared by services.ts and the pages
// (docs/18-build-plan.md M1; docs/24-threat-model.md, "Login brute force,
// credential stuffing, enumeration", "Session fixation", "Session hijacking").
//
// - Passwords: argon2id through `ctx.password` (platform op, m = 64 MiB,
//   t = 3, p = 1, ops.md 1.3.0 section 16). An unknown email is verified
//   against a fixed hash, so it costs the same as a wrong password.
// - Sessions: a 32-byte random token in the `__Host-renox_auth` cookie
//   (HttpOnly, Secure, SameSite=Lax, Path=/); only its SHA-256 is stored.
//   Idle and absolute expiry from config. A new session at every sign-in
//   (the previous one of the browser is revoked: no fixation) and at a
//   password change (the others are revoked).
// - Not the platform's page `session.id` (ops.md section 14): that one
//   lives as long as the browser keeps it and exists before sign-in; a user
//   session has its own lifetime and is revoked on logout.
// - Buckets: 10 failures per account and 30 per IP address in 15 minutes;
//   past either, every attempt gets the same generic message.

import type { DbStatements } from "renox";

export interface AuthCtx {
  db: DbStatements;
  headers: Headers;
  config: Readonly<Record<string, unknown>>;
  password: { hash(password: string): Promise<string>; verify(password: string, hash: string): Promise<boolean> };
  events: { emit(name: string, payload: Record<string, unknown>, options?: { durable?: boolean }): Promise<string> };
  hooks: { run(name: string, args: unknown): Promise<{ halt: false } | { halt: true; response: Response; module: string }> };
}

export interface User {
  id: string;
  email: string;
  display_name: string;
  created_at: number;
}

export const COOKIE = "__Host-renox_auth";
export const ACCOUNT_LIMIT = 10;
export const IP_LIMIT = 30;
export const WINDOW_SECONDS = 15 * 60;

/** The same message for an unknown email, a wrong password, and a locked bucket. */
export const GENERIC_LOGIN_ERROR = "The email or password is incorrect, or there were too many attempts. Try again later.";

/**
 * A valid argon2id hash of a random password nobody knows, at the platform's
 * parameters: verifying an unknown email against it costs one argon2 run,
 * like a known one.
 */
const DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=1$YXV0aC10aW1pbmctc2FsdA$Hk5oYhG8b6q3U0mW1Vd8Ow3Y0bBqX9Y4s2y1zQm4n2c";

const now = (): number => Math.floor(Date.now() / 1000);

const intConfig = (ctx: AuthCtx, key: string, fallback: number): number => {
  const v = ctx.config[key];
  return typeof v === "number" && Number.isSafeInteger(v) ? v : fallback;
};

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** `n` random bytes as hex. */
export function randomHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return hex(b);
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/u;

/** The `__Host-renox_auth` cookie of the request, if any. */
export function sessionToken(headers: Headers): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) {
      const v = part.slice(eq + 1).trim();
      return /^[0-9a-f]{64}$/u.test(v) ? v : null;
    }
  }
  return null;
}

/** `Set-Cookie` for a new session, valid until its absolute expiry. */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** `Set-Cookie` that removes the session cookie. */
export const clearCookie = (): string => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

const userAgentFamily = (headers: Headers): string => {
  const ua = headers.get("user-agent") ?? "";
  for (const f of ["Edg", "Firefox", "Chrome", "Safari", "curl"]) if (ua.includes(f)) return f === "Edg" ? "Edge" : f;
  return ua ? "Other" : "Unknown";
};

/** The live session of the request: not revoked, within idle and absolute expiry. Touches `last_seen_at`. */
export async function currentSession(ctx: AuthCtx): Promise<{ id: string; user: User } | null> {
  const token = sessionToken(ctx.headers);
  if (token === null) return null;
  const hash = await sha256Hex(token);
  const s = await ctx.db.queryOne<{ id: string; user_id: string; last_seen_at: number; absolute_expires_at: number; revoked_at: number | null }>(
    "select id, user_id, last_seen_at, absolute_expires_at, revoked_at from auth__sessions where token_hash = ?",
    [hash],
  );
  const t = now();
  const idle = intConfig(ctx, "session_idle_hours", 24) * 3600;
  if (s === null || s.revoked_at !== null || t >= s.absolute_expires_at || t - s.last_seen_at >= idle) return null;
  const user = await ctx.db.queryOne<User>("select id, email, display_name, created_at from auth__users where id = ?", [s.user_id]);
  if (user === null) return null;
  // At most once a minute, so a page view is not a write each time.
  if (t - s.last_seen_at >= 60) await ctx.db.execute("update auth__sessions set last_seen_at = ? where id = ?", [t, s.id]);
  return { id: s.id, user };
}

export async function currentUser(ctx: AuthCtx): Promise<User | null> {
  return (await currentSession(ctx))?.user ?? null;
}

/** Start a session for `userId`; revokes the browser's previous one (fixation). Returns the cookie. */
export async function startSession(ctx: AuthCtx, userId: string): Promise<{ id: string; cookie: string }> {
  const old = sessionToken(ctx.headers);
  const t = now();
  if (old !== null) await ctx.db.execute("update auth__sessions set revoked_at = ? where token_hash = ? and revoked_at is null", [t, await sha256Hex(old)]);
  const token = randomHex(32);
  const id = randomHex(16);
  const absolute = intConfig(ctx, "session_absolute_days", 30) * 86400;
  await ctx.db.execute(
    "insert into auth__sessions (id, token_hash, user_id, created_at, last_seen_at, absolute_expires_at, user_agent) values (?, ?, ?, ?, ?, ?, ?)",
    [id, await sha256Hex(token), userId, t, t, t + absolute, userAgentFamily(ctx.headers)],
  );
  return { id, cookie: sessionCookie(token, absolute) };
}

/** Bucket counts after `failed` (one more failure) or read only. */
async function bucket(ctx: AuthCtx, key: string, add: boolean): Promise<number> {
  const t = now();
  const row = await ctx.db.queryOne<{ count: number; window_start: number }>("select count, window_start from auth__attempts where bucket = ?", [key]);
  const fresh = row === null || t - row.window_start >= WINDOW_SECONDS;
  const count = fresh ? 0 : (row as { count: number }).count;
  if (!add) return count;
  if (fresh) await ctx.db.execute("insert or replace into auth__attempts (bucket, count, window_start) values (?, 1, ?)", [key, t]);
  else await ctx.db.execute("update auth__attempts set count = count + 1 where bucket = ?", [key]);
  return count + 1;
}

const clientIp = (headers: Headers): string => headers.get("x-renox-client-ip") ?? "unknown";

/** `halt`: a filler of `auth.after_login` answered; no session was started and `cookie` is empty. */
export type LoginResult = { ok: true; user: User; cookie: string; halt?: Response } | { ok: false; error: string };

/** The password check, buckets, session rotation, the `auth.after_login` hook, and the `auth.login` event. */
export async function login(ctx: AuthCtx, input: { email?: unknown; password?: unknown; next?: string }): Promise<LoginResult> {
  const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
  const password = typeof input.password === "string" ? input.password : "";
  const acct = `acct:${email}`;
  const ip = `ip:${clientIp(ctx.headers)}`;
  const locked = (await bucket(ctx, acct, false)) >= ACCOUNT_LIMIT || (await bucket(ctx, ip, false)) >= IP_LIMIT;
  const row = email ? await ctx.db.queryOne<User & { password_hash: string }>("select id, email, display_name, created_at, password_hash from auth__users where email = ?", [email]) : null;
  // Always one argon2 run: unknown email, wrong password, and lock cost the same.
  const valid = password.length > 0 && password.length <= 1024 ? await ctx.password.verify(password, row?.password_hash ?? DUMMY_HASH) : false;
  if (locked || row === null || !valid) {
    await bucket(ctx, acct, true);
    await bucket(ctx, ip, true);
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }
  await ctx.db.execute("delete from auth__attempts where bucket = ?", [acct]);
  const user: User = { id: row.id, email: row.email, display_name: row.display_name, created_at: row.created_at };
  // A filler that halts (2fa, F5) answers instead; no session is started yet.
  const hook = await ctx.hooks.run("auth.after_login", { user_id: user.id, ...(input.next ? { next: input.next } : {}) });
  if (hook.halt) return { ok: true, user, cookie: "", halt: hook.response };
  const session = await startSession(ctx, user.id);
  await ctx.events.emit("auth.login", { user_id: user.id, at: now() });
  return { ok: true, user, cookie: session.cookie };
}

export type RegisterResult = { ok: true; user: User; cookie: string } | { ok: false; error: string; halt?: Response };

/** `auth.before_register`, the checks, the argon2id hash, the user, a first session, and `auth.user_registered`. */
export async function register(ctx: AuthCtx, input: { email?: unknown; password?: unknown; display_name?: unknown }): Promise<RegisterResult> {
  const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
  const password = typeof input.password === "string" ? input.password : "";
  const displayName = typeof input.display_name === "string" && input.display_name.trim() ? input.display_name.trim().slice(0, 100) : email.split("@")[0] ?? "";
  if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
  const min = intConfig(ctx, "password_min_length", 12);
  if (password.length < min) return { ok: false, error: `Use a password of at least ${min} characters.` };
  if (new TextEncoder().encode(password).length > 1024) return { ok: false, error: "That password is too long." };
  const hook = await ctx.hooks.run("auth.before_register", { email, display_name: displayName });
  if (hook.halt) return { ok: false, error: "Registration is not open.", halt: hook.response };
  const taken = await ctx.db.queryOne("select 1 as x from auth__users where email = ?", [email]);
  // Same answer whether or not the email exists would need an email loop (#240);
  // until then a taken email is reported, and the IP bucket limits probing.
  if (taken !== null) {
    await bucket(ctx, `ip:${clientIp(ctx.headers)}`, true);
    return { ok: false, error: "An account with this email exists. Sign in instead." };
  }
  const hash = await ctx.password.hash(password);
  const t = now();
  const user: User = { id: randomHex(16), email, display_name: displayName, created_at: t };
  await ctx.db.execute("insert into auth__users (id, email, display_name, password_hash, created_at, updated_at) values (?, ?, ?, ?, ?, ?)", [user.id, email, displayName, hash, t, t]);
  await ctx.events.emit("auth.user_registered", { user_id: user.id, at: t, source: "password" });
  const session = await startSession(ctx, user.id);
  return { ok: true, user, cookie: session.cookie };
}

/** Revoke the request's session. */
export async function logout(ctx: AuthCtx): Promise<void> {
  const token = sessionToken(ctx.headers);
  if (token !== null) await ctx.db.execute("update auth__sessions set revoked_at = ? where token_hash = ? and revoked_at is null", [now(), await sha256Hex(token)]);
}

/** Change the password: checks the current one, revokes every other session, rotates this one. */
export async function changePassword(ctx: AuthCtx, current: string, next: string): Promise<{ ok: true; cookie: string } | { ok: false; error: string }> {
  const s = await currentSession(ctx);
  if (s === null) return { ok: false, error: "Sign in first." };
  const row = await ctx.db.queryOne<{ password_hash: string }>("select password_hash from auth__users where id = ?", [s.user.id]);
  if (row === null || !(await ctx.password.verify(current, row.password_hash))) return { ok: false, error: "The current password is incorrect." };
  const min = intConfig(ctx, "password_min_length", 12);
  if (next.length < min) return { ok: false, error: `Use a password of at least ${min} characters.` };
  const t = now();
  await ctx.db.execute("update auth__users set password_hash = ?, updated_at = ? where id = ?", [await ctx.password.hash(next), t, s.user.id]);
  await ctx.db.execute("update auth__sessions set revoked_at = ? where user_id = ? and revoked_at is null", [t, s.user.id]);
  const session = await startSession(ctx, s.user.id);
  return { ok: true, cookie: session.cookie };
}

/** The user's sessions, newest first; `current` marks this request's. */
export async function sessions(ctx: AuthCtx, userId: string, currentId: string) {
  const rows = await ctx.db.query<{ id: string; created_at: number; last_seen_at: number; user_agent: string | null }>(
    "select id, created_at, last_seen_at, user_agent from auth__sessions where user_id = ? and revoked_at is null and absolute_expires_at > ? order by created_at desc",
    [userId, now()],
  );
  return rows.map((r) => ({ ...r, current: r.id === currentId }));
}

export async function revokeSession(ctx: AuthCtx, userId: string, sessionId: string): Promise<void> {
  await ctx.db.execute("update auth__sessions set revoked_at = ? where id = ? and user_id = ? and revoked_at is null", [now(), sessionId, userId]);
}

export async function revokeAll(ctx: AuthCtx, userId: string): Promise<void> {
  await ctx.db.execute("update auth__sessions set revoked_at = ? where user_id = ? and revoked_at is null", [now(), userId]);
}

/** The login page (config `login_path`), with `next` kept only when it is a path of the app. */
export function loginUrl(ctx: Pick<AuthCtx, "config">, next?: string): string {
  const base = typeof ctx.config.login_path === "string" && ctx.config.login_path.startsWith("/") ? ctx.config.login_path : "/auth/login";
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? `${base}?next=${encodeURIComponent(next)}` : base;
}

/** A 303 to `target` if it is a path of the app (`redirect.safe` rules), else to `fallback`, with `cookies` set. */
export function redirectWith(target: string | null | undefined, cookies: string[], fallback = "/"): Response {
  const t = typeof target === "string" ? target : "";
  const safe = t.startsWith("/") && !t.startsWith("//") && !t.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(t) && t.length <= 2048 ? t : fallback;
  const headers = new Headers({ location: safe });
  for (const c of cookies) if (c) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

export class AuthRequiredError extends Error {
  readonly code = "AUTH_REQUIRED";
  readonly status = 401;
  constructor() {
    super("Sign in to continue.");
    this.name = "AuthRequiredError";
  }
}
