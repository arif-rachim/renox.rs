// The booking pages' guard (#334): the locale from i18n, then a signed-in
// user (anonymous visitors go to auth's login page).
import { auth, i18n } from "renox:modules";

import type { BookingCtx as BillingCtx } from "./core.ts";

export type Page = BillingCtx & {
  url: URL;
  form: FormData;
  principal?: { kind: string; id: string } | null;
  authz: { require(action: string, resource?: unknown): Promise<void> };
  setLocale?: (locale: string, dir?: "ltr" | "rtl") => void;
};

const redirect = (location: string): Response => new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

const LOCALES = new WeakMap<object, string>();

/** The page's tag as i18n chose it (`ar-u-ca-islamic-umalqura-nu-arab`); `en` before the guard ran. */
export const localeOf = (ctx: object): string => LOCALES.get(ctx) ?? "en";

export function guarded<T>(fn: (ctx: Page) => Promise<T>): (ctx: Page) => Promise<T | Response> {
  return async (ctx) => {
    const r = (await i18n.detectLocale({ user_id: ctx.principal?.id ?? null })) as { locale: string; dir: "ltr" | "rtl"; halt?: Response };
    ctx.setLocale?.(r.locale, r.dir);
    LOCALES.set(ctx, r.locale);
    if (r.halt) return r.halt;
    if (!ctx.principal || ctx.principal.kind === "anonymous") return redirect((await auth.loginUrl(ctx.url.pathname + ctx.url.search)) as string);
    return fn(ctx);
  };
}

/** Fils (minor units) as the amount the template's `money` filter formats: AED with 2 decimals (#336). */
export const aed = (fils: number): number => fils / 100;

export { hijri } from "./hijri.ts";
