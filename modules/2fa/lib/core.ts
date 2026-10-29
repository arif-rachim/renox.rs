// The 2fa module's logic (#287). After the first factor, auth runs
// its after-login hook with a single-use `resume` ticket; when the user has a
// second factor, this module halts the sign-in with a redirect to
// `<mount>/verify` and keeps the ticket (sealed) under a short-lived cookie.
// A correct TOTP code, passkey or recovery code redeems it through
// `auth.resumeLogin`, which starts the session; the session is then
// recorded as verified, and the principal hook of auth gets `mfa_verified` while that
// verification is younger than `step_up_minutes`.

import { auth } from "renox:modules";
import { base64url, fromBase64url, generateTotpSecret, totpUri, verifyAssertion, verifyRegistration, verifyTotp, WebAuthnError } from "renox";

import { qrSvg } from "./qr.ts";

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export interface TwofaCtx {
  db: Db;
  headers: Headers;
  url?: URL;
  secrets: Record<string, string | undefined>;
  config: { step_up_minutes?: number; allow_totp?: boolean; allow_passkeys?: boolean; recovery_codes?: number; issuer?: string; base_path?: string; passkey_rp_id?: string; passkey_origin?: string };
}

export interface Session {
  id: string;
  user: { id: string; email: string; display_name: string };
}

export const COOKIE = "__Host-renox_2fa";
export const PENDING_MS = 10 * 60_000;
export const PENDING_ATTEMPTS = 5;
export const USER_LIMIT = 10;
export const WINDOW_MS = 15 * 60_000;
export const GENERIC_ERROR = "That code or passkey did not work. Try again, or use a recovery code.";

export class StepUpError extends Error {
  readonly code = "STEP_UP_REQUIRED";
  readonly status = 403;
  constructor(readonly details: { verify_url: string }) {
    super("Confirm it is you with your second factor first.");
    this.name = "StepUpError";
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function basePath(ctx: Pick<TwofaCtx, "config">): string {
  const p = ctx.config.base_path;
  return typeof p === "string" && /^\/[A-Za-z0-9/_-]*$/u.test(p) ? p.replace(/\/+$/u, "") || "/2fa" : "/2fa";
}

const stepUpMs = (ctx: TwofaCtx): number => Number(ctx.config.step_up_minutes ?? 15) * 60_000;

function randomHex(n: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
}

function key(ctx: TwofaCtx): Promise<CryptoKey> {
  const secret = ctx.secrets.TWOFA_KEY;
  if (!secret || secret.length < 16) throw new Error("TWOFA_KEY is not set (16 characters or more)");
  return crypto.subtle.digest("SHA-256", enc.encode(`twofa-seal:${secret}`)).then((raw) => crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));
}

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function seal(ctx: TwofaCtx, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(ctx), enc.encode(text)));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function unseal(ctx: TwofaCtx, sealed: string): Promise<string | null> {
  const [iv, ct] = sealed.split(".");
  if (!iv || !ct) return null;
  try {
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(ctx), unb64(ct)));
  } catch {
    return null;
  }
}

export async function session(): Promise<Session | null> {
  return (await auth.currentSession()) as Session | null;
}

export async function enrolled(ctx: TwofaCtx, userId: string): Promise<{ totp: boolean; passkeys: number }> {
  const totp = ctx.config.allow_totp !== false && (await ctx.db.queryOne("select 1 as x from twofa__totp where user_id = ? and confirmed_at is not null", [userId])) !== null;
  const passkeys = ctx.config.allow_passkeys === false ? 0 : ((await ctx.db.queryOne<{ n: number }>("select count(*) as n from twofa__webauthn where user_id = ?", [userId]))?.n ?? 0);
  return { totp, passkeys };
}

export const isEnrolled = async (ctx: TwofaCtx, userId: string): Promise<boolean> => {
  const e = await enrolled(ctx, userId);
  return e.totp || e.passkeys > 0;
};

const cookie = (value: string, maxAge: number): string => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
export const clearCookie = (): string => cookie("", 0);

function cookieValue(headers: Headers): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

/** auth's after-login hook filler: a user with a second factor goes to the verify page; the sign-in waits. */
export async function afterLogin(ctx: TwofaCtx, args: { user_id: string; next?: string; resume?: string }): Promise<{ halt: true; response: Response } | undefined> {
  if (typeof args.resume !== "string" || !(await isEnrolled(ctx, args.user_id))) return undefined;
  const token = randomHex(32);
  const next = typeof args.next === "string" && /^\/(?![/\\])/u.test(args.next) ? args.next : "/";
  await ctx.db.execute("delete from twofa__pending where expires_at < ?", [Date.now()]);
  await ctx.db.execute("insert into twofa__pending (token_hash, user_id, resume_sealed, next, expires_at) values (?, ?, ?, ?, ?)", [await sha256Hex(token), args.user_id, await seal(ctx, args.resume), next, Date.now() + PENDING_MS]);
  const location = `${basePath(ctx)}/verify?next=${encodeURIComponent(next)}`;
  return { halt: true, response: new Response(null, { status: 303, headers: { location, "set-cookie": cookie(token, PENDING_MS / 1000), "cache-control": "no-store" } }) };
}

export interface Pending {
  token_hash: string;
  user_id: string;
  resume_sealed: string;
  next: string | null;
  attempts: number;
}

export async function pending(ctx: TwofaCtx): Promise<Pending | null> {
  const token = cookieValue(ctx.headers);
  if (token === null || !/^[0-9a-f]{64}$/u.test(token)) return null;
  return ctx.db.queryOne<Pending>("select token_hash, user_id, resume_sealed, next, attempts from twofa__pending where token_hash = ? and expires_at > ?", [await sha256Hex(token), Date.now()]);
}

/** One more failure for the user's bucket; whether the user is locked. */
async function bucket(ctx: TwofaCtx, userId: string, add: boolean): Promise<number> {
  const key = `user:${userId}`;
  const t = Date.now();
  const row = await ctx.db.queryOne<{ count: number; window_start: number }>("select count, window_start from twofa__attempts where bucket = ?", [key]);
  const fresh = row === null || t - row.window_start >= WINDOW_MS;
  const count = fresh ? 0 : (row as { count: number }).count;
  if (!add) return count;
  if (fresh) {
    await ctx.db.execute("delete from twofa__attempts where bucket = ?", [key]);
    await ctx.db.execute("insert into twofa__attempts (bucket, count, window_start) values (?, 1, ?)", [key, t]);
  } else await ctx.db.execute("update twofa__attempts set count = count + 1 where bucket = ?", [key]);
  return count + 1;
}

export async function locked(ctx: TwofaCtx, userId: string, p: Pending | null): Promise<boolean> {
  return (p !== null && p.attempts >= PENDING_ATTEMPTS) || (await bucket(ctx, userId, false)) >= USER_LIMIT;
}

export async function failed(ctx: TwofaCtx, userId: string, p: Pending | null): Promise<void> {
  await bucket(ctx, userId, true);
  if (p !== null) await ctx.db.execute("update twofa__pending set attempts = attempts + 1 where token_hash = ?", [p.token_hash]);
}

export async function checkTotp(ctx: TwofaCtx, userId: string, code: unknown): Promise<boolean> {
  if (ctx.config.allow_totp === false || typeof code !== "string") return false;
  const row = await ctx.db.queryOne<{ secret_sealed: string; last_step: number | null }>("select secret_sealed, last_step from twofa__totp where user_id = ? and confirmed_at is not null", [userId]);
  if (row === null) return false;
  const secret = await unseal(ctx, row.secret_sealed);
  if (secret === null) return false;
  const step = await verifyTotp(secret, code.replace(/\s/gu, ""), { lastStep: row.last_step });
  if (step === null) return false;
  // Only a newer step: the same code twice in its window is refused (RFC 6238 section 5.2).
  const r = await ctx.db.execute("update twofa__totp set last_step = ? where user_id = ? and (last_step is null or last_step < ?)", [step, userId, step]);
  return r.changes === 1;
}

const RECOVERY = /^[a-z2-7]{5}-?[a-z2-7]{5}$/u;

export async function checkRecovery(ctx: TwofaCtx, userId: string, code: unknown): Promise<boolean> {
  if (typeof code !== "string") return false;
  const c = code.trim().toLowerCase();
  if (!RECOVERY.test(c)) return false;
  const hash = await sha256Hex(`${userId}:${c.replace("-", "")}`);
  return (await ctx.db.execute("update twofa__recovery set used_at = ? where user_id = ? and code_hash = ? and used_at is null", [Date.now(), userId, hash])).changes === 1;
}

/** A new set of recovery codes (the old ones stop working); shown once. */
export async function newRecoveryCodes(ctx: TwofaCtx, userId: string): Promise<string[]> {
  const n = Number(ctx.config.recovery_codes ?? 10);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const b = crypto.getRandomValues(new Uint8Array(10));
    const raw = Array.from(b, (x) => alphabet[x % 32]).join("");
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  await ctx.db.execute("delete from twofa__recovery where user_id = ?", [userId]);
  for (const c of codes) await ctx.db.execute("insert into twofa__recovery (user_id, code_hash, created_at) values (?, ?, ?)", [userId, await sha256Hex(`${userId}:${c.replace("-", "")}`), Date.now()]);
  return codes;
}

export async function recoveryLeft(ctx: TwofaCtx, userId: string): Promise<number> {
  return (await ctx.db.queryOne<{ n: number }>("select count(*) as n from twofa__recovery where user_id = ? and used_at is null", [userId]))?.n ?? 0;
}

export function relyingParty(ctx: TwofaCtx): { rpId: string; origin: string } {
  const host = ctx.url?.host ?? "localhost";
  const rpId = ctx.config.passkey_rp_id || (ctx.url?.hostname ?? "localhost");
  return { rpId, origin: ctx.config.passkey_origin || `https://${host}` };
}

async function challenge(ctx: TwofaCtx, purpose: "register" | "verify", userId: string): Promise<string> {
  const c = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const t = Date.now();
  await ctx.db.execute("delete from twofa__challenges where expires_at < ?", [t]);
  await ctx.db.execute("insert into twofa__challenges (challenge, purpose, user_id, expires_at) values (?, ?, ?, ?)", [c, purpose, userId, t + 5 * 60_000]);
  return c;
}

async function takeChallenge(ctx: TwofaCtx, clientDataJSON: string, purpose: "register" | "verify", userId: string): Promise<string | null> {
  let c: unknown;
  try {
    c = (JSON.parse(dec.decode(fromBase64url(clientDataJSON))) as { challenge?: unknown }).challenge;
  } catch {
    return null;
  }
  if (typeof c !== "string") return null;
  const t = Date.now();
  const r = await ctx.db.execute("update twofa__challenges set used_at = ? where challenge = ? and purpose = ? and user_id = ? and used_at is null and expires_at > ?", [t, c, purpose, userId, t]);
  return r.changes === 1 ? c : null;
}

export async function passkeyRegistrationOptions(ctx: TwofaCtx, user: Session["user"]) {
  const { rpId } = relyingParty(ctx);
  const existing = await ctx.db.query<{ credential_id: string }>("select credential_id from twofa__webauthn where user_id = ?", [user.id]);
  return {
    challenge: await challenge(ctx, "register", user.id),
    rp: { id: rpId, name: rpId },
    user: { id: base64url(enc.encode(user.id)), name: user.email, displayName: user.display_name },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: { userVerification: "preferred" },
    excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.credential_id })),
  };
}

export async function finishPasskeyRegistration(ctx: TwofaCtx, userId: string, input: { clientDataJSON: unknown; attestationObject: unknown; name?: unknown }): Promise<boolean> {
  if (typeof input.clientDataJSON !== "string" || typeof input.attestationObject !== "string") return false;
  const c = await takeChallenge(ctx, input.clientDataJSON, "register", userId);
  if (c === null) return false;
  const { rpId, origin } = relyingParty(ctx);
  try {
    const cred = await verifyRegistration({ expectedChallenge: c, expectedOrigin: origin, expectedRpId: rpId, response: { clientDataJSON: input.clientDataJSON, attestationObject: input.attestationObject } });
    if ((await ctx.db.queryOne("select 1 as x from twofa__webauthn where credential_id = ?", [cred.credentialId])) !== null) return false;
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 60) : "Passkey";
    await ctx.db.execute("insert into twofa__webauthn (id, user_id, credential_id, public_key, algorithm, counter, name, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)", [`tfk_${randomHex(10)}`, userId, cred.credentialId, cred.publicKey, cred.algorithm, cred.counter, name, Date.now()]);
    return true;
  } catch (e) {
    if (e instanceof WebAuthnError) return false;
    throw e;
  }
}

export async function passkeyVerifyOptions(ctx: TwofaCtx, userId: string) {
  const creds = await ctx.db.query<{ credential_id: string }>("select credential_id from twofa__webauthn where user_id = ?", [userId]);
  if (creds.length === 0) return null;
  return { challenge: await challenge(ctx, "verify", userId), rpId: relyingParty(ctx).rpId, allowCredentials: creds.map((c) => ({ type: "public-key", id: c.credential_id })), userVerification: "preferred" };
}

export async function checkPasskey(ctx: TwofaCtx, userId: string, input: { credentialId: unknown; clientDataJSON: unknown; authenticatorData: unknown; signature: unknown }): Promise<boolean> {
  if (ctx.config.allow_passkeys === false) return false;
  const { credentialId, clientDataJSON, authenticatorData, signature } = input;
  if (typeof credentialId !== "string" || typeof clientDataJSON !== "string" || typeof authenticatorData !== "string" || typeof signature !== "string") return false;
  const c = await takeChallenge(ctx, clientDataJSON, "verify", userId);
  if (c === null) return false;
  const pk = await ctx.db.queryOne<{ id: string; public_key: string; counter: number }>("select id, public_key, counter from twofa__webauthn where credential_id = ? and user_id = ?", [credentialId, userId]);
  if (pk === null) return false;
  const { rpId, origin } = relyingParty(ctx);
  try {
    const r = await verifyAssertion({ expectedChallenge: c, expectedOrigin: origin, expectedRpId: rpId, response: { clientDataJSON, authenticatorData, signature }, credential: { publicKey: pk.public_key, counter: pk.counter } });
    await ctx.db.execute("update twofa__webauthn set counter = ? where id = ?", [r.counter, pk.id]);
    return true;
  } catch (e) {
    if (e instanceof WebAuthnError) return false;
    throw e;
  }
}

/** A TOTP secret for the enrolment page: the unconfirmed one, or a new one; null when one is already on (remove it first). */
export async function startTotp(ctx: TwofaCtx, user: Session["user"]): Promise<{ secret: string; uri: string; svg: string } | null> {
  const row = await ctx.db.queryOne<{ secret_sealed: string; confirmed_at: number | null }>("select secret_sealed, confirmed_at from twofa__totp where user_id = ?", [user.id]);
  if (row !== null && row.confirmed_at !== null) return null;
  let secret = row !== null ? await unseal(ctx, row.secret_sealed) : null;
  if (secret === null) {
    secret = generateTotpSecret();
    await ctx.db.execute("delete from twofa__totp where user_id = ?", [user.id]);
    await ctx.db.execute("insert into twofa__totp (user_id, secret_sealed, created_at) values (?, ?, ?)", [user.id, await seal(ctx, secret), Date.now()]);
  }
  const issuer = ctx.config.issuer || (ctx.url?.hostname ?? "Renox");
  const uri = totpUri({ secret, issuer, account: user.email });
  return { secret, uri, svg: qrSvg(uri) };
}

/** The first code confirms the secret; the session counts as verified. */
export async function confirmTotp(ctx: TwofaCtx, s: Session, code: unknown): Promise<boolean> {
  const row = await ctx.db.queryOne<{ secret_sealed: string }>("select secret_sealed from twofa__totp where user_id = ? and confirmed_at is null", [s.user.id]);
  if (row === null || typeof code !== "string") return false;
  const secret = await unseal(ctx, row.secret_sealed);
  if (secret === null) return false;
  const step = await verifyTotp(secret, code.replace(/\s/gu, ""));
  if (step === null) return false;
  await ctx.db.execute("update twofa__totp set confirmed_at = ?, last_step = ? where user_id = ?", [Date.now(), step, s.user.id]);
  await markVerified(ctx, s.id, s.user.id, "totp");
  return true;
}

export async function markVerified(ctx: TwofaCtx, sessionId: string, userId: string, method: "totp" | "passkey" | "recovery"): Promise<void> {
  await ctx.db.execute("delete from twofa__sessions where session_id = ?", [sessionId]);
  await ctx.db.execute("insert into twofa__sessions (session_id, user_id, verified_at, method) values (?, ?, ?, ?)", [sessionId, userId, Date.now(), method]);
}

export async function verifiedAt(ctx: TwofaCtx, sessionId: unknown): Promise<number | null> {
  if (typeof sessionId !== "string") return null;
  return (await ctx.db.queryOne<{ verified_at: number }>("select verified_at from twofa__sessions where session_id = ?", [sessionId]))?.verified_at ?? null;
}

/** Whether this session verified within `within` minutes (default: step_up_minutes). */
export async function recent(ctx: TwofaCtx, withinMinutes?: number): Promise<boolean> {
  const s = await session();
  if (s === null) return false;
  const at = await verifiedAt(ctx, s.id);
  const window = withinMinutes !== undefined ? withinMinutes * 60_000 : stepUpMs(ctx);
  return at !== null && Date.now() - at <= window;
}

export async function requireRecent(ctx: TwofaCtx, opts: { within?: number; next?: string } = {}): Promise<void> {
  if (await recent(ctx, opts.within)) return;
  throw new StepUpError({ verify_url: `${basePath(ctx)}/verify?next=${encodeURIComponent(opts.next ?? "/")}` });
}

/** auth's principal hook filler: `mfa_verified` while this session's verification is within the step-up window. */
export async function principalFiller(ctx: TwofaCtx, args: { principal: { id: string; attrs: Record<string, unknown> } }): Promise<undefined> {
  const s = await session();
  if (s === null || s.user.id !== args.principal.id) {
    args.principal.attrs.mfa_verified = false;
    return undefined;
  }
  const at = await verifiedAt(ctx, s.id);
  args.principal.attrs.mfa_verified = at !== null && Date.now() - at <= stepUpMs(ctx);
  return undefined;
}

/** After a passed second factor: the sign-in resumes (pending), or the signed-in session steps up. */
export async function passed(ctx: TwofaCtx, p: Pending | null, method: "totp" | "passkey" | "recovery"): Promise<{ cookies: string[]; next: string } | null> {
  if (p !== null) {
    const ticket = await unseal(ctx, p.resume_sealed);
    await ctx.db.execute("delete from twofa__pending where token_hash = ?", [p.token_hash]);
    const r = ticket === null ? null : ((await auth.resumeLogin(ticket)) as { cookie: string; session_id: string; user_id: string } | null);
    if (r === null) return null;
    await markVerified(ctx, r.session_id, r.user_id, method);
    return { cookies: [r.cookie, clearCookie()], next: p.next ?? "/" };
  }
  const s = await session();
  if (s === null) return null;
  await markVerified(ctx, s.id, s.user.id, method);
  return { cookies: [], next: "/" };
}
