// What the notifications pages share: the locale from i18n, the login hop
// for a signed-out visitor.
import { auth, i18n } from "renox:modules";

import { NotifError, type NotifCtx } from "./core.ts";

export type Page = NotifCtx & { url: URL; form: FormData; setLocale?: (locale: string, dir?: "ltr" | "rtl") => void };

export const redirect = (location: string): Response => new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

export async function toLogin(ctx: Page): Promise<Response> {
  return redirect((await auth.loginUrl(ctx.url.pathname + ctx.url.search)) as string);
}

/** Runs a load or an action with the page's locale set; a signed-out visitor goes to the login page. */
export function guarded<T>(fn: (ctx: Page) => Promise<T>): (ctx: Page) => Promise<T | Response> {
  return async (ctx) => {
    try {
      const r = (await i18n.detectLocale({ user_id: ctx.principal?.id ?? null })) as { locale: string; dir: "ltr" | "rtl"; halt?: Response };
      ctx.setLocale?.(r.locale, r.dir);
      if (r.halt) return r.halt;
      return await fn(ctx);
    } catch (e) {
      if (e instanceof NotifError && e.code === "AUTH_REQUIRED") return toLogin(ctx);
      throw e;
    }
  };
}
