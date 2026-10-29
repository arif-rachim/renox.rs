// Phone-first sign-in and phone verification (#291; docs/21-uae-gcc-strategy.md:
// +971 OTP is table stakes). auth owns the code: 6 digits, 5 minutes, 5
// attempts, single use, stored as argon2id (ctx.password, like passwords).
// It is delivered through the hook `auth.send_otp` ({ to, code, purpose }),
// which the whatsapp module fills (#290) and an SMS module will in F7:
// auth cannot call an optional module's service directly (ops.md 1.3.0,
// the dependency check), and a hook needs no dependency.
//
// The sign-in request answers the same whether or not a user has the
// phone, and sends nothing for an unknown one; it costs one argon2 run in
// both cases. Buckets: 5 codes per phone and 30 per IP address in 15
// minutes, on top of the 5 attempts per code.

import { type AuthCtx, bucket, clientIp, now, startSession, type User } from "./core.ts";

export const CODE_TTL_SECONDS = 5 * 60;
export const CODE_ATTEMPTS = 5;
export const SENDS_PER_PHONE = 5;
export const SENDS_PER_IP = 30;

/** The same message for an unknown phone, a wrong, expired or used code, and a locked bucket. */
export const GENERIC_PHONE_ERROR = "The code is incorrect or has expired, or there were too many attempts. Request a new code.";
export const SENT_MESSAGE = "If this number has an account, a code is on its way.";

/** argon2id of a code nobody knows, to spend the same on an unknown phone. */
const DUMMY_CODE = "000000-unused";

/** A phone in E.164; a UAE local number (`05x xxx xxxx`) becomes `+9715x…`. */
export function normalizePhone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let p = v.replace(/[\s\-().]/gu, "");
  if (p.startsWith("00")) p = `+${p.slice(2)}`;
  else if (/^0[0-9]{8,9}$/u.test(p)) p = `+971${p.slice(1)}`;
  if (!/^\+[1-9][0-9]{7,14}$/u.test(p)) return null;
  // UAE numbers: +971 then 8 or 9 digits (mobiles start with 5).
  if (p.startsWith("+971") && !/^\+971[0-9]{8,9}$/u.test(p)) return null;
  return p;
}

function newCode(): string {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String((b[0] as number) % 1_000_000).padStart(6, "0");
}

async function issue(ctx: AuthCtx, phone: string, purpose: "login" | "verify", userId: string): Promise<void> {
  const code = newCode();
  const t = now();
  await ctx.db.execute("delete from auth__phone_codes where phone = ? and purpose = ?", [phone, purpose]);
  await ctx.db.execute("insert into auth__phone_codes (phone, purpose, user_id, code_hash, expires_at, attempts, created_at) values (?, ?, ?, ?, ?, 0, ?)", [phone, purpose, userId, await ctx.password.hash(code), t + CODE_TTL_SECONDS, t]);
  await ctx.hooks.run("auth.send_otp", { to: phone, code, purpose });
}

/** Whether another code may be sent (and counts this one). */
async function mayRequest(ctx: AuthCtx, phone: string): Promise<boolean> {
  const byPhone = `otp:${phone}`;
  const byIp = `otpip:${clientIp(ctx.headers)}`;
  if ((await bucket(ctx, byPhone, false)) >= SENDS_PER_PHONE || (await bucket(ctx, byIp, false)) >= SENDS_PER_IP) return false;
  await bucket(ctx, byPhone, true);
  await bucket(ctx, byIp, true);
  return true;
}

/** Sign-in step 1: a code to the phone of the account that verified it. The same answer in every case. */
export async function requestLoginCode(ctx: AuthCtx, input: unknown): Promise<{ ok: true; phone: string; message: string } | { ok: false; error: string }> {
  const phone = normalizePhone(input);
  if (phone === null) return { ok: false, error: "Enter a mobile number such as +971 50 123 4567." };
  const answer = { ok: true as const, phone, message: SENT_MESSAGE };
  if (!(await mayRequest(ctx, phone))) return answer;
  const user = await ctx.db.queryOne<{ id: string }>("select id from auth__users where phone = ? and phone_verified_at is not null", [phone]);
  if (user === null) {
    await ctx.password.hash(DUMMY_CODE);
    return answer;
  }
  await issue(ctx, phone, "login", user.id);
  return answer;
}

/** Checks a code: one attempt, then the row is used up, expired, or exhausted. */
async function consume(ctx: AuthCtx, phone: string | null, purpose: "login" | "verify", code: unknown): Promise<string | null> {
  if (phone === null || typeof code !== "string" || !/^[0-9]{6}$/u.test(code.trim())) return null;
  const row = await ctx.db.queryOne<{ user_id: string; code_hash: string; expires_at: number; attempts: number }>("select user_id, code_hash, expires_at, attempts from auth__phone_codes where phone = ? and purpose = ?", [phone, purpose]);
  if (row === null || row.expires_at <= now() || row.attempts >= CODE_ATTEMPTS) {
    await ctx.password.hash(DUMMY_CODE); // one argon2 run, like a real check
    return null;
  }
  await ctx.db.execute("update auth__phone_codes set attempts = attempts + 1 where phone = ? and purpose = ?", [phone, purpose]);
  if (!(await ctx.password.verify(code.trim(), row.code_hash))) return null;
  await ctx.db.execute("delete from auth__phone_codes where phone = ? and purpose = ?", [phone, purpose]);
  return row.user_id;
}

export type PhoneLogin = { ok: true; user: User; cookie: string; halt?: Response } | { ok: false; error: string };

/** Sign-in step 2: the code, then `auth.after_login`, a new session, `auth.login`, as the password flow. */
export async function verifyLoginCode(ctx: AuthCtx, phoneInput: unknown, code: unknown, next?: string): Promise<PhoneLogin> {
  const userId = await consume(ctx, normalizePhone(phoneInput), "login", code);
  if (userId === null) return { ok: false, error: GENERIC_PHONE_ERROR };
  const user = await ctx.db.queryOne<User>("select id, email, display_name, created_at from auth__users where id = ?", [userId]);
  if (user === null) return { ok: false, error: GENERIC_PHONE_ERROR };
  const hook = await ctx.hooks.run("auth.after_login", { user_id: user.id, ...(next ? { next } : {}) });
  if (hook.halt) return { ok: true, user, cookie: "", halt: hook.response };
  const session = await startSession(ctx, user.id);
  await ctx.events.emit("auth.login", { user_id: user.id, at: now() });
  return { ok: true, user, cookie: session.cookie };
}

/** Account page: a code to a new phone for the signed-in user. */
export async function requestVerifyCode(ctx: AuthCtx, user: User, input: unknown): Promise<{ ok: true; phone: string } | { ok: false; error: string }> {
  const phone = normalizePhone(input);
  if (phone === null) return { ok: false, error: "Enter a mobile number such as +971 50 123 4567." };
  if (!(await mayRequest(ctx, phone))) return { ok: false, error: "Too many codes for this number. Try again later." };
  await issue(ctx, phone, "verify", user.id);
  return { ok: true, phone };
}

/** Account page: the code; the phone becomes the user's, verified. */
export async function confirmPhone(ctx: AuthCtx, user: User, phoneInput: unknown, code: unknown): Promise<{ ok: true; phone: string } | { ok: false; error: string }> {
  const phone = normalizePhone(phoneInput);
  const owner = await consume(ctx, phone, "verify", code);
  if (owner === null || owner !== user.id || phone === null) return { ok: false, error: GENERIC_PHONE_ERROR };
  const taken = await ctx.db.queryOne("select 1 as x from auth__users where phone = ? and id != ?", [phone, user.id]);
  if (taken !== null) return { ok: false, error: "That number belongs to another account." };
  const t = now();
  await ctx.db.execute("update auth__users set phone = ?, phone_verified_at = ?, updated_at = ? where id = ?", [phone, t, t, user.id]);
  return { ok: true, phone };
}
