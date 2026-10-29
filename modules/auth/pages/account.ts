// GET <mount>/account: the signed-in user's account: change password, the
// sessions with revoke, sign out everywhere. Signed out: a 303 to the
// login page with `next` back here.
import { type AuthCtx, changePassword, clearCookie, currentSession, logout, redirectWith, revokeAll, revokeSession, sessions } from "../lib/core.ts";
import { localized } from "../lib/locale.ts";

type Page = AuthCtx & { url: URL; form: FormData };

/** `<mount>/login?next=<this page>`, from this page's own path (the mount is not in ctx). */
const toLogin = (ctx: Page): Response => {
  const mount = ctx.url.pathname.replace(/\/account\/?$/u, "");
  return redirectWith(`${mount}/login?next=${encodeURIComponent(ctx.url.pathname)}`, []);
};

async function view(ctx: Page, notice: string | null, error: string | null) {
  const s = await currentSession(ctx);
  if (s === null) return toLogin(ctx);
  return { user: s.user, sessions: await sessions(ctx, s.user.id, s.id), notice, error };
}

export const load = localized(async (ctx: Page) => {
  return view(ctx, null, null);
});

export const actions = {
  password: localized(async (ctx: Page) => {
    const r = await changePassword(ctx, String(ctx.form.get("current") ?? ""), String(ctx.form.get("password") ?? ""));
    if (!r.ok) return view(ctx, null, r.error);
    // Rotated: this browser gets the new session, every other one is signed out.
    return redirectWith(ctx.url.pathname, [r.cookie]);
  }),
  revoke: localized(async (ctx: Page) => {
    const s = await currentSession(ctx);
    if (s === null) return toLogin(ctx);
    await revokeSession(ctx, s.user.id, String(ctx.form.get("session") ?? ""));
    return view(ctx, "Session signed out.", null);
  }),
  everywhere: localized(async (ctx: Page) => {
    const s = await currentSession(ctx);
    if (s === null) return toLogin(ctx);
    await revokeAll(ctx, s.user.id);
    return redirectWith("/", [clearCookie()]);
  }),
  logout: localized(async (ctx: Page) => {
    await logout(ctx);
    return redirectWith("/", [clearCookie()]);
  }),
};
