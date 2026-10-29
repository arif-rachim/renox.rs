// GET <mount>/phone: phone-first sign-in, step 1 (#291). POST ?/default
// sends a code when the number belongs to an account (the same answer in
// every case), then a 303 to the code page. Off unless config `phone_login`.
import { type AuthCtx, currentUser, redirectWith } from "../../lib/core.ts";
import { localized } from "../../lib/locale.ts";
import { requestLoginCode } from "../../lib/phone.ts";

type Page = AuthCtx & { url: URL; form: FormData };

const off = () => new Response("Not found", { status: 404 });

export const load = localized(async (ctx: Page) => {
  if (ctx.config.phone_login !== true) return off();
  const next = ctx.url.searchParams.get("next") ?? "/";
  if ((await currentUser(ctx)) !== null) return redirectWith(next, []);
  return { next, phone: "", error: null };
});

export const actions = {
  default: localized(async (ctx: Page) => {
    if (ctx.config.phone_login !== true) return off();
    const next = String(ctx.form.get("next") ?? "/");
    const r = await requestLoginCode(ctx, ctx.form.get("phone"));
    if (!r.ok) return { next, phone: String(ctx.form.get("phone") ?? ""), error: r.error };
    const mount = ctx.url.pathname.replace(/\/phone\/?$/u, "");
    return redirectWith(`${mount}/phone/verify?phone=${encodeURIComponent(r.phone)}&next=${encodeURIComponent(next)}`, []);
  }),
};
