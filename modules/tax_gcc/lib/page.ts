// The tax pages' guard (#331): the locale from i18n, then a signed-in
// user (anonymous visitors go to auth's login page).
import { auth, i18n } from "renox:modules";

import type { TaxCtx } from "./core.ts";

export type Page = TaxCtx & {
  url: URL;
  form: FormData;
  principal?: { kind: string; id: string } | null;
  authz: { require(action: string, resource?: unknown): Promise<void> };
  setLocale?: (locale: string, dir?: "ltr" | "rtl") => void;
};

const redirect = (location: string): Response => new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

export function guarded<T>(fn: (ctx: Page) => Promise<T>): (ctx: Page) => Promise<T | Response> {
  return async (ctx) => {
    const r = (await i18n.detectLocale({ user_id: ctx.principal?.id ?? null })) as { locale: string; dir: "ltr" | "rtl"; halt?: Response };
    ctx.setLocale?.(r.locale, r.dir);
    if (r.halt) return r.halt;
    if (!ctx.principal || ctx.principal.kind === "anonymous") return redirect((await auth.loginUrl(ctx.url.pathname + ctx.url.search)) as string);
    return fn(ctx);
  };
}

export const day = (t: number | null): string => (t === null ? "-" : new Date(t).toISOString().slice(0, 10));
