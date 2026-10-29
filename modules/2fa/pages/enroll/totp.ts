// GET <mount>/enroll/totp: a new secret as a QR code (inline SVG) and as
// text; POST ?/confirm with the app's first code turns it on, counts the
// session as verified, and shows the recovery codes once.
import * as core from "../../lib/core.ts";
import { type Page, signedIn } from "../../lib/page.ts";

const off = () => new Response("Not found", { status: 404 });

async function view(ctx: Page, s: core.Session, error: string | null) {
  const t = await core.startTotp(ctx, s.user);
  if (t === null) return { qr: null, secret: null, uri: null, error, codes: null, already: true, done_url: core.basePath(ctx) };
  return { qr: t.svg, secret: t.secret.replace(/(.{4})/gu, "$1 ").trim(), uri: t.uri, error, codes: null, already: false, done_url: core.basePath(ctx) };
}

export const load = signedIn(async (ctx, s) => (ctx.config.allow_totp === false ? off() : view(ctx, s, null)));

export const actions = {
  confirm: signedIn(async (ctx, s) => {
    if (ctx.config.allow_totp === false) return off();
    if (!(await core.confirmTotp(ctx, s, ctx.form.get("code")))) return view(ctx, s, core.GENERIC_ERROR);
    const codes = (await core.recoveryLeft(ctx, s.user.id)) === 0 ? await core.newRecoveryCodes(ctx, s.user.id) : null;
    return { qr: null, secret: null, uri: null, error: null, codes, already: false, done_url: core.basePath(ctx) };
  }),
};
