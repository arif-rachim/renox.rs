// GET <mount>/reset/confirm?token=…: the new password form. POST ?/default:
// the token once, the password, every session signed out, a new one here.
import { type AuthCtx, redirectWith } from "../../lib/core.ts";
import { confirmReset } from "../../lib/tokens.ts";
import { localized } from "../../lib/locale.ts";

type Page = AuthCtx & { url: URL; form: FormData };

export const load = localized(async (ctx: Page) => {
  return { token: ctx.url.searchParams.get("token") ?? "", error: null };
});

export const actions = {
  default: localized(async (ctx: Page) => {
    const token = String(ctx.form.get("token") ?? "");
    const r = await confirmReset(ctx, token, String(ctx.form.get("password") ?? ""));
    if (!r.ok) return { token, error: r.error };
    return redirectWith("/", [r.cookie]);
  }),
};
