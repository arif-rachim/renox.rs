// Locale detection for the i18n module (#244; docs/08-template-engine.md
// RTL; docs/21-uae-gcc-strategy.md). Pure functions, no I/O: the services
// read the stored preferences and pass them in.
//
// Order: an explicit `?lang=` (the caller stores it), the user's stored
// preference, the page session's stored preference, the organisation's
// default, `Accept-Language`, then the configured default. Each candidate
// counts only when it is one of the offered locales.

export interface Options {
  locales: string[];
  fallback: string;
  digits: "latin" | "arabic_indic";
}

export type Source = "query" | "user" | "session" | "org" | "accept_language" | "default";

export interface Candidates {
  query?: string | null;
  user?: string | null;
  session?: string | null;
  org?: string | null;
  accept_language?: string | null;
}

const TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u;
const RTL = ["ar", "fa", "he", "ur", "ps", "sd", "ug", "yi", "dv", "ckb"];

const primary = (tag: string): string => tag.split("-")[0]?.toLowerCase() ?? "";

/** The module config as options; bad entries are dropped, `en` when nothing is left. */
export function options(config: Readonly<Record<string, unknown>>): Options {
  const raw = typeof config.locales === "string" ? config.locales : "en,ar";
  const locales = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => TAG.test(s) && s.length <= 35))];
  if (locales.length === 0) locales.push("en");
  const want = typeof config.default_locale === "string" ? config.default_locale : "en";
  const fallback = match(want, locales) ?? (locales[0] as string);
  return { locales, fallback, digits: config.digits === "arabic_indic" ? "arabic_indic" : "latin" };
}

/** `tag` when offered, else an offered locale with its language (`ar-AE` -> `ar`), else null. */
export function match(tag: string | null | undefined, locales: readonly string[]): string | null {
  // BCP 47 tags are case-insensitive: `EN`, `ar-ae` match too.
  if (typeof tag !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u.test(tag.trim())) return null;
  const t = tag.trim();
  return locales.find((l) => l.toLowerCase() === t.toLowerCase()) ?? locales.find((l) => primary(l) === primary(t)) ?? null;
}

/** `Accept-Language` by quality (RFC 9110 12.5.4), the first offered match; `*` is ignored. */
export function negotiate(header: string | null | undefined, locales: readonly string[]): string | null {
  if (typeof header !== "string" || header.length > 1024) return null;
  const ranges = header
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const quality = q === undefined ? 1 : Number(q.slice(2));
      return { tag: tag.trim(), q: Number.isFinite(quality) ? quality : 0, i };
    })
    .filter((r) => r.tag !== "" && r.tag !== "*" && r.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const r of ranges) {
    const m = match(r.tag, locales);
    if (m !== null) return m;
  }
  return null;
}

export const dirOf = (locale: string): "ltr" | "rtl" => (RTL.includes(primary(locale)) ? "rtl" : "ltr");

/** The first candidate that is offered, in the order above. */
export function pick(c: Candidates, o: Options): { locale: string; source: Source } {
  const steps: [Source, string | null][] = [
    ["query", match(c.query, o.locales)],
    ["user", match(c.user, o.locales)],
    ["session", match(c.session, o.locales)],
    ["org", match(c.org, o.locales)],
    ["accept_language", negotiate(c.accept_language, o.locales)],
  ];
  for (const [source, locale] of steps) if (locale !== null) return { locale, source };
  return { locale: o.fallback, source: "default" };
}

/** `digits` applies to Arabic only. */
export const digitsOf = (locale: string, o: Options): "latin" | "arabic_indic" => (primary(locale) === "ar" ? o.digits : "latin");
