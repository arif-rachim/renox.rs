// GET <mount>/login: the sign-in form. POST ?/default: the password check,
// then a 303 to `next` (a path of the app only) with the session cookie.
import { type AuthCtx, currentUser, GENERIC_LOGIN_ERROR, login, redirectWith } from "../lib/core.ts";

type Page = AuthCtx & { url: URL; form: FormData };

export async function load(ctx: Page) {
  const next = ctx.url.searchParams.get("next") ?? "/";
  if ((await currentUser(ctx)) !== null) return redirectWith(next, []);
  return { next, email: "", error: null };
}

export const actions = {
  async default(ctx: Page) {
    const email = String(ctx.form.get("email") ?? "");
    const next = String(ctx.form.get("next") ?? "/");
    const r = await login(ctx, { email, password: String(ctx.form.get("password") ?? ""), next });
    if (!r.ok) return { next, email, error: r.error ?? GENERIC_LOGIN_ERROR };
    if (r.halt) return r.halt;
    return redirectWith(next, [r.cookie]);
  },
};
