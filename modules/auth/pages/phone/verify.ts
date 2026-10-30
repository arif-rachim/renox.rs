// GET <mount>/phone/verify?phone=…: phone-first sign-in, step 2 (#291).
// POST ?/default checks the code; then `auth.after_login`, a new session,
// a 303 to `next`, as the password flow.
import { type AuthCtx, redirectWith } from "../../lib/core.ts";
import { localized } from "../../lib/locale.ts";
import { normalizePhone, SENT_MESSAGE, verifyLoginCode } from "../../lib/phone.ts";

type Page = AuthCtx & { url: URL; form: FormData };

const off = () => new Response("Not found", { status: 404 });

export const load = localized(async (ctx: Page) => {
  if (ctx.config.phone_login !== true) return off();
  return { phone: normalizePhone(ctx.url.searchParams.get("phone")) ?? "", next: ctx.url.searchParams.get("next") ?? "/", message: SENT_MESSAGE, error: null };
});

export const actions = {
  default: localized(async (ctx: Page) => {
    if (ctx.config.phone_login !== true) return off();
    const phone = String(ctx.form.get("phone") ?? "");
    const next = String(ctx.form.get("next") ?? "/");
    const r = await verifyLoginCode(ctx, phone, ctx.form.get("code"), next);
    if (!r.ok) return { phone, next, message: null, error: r.error };
    if (r.halt) return r.halt;
    return redirectWith(next, [r.cookie]);
  }),
};
