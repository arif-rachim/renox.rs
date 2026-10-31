// Locale detection for the i18n module (#244; docs/08-template-engine.md
// RTL; docs/21-uae-gcc-strategy.md). Pure functions, no I/O: the services
// read the stored preferences and pass them in.
//
// Order: an explicit `?lang=` (the caller stores it), the user's stored
// preference, the page session's stored preference, the organisation's
// default, `Accept-Language`, then the configured default. Each candidate
// counts only when it is one of the offered locales.
//
// Digits (#266, ops.md 1.4.0 "Locale"): an Arabic page gets the tag
// `<locale>-u-nu-arab` when the config says `arab`, or says `auto` and the
// stored choice asked for Arabic digits. The renderer's number, money and
// date filters then write Eastern Arabic digits.
//
// Calendar (#336, the `ca` extension of the same rule): an Arabic page gets
// `-u-ca-islamic-umalqura` when the config says `islamic-umalqura`, or says
// `auto` and the stored choice asked for a Hijri calendar. The renderer's
// `date` filter stays Gregorian (it formats `gregory` only, ops.md 1.4.0);
// a page shows the Hijri date next to it from the tag (README, "Hijri").

export interface Options {
  locales: string[];
  fallback: string;
  digits: Digits;
  calendar: CalendarOption;
}

/** The `digits` config: always Latin, always Arabic-Indic, or the stored choice. */
export type Digits = "latn" | "arab" | "auto";

/** The calendars of `setLocale`'s `ca` key (ops.md 1.4.0, CLDR `calendar.xml`). */
export const CALENDARS = ["gregory", "islamic", "islamic-civil", "islamic-tbla", "islamic-umalqura", "persian"] as const;
export type Calendar = (typeof CALENDARS)[number];

/** The `calendar` config: always Gregorian, always Umm al-Qura on Arabic pages, or the stored choice. */
export type CalendarOption = "gregory" | "islamic-umalqura" | "auto";

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
  return {
    locales,
    fallback,
    digits: config.digits === "arab" || config.digits === "auto" ? config.digits : "latn",
    calendar: config.calendar === "islamic-umalqura" || config.calendar === "auto" ? config.calendar : "gregory",
  };
}

/** A tag split into its language part and the `nu` and `ca` values of its `-u-` extension (if any). */
export function splitTag(tag: string): { base: string; nu: "latn" | "arab" | null; ca: Calendar | null } {
  const t = tag.trim();
  const i = t.toLowerCase().indexOf("-u-");
  if (i < 0) return { base: t, nu: null, ca: null };
  const ext = t.slice(i + 3).toLowerCase();
  const nu = /(?:^|-)nu-(latn|arab)(?:-|$)/u.exec(ext)?.[1] as "latn" | "arab" | undefined;
  // `ca-<calendar>` up to the next key (`-nu-`) or the end; only the calendars of ops.md count.
  const ca = /(?:^|-)ca-([a-z]+(?:-(?!nu-)[a-z]+)*)/u.exec(ext)?.[1];
  return { base: t.slice(0, i), nu: nu ?? null, ca: (CALENDARS as readonly string[]).includes(ca ?? "") ? (ca as Calendar) : null };
}

/** `tag` when offered, else an offered locale with its language (`ar-AE` -> `ar`), else null. */
export function match(tag: string | null | undefined, locales: readonly string[]): string | null {
  if (typeof tag !== "string") return null;
  // BCP 47 tags are case-insensitive: `EN`, `ar-ae` match too; a `-u-`
  // extension (`ar-u-nu-arab`) is not part of the match.
  const t = splitTag(tag).base;
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u.test(t)) return null;
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

/** The digits of a page in `locale`: Latin except on Arabic pages, where the config (or, with `auto`, the stored choice) decides. */
export function digitsOf(locale: string, o: Options, stored: "latn" | "arab" | null = null): "latn" | "arab" {
  if (primary(locale) !== "ar") return "latn";
  if (o.digits === "auto") return stored ?? "latn";
  return o.digits;
}

/** The calendar of a page in `locale`: Gregorian except on Arabic pages, where the config (or, with `auto`, the stored choice) decides. */
export function calendarOf(locale: string, o: Options, stored: Calendar | null = null): Calendar {
  if (primary(locale) !== "ar") return "gregory";
  if (o.calendar === "auto") return stored ?? "gregory";
  return o.calendar;
}

/**
 * The tag the page sets: the locale, with `-u-ca-<calendar>` for a calendar
 * other than Gregorian and `-nu-arab` for Eastern Arabic digits, in the
 * canonical order of ops.md 1.4.0 (`ar-u-ca-islamic-umalqura-nu-arab`).
 */
export function tagOf(locale: string, digits: "latn" | "arab", calendar: Calendar = "gregory"): string {
  const ext = [...(calendar === "gregory" ? [] : [`ca-${calendar}`]), ...(digits === "arab" ? ["nu-arab"] : [])];
  return ext.length === 0 ? locale : `${locale}-u-${ext.join("-")}`;
}
