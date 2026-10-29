// GET <mount>/register: the form. POST ?/default: `auth.before_register`,
// the account, and a confirmation link by mail. The same answer, and no
// cookie, whether or not the email already has an account (#100).
import { enabled } from "../lib/oauth.ts";
import type { AuthCtx } from "../lib/core.ts";
import { signUp } from "../lib/tokens.ts";

/** The buttons of the providers that are set up, coming back to `next`. */
const buttons = (ctx: Page, next: string) => enabled(ctx).map((p) => ({ ...p, href: `oauth/${p.name}/start?next=${encodeURIComponent(next)}` }));

type Page = AuthCtx & { url: URL; form: FormData; secrets: Readonly<Record<string, string>> };

export async function load(ctx: Page) {
  return { next: ctx.url.searchParams.get("next") ?? "/", email: "", display_name: "", error: null, notice: null, providers: buttons(ctx, ctx.url.searchParams.get("next") ?? "/") };
}

export const actions = {
  async default(ctx: Page) {
    const input = { email: String(ctx.form.get("email") ?? ""), password: String(ctx.form.get("password") ?? ""), display_name: String(ctx.form.get("display_name") ?? "") };
    const next = String(ctx.form.get("next") ?? "/");
    const r = await signUp(ctx, input);
    if (!r.ok) return r.halt ?? { next, email: input.email, display_name: input.display_name, error: r.error, notice: null, providers: buttons(ctx, next) };
    return { next, email: "", display_name: "", error: null, notice: r.message, providers: buttons(ctx, next) };
  },
};
