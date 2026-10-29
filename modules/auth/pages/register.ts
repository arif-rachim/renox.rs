// GET <mount>/register: the form. POST ?/default: `auth.before_register`,
// the user, a first session, then a 303 to `next` with the cookie.
import { type AuthCtx, redirectWith, register } from "../lib/core.ts";

type Page = AuthCtx & { url: URL; form: FormData };

export async function load(ctx: Page) {
  return { next: ctx.url.searchParams.get("next") ?? "/", email: "", display_name: "", error: null };
}

export const actions = {
  async default(ctx: Page) {
    const input = { email: String(ctx.form.get("email") ?? ""), password: String(ctx.form.get("password") ?? ""), display_name: String(ctx.form.get("display_name") ?? "") };
    const next = String(ctx.form.get("next") ?? "/");
    const r = await register(ctx, input);
    if (!r.ok) return r.halt ?? { next, email: input.email, display_name: input.display_name, error: r.error };
    return redirectWith(next, [r.cookie]);
  },
};
