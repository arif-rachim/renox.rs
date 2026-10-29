// The i18n module on the worker (#244): the page's lang and dir follow the
// detection order; a `?lang=` choice is stored per page session signed out
// and per user signed in (it follows the user to another browser);
// setLocale stores the same way; the language links.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

const source = (html: string): string | undefined => /<p id="source"[^>]*>([^<]*)</u.exec(html)?.[1];

describe.skipIf(!worker)("i18n", () => {
  test("signed out: ?lang= is stored for the page session; the org default, Accept-Language, the default", async () => {
    const a = t.as("a");
    const en = await a.page("/");
    expect(en.html).toContain('<html lang="en" dir="ltr">');
    expect(source(en.html)).toBe("default");
    expect(en.html).toContain("<h1>Hello</h1>");
    const ar = await a.page("/?lang=ar");
    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
    expect(ar.html).toContain("<h1>مرحباً</h1>");
    expect(source(ar.html)).toBe("query");
    // Stored for this session.
    expect(source((await a.page("/")).html)).toBe("session");
    expect((await a.page("/")).html).toContain('<html lang="ar" dir="rtl">');
    // Another browser: the org default, then Accept-Language.
    expect(source((await t.as("b").page("/?org=ar")).html)).toBe("org");
    const accept = await t.as("c").request("GET", "/", { headers: { "accept-language": "ar-AE,ar;q=0.9" } });
    expect(accept.html).toContain('<html lang="ar" dir="rtl">');
    expect(source(accept.html)).toBe("accept_language");
    // An offered locale only: ?lang=fr changes nothing and stores nothing.
    expect(source((await t.as("d").page("/?lang=fr")).html)).toBe("default");
    expect(t.db.query("select count(*) as n from i18n__prefs")).toEqual([{ n: 1 }]);
  });

  test("signed in: the choice is stored for the user and follows them; it beats the org default", async () => {
    const u = t.as("u");
    await u.action("/auth/register", "default", { email: "u@example.com", password: "correct horse battery", display_name: "U" });
    expect((await u.action("/auth/login", "default", { email: "u@example.com", password: "correct horse battery" })).status).toBe(303);
    expect(source((await u.page("/?lang=ar")).html)).toBe("query");
    const id = t.db.query<{ id: string }>("select id from auth__public_users_v1 where email = 'u@example.com'")[0]?.id as string;
    expect(t.db.query("select locale from i18n__prefs where subject = ?", [`user:${id}`])).toEqual([{ locale: "ar" }]);
    const phone = t.as("u-phone");
    await phone.action("/auth/login", "default", { email: "u@example.com", password: "correct horse battery" });
    const there = await phone.page("/?org=en");
    expect(there.html).toContain('<html lang="ar" dir="rtl">');
    expect(source(there.html)).toBe("user");
  });

  test("setLocale: per user with user_id, else per page session; offered locales only", async () => {
    expect(await t.service("i18n").setLocale("fr", { user_id: "u_x" })).toEqual({ error: "not an offered locale: en, ar" });
    expect(await t.service("i18n").setLocale("ar-AE", { user_id: "u_x" })).toEqual({ locale: "ar", dir: "rtl" });
    expect(t.db.query("select locale from i18n__prefs where subject = 'user:u_x'")).toEqual([{ locale: "ar" }]);
    // A function route has no page session: nothing to store it for.
    expect(await t.service("i18n").setLocale("ar")).toEqual({ error: "no user and no page session to store it for" });
  });

  test("the language links: this page with ?lang=, the current one not a link", async () => {
    const html = (await t.as("links").page("/?lang=en&x=1")).html;
    expect(html).toContain('<a href="/?lang=ar&amp;x=1" lang="ar">العربية</a>');
    expect(html).toContain('<strong lang="en">English</strong>');
    expect(/<p id="digits"[^>]*>([^<]*)</u.exec(html)?.[1]).toBe("latn");
  });

  test("digits = auto (#266): Arabic digits when the choice asked for them, Latin otherwise; numbers, money, dates", async () => {
    const price = (h: string) => /<p id="price"[^>]*>([^<]*)</u.exec(h)?.[1];
    const number = (h: string) => /<p id="number"[^>]*>([^<]*)</u.exec(h)?.[1];
    const date = (h: string) => /<p id="date"[^>]*>([^<]*)</u.exec(h)?.[1];
    // A choice made with -u-nu-arab: the page tag carries it, digits are Eastern Arabic.
    const arab = t.as("digits-arab");
    const a = (await arab.page("/?lang=ar-u-nu-arab")).html;
    expect(a).toContain('<html lang="ar-u-nu-arab" dir="rtl">');
    expect(number(a)).toBe("١٢٣٫٤٥");
    expect(price(a)).toMatch(/^١٬٢٣٤٫٥٠\u00a0د\.إ\.$/u);
    expect(date(a)).toMatch(/[٠-٩]/u);
    expect(date(a)).not.toMatch(/[0-9]/u);
    // Stored: the next page without ?lang= keeps the digits.
    expect(number((await arab.page("/")).html)).toBe("١٢٣٫٤٥");
    // Plain ar: Latin digits.
    const latn = (await t.as("digits-latn").page("/?lang=ar")).html;
    expect(latn).toContain('<html lang="ar" dir="rtl">');
    expect(number(latn)).toBe("123.45");
    // A user's stored choice with digits follows them (auto reads the row).
    const u = t.as("digits-user");
    await u.action("/auth/register", "default", { email: "d@example.com", password: "correct horse battery", display_name: "D" });
    await u.action("/auth/login", "default", { email: "d@example.com", password: "correct horse battery" });
    expect(await t.service("i18n").setLocale("ar-u-nu-arab", { user_id: t.db.query<{ id: string }>("select id from auth__public_users_v1 where email = 'd@example.com'")[0]?.id })).toEqual({ locale: "ar-u-nu-arab", dir: "rtl" });
    expect(number((await u.page("/")).html)).toBe("١٢٣٫٤٥");
  });
});
