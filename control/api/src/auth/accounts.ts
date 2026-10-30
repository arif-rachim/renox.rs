// Accounts (#113; docs/24-threat-model.md E, "Account takeover"): sign-up
// with email and password, email verification, login with buckets per
// address and per email, password reset with single-use tokens, sessions
// (list, sign out, sign out everywhere), switching the session's tenant,
// accepting an invitation, and the device flow behind `renox login`.
//
// Unknown email and wrong password get the same answer and take the same
// time; sign-up and reset answer 202 whether or not the address has an
// account, so neither enumerates users.

import type { Context, Hono, MiddlewareHandler } from "hono";
import { operation } from "../audit.ts";
import { check } from "../contract.ts";
import type { Deps, Env, Principal } from "../context.ts";
import { num, numOrNull, type Db } from "../db/db.ts";
import { ApiError, conflict, invalid, notFound } from "../errors.ts";
import { JSON_LIMIT, readBody } from "../http.ts";
import { ulid } from "../ids.ts";
import { ACTIONS, createTenantToken, DAY_MS, sha256hex } from "./tokens.ts";
import { isRole, roleAllows, type Role } from "../tenancy/roles.ts";
import { refusal } from "../tokens/routes.ts";
import { crossTenant } from "../tenancy/scope.ts";
import { accountAuth, sessionUser, tenantAuth } from "./middleware.ts";
import { Buckets, RULES, type BucketRule } from "./buckets.ts";
import { clientIp } from "./ip.ts";
import { checkPassword, hashPassword, verifyPassword } from "./password.ts";
import {
  cookie,
  createSession,
  csrfOf,
  DEVICE_COOKIE,
  newDeviceValue,
  newOneTimeValue,
  readCookie,
  revokeSessions,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
} from "./sessions.ts";
import { sendNewDevice, sendPasswordChanged, sendPasswordReset, sendSignupExists, sendVerification } from "./notify.ts";
import { sessionState } from "./mfa.ts";

export const VERIFY_TTL_MS = DAY_MS;
export const RESET_TTL_MS = 3_600_000;
export const DEVICE_TTL_MS = 15 * 60_000;
export const DEVICE_INTERVAL_S = 5;
const DEVICE_TOKEN_DAYS = 90;
const DEVICE_COOKIE_MAX_AGE_S = 400 * 86_400;
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** device_codes is not tenant data until approved; the approval writes the session's tenant into it. */
const deviceCodes = (db: Db): Db => crossTenant(db, "a pending device code belongs to no tenant until a user approves it");

// ---------------------------------------------------------------- input

/** A JSON object body of at most 1 MiB (deploy-api.md section 1). */
async function objectBody(c: Context<Env>): Promise<Record<string, unknown>> {
  if (!/^application\/json(;|$)/u.test(c.req.header("content-type") ?? "")) throw invalid("content-type", "must be application/json");
  const bytes = await readBody(c, JSON_LIMIT);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid("body", "not valid UTF-8 JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid("body", "must be a JSON object");
  return value as Record<string, unknown>;
}

export function emailField(v: unknown): string {
  if (typeof v !== "string") throw invalid("email", "must be a string");
  const email = v.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw invalid("email", "not an email address");
  return email;
}

/** A single-use value from a link or the CLI: malformed is "not found", like unknown. */
const oneTimeField = (v: unknown): string => {
  if (typeof v !== "string" || !/^[a-z2-7]{32}$/u.test(v)) throw notFound();
  return v;
};

function optionalString(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length < 1 || v.length > max) throw invalid(field, `1 to ${max} characters`);
  return v;
}

// ---------------------------------------------------------------- buckets

const buckets = new WeakMap<Deps, Buckets>();
function bucketsOf(deps: Deps): Buckets {
  let b = buckets.get(deps);
  if (b === undefined) buckets.set(deps, (b = new Buckets(deps.now)));
  return b;
}

/** Takes one request from each `[rule, key]`; 429 with Retry-After when any is empty. */
function limit(deps: Deps, takes: [BucketRule, string][]): void {
  for (const [rule, key] of takes) {
    const r = bucketsOf(deps).take(rule, key);
    if (!r.ok) throw new ApiError("RENOX_RATE_LIMITED", undefined, { retryAfter: r.retryAfter });
  }
}

/** Unauthenticated routes: the per-address bucket (deploy-api.md section 2, proposed 5/s). */
function publicRoute(deps: Deps): MiddlewareHandler<Env> {
  return async (c, next) => {
    limit(deps, [[RULES.publicIp, `ip:${clientIp(c) ?? "unknown"}`]]);
    await next();
  };
}

// ---------------------------------------------------------------- helpers

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  email_verified_at: number | null;
  created_at: number;
}

async function userByEmail(db: Db, email: string): Promise<UserRow | null> {
  const rows = await db.query<Record<string, unknown>>("select id, email, password_hash, email_verified_at, created_at from users where email = $1", [email]);
  const r = rows[0];
  return r === undefined ? null : { id: r.id as string, email: r.email as string, password_hash: r.password_hash as string, email_verified_at: numOrNull(r.email_verified_at), created_at: num(r.created_at) };
}

async function userById(db: Db, id: string): Promise<UserRow> {
  const rows = await db.query<Record<string, unknown>>("select id, email, password_hash, email_verified_at, created_at from users where id = $1", [id]);
  const r = rows[0];
  if (r === undefined) throw new ApiError("RENOX_UNAUTHENTICATED");
  return { id: r.id as string, email: r.email as string, password_hash: r.password_hash as string, email_verified_at: numOrNull(r.email_verified_at), created_at: num(r.created_at) };
}

async function memberships(db: Db, userId: string): Promise<{ tenant_id: string; role: Role }[]> {
  const rows = await db.query<{ tenant_id: string; role: string }>("select tenant_id, role from memberships where user_id = $1 order by created_at, tenant_id", [userId]);
  return rows.flatMap((r) => (isRole(r.role) ? [{ tenant_id: r.tenant_id, role: r.role }] : []));
}

/** Issues a single-use email token for `userId`; earlier unused ones of the same purpose stop working. */
async function emailToken(db: Db, userId: string, purpose: "verify" | "reset", now: number): Promise<string> {
  const value = newOneTimeValue();
  await db.query("update email_tokens set used_at = $1 where user_id = $2 and purpose = $3 and used_at is null", [now, userId, purpose]);
  await db.query(
    "insert into email_tokens (id, user_id, purpose, token_sha256, created_at, expires_at) values ($1, $2, $3, $4, $5, $6)",
    [`emt_${ulid(now)}`, userId, purpose, sha256hex(value), now, now + (purpose === "verify" ? VERIFY_TTL_MS : RESET_TTL_MS)],
  );
  return value;
}

/** Consumes a single-use email token: the user id, or 404 when unknown, used, or expired. */
async function useEmailToken(db: Db, value: string, purpose: "verify" | "reset", now: number): Promise<string> {
  const rows = await db.query<{ user_id: string }>(
    "update email_tokens set used_at = $1 where token_sha256 = $2 and purpose = $3 and used_at is null and expires_at > $1 returning user_id",
    [now, sha256hex(value), purpose],
  );
  if (rows[0] === undefined) throw notFound();
  return rows[0].user_id;
}

function setSessionCookie(c: Context<Env>, value: string): void {
  c.header("set-cookie", cookie(SESSION_COOKIE, value, SESSION_ABSOLUTE_MS / 1000), { append: true });
}

function clearSessionCookie(c: Context<Env>): void {
  c.header("set-cookie", cookie(SESSION_COOKIE, "", 0), { append: true });
}

/** Records the browser and sends the new-device email when the user has signed in elsewhere before. */
async function noteDevice(deps: Deps, c: Context<Env>, user: UserRow, now: number): Promise<void> {
  let device = readCookie(c.req.header("cookie"), DEVICE_COOKIE);
  if (device === null || !/^[a-z2-7]{32}$/u.test(device)) {
    device = newDeviceValue();
    c.header("set-cookie", cookie(DEVICE_COOKIE, device, DEVICE_COOKIE_MAX_AGE_S), { append: true });
  }
  const inserted = await deps.db.query(
    "insert into known_devices (user_id, device_sha256, first_seen_at) values ($1, $2, $3) on conflict do nothing returning user_id",
    [user.id, sha256hex(device), now],
  );
  if (inserted.length === 0) return;
  const known = await deps.db.query("select 1 from known_devices where user_id = $1 limit 2", [user.id]);
  if (known.length > 1) await sendNewDevice(deps, user.email, clientIp(c), c.req.header("user-agent") ?? null);
}

/** The cookie value of the current request (accountAuth has validated it). */
const sessionValue = (c: Context<Env>): string => readCookie(c.req.header("cookie"), SESSION_COOKIE) as string;

/** A user code: 8 letters without vowels (no words), shown as XXXX-XXXX. */
function newUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const s = [...bytes].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// ---------------------------------------------------------------- routes

export function registerAccounts(app: Hono<Env>, deps: Deps): void {
  const { db } = deps;

  app.post("/v1/account/signup", operation(deps, "signup"), publicRoute(deps), async (c) => {
    const body = await objectBody(c);
    const email = emailField(body.email);
    const password = checkPassword(body.password);
    const tenantId = body.tenant_id === undefined ? undefined : (() => {
      try {
        return check<string>("TenantId", body.tenant_id);
      } catch {
        throw invalid("tenant_id", "must match ^[a-z0-9][a-z0-9_-]{0,62}$");
      }
    })();
    const tenantName = optionalString(body.tenant_name, "tenant_name", 128) ?? tenantId;
    // deploy-api.md 0.5 section 21 (#326): the DPA, when the client sends it, is accepted.
    if (body.dpa_accepted !== undefined && body.dpa_accepted !== true) throw invalid("dpa_accepted", "must be true");
    if (body.captcha_token !== undefined && (typeof body.captcha_token !== "string" || body.captcha_token.length === 0 || body.captcha_token.length > 4096)) throw invalid("captcha_token", "a non-empty string");
    limit(deps, [
      [RULES.mailIp, `mail-ip:${clientIp(c) ?? "unknown"}`],
      [RULES.mailEmail, `mail-email:${email}`],
    ]);
    const hash = await hashPassword(password);
    const now = deps.now();
    const outcome = await db.transaction(async (tx) => {
      if (tenantId !== undefined) {
        const taken = await tx.query("select 1 from tenants where id = $1", [tenantId]);
        if (taken.length > 0) throw conflict("tenant_id", "not available");
      }
      const userId = `usr_${ulid(now)}`;
      const inserted = await tx.query(
        "insert into users (id, email, password_hash, created_at) values ($1, $2, $3, $4) on conflict (email) do nothing returning id",
        [userId, email, hash, now],
      );
      if (inserted.length === 0) return { exists: true as const };
      if (tenantId !== undefined) {
        await tx.query("insert into tenants (id, name, tier, created_at) values ($1, $2, 'free', $3)", [tenantId, tenantName, now]);
        await tx.query("insert into memberships (tenant_id, user_id, role, created_at) values ($1, $2, 'owner', $3)", [tenantId, userId, now]);
      }
      return { exists: false as const, userId, verify: await emailToken(tx, userId, "verify", now) };
    });
    if (outcome.exists) await sendSignupExists(deps, email);
    else {
      c.set("auditTarget", { user_id: outcome.userId, ...(tenantId === undefined ? {} : { tenant_id: tenantId }) });
      await sendVerification(deps, email, outcome.verify);
    }
    return c.json({ status: "check_email" }, 202);
  });

  app.post("/v1/account/verify", operation(deps, "verifyEmail"), publicRoute(deps), async (c) => {
    const body = await objectBody(c);
    const now = deps.now();
    const userId = await db.transaction(async (tx) => {
      const id = await useEmailToken(tx, oneTimeField(body.token), "verify", now);
      await tx.query("update users set email_verified_at = coalesce(email_verified_at, $1) where id = $2", [now, id]);
      return id;
    });
    c.set("auditTarget", { user_id: userId });
    return c.json({ user_id: userId, email_verified: true });
  });

  app.post("/v1/account/verify/resend", operation(deps, "resendVerification"), accountAuth(deps), async (c) => {
    const user = await userById(db, sessionUser(c).userId);
    if (user.email_verified_at === null) {
      limit(deps, [[RULES.mailEmail, `mail-email:${user.email}`]]);
      await sendVerification(deps, user.email, await emailToken(db, user.id, "verify", deps.now()));
    }
    return c.json({ status: "check_email" }, 202);
  });

  app.post("/v1/account/login", operation(deps, "login"), publicRoute(deps), async (c) => {
    const body = await objectBody(c);
    const email = emailField(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    limit(deps, [
      [RULES.loginIp, `login-ip:${clientIp(c) ?? "unknown"}`],
      [RULES.loginEmail, `login-email:${email}`],
    ]);
    const user = await userByEmail(db, email);
    const ok = await verifyPassword(password, user?.password_hash ?? null);
    if (user === null || !ok) throw new ApiError("RENOX_UNAUTHENTICATED");
    const all = await memberships(db, user.id);
    let tenant = all[0] ?? null;
    if (body.tenant_id !== undefined) {
      tenant = all.find((m) => m.tenant_id === body.tenant_id) ?? null;
      if (tenant === null) throw notFound();
    }
    const now = deps.now();
    // #293: a user with a second factor, or an owner or admin past the grace period without one, starts in an MFA state.
    const mfaState = await sessionState(db, user, now);
    const session = await createSession(db, user.id, tenant?.tenant_id ?? null, now, clientIp(c), c.req.header("user-agent") ?? null, mfaState);
    c.set("principal", { kind: "user", userId: user.id, sessionId: session.id, tenantId: tenant?.tenant_id ?? null });
    c.set("auditTarget", { user_id: user.id, session_id: session.id });
    setSessionCookie(c, session.value);
    await noteDevice(deps, c, user, now);
    return c.json({
      user_id: user.id,
      email: user.email,
      email_verified: user.email_verified_at !== null,
      tenant_id: tenant?.tenant_id ?? null,
      role: tenant?.role ?? null,
      session_id: session.id,
      expires_at: now + SESSION_ABSOLUTE_MS,
      csrf: csrfOf(session.value),
      // #293: `verify`: POST /v1/account/mfa/verify next; `enrol`: set up a second factor first.
      mfa: mfaState,
    });
  });

  app.post("/v1/account/logout", operation(deps, "logout"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    await revokeSessions(db, u.userId, deps.now(), u.sessionId);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.post("/v1/account/password-reset", operation(deps, "requestPasswordReset"), publicRoute(deps), async (c) => {
    const body = await objectBody(c);
    const email = emailField(body.email);
    limit(deps, [
      [RULES.mailIp, `mail-ip:${clientIp(c) ?? "unknown"}`],
      [RULES.mailEmail, `mail-email:${email}`],
    ]);
    const user = await userByEmail(db, email);
    if (user !== null) await sendPasswordReset(deps, user.email, await emailToken(db, user.id, "reset", deps.now()));
    return c.json({ status: "check_email" }, 202);
  });

  app.post("/v1/account/password-reset/confirm", operation(deps, "confirmPasswordReset"), publicRoute(deps), async (c) => {
    const body = await objectBody(c);
    const token = oneTimeField(body.token);
    const hash = await hashPassword(checkPassword(body.password));
    const now = deps.now();
    const userId = await db.transaction(async (tx) => {
      const id = await useEmailToken(tx, token, "reset", now);
      // The link reached the address, so the address is verified too.
      await tx.query("update users set password_hash = $1, email_verified_at = coalesce(email_verified_at, $2) where id = $3", [hash, now, id]);
      await revokeSessions(tx, id, now);
      return id;
    });
    c.set("auditTarget", { user_id: userId });
    await sendPasswordChanged(deps, (await userById(db, userId)).email);
    return c.body(null, 204);
  });

  app.get("/v1/account", operation(deps, "getAccount"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    const user = await userById(db, u.userId);
    const all = await memberships(db, u.userId);
    return c.json({
      user_id: user.id,
      email: user.email,
      email_verified: user.email_verified_at !== null,
      tenant_id: u.tenantId,
      role: all.find((m) => m.tenant_id === u.tenantId)?.role ?? null,
      memberships: all,
      csrf: csrfOf(sessionValue(c)),
    });
  });

  app.post("/v1/account/tenant", operation(deps, "switchTenant"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    const body = await objectBody(c);
    const m = (await memberships(db, u.userId)).find((x) => x.tenant_id === body.tenant_id);
    if (m === undefined) throw notFound();
    await db.query("update sessions set tenant_id = $1 where id = $2 and user_id = $3", [m.tenant_id, u.sessionId, u.userId]);
    c.set("auditTarget", { tenant_id: m.tenant_id });
    return c.json({ tenant_id: m.tenant_id, role: m.role });
  });

  app.get("/v1/account/sessions", operation(deps, "listSessions"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    const now = deps.now();
    const rows = await db.query<Record<string, unknown>>(
      `select id, tenant_id, created_at, last_seen_at, expires_at, ip, user_agent from sessions
       where user_id = $1 and revoked_at is null and expires_at > $2 and last_seen_at > $3 order by created_at desc`,
      [u.userId, now, now - 86_400_000],
    );
    return c.json({
      sessions: rows.map((r) => ({
        id: r.id,
        tenant_id: r.tenant_id ?? null,
        created_at: num(r.created_at),
        last_seen_at: num(r.last_seen_at),
        expires_at: num(r.expires_at),
        ip: r.ip ?? null,
        user_agent: r.user_agent ?? null,
        current: r.id === u.sessionId,
      })),
    });
  });

  app.delete("/v1/account/sessions/:session_id", operation(deps, "revokeSession"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    const id = c.req.param("session_id");
    if ((await revokeSessions(db, u.userId, deps.now(), id)) === 0) throw notFound();
    if (id === u.sessionId) clearSessionCookie(c);
    return c.body(null, 204);
  });

  // "Sign out everywhere": every session of the user, this one included.
  app.post("/v1/account/sessions/revoke-all", operation(deps, "revokeAllSessions"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    const revoked = await revokeSessions(db, u.userId, deps.now());
    clearSessionCookie(c);
    return c.json({ revoked });
  });

  app.post("/v1/account/invitations/accept", operation(deps, "acceptInvitation"), accountAuth(deps), async (c) => {
    const u = sessionUser(c);
    const body = await objectBody(c);
    const token = oneTimeField(body.token);
    const user = await userById(db, u.userId);
    const now = deps.now();
    const accepted = await db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string; tenant_id: string; email: string; role: string }>(
        "select id, tenant_id, email, role from invitations where token_sha256 = $1 and accepted_at is null and revoked_at is null and expires_at > $2 for update",
        [sha256hex(token), now],
      );
      const inv = rows[0];
      // Another address's invitation is "not found", like an unknown one.
      if (inv === undefined || inv.email !== user.email) throw notFound();
      if (user.email_verified_at === null) throw new ApiError("RENOX_TOKEN_SCOPE", [{ field: "email", reason: "verify the email address first" }]);
      const added = await tx.query(
        "insert into memberships (tenant_id, user_id, role, created_at) values ($1, $2, $3, $4) on conflict do nothing returning tenant_id",
        [inv.tenant_id, user.id, inv.role, now],
      );
      if (added.length === 0) throw conflict("tenant_id", "already a member");
      await tx.query("update invitations set accepted_at = $1 where id = $2", [now, inv.id]);
      return { tenant_id: inv.tenant_id, role: inv.role, invitation_id: inv.id };
    });
    c.set("auditTarget", { tenant_id: accepted.tenant_id, invitation_id: accepted.invitation_id, role: accepted.role });
    return c.json({ tenant_id: accepted.tenant_id, role: accepted.role });
  });

  // `renox login`: the device authorization flow (RFC 8628 in shape).
  app.post("/v1/account/device", operation(deps, "startDeviceLogin"), publicRoute(deps), async (c) => {
    const body = c.req.header("content-type") === undefined ? {} : await objectBody(c);
    const name = optionalString(body.name, "name", 64) ?? "renox login";
    const now = deps.now();
    const device = newOneTimeValue();
    const userCode = newUserCode();
    await db.query(
      "insert into device_codes (id, device_sha256, user_code, created_at, expires_at, name) values ($1, $2, $3, $4, $5, $6)",
      [`dev_${ulid(now)}`, sha256hex(device), userCode, now, now + DEVICE_TTL_MS, name],
    );
    return c.json(
      {
        device_code: device,
        user_code: userCode,
        verification_uri: `${deps.config.dashboardUrl.replace(/\/+$/u, "")}/device`,
        expires_in: DEVICE_TTL_MS / 1000,
        interval: DEVICE_INTERVAL_S,
      },
      201,
    );
  });

  app.post("/v1/account/device/approve", operation(deps, "approveDeviceLogin"), tenantAuth(deps, "tokens:write"), async (c) => {
    const p = c.get("principal") as Principal & { kind: "tenant" };
    // Only a person in a browser approves a device; a token cannot.
    if (p.via !== "session") throw new ApiError("RENOX_TOKEN_SCOPE");
    const body = await objectBody(c);
    if (typeof body.user_code !== "string") throw notFound();
    const role = p.role;
    const scopes = body.scopes === undefined ? ACTIONS.filter((a) => roleAllows(role, a)) : body.scopes;
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 50) throw invalid("scopes", "1 to 50 scopes");
    for (const s of scopes) {
      try {
        check<string>("Scope", s);
      } catch {
        throw invalid("scopes", `${String(s)} is not a scope`);
      }
      const why = refusal(p, s as string);
      if (why !== null) throw invalid("scopes", why);
    }
    const rows = await deviceCodes(db).query<{ id: string }>(
      `update device_codes set tenant_id = $1, user_id = $2, scopes = $3::text::jsonb, approved_at = $4
       where user_code = $5 and approved_at is null and used_at is null and expires_at > $4 returning id`,
      [p.tenantId, p.userId, JSON.stringify(scopes), deps.now(), body.user_code.trim().toUpperCase()],
    );
    if (rows[0] === undefined) throw notFound();
    c.set("auditTarget", { device_id: rows[0].id });
    return c.json({ approved: true });
  });

  app.post("/v1/account/device/token", operation(deps, "pollDeviceLogin"), publicRoute(deps), async (c) => {
    const body = await objectBody(c);
    const device = oneTimeField(body.device_code);
    const now = deps.now();
    const result = await db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string; tenant_id: string | null; user_id: string | null; scopes: string[] | null; name: string; approved_at: unknown }>(
        "select id, tenant_id, user_id, scopes, name, approved_at from device_codes where device_sha256 = $1 and used_at is null and expires_at > $2 for update",
        [sha256hex(device), now],
      );
      const d = rows[0];
      if (d === undefined) throw notFound();
      if (d.approved_at === null || d.tenant_id === null || d.user_id === null || d.scopes === null) return null;
      await tx.query("update device_codes set used_at = $1 where id = $2", [now, d.id]);
      const token = await createTenantToken(tx, d.tenant_id, d.name, d.scopes, DEVICE_TOKEN_DAYS, now, d.user_id);
      return { tenant_id: d.tenant_id, user_id: d.user_id, token };
    });
    if (result === null) return c.json({ status: "authorization_pending", interval: DEVICE_INTERVAL_S }, 202);
    c.set("auditTarget", { token_id: result.token.id, tenant_id: result.tenant_id, user_id: result.user_id });
    return c.json({ tenant_id: result.tenant_id, ...result.token }, 201);
  });
}
