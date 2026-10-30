// Second factors for control-plane accounts (#293; docs/24-threat-model.md
// E, "Account takeover of a tenant developer"): TOTP and passkeys (the SDK's
// primitives, #284) with single-use recovery codes.
//
// - Sign-in: a user with a factor gets a session in state `verify`; it can
//   only call the MFA endpoints (and log out) until `POST
//   /v1/account/mfa/verify` passes.
// - Requirement: an owner or admin of a team, or a member of a team with
//   `mfa_required`, who has no factor once the grace period
//   (`MFA_GRACE_DAYS`, 14) after their sign-up has passed, gets a session
//   in state `enrol`: only enrolment until a factor is confirmed.
// - Step-up: for a user with a factor, a session acting on secrets, tokens,
//   team roles and members needs a verification in the last 15 minutes
//   (STEP_UP_ACTIONS, checked by the tenant middleware). Tokens are not
//   stepped up: a token is a credential of its own, created by a session
//   that was.
// - The TOTP secret is sealed (AES-256-GCM, a key derived from the master
//   key); recovery codes are stored as SHA-256. Enrolment and removal mail
//   the account (a new-device style notice).

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { operation } from "../audit.ts";
import type { Deps, Env } from "../context.ts";
import { num, numOrNull, type Db } from "../db/db.ts";
import { ApiError, invalid, notFound } from "../errors.ts";
import { JSON_LIMIT, readBody } from "../http.ts";
import { ulid } from "../ids.ts";
import { base64url, fromBase64url, verifyAssertion, verifyRegistration, WebAuthnError } from "../../../../sdk/src/webauthn.ts";
import { generateTotpSecret, totpUri, verifyTotp } from "../../../../sdk/src/totp.ts";
import { bucketsOf, RULES } from "./buckets.ts";
import { withTenant } from "../tenancy/scope.ts";
import { accountAuth, sessionUser, tenantAuth } from "./middleware.ts";
import { sendMfaChanged } from "./notify.ts";
import { verifyPassword } from "./password.ts";
import { sha256hex } from "./tokens.ts";

export const STEP_UP_MS = 15 * 60_000;
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const RECOVERY_CODES = 10;
const DAY_MS = 86_400_000;

/** `MFA_GRACE_DAYS` (default 14): how long an owner or admin may go without a factor after sign-up. */
export const graceMs = (): number => {
  const d = Number(process.env.MFA_GRACE_DAYS ?? 14);
  return (Number.isFinite(d) && d >= 0 ? d : 14) * DAY_MS;
};

/** The operations of this file and what they need (the middleware's table, besides ROUTE_PERMISSIONS). */
export const MFA_ROUTE_PERMISSIONS: Record<string, "account" | "team:write"> = {
  getMfa: "account",
  startTotp: "account",
  confirmTotp: "account",
  passkeyOptions: "account",
  registerPasskey: "account",
  mfaChallenge: "account",
  verifyMfa: "account",
  regenerateRecoveryCodes: "account",
  disableMfa: "account",
  setTeamMfaRequired: "team:write",
};

/** What a session in state `verify` or `enrol` may still do. */
export const PENDING_ACTIONS = new Set(["getMfa", "startTotp", "confirmTotp", "passkeyOptions", "registerPasskey", "mfaChallenge", "verifyMfa", "logout"]);

/** Operations that need a recent second factor from a user who has one. */
export const STEP_UP_ACTIONS = new Set([
  "putSecret",
  "deleteSecret",
  "bumpSecrets",
  "createToken",
  "revokeToken",
  "approveDeviceLogin",
  "changeMemberRole",
  "removeMember",
  "proposeOwnerTransfer",
  "setTeamMfaRequired",
  "regenerateRecoveryCodes",
]);

// ---------------------------------------------------------------- sealing

const keys = new WeakMap<Deps, Buffer>();

function keyOf(deps: Deps): Buffer {
  let k = keys.get(deps);
  if (k === undefined) {
    const master = deps.config.masterKey === null ? null : Buffer.from(deps.config.masterKey, "base64");
    if (master === null || master.length !== 32) throw new ApiError("RENOX_UNAVAILABLE", undefined, { retryAfter: 60 });
    k = Buffer.from(hkdfSync("sha256", master, "renox-mfa", "renox-mfa-totp-v1", 32));
    keys.set(deps, k);
  }
  return k;
}

function sealSecret(deps: Deps, userId: string, secret: string): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(deps), nonce);
  c.setAAD(Buffer.from(`totp:${userId}`));
  const body = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString("base64url");
}

function openSecret(deps: Deps, userId: string, sealed: string): string | null {
  const raw = Buffer.from(sealed, "base64url");
  if (raw.length < 12 + 16 + 1) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", keyOf(deps), raw.subarray(0, 12));
    d.setAAD(Buffer.from(`totp:${userId}`));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return null;
  }
}

// ---------------------------------------------------------------- state

export interface MfaStatus {
  totp: boolean;
  passkeys: number;
  recovery_left: number;
}

export async function status(db: Db, userId: string): Promise<MfaStatus> {
  const t = await db.query("select 1 from account_mfa_totp where user_id = $1 and confirmed_at is not null", [userId]);
  const p = await db.query<{ n: unknown }>("select count(*) as n from account_mfa_webauthn where user_id = $1", [userId]);
  const r = await db.query<{ n: unknown }>("select count(*) as n from account_recovery_codes where user_id = $1 and used_at is null", [userId]);
  return { totp: t.length > 0, passkeys: num(p[0]?.n ?? 0), recovery_left: num(r[0]?.n ?? 0) };
}

export const enrolled = (s: MfaStatus): boolean => s.totp || s.passkeys > 0;

/** Whether the user must have a factor now, and from when (sign-up + grace). */
export async function requirement(db: Db, user: { id: string; created_at: number }, now: number): Promise<{ required: boolean; grace_until: number; by_role: boolean; by_team: boolean }> {
  const rows = await db.query<{ role: string; mfa_required: boolean }>(
    "select m.role, t.mfa_required from memberships m join tenants t on t.id = m.tenant_id where m.user_id = $1",
    [user.id],
  );
  const byRole = rows.some((r) => r.role === "owner" || r.role === "admin");
  const byTeam = rows.some((r) => r.mfa_required === true);
  const graceUntil = user.created_at + graceMs();
  return { required: (byRole || byTeam) && now >= graceUntil, grace_until: graceUntil, by_role: byRole, by_team: byTeam };
}

/** The state a new session starts in (accounts.ts, login). */
export async function sessionState(db: Db, user: { id: string; created_at: number }, now: number): Promise<"verify" | "enrol" | null> {
  if (enrolled(await status(db, user.id))) return "verify";
  return (await requirement(db, user, now)).required ? "enrol" : null;
}

/** Step-up: the user has a factor and the session has not verified within 15 minutes. */
export async function needsStepUp(db: Db, userId: string, sessionId: string, now: number): Promise<boolean> {
  if (!enrolled(await status(db, userId))) return false;
  const rows = await db.query<{ mfa_at: unknown }>("select mfa_at from sessions where id = $1", [sessionId]);
  const at = numOrNull(rows[0]?.mfa_at ?? null);
  return at === null || now - at > STEP_UP_MS;
}

async function passed(db: Db, sessionId: string, now: number): Promise<void> {
  await db.query("update sessions set mfa_state = null, mfa_at = $1 where id = $2", [now, sessionId]);
}

const RECOVERY_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

async function newRecoveryCodes(db: Db, userId: string, now: number): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODES }, () => {
    const b = randomBytes(10);
    const s = [...b].map((x) => RECOVERY_ALPHABET[x % RECOVERY_ALPHABET.length]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  await db.query("delete from account_recovery_codes where user_id = $1", [userId]);
  for (const c of codes) await db.query("insert into account_recovery_codes (user_id, code_sha256, created_at) values ($1, $2, $3)", [userId, sha256hex(`${userId}:${c.replace("-", "")}`), now]);
  return codes;
}

async function useRecoveryCode(db: Db, userId: string, code: unknown, now: number): Promise<boolean> {
  if (typeof code !== "string" || !/^[a-z2-9]{5}-?[a-z2-9]{5}$/u.test(code.trim().toLowerCase())) return false;
  const c = code.trim().toLowerCase().replace("-", "");
  const rows = await db.query("update account_recovery_codes set used_at = $1 where user_id = $2 and code_sha256 = $3 and used_at is null returning user_id", [now, userId, sha256hex(`${userId}:${c}`)]);
  return rows.length === 1;
}

async function checkTotp(deps: Deps, userId: string, code: unknown): Promise<boolean> {
  if (typeof code !== "string") return false;
  const rows = await deps.db.query<{ secret_sealed: string; last_step: unknown }>("select secret_sealed, last_step from account_mfa_totp where user_id = $1 and confirmed_at is not null", [userId]);
  const row = rows[0];
  if (row === undefined) return false;
  const secret = openSecret(deps, userId, row.secret_sealed);
  if (secret === null) return false;
  const step = await verifyTotp(secret, code.replace(/\s/gu, ""), { time: deps.now() / 1000, lastStep: numOrNull(row.last_step) });
  if (step === null) return false;
  const r = await deps.db.query("update account_mfa_totp set last_step = $1 where user_id = $2 and (last_step is null or last_step < $1) returning user_id", [step, userId]);
  return r.length === 1;
}

// ---------------------------------------------------------------- WebAuthn

function relyingParty(deps: Deps): { rpId: string; origin: string } {
  const u = new URL(deps.config.dashboardUrl);
  return { rpId: process.env.MFA_RP_ID ?? u.hostname, origin: process.env.MFA_ORIGIN ?? u.origin };
}

async function newChallenge(db: Db, userId: string, purpose: "register" | "verify", now: number): Promise<string> {
  const c = base64url(randomBytes(32));
  await db.query("delete from account_mfa_challenges where expires_at < $1", [now]);
  await db.query("insert into account_mfa_challenges (challenge, user_id, purpose, expires_at) values ($1, $2, $3, $4)", [c, userId, purpose, now + CHALLENGE_TTL_MS]);
  return c;
}

async function takeChallenge(db: Db, userId: string, clientDataJSON: string, purpose: "register" | "verify", now: number): Promise<string | null> {
  let challenge: unknown;
  try {
    challenge = (JSON.parse(new TextDecoder().decode(fromBase64url(clientDataJSON))) as { challenge?: unknown }).challenge;
  } catch {
    return null;
  }
  if (typeof challenge !== "string") return null;
  const rows = await db.query("update account_mfa_challenges set used_at = $1 where challenge = $2 and user_id = $3 and purpose = $4 and used_at is null and expires_at > $1 returning challenge", [now, challenge, userId, purpose]);
  return rows.length === 1 ? challenge : null;
}

async function checkPasskey(deps: Deps, userId: string, body: Record<string, unknown>): Promise<boolean> {
  const { credential_id: credentialId, client_data: clientDataJSON, authenticator_data: authenticatorData, signature } = body;
  if (typeof credentialId !== "string" || typeof clientDataJSON !== "string" || typeof authenticatorData !== "string" || typeof signature !== "string") return false;
  const now = deps.now();
  const challenge = await takeChallenge(deps.db, userId, clientDataJSON, "verify", now);
  if (challenge === null) return false;
  const rows = await deps.db.query<{ id: string; public_key: string; counter: unknown }>("select id, public_key, counter from account_mfa_webauthn where credential_id = $1 and user_id = $2", [credentialId, userId]);
  const pk = rows[0];
  if (pk === undefined) return false;
  const { rpId, origin } = relyingParty(deps);
  try {
    const r = await verifyAssertion({ expectedChallenge: challenge, expectedOrigin: origin, expectedRpId: rpId, response: { clientDataJSON, authenticatorData, signature }, credential: { publicKey: pk.public_key, counter: num(pk.counter) } });
    await deps.db.query("update account_mfa_webauthn set counter = $1 where id = $2", [r.counter, pk.id]);
    return true;
  } catch (e) {
    if (e instanceof WebAuthnError) return false;
    throw e;
  }
}

// ---------------------------------------------------------------- routes

async function objectBody(c: Context<Env>): Promise<Record<string, unknown>> {
  if (!/^application\/json(;|$)/u.test(c.req.header("content-type") ?? "")) throw invalid("content-type", "must be application/json");
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(c, JSON_LIMIT))) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw invalid("body", "must be a JSON object");
  }
}

async function userRow(db: Db, id: string): Promise<{ id: string; email: string; password_hash: string; created_at: number }> {
  const rows = await db.query<{ id: string; email: string; password_hash: string; created_at: unknown }>("select id, email, password_hash, created_at from users where id = $1", [id]);
  const r = rows[0];
  if (r === undefined) throw notFound();
  return { ...r, created_at: num(r.created_at) };
}

/** Wrong codes cost: the login bucket of the address, so a code cannot be guessed faster than a password. */
function limitVerify(deps: Deps, email: string): void {
  const r = bucketsOf(deps).take(RULES.loginEmail, `mfa-email:${email}`);
  if (!r.ok) throw new ApiError("RENOX_RATE_LIMITED", undefined, { retryAfter: r.retryAfter });
}

async function sessionStateOf(db: Db, sessionId: string): Promise<{ state: string | null; mfa_at: number | null }> {
  const rows = await db.query<{ mfa_state: string | null; mfa_at: unknown }>("select mfa_state, mfa_at from sessions where id = $1", [sessionId]);
  return { state: rows[0]?.mfa_state ?? null, mfa_at: numOrNull(rows[0]?.mfa_at ?? null) };
}

/** Adding a factor next to an existing one is a sensitive change: a recent verification first. */
async function requireFresh(deps: Deps, userId: string, sessionId: string): Promise<void> {
  const s = await sessionStateOf(deps.db, sessionId);
  if (s.state === "verify") throw new ApiError("RENOX_UNAUTHENTICATED", [{ field: "mfa", reason: "required" }]);
  if (await needsStepUp(deps.db, userId, sessionId, deps.now())) throw new ApiError("RENOX_TOKEN_SCOPE", [{ field: "mfa", reason: "step_up_required" }]);
}

export function registerMfa(app: Hono<Env>, deps: Deps): void {
  const { db } = deps;

  app.get("/v1/account/mfa", operation(deps, "getMfa"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    const user = await userRow(db, u.userId);
    const now = deps.now();
    const s = await status(db, u.userId);
    const req = await requirement(db, user, now);
    const session = await sessionStateOf(db, u.sessionId);
    return c.json({ ...s, enrolled: enrolled(s), required: req.required || enrolled(s), grace_until: req.grace_until, session_state: session.state, verified_at: session.mfa_at });
  });

  app.post("/v1/account/mfa/totp", operation(deps, "startTotp"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    if (enrolled(await status(db, u.userId))) await requireFresh(deps, u.userId, u.sessionId);
    const user = await userRow(db, u.userId);
    const rows = await db.query<{ confirmed_at: unknown }>("select confirmed_at from account_mfa_totp where user_id = $1", [u.userId]);
    if (rows[0] !== undefined && rows[0].confirmed_at !== null) throw new ApiError("RENOX_CONFLICT", [{ field: "totp", reason: "already set up; disable it first" }]);
    const secret = generateTotpSecret();
    await db.query("delete from account_mfa_totp where user_id = $1", [u.userId]);
    await db.query("insert into account_mfa_totp (user_id, secret_sealed, created_at) values ($1, $2, $3)", [u.userId, sealSecret(deps, u.userId, secret), deps.now()]);
    c.set("auditTarget", { user_id: u.userId });
    return c.json({ secret, otpauth_uri: totpUri({ secret, issuer: "Renox", account: user.email }) }, 201);
  });

  app.post("/v1/account/mfa/totp/confirm", operation(deps, "confirmTotp"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    const user = await userRow(db, u.userId);
    limitVerify(deps, user.email);
    const body = await objectBody(c);
    const rows = await db.query<{ secret_sealed: string }>("select secret_sealed from account_mfa_totp where user_id = $1 and confirmed_at is null", [u.userId]);
    const secret = rows[0] === undefined ? null : openSecret(deps, u.userId, rows[0].secret_sealed);
    const now = deps.now();
    const step = secret === null || typeof body.code !== "string" ? null : await verifyTotp(secret, body.code.replace(/\s/gu, ""), { time: now / 1000 });
    if (step === null) throw invalid("code", "does not match");
    await db.query("update account_mfa_totp set confirmed_at = $1, last_step = $2 where user_id = $3", [now, step, u.userId]);
    const codes = (await status(db, u.userId)).recovery_left === 0 ? await newRecoveryCodes(db, u.userId, now) : null;
    await passed(db, u.sessionId, now);
    c.set("auditTarget", { user_id: u.userId });
    await sendMfaChanged(deps, user.email, "totp_enabled");
    return c.json({ totp: true, recovery_codes: codes });
  });

  app.post("/v1/account/mfa/passkeys/options", operation(deps, "passkeyOptions"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    if (enrolled(await status(db, u.userId))) await requireFresh(deps, u.userId, u.sessionId);
    const user = await userRow(db, u.userId);
    const { rpId } = relyingParty(deps);
    const existing = await db.query<{ credential_id: string }>("select credential_id from account_mfa_webauthn where user_id = $1", [u.userId]);
    return c.json({
      challenge: await newChallenge(db, u.userId, "register", deps.now()),
      rp: { id: rpId, name: "Renox" },
      user: { id: base64url(new TextEncoder().encode(user.id)), name: user.email, displayName: user.email },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      excludeCredentials: existing.map((e) => ({ type: "public-key", id: e.credential_id })),
      authenticatorSelection: { userVerification: "preferred" },
    });
  });

  app.post("/v1/account/mfa/passkeys", operation(deps, "registerPasskey"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    const user = await userRow(db, u.userId);
    const body = await objectBody(c);
    if (typeof body.client_data !== "string" || typeof body.attestation_object !== "string") throw invalid("body", "client_data and attestation_object are required");
    const now = deps.now();
    const challenge = await takeChallenge(db, u.userId, body.client_data, "register", now);
    if (challenge === null) throw invalid("client_data", "unknown or used challenge");
    const { rpId, origin } = relyingParty(deps);
    let cred;
    try {
      cred = await verifyRegistration({ expectedChallenge: challenge, expectedOrigin: origin, expectedRpId: rpId, response: { clientDataJSON: body.client_data, attestationObject: body.attestation_object } });
    } catch (e) {
      if (e instanceof WebAuthnError) throw invalid("attestation_object", e.message);
      throw e;
    }
    const name = typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim().slice(0, 60) : "Passkey";
    await db.query("insert into account_mfa_webauthn (id, user_id, credential_id, public_key, algorithm, counter, name, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (credential_id) do nothing", [`pk_${ulid(now)}`, u.userId, cred.credentialId, cred.publicKey, cred.algorithm, cred.counter, name, now]);
    const codes = (await status(db, u.userId)).recovery_left === 0 ? await newRecoveryCodes(db, u.userId, now) : null;
    await passed(db, u.sessionId, now);
    c.set("auditTarget", { user_id: u.userId });
    await sendMfaChanged(deps, user.email, "passkey_added");
    return c.json({ passkeys: (await status(db, u.userId)).passkeys, recovery_codes: codes }, 201);
  });

  app.post("/v1/account/mfa/challenge", operation(deps, "mfaChallenge"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    const creds = await db.query<{ credential_id: string }>("select credential_id from account_mfa_webauthn where user_id = $1", [u.userId]);
    if (creds.length === 0) throw notFound();
    return c.json({ challenge: await newChallenge(db, u.userId, "verify", deps.now()), rpId: relyingParty(deps).rpId, allowCredentials: creds.map((x) => ({ type: "public-key", id: x.credential_id })), userVerification: "preferred" });
  });

  app.post("/v1/account/mfa/verify", operation(deps, "verifyMfa"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    const user = await userRow(db, u.userId);
    limitVerify(deps, user.email);
    const body = await objectBody(c);
    const now = deps.now();
    const method = body.method;
    const ok =
      method === "totp" ? await checkTotp(deps, u.userId, body.code) : method === "recovery" ? await useRecoveryCode(db, u.userId, body.code, now) : method === "passkey" ? await checkPasskey(deps, u.userId, body) : false;
    c.set("auditTarget", { user_id: u.userId, method: String(method) });
    if (!ok) throw new ApiError("RENOX_UNAUTHENTICATED", [{ field: "mfa", reason: "invalid" }]);
    await passed(db, u.sessionId, now);
    return c.json({ verified_at: now });
  });

  app.post("/v1/account/mfa/recovery-codes", operation(deps, "regenerateRecoveryCodes"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    if (!enrolled(await status(db, u.userId))) throw new ApiError("RENOX_CONFLICT", [{ field: "mfa", reason: "no second factor" }]);
    await requireFresh(deps, u.userId, u.sessionId);
    c.set("auditTarget", { user_id: u.userId });
    return c.json({ recovery_codes: await newRecoveryCodes(db, u.userId, deps.now()) });
  });

  app.post("/v1/account/mfa/disable", operation(deps, "disableMfa"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    const user = await userRow(db, u.userId);
    limitVerify(deps, user.email);
    const body = await objectBody(c);
    const now = deps.now();
    const passwordOk = await verifyPassword(typeof body.password === "string" ? body.password : "", user.password_hash);
    const codeOk = passwordOk && ((await checkTotp(deps, u.userId, body.code)) || (await useRecoveryCode(db, u.userId, body.code, now)));
    c.set("auditTarget", { user_id: u.userId });
    if (!passwordOk || !codeOk) throw new ApiError("RENOX_UNAUTHENTICATED", [{ field: "mfa", reason: "password and a current code are required" }]);
    await db.query("delete from account_mfa_totp where user_id = $1", [u.userId]);
    await db.query("delete from account_mfa_webauthn where user_id = $1", [u.userId]);
    await db.query("delete from account_recovery_codes where user_id = $1", [u.userId]);
    // An owner or admin past the grace period is back to enrolment.
    const state = (await requirement(db, user, now)).required ? "enrol" : null;
    await db.query("update sessions set mfa_state = $1, mfa_at = null where id = $2", [state, u.sessionId]);
    await sendMfaChanged(deps, user.email, "mfa_disabled");
    return c.json({ enrolled: false, session_state: state });
  });

  app.post("/v1/team/mfa-required", operation(deps, "setTeamMfaRequired"), tenantAuth(deps, "team:write"), async (c) => {
    const p = c.get("principal");
    if (p === undefined || p.kind !== "tenant") throw new ApiError("RENOX_UNAUTHENTICATED");
    const body = await objectBody(c);
    if (typeof body.required !== "boolean") throw invalid("required", "must be a boolean");
    await withTenant(db, p).query("update tenants set mfa_required = $2 where id = $1", [p.tenantId, body.required]);
    c.set("auditTarget", { tenant_id: p.tenantId, required: String(body.required) });
    return c.json({ tenant_id: p.tenantId, mfa_required: body.required });
  });
}
