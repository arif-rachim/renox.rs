// The auth module's services (docs/contracts/manifest.md [exports.services]).
// Each gets the auth module's ctx (its own tables, in the caller's
// transaction) first, then the caller's arguments.

import * as core from "./lib/core.ts";
import type { AuthCtx, User } from "./lib/core.ts";
import * as tokens from "./lib/tokens.ts";
import * as agents from "./lib/agents.ts";

/** Register: the account and a confirmation link by mail (auth.send_mail); `message` is the same whether or not the email was taken. */
export async function register(ctx: AuthCtx & { url: URL }, input: { email: string; password: string; display_name?: string }): Promise<{ message: string } | { error: string }> {
  const r = await tokens.signUp(ctx, input);
  return r.ok ? { message: r.message } : { error: r.error };
}

/** Sign in. A wrong password, an unknown email, and a locked bucket all answer the same `error`. */
export async function login(ctx: AuthCtx, input: { email: string; password: string }): Promise<{ user: User; cookie: string } | { error: string }> {
  const r = await core.login(ctx, input);
  return r.ok ? { user: r.user, cookie: r.cookie } : { error: r.error };
}

/** End this request's session; send `cookie` to clear the browser's. */
export async function logout(ctx: AuthCtx): Promise<{ cookie: string }> {
  await core.logout(ctx);
  return { cookie: core.clearCookie() };
}

/**
 * The request's live session: its id (not the cookie token) and the user,
 * or null. Other modules key per-session state by `id` (org's active
 * organisation, #242); it ends when the session is revoked or expires.
 */
export async function currentSession(ctx: AuthCtx): Promise<{ id: string; user: User } | null> {
  return core.currentSession(ctx);
}

export async function currentUser(ctx: AuthCtx): Promise<User | null> {
  return core.currentUser(ctx);
}

/** The user attributes the platform's Cedar schema knows (renox-authz USER_ATTRS); a filler's other keys are dropped. */
const PRINCIPAL_ATTRS = agents.PRINCIPAL_ATTRS;

/**
 * The request's principal (ops.md 1.5.0 section 17, "Principal"): the cell
 * calls it once per request, before any guard. `null` when signed out
 * (the anonymous principal). The hook `auth.principal` lets other modules
 * extend `attrs` in place (2fa sets `mfa_verified`, org sets `org`); only
 * the platform's user attributes are kept. Roles are the platform's role
 * assignments, added by the cell.
 */
export async function principal(ctx: AuthCtx, _sessionId?: string | null): Promise<{ id: string; attrs: Record<string, unknown> } | null> {
  const u = await core.currentUser(ctx);
  if (u === null) return null;
  const row = await ctx.db.queryOne<{ email_verified_at: number | null; phone_verified_at: number | null; created_at: number }>("select email_verified_at, phone_verified_at, created_at from auth__users where id = ?", [u.id]);
  if (row === null) return null;
  const p = { id: u.id, attrs: { email_verified: row.email_verified_at !== null, phone_verified: row.phone_verified_at !== null, created_at: row.created_at } as Record<string, unknown> };
  await ctx.hooks.run("auth.principal", { principal: p });
  const attrs: Record<string, unknown> = {};
  for (const k of PRINCIPAL_ATTRS) if (p.attrs[k] !== undefined) attrs[k] = p.attrs[k];
  return { id: u.id, attrs };
}

/**
 * Set the signed-in user's display name (#773): a phone-only account starts
 * with an empty one, and an app asks for it once. 1 to 80 characters after
 * trimming; throws `AuthRequiredError` when signed out.
 */
export async function setDisplayName(ctx: AuthCtx, name: unknown): Promise<{ display_name: string } | { error: string }> {
  const u = await core.currentUser(ctx);
  if (u === null) throw new core.AuthRequiredError();
  const v = typeof name === "string" ? name.trim() : "";
  if (v.length < 1 || v.length > 80) return { error: "Enter a name of 1 to 80 characters." };
  await ctx.db.execute("update auth__users set display_name = ?, updated_at = ? where id = ?", [v, core.now(), u.id]);
  return { display_name: v };
}

/**
 * Whether the signed-in user has a password (#773): false for an account
 * made by phone sign-up (or OAuth), so an app can tell a phone-only
 * account. False when signed out. (`principal` attrs cannot carry it: the
 * platform's Cedar schema fixes them.)
 */
export async function hasPassword(ctx: AuthCtx): Promise<boolean> {
  const u = await core.currentUser(ctx);
  if (u === null) return false;
  const row = await ctx.db.queryOne<{ password_hash: string }>("select password_hash from auth__users where id = ?", [u.id]);
  return row !== null && row.password_hash.startsWith("$");
}

/** The signed-in user, or throws `AuthRequiredError` (`code: "AUTH_REQUIRED"`, `status: 401`); a page sends `loginUrl(next)` instead. */
export async function requireUser(ctx: AuthCtx): Promise<User> {
  const u = await core.currentUser(ctx);
  if (u === null) throw new core.AuthRequiredError();
  return u;
}

/** Where to send a signed-out visitor: the login page, coming back to `next` if it is a path of the app. */
export async function loginUrl(ctx: AuthCtx, next?: string): Promise<string> {
  return core.loginUrl(ctx, next);
}

/** Mail a magic link through `auth.send_mail` (when the account exists; 5 per email per 15 min). Same answer in every case. */
export async function sendMagicLink(ctx: AuthCtx & { url: URL }, input: { email: string }): Promise<{ message: string }> {
  return { message: await tokens.sendLink(ctx, "magic", String(input?.email ?? "")) };
}

/** Mail a password reset link, same rules as `sendMagicLink`. */
export async function requestPasswordReset(ctx: AuthCtx & { url: URL }, input: { email: string }): Promise<{ message: string }> {
  return { message: await tokens.sendLink(ctx, "reset", String(input?.email ?? "")) };
}

/**
 * The cell's check of an agent token on `/mcp` (#286; ops.md 1.5.0 section
 * 19): `{ principal, scopes, client }` for a live `renox_agt_` token, else
 * null (unknown, expired, revoked). #590: `principal` is `{ id, attrs,
 * roles }` as for a session: `attrs` from the `auth.principal` hook (run
 * with `agent: true` and the token's `org_id`; `org` is the organisation
 * picked at consent while the user is still a member; `mfa_verified`
 * false), `roles` the user's role assignments `{ role, scope_type, scope_id }`.
 */
export async function verifyAgentToken(ctx: AuthCtx, token: string): Promise<agents.VerifiedAgent | null> {
  return agents.verify(ctx, String(token ?? ""));
}

/**
 * RFC 8414 metadata of the app's authorization server for agents (#286):
 * the cell answers `/.well-known/oauth-authorization-server<mount>/oauth`
 * and `<mount>/oauth/.well-known/oauth-authorization-server` with it
 * (ops.md 1.5.0 section 19, "Discovery"). `issuer` is `https://<host><mount>/oauth`.
 */
export async function oauthMetadata(_ctx: AuthCtx, issuer: string): Promise<Record<string, unknown>> {
  return agents.metadata(String(issuer ?? ""));
}

/** The signed-in user's connected agents (live tokens), newest first. */
export async function listAgentTokens(ctx: AuthCtx): Promise<agents.AgentTokenRow[]> {
  const u = await core.currentUser(ctx);
  return u === null ? [] : agents.list(ctx, u.id);
}

/** Disconnect one of the signed-in user's agents; true when a token was revoked. */
export async function revokeAgentToken(ctx: AuthCtx, id: string): Promise<boolean> {
  const u = await core.currentUser(ctx);
  return u === null ? false : agents.revoke(ctx, u.id, String(id ?? ""));
}

/** Set a new password with a reset token (once); every session is signed out and a new one starts. */
export async function confirmPasswordReset(ctx: AuthCtx, input: { token: string; password: string }): Promise<{ cookie: string } | { error: string }> {
  const r = await tokens.confirmReset(ctx, String(input?.token ?? ""), String(input?.password ?? ""));
  return r.ok ? { cookie: r.cookie } : { error: r.error };
}

/**
 * Resume a sign-in that a filler of `auth.after_login` halted (#287): the
 * filler passes the `resume` ticket it was given, once its own check
 * passed. Starts the session and emits `auth.login`; null for a ticket
 * that is unknown, used, or older than 10 minutes.
 */
export async function resumeLogin(ctx: AuthCtx, ticket: unknown): Promise<{ cookie: string; session_id: string; user_id: string; next: string | null } | null> {
  return core.resumeLogin(ctx, ticket);
}

/**
 * What the principal hook's fillers set changed for `userId` (default: the
 * signed-in user): org after a switch, 2fa after a verification. Emits
 * `auth.principal_changed`; the cell drops the cached principal when the
 * event is delivered (#292).
 */
export async function refreshPrincipal(ctx: AuthCtx, userId?: unknown): Promise<boolean> {
  const id = typeof userId === "string" && userId !== "" ? userId : (await core.currentUser(ctx))?.id;
  if (id === undefined) return false;
  await ctx.events.emit("auth.principal_changed", { user_id: id, at: core.now() });
  return true;
}

/** Thrown by `mintAgentToken` for any caller but the platform (code `AUTH_PLATFORM_ONLY`). */
export class PlatformOnlyError extends Error {
  readonly code = "AUTH_PLATFORM_ONLY";
  readonly status = 403;
  constructor() {
    super("Only the platform may mint an agent token.");
    this.name = "PlatformOnlyError";
  }
}

/** Thrown by `mintAgentToken` for a malformed request (code `RENOX_VALIDATION`, `details: [{ field, reason }]`). */
export class MintValidationError extends Error {
  readonly code = "RENOX_VALIDATION";
  readonly status = 400;
  constructor(readonly details: { field: string; reason: string }[]) {
    super("The request is not valid.");
    this.name = "MintValidationError";
  }
}

/** The platform: the cell invoking a service as `Renox::System::"renox"` (no module may be named `renox`, manifest.md MF1). */
function isPlatform(ctx: AuthCtx): boolean {
  const p = (ctx as AuthCtx & { principal?: { kind?: unknown; id?: unknown } | null }).principal;
  return p !== null && p !== undefined && p.kind === "system" && p.id === "renox";
}

/**
 * The owner connector's bridge (#698; docs/20-ai-agents-mcp.md section 1b;
 * deploy-api.md 0.9 section 15): the node runs it in the app's cell for
 * `nodeMintAgentToken`. `{ email, scopes: ["tools:<name>", ...], ttl_seconds
 * (30 to 300), client_name, grant_id }` -> `{ token, expires_at }` (unix ms)
 * for the app user with that verified email, or null when there is none.
 * Platform only: a call from tenant code, a route, a job or another module
 * (any principal but `Renox::System::"renox"`) throws `AUTH_PLATFORM_ONLY`.
 * Never logs the token.
 */
export async function mintAgentToken(ctx: AuthCtx, input: unknown): Promise<agents.Minted> {
  if (!isPlatform(ctx)) throw new PlatformOnlyError();
  const problem = agents.mintProblem(input);
  if (problem !== null) throw new MintValidationError([problem]);
  const i = input as agents.MintInput;
  return agents.mint(ctx, { email: i.email, scopes: [...i.scopes], ttl_seconds: i.ttl_seconds, client_name: i.client_name, grant_id: i.grant_id });
}
