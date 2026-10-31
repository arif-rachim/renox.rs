// The dashboard's page language (#336): English or Arabic, from the
// catalogs in i18n/. The dashboard installs no modules, so it does not use the
// i18n module's detectLocale; it chooses the same way, without the database:
//
//   1. `?lang=en|ar` in the URL. On a full-page GET this answers 303 to the
//      same address without `lang`, with a cookie that keeps the choice: a
//      loader that returns data cannot set a cookie, a `Response` can, and the
//      redirect happens before the first call to the control API, inside the
//      shell delay (ops.md section 14).
//   2. The `renox_lang` cookie.
//   3. `Accept-Language`, by quality.
//   4. English.
//
// `ctx.setLocale` then sets `<html lang dir>`, the catalog and the filters'
// formats for the page (ops.md section 14, "Locale").

import { safeRedirectTarget, type ActionContext, type LoaderContext } from "renox";

export const LOCALES = ["en", "ar"] as const;
export type Locale = (typeof LOCALES)[number];

export const LANG_COOKIE = "renox_lang";
/** One year. */
const COOKIE_MAX_AGE = 365 * 24 * 3600;

const offered = (raw: string | null | undefined): Locale | null => {
  if (typeof raw !== "string") return null;
  const lang = raw.trim().toLowerCase().split(/[-_]/u)[0];
  return (LOCALES as readonly string[]).includes(lang ?? "") ? (lang as Locale) : null;
};

/** The `renox_lang` cookie's locale, if it names an offered one. */
export function cookieLocale(headers: Headers): Locale | null {
  for (const pair of (headers.get("cookie") ?? "").split(";")) {
    const [name, value] = pair.trim().split("=", 2);
    if (name === LANG_COOKIE) return offered(value);
  }
  return null;
}

/** The first offered locale of `Accept-Language`, highest quality first. */
export function acceptLocale(header: string | null): Locale | null {
  if (header === null) return null;
  const ranked = header
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/u.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag: tag ?? "", q: q === undefined ? 1 : Number(q), i };
    })
    .filter((r) => r.q > 0 && Number.isFinite(r.q))
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const r of ranked) {
    const l = offered(r.tag);
    if (l !== null) return l;
  }
  return null;
}

/** The page's locale: `?lang=`, the cookie, `Accept-Language`, then English. */
export function chooseLocale(url: URL, headers: Headers): { locale: Locale; fromQuery: boolean } {
  const q = offered(url.searchParams.get("lang"));
  if (q !== null) return { locale: q, fromQuery: true };
  return { locale: cookieLocale(headers) ?? acceptLocale(headers.get("accept-language")) ?? "en", fromQuery: false };
}

export const dirOf = (l: Locale): "ltr" | "rtl" => (l === "ar" ? "rtl" : "ltr");

/**
 * Sets the page's locale. Returns the redirect that stores a `?lang=` choice
 * on a full-page GET (the caller sends it), or null.
 */
export function applyLocale(ctx: LoaderContext | ActionContext): Response | null {
  const { locale, fromQuery } = chooseLocale(ctx.url, ctx.headers);
  ctx.setLocale(locale, dirOf(locale));
  if (!fromQuery || ctx.req.method !== "GET" || ctx.fragment !== null) return null;
  const rest = new URLSearchParams(ctx.url.searchParams);
  rest.delete("lang");
  const search = rest.toString();
  // A path of this app only (no-unsafe-redirect): `//host` in the path goes to `/`.
  const location = safeRedirectTarget(`${ctx.url.pathname}${search === "" ? "" : `?${search}`}`) ?? "/";
  return new Response(null, {
    status: 303,
    headers: {
      location,
      "set-cookie": `${LANG_COOKIE}=${locale}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; Secure`,
      "cache-control": "no-store",
    },
  });
}
