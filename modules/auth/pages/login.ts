// GET <mount>/login: the sign-in form. POST ?/default: the password check,
// then a 303 to `next` (a path of the app only) with the session cookie.
import { enabled } from "../lib/oauth.ts";
import { type AuthCtx, currentUser, GENERIC_LOGIN_ERROR, login, redirectWith } from "../lib/core.ts";
import { localized } from "../lib/locale.ts";

/** The buttons of the providers that are set up, coming back to `next`. */
const buttons = (ctx: Page, next: string) => enabled(ctx).map((p) => ({ ...p, href: `oauth/${p.name}/start?next=${encodeURIComponent(next)}` }));

type Page = AuthCtx & { url: URL; form: FormData; secrets: Readonly<Record<string, string>> };

/** Phone-first and passkey sign-in (#291), each behind its config flag. */
const methods = (ctx: Page, next: string) => ({
  phone_href: ctx.config.phone_login === true ? `phone?next=${encodeURIComponent(next)}` : null,
  passkey_href: ctx.config.passkeys === true ? `passkeys/login?next=${encodeURIComponent(next)}` : null,
});

export const load = localized(async (ctx: Page) => {
  const next = ctx.url.searchParams.get("next") ?? "/";
  if ((await currentUser(ctx)) !== null) return redirectWith(next, []);
  return { next, email: "", error: null, providers: buttons(ctx, next), ...methods(ctx, next) };
});

export const actions = {
  default: localized(async (ctx: Page) => {
    const email = String(ctx.form.get("email") ?? "");
    const next = String(ctx.form.get("next") ?? "/");
    const r = await login(ctx, { email, password: String(ctx.form.get("password") ?? ""), next });
    if (!r.ok) return { next, email, error: r.error ?? GENERIC_LOGIN_ERROR, providers: buttons(ctx, next), ...methods(ctx, next) };
    if (r.halt) return r.halt;
    return redirectWith(next, [r.cookie]);
  }),
};
