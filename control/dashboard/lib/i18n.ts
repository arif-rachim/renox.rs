// Messages built in TypeScript (#336): notices, form errors, problem
// messages, `ago()`, state labels, the checklist and the chart titles.
// Templates cannot call functions (docs/08-template-engine.md), so a loader
// or an action looks its strings up here, in the same catalogs the templates
// use (i18n/en.json, i18n/ar.json), in the request's locale (lib/locale.ts).
//
// The message syntax is the subset of ICU the renderer formats: `{name}`,
// and `{n, plural, =0 {…} one {…} two {…} few {…} many {…} other {…}}` with
// `#` for the number. Plural categories follow CLDR: English `one`/`other`,
// Arabic `zero`/`one`/`two`/`few`/`many`/`other`. A key missing from the
// locale's catalog falls back to English, then to the key itself; the
// completeness rule of `renox check` keeps that from happening.

import ar from "../i18n/ar.json" with { type: "json" };
import en from "../i18n/en.json" with { type: "json" };
import { chooseLocale, type Locale } from "./locale.ts";

type Catalog = { [k: string]: string | Catalog };
export type Args = Readonly<Record<string, string | number>>;
/** A message lookup in one locale. */
export type Tr = (key: string, args?: Args) => string;

function flatten(c: Catalog, prefix = "", out = new Map<string, string>()): Map<string, string> {
  for (const [k, v] of Object.entries(c)) {
    if (prefix === "" && k === "_meta") continue;
    const key = prefix === "" ? k : `${prefix}.${k}`;
    if (typeof v === "string") out.set(key, v);
    else flatten(v, key, out);
  }
  return out;
}

const CATALOGS: Record<Locale, Map<string, string>> = { en: flatten(en as Catalog), ar: flatten(ar as Catalog) };

/** CLDR plural category of `n` in `locale`. */
export function pluralCategory(n: number, locale: Locale): "zero" | "one" | "two" | "few" | "many" | "other" {
  if (locale === "en") return n === 1 ? "one" : "other";
  if (!Number.isInteger(n)) return "other";
  const m = Math.abs(n) % 100;
  if (n === 0) return "zero";
  if (n === 1) return "one";
  if (n === 2) return "two";
  if (m >= 3 && m <= 10) return "few";
  if (m >= 11 && m <= 99) return "many";
  return "other";
}

/** The index of the brace that closes the one at `open`. */
function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

function plural(body: string, n: number, locale: Locale, args: Args): string {
  const branches = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf("{", i);
    if (open < 0) break;
    const end = closing(body, open);
    if (end < 0) break;
    branches.set(body.slice(i, open).trim(), body.slice(open + 1, end));
    i = end + 1;
  }
  const chosen = branches.get(`=${n}`) ?? branches.get(pluralCategory(n, locale)) ?? branches.get("other") ?? "";
  return format(chosen, args, locale, n);
}

/** Formats `message` with `args`; `hash` is the number `#` stands for inside a plural branch. */
export function format(message: string, args: Args, locale: Locale, hash?: number): string {
  let out = "";
  let i = 0;
  while (i < message.length) {
    const c = message[i] as string;
    if (c === "#" && hash !== undefined) {
      out += String(hash);
      i++;
      continue;
    }
    if (c !== "{") {
      out += c;
      i++;
      continue;
    }
    const end = closing(message, i);
    if (end < 0) {
      out += message.slice(i);
      break;
    }
    const inner = message.slice(i + 1, end);
    const comma = inner.indexOf(",");
    if (comma < 0) {
      const v = args[inner.trim()];
      out += v === undefined ? `{${inner}}` : String(v);
    } else {
      const name = inner.slice(0, comma).trim();
      const rest = inner.slice(comma + 1);
      const kindEnd = rest.indexOf(",");
      const kind = rest.slice(0, kindEnd < 0 ? undefined : kindEnd).trim();
      const n = Number(args[name]);
      out += kind === "plural" && kindEnd >= 0 && Number.isFinite(n) ? plural(rest.slice(kindEnd + 1), n, locale, args) : `{${inner}}`;
    }
    i = end + 1;
  }
  return out;
}

/** The lookup for `locale`. */
export function translator(locale: Locale): Tr {
  const own = CATALOGS[locale];
  return (key, args = {}) => format(own.get(key) ?? CATALOGS.en.get(key) ?? key, args, locale);
}

/** English: the default of the pure helpers (lib/view.ts and the others), so their callers without a request read as before. */
export const EN: Tr = translator("en");

/** The lookup for a request's locale (the choice of lib/locale.ts). */
export const trOf = (ctx: { url: URL; headers: Headers }): Tr => translator(chooseLocale(ctx.url, ctx.headers).locale);
