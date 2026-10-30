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
const PRINCIPAL_ATTRS = ["created_at", "email_verified", "mfa_verified", "org", "phone_verified"] as const;

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
 * null (unknown, expired, revoked).
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
