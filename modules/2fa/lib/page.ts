// What the 2fa pages share: the locale from i18n, the login hop.
import { auth, i18n } from "renox:modules";

import { type Session, session, type TwofaCtx } from "./core.ts";

export type Page = TwofaCtx & { url: URL; form: FormData; setLocale?: (locale: string, dir?: "ltr" | "rtl") => void };

export const redirect = (location: string, cookies: string[] = []): Response => {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) if (c) h.append("set-cookie", c);
  return new Response(null, { status: 303, headers: h });
};

export const safeNext = (v: unknown): string => (typeof v === "string" && /^\/(?![/\\])[^\s]*$/u.test(v) && v.length <= 2000 ? v : "/");

export async function toLogin(ctx: Page): Promise<Response> {
  return redirect((await auth.loginUrl(ctx.url.pathname + ctx.url.search)) as string);
}

/** A page for a signed-in user: the locale set, else the login hop. */
export function signedIn<T>(fn: (ctx: Page, s: Session) => Promise<T>): (ctx: Page) => Promise<T | Response> {
  return localized(async (ctx) => {
    const s = await session();
    return s === null ? toLogin(ctx) : fn(ctx, s);
  });
}

export function localized<T>(fn: (ctx: Page) => Promise<T>): (ctx: Page) => Promise<T | Response> {
  return async (ctx) => {
    const s = await session();
    const r = (await i18n.detectLocale({ user_id: s?.user.id ?? null })) as { locale: string; dir: "ltr" | "rtl"; halt?: Response };
    ctx.setLocale?.(r.locale, r.dir);
    return r.halt ?? fn(ctx);
  };
}
