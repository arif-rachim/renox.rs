// GET <mount>: the signed-in user's second factors: the authenticator app,
// passkeys, recovery codes. Removing one needs a recent verification
// (step-up).
import * as core from "../lib/core.ts";
import { type Page, signedIn } from "../lib/page.ts";

async function view(ctx: Page, s: core.Session, notice: string | null, error: string | null) {
  const e = await core.enrolled(ctx, s.user.id);
  const passkeys = await ctx.db.query<{ id: string; name: string; created_at: number }>("select id, name, created_at from twofa__webauthn where user_id = ? order by created_at", [s.user.id]);
  const base = core.basePath(ctx);
  return {
    totp: e.totp,
    allow_totp: ctx.config.allow_totp !== false,
    allow_passkeys: ctx.config.allow_passkeys !== false,
    passkeys,
    recovery_left: await core.recoveryLeft(ctx, s.user.id),
    enrolled: e.totp || e.passkeys > 0,
    totp_url: `${base}/enroll/totp`,
    passkey_url: `${base}/enroll/passkey`,
    recovery_url: `${base}/recovery`,
    verify_url: `${base}/verify?next=${encodeURIComponent(base)}`,
    notice,
    error,
  };
}

const stepUp = async (ctx: Page, s: core.Session, fn: () => Promise<string>) => {
  if (!(await core.recent(ctx))) return view(ctx, s, null, "Confirm it is you with your second factor first.");
  return view(ctx, s, await fn(), null);
};

export const load = signedIn((ctx, s) => view(ctx, s, null, null));

export const actions = {
  remove_totp: signedIn((ctx, s) =>
    stepUp(ctx, s, async () => {
      await ctx.db.execute("delete from twofa__totp where user_id = ?", [s.user.id]);
      return "Authenticator app removed.";
    }),
  ),
  remove_passkey: signedIn((ctx, s) =>
    stepUp(ctx, s, async () => {
      await ctx.db.execute("delete from twofa__webauthn where id = ? and user_id = ?", [String(ctx.form.get("passkey") ?? ""), s.user.id]);
      return "Passkey removed.";
    }),
  ),
};
