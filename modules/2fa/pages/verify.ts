// GET <mount>/verify: the second factor. With a pending sign-in (the
// cookie set by the auth.after_login filler) a passed check resumes it
// through auth.resumeLogin; for a signed-in user it is a step-up. Five
// failures end a pending sign-in, ten per user in 15 minutes lock.
import * as core from "../lib/core.ts";
import { localized, type Page, redirect, safeNext, toLogin } from "../lib/page.ts";

async function view(ctx: Page, userId: string, error: string | null) {
  const e = await core.enrolled(ctx, userId);
  const options = e.passkeys > 0 ? await core.passkeyVerifyOptions(ctx, userId) : null;
  return { totp: e.totp, passkey_options: options === null ? null : JSON.stringify(options), next: safeNext(ctx.url.searchParams.get("next") ?? ctx.form?.get?.("next")), error };
}

async function who(ctx: Page): Promise<{ userId: string; p: core.Pending | null } | null> {
  const p = await core.pending(ctx);
  if (p !== null) return { userId: p.user_id, p };
  const s = await core.session();
  return s === null ? null : { userId: s.user.id, p: null };
}

export const load = localized(async (ctx) => {
  const w = await who(ctx);
  if (w === null) return toLogin(ctx);
  return view(ctx, w.userId, null);
});

async function attempt(ctx: Page, method: "totp" | "passkey" | "recovery", check: (userId: string) => Promise<boolean>) {
  const w = await who(ctx);
  if (w === null) return toLogin(ctx);
  if (await core.locked(ctx, w.userId, w.p)) {
    // The pending sign-in ends: the page (its load runs after the action) sends to the login page.
    if (w.p !== null) await ctx.db.execute("delete from twofa__pending where token_hash = ?", [w.p.token_hash]);
    return { ...(await view(ctx, w.userId, null)), error: "Too many attempts. Sign in again later." };
  }
  if (!(await check(w.userId))) {
    await core.failed(ctx, w.userId, w.p);
    return view(ctx, w.userId, core.GENERIC_ERROR);
  }
  const done = await core.passed(ctx, w.p, method);
  if (done === null) return toLogin(ctx);
  return redirect(w.p !== null ? safeNext(done.next) : safeNext(ctx.form.get("next")), done.cookies);
}

export const actions = {
  totp: localized((ctx) => attempt(ctx, "totp", (u) => core.checkTotp(ctx, u, ctx.form.get("code")))),
  recovery: localized((ctx) => attempt(ctx, "recovery", (u) => core.checkRecovery(ctx, u, ctx.form.get("code")))),
  passkey: localized((ctx) =>
    attempt(ctx, "passkey", (u) => core.checkPasskey(ctx, u, { credentialId: ctx.form.get("credential_id"), clientDataJSON: ctx.form.get("client_data"), authenticatorData: ctx.form.get("authenticator_data"), signature: ctx.form.get("signature") })),
  ),
};
