// The auth module's services (docs/contracts/manifest.md [exports.services]).
// Each gets the auth module's ctx (its own tables, in the caller's
// transaction) first, then the caller's arguments.

import * as core from "./lib/core.ts";
import type { AuthCtx, User } from "./lib/core.ts";

/** Create a user and a first session. The caller sends `cookie` as `Set-Cookie`. */
export async function register(ctx: AuthCtx, input: { email: string; password: string; display_name?: string }): Promise<{ user: User; cookie: string } | { error: string }> {
  const r = await core.register(ctx, input);
  return r.ok ? { user: r.user, cookie: r.cookie } : { error: r.error };
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
