// GET <mount>/account: the signed-in user's account: change password, the
// sessions with revoke, sign out everywhere. Signed out: a 303 to the
// login page with `next` back here.
import { type AuthCtx, changePassword, clearCookie, currentSession, logout, redirectWith, revokeAll, revokeSession, sessions } from "../lib/core.ts";
import { list as agentTokens, revoke as revokeAgent } from "../lib/agents.ts";
import { localized } from "../lib/locale.ts";
import { list as passkeyList, remove as removePasskey } from "../lib/passkeys.ts";
import { confirmPhone, requestVerifyCode } from "../lib/phone.ts";

type Page = AuthCtx & { url: URL; form: FormData };

/** `<mount>/login?next=<this page>`, from this page's own path (the mount is not in ctx). */
const toLogin = (ctx: Page): Response => {
  const mount = ctx.url.pathname.replace(/\/account\/?$/u, "");
  return redirectWith(`${mount}/login?next=${encodeURIComponent(ctx.url.pathname)}`, []);
};

async function view(ctx: Page, notice: string | null, error: string | null, pendingPhone: string | null = null) {
  const s = await currentSession(ctx);
  if (s === null) return toLogin(ctx);
  const phone = await ctx.db.queryOne<{ phone: string | null }>("select phone from auth__users where id = ?", [s.user.id]);
  return {
    user: s.user,
    sessions: await sessions(ctx, s.user.id, s.id),
    agents: await agentTokens(ctx, s.user.id),
    // #291: the phone (verified) and the passkeys, each when the app turns it on.
    phone_on: ctx.config.phone_login === true,
    phone: phone?.phone ?? null,
    pending_phone: pendingPhone,
    passkeys_on: ctx.config.passkeys === true,
    passkeys: ctx.config.passkeys === true ? await passkeyList(ctx, s.user.id) : [],
    notice,
    error,
  };
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
  // #286: disconnect an agent; the cell drops its token on the event.
  agent: localized(async (ctx: Page) => {
    const s = await currentSession(ctx);
    if (s === null) return toLogin(ctx);
    await revokeAgent(ctx, s.user.id, String(ctx.form.get("agent") ?? ""));
    return view(ctx, "Agent disconnected.", null);
  }),
  // #291: add or change the phone: a code to the new number, then the code.
  phone_send: localized(async (ctx: Page) => {
    const s = await currentSession(ctx);
    if (s === null) return toLogin(ctx);
    const r = await requestVerifyCode(ctx, s.user, ctx.form.get("phone"));
    return r.ok ? view(ctx, "A code is on its way.", null, r.phone) : view(ctx, null, r.error);
  }),
  phone_verify: localized(async (ctx: Page) => {
    const s = await currentSession(ctx);
    if (s === null) return toLogin(ctx);
    const phone = String(ctx.form.get("phone") ?? "");
    const r = await confirmPhone(ctx, s.user, phone, ctx.form.get("code"));
    return r.ok ? view(ctx, "Phone number verified.", null) : view(ctx, null, r.error, phone);
  }),
  passkey_remove: localized(async (ctx: Page) => {
    const s = await currentSession(ctx);
    if (s === null) return toLogin(ctx);
    await removePasskey(ctx, s.user.id, String(ctx.form.get("passkey") ?? ""));
    return view(ctx, "Passkey removed.", null);
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
