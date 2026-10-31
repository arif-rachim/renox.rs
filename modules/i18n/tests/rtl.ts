// RTL snapshots of a module's pages in both directions (#336;
// docs/08-template-engine.md, "Right-to-left and bilingual output": official
// module templates "are snapshot-tested in both ltr and rtl"). Shared by the
// `tests/rtl.test.ts` of every official module that has pages.
//
// Each page is fetched twice by the same user, with `?lang=en` and
// `?lang=ar`, and checked:
//   - `<html lang="en" dir="ltr">`, then `<html lang="ar" dir="rtl">`;
//   - in Arabic, no message of the page's own keys (its template and the
//     module's layouts) is left in English, and no key is rendered raw (a
//     key missing from the catalog renders as the key itself);
//   - both bodies are snapshotted (`renox/test` `snapshot`, after `stable`).
//
// The completeness rule of `renox check` (`i18n-missing-key`) guarantees the
// catalogs; this proves the pages actually render from them.

import { expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { snapshot, type TestApp } from "../../../sdk/src/test.ts";

const MODULES = join(import.meta.dir, "..", "..");

type Catalog = { [k: string]: string | Catalog };

function flatten(c: Catalog, prefix = "", out = new Map<string, string>()): Map<string, string> {
  for (const [k, v] of Object.entries(c)) {
    if (prefix === "" && k === "_meta") continue;
    const key = prefix === "" ? k : `${prefix}.${k}`;
    if (typeof v === "string") out.set(key, v);
    else flatten(v, key, out);
  }
  return out;
}

/** Every official module's catalog for `locale`, merged (a page may use another module's keys). */
function catalog(locale: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of readdirSync(MODULES)) {
    const file = join(MODULES, m, "i18n", `${locale}.json`);
    if (existsSync(file)) for (const [k, v] of flatten(JSON.parse(readFileSync(file, "utf8")) as Catalog)) out.set(k, v);
  }
  return out;
}

const EN = catalog("en");
const AR = catalog("ar");

/** The catalog keys a template uses: `<r-t key>` and `'key' | t`. */
export function keysOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/key="([a-z0-9_]+\.[a-z0-9_.]+)"|'([a-z0-9_]+\.[a-z0-9_.]+)'\s*\|\s*t\b/gu)].map((m) => (m[1] ?? m[2]) as string);
}

/** HTML text escaping as the renderer writes a message. */
const escaped = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** The English messages of `keys` (plain text of more than one word, not the same in Arabic) found in `html`, and the keys rendered raw. */
export function englishLeft(html: string, keys: readonly string[]): string[] {
  return [...new Set(keys)].flatMap((k) => {
    const en = EN.get(k);
    if (en === undefined) return [`${k}: no English message`];
    if (html.includes(`>${k}<`) || html.includes(`"${k}"`)) return [`${k}: rendered as the key`];
    if (!en.includes(" ") || en.includes("{") || AR.get(k) === en) return [];
    return html.includes(escaped(en)) ? [`${k}: ${en}`] : [];
  });
}

export interface RtlPage {
  /** The snapshot name, e.g. `bookings`. */
  name: string;
  /** The page's path in the test app, with its own query if any. */
  path: string;
  /** Who fetches it (a signed-in user, a visitor). */
  as: TestApp;
  /** The template, relative to the module (`pages/mine.html`). */
  template: string;
  /** Text the Arabic page must contain (proves the page itself rendered, not an error page). */
  arabic?: string;
}

const withLang = (path: string, lang: string): string => `${path}${path.includes("?") ? "&" : "?"}lang=${lang}`;

/** The page's layouts: every `pages/_layouts/*.html` of the module. */
function layouts(module: string): string[] {
  const dir = join(module, "pages", "_layouts");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => join(dir, f)) : [];
}

/**
 * Renders every page of `pages` in `en` (ltr) and `ar` (rtl), checks both
 * directions and the Arabic catalog, and snapshots both. `stable` removes
 * what changes per run (ids, times) before the snapshot.
 */
export async function bothDirections(module: string, pages: readonly RtlPage[], stable: (html: string) => string = (h) => h): Promise<void> {
  const shared = layouts(module).flatMap(keysOf);
  for (const p of pages) {
    const keys = [...keysOf(join(module, p.template)), ...shared];
    const en = await p.as.page(withLang(p.path, "en"));
    expect(`${p.name} en ${en.status}`).toBe(`${p.name} en 200`);
    expect(en.html).toContain('<html lang="en" dir="ltr">');
    const ar = await p.as.page(withLang(p.path, "ar"));
    expect(`${p.name} ar ${ar.status}`).toBe(`${p.name} ar 200`);
    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
    if (p.arabic !== undefined) expect(ar.html).toContain(p.arabic);
    expect({ page: p.name, english: englishLeft(ar.html, keys) }).toEqual({ page: p.name, english: [] });
    snapshot(stable(en.html), { role: `${p.name} en` });
    snapshot(stable(ar.html), { role: `${p.name} ar` });
  }
}

/** Ids, timestamps and dates that change per run, as placeholders. */
export function stableIds(html: string): string {
  return html
    .replace(/\b[0-9a-f]{32,64}\b/gu, "<id>")
    // Prefixed random ids (`bk_mvw0d97gsdv0p03m`, `em_…`).
    .replace(/\b[a-z]{2,5}_[0-9a-z]{14,}\b/gu, "<id>")
    .replace(/\b1[0-9]{9}(?:[0-9]{3})?\b/gu, "<time>")
    // The date filter's short form: DD/MM/YYYY, and Arabic's d‏/M‏/y (right-to-left marks), in either digits.
    .replace(/[0-9٠-٩]{1,2}\u200f?\/[0-9٠-٩]{1,2}\u200f?\/[0-9٠-٩]{4}/gu, "<date>")
    .replace(/\b20[0-9]{2}-[01][0-9]-[0-3][0-9](?:[T ][0-2][0-9]:[0-5][0-9](?::[0-5][0-9](?:\.[0-9]+)?)?Z?)?\b/gu, "<date>");
}

/** A user of the test app's `auth`, signed in, with `roles` from the test app's `/api/grant?role=` route. */
export async function member(t: TestApp, name: string, ...roles: string[]): Promise<TestApp> {
  const u = t.as(name);
  const password = "correct horse battery";
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password })).status).toBe(303);
  for (const role of roles) expect((await u.request("POST", `/api/grant?role=${role}`)).status).toBe(200);
  return u;
}
