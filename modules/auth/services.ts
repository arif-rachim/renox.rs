// The auth module's services (docs/contracts/manifest.md [exports.services]).
// Each gets the auth module's ctx (its own tables, in the caller's
// transaction) first, then the caller's arguments.

import * as core from "./lib/core.ts";
import type { AuthCtx, User } from "./lib/core.ts";
import * as tokens from "./lib/tokens.ts";

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

/** Set a new password with a reset token (once); every session is signed out and a new one starts. */
export async function confirmPasswordReset(ctx: AuthCtx, input: { token: string; password: string }): Promise<{ cookie: string } | { error: string }> {
  const r = await tokens.confirmReset(ctx, String(input?.token ?? ""), String(input?.password ?? ""));
  return r.ok ? { cookie: r.cookie } : { error: r.error };
}
