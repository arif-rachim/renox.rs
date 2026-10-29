// The i18n module's services (#244). The caller passes what i18n cannot
// know without depending on other modules: the signed-in user's id and
// the organisation's default locale. i18n never sets the page locale
// itself (ops.md 1.3.0 section 14, "Locale"): the loader calls
// `ctx.setLocale(r.locale, r.dir)` with what detectLocale returns.

import type { DbStatements } from "renox";

import { type Candidates, digitsOf, dirOf, match, options, pick, type Source, splitTag, tagOf } from "./lib/detect.ts";

interface I18nCtx {
  db: DbStatements;
  config: Readonly<Record<string, unknown>>;
  url?: URL;
  headers?: Headers;
  session?: { id: string };
  hooks: { run(name: string, args: unknown): Promise<{ halt: false } | { halt: true; response: Response; module: string }> };
}

export interface Who {
  user_id?: string | null;
  org_locale?: string | null;
}

export interface Detected {
  /** The tag for `ctx.setLocale`: the language, with `-u-nu-arab` for Eastern Arabic digits (ops.md 1.4.0). */
  locale: string;
  /** The offered locale without the extension (`ar`). */
  language: string;
  dir: "ltr" | "rtl";
  digits: "latn" | "arab";
  source: Source;
  /** One link per offered locale: this page with `?lang=<locale>`. */
  alternates: { locale: string; href: string; current: boolean }[];
  /** A filler of `i18n.detect` answered instead: the loader returns it. */
  halt?: Response;
}

const now = (): number => Math.floor(Date.now() / 1000);

const subjects = (ctx: I18nCtx, who?: Who): { user: string | null; session: string | null } => ({
  user: typeof who?.user_id === "string" && who.user_id !== "" ? `user:${who.user_id}` : null,
  session: typeof ctx.session?.id === "string" ? `session:${ctx.session.id}` : null,
});

interface Pref {
  locale: string;
  digits: "latn" | "arab" | null;
}

async function stored(ctx: I18nCtx, subject: string | null): Promise<Pref | null> {
  if (subject === null) return null;
  return ctx.db.queryOne<Pref>("select locale, digits from i18n__prefs where subject = ?", [subject]);
}

async function store(ctx: I18nCtx, subject: string, locale: string, digits: "latn" | "arab" | null): Promise<void> {
  await ctx.db.execute(
    "insert into i18n__prefs (subject, locale, digits, updated_at) values (?, ?, ?, ?) on conflict (subject) do update set locale = excluded.locale, digits = excluded.digits, updated_at = excluded.updated_at",
    [subject, locale, digits, now()],
  );
}

function alternates(ctx: I18nCtx, locales: string[], current: string): Detected["alternates"] {
  return locales.map((locale) => {
    const u = ctx.url === undefined ? new URL("http://x/") : new URL(ctx.url.href);
    u.searchParams.set("lang", locale);
    return { locale, href: `${u.pathname}${u.search}`, current: locale === current };
  });
}

/**
 * The locale of this request: `?lang=` (stored for the user, or for the
 * page session when there is no user), the user's stored choice, the
 * session's, the organisation's default, `Accept-Language`, the default.
 */
export async function detectLocale(ctx: I18nCtx, who?: Who): Promise<Detected> {
  const o = options(ctx.config);
  const s = subjects(ctx, who);
  const query = ctx.url?.searchParams.get("lang") ?? null;
  const user = await stored(ctx, s.user);
  const session = await stored(ctx, s.session);
  const c: Candidates = {
    query,
    user: user?.locale ?? null,
    session: session?.locale ?? null,
    org: who?.org_locale ?? null,
    accept_language: ctx.headers?.get("accept-language") ?? null,
  };
  const hook = await ctx.hooks.run("i18n.detect", { candidates: c, ...(typeof who?.user_id === "string" ? { user_id: who.user_id } : {}) });
  const { locale, source } = pick(c, o);
  // The digits asked for with the choice that won (`?lang=ar-u-nu-arab`, or the stored row).
  const asked = source === "query" ? splitTag(query ?? "").nu : source === "user" ? (user?.digits ?? null) : source === "session" ? (session?.digits ?? null) : null;
  if (source === "query") {
    const subject = s.user ?? s.session;
    if (subject !== null) await store(ctx, subject, locale, asked);
  }
  const digits = digitsOf(locale, o, asked);
  const out: Detected = { locale: tagOf(locale, digits), language: locale, dir: dirOf(locale), digits, source, alternates: alternates(ctx, o.locales, locale) };
  if (hook.halt) out.halt = hook.response;
  return out;
}

/** The same as detectLocale (the name of the issue, #244). */
export const locale = detectLocale;

/** Store `locale` (with its `-u-nu-` digits, if any) for the user (`user_id`) or, without one, for the page session. */
export async function setLocale(ctx: I18nCtx, wanted: string, who?: Who): Promise<{ locale: string; dir: "ltr" | "rtl" } | { error: string }> {
  const o = options(ctx.config);
  const m = match(wanted, o.locales);
  if (m === null) return { error: `not an offered locale: ${o.locales.join(", ")}` };
  const s = subjects(ctx, who);
  const subject = s.user ?? s.session;
  if (subject === null) return { error: "no user and no page session to store it for" };
  const asked = splitTag(wanted).nu;
  await store(ctx, subject, m, asked);
  return { locale: tagOf(m, digitsOf(m, o, asked)), dir: dirOf(m) };
}
