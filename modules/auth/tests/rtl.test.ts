// auth's pages in Arabic (#244; docs/08-template-engine.md, RTL;
// docs/21-uae-gcc-strategy.md): login, register and account with
// `?lang=ar` render `<html lang="ar" dir="rtl">` and the Arabic catalog,
// snapshotted; the choice is stored (per page session signed out, per
// user signed in), so the next page stays Arabic without `?lang=`.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, snapshot, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

/** Session ids, timestamps and user agents vary: stable placeholders. */
const stable = (html: string): string => html.replace(/\b[0-9a-f]{32}\b/gu, "<id>").replace(/\b1[0-9]{9}\b/gu, "<time>");

describe.skipIf(!worker)("auth in Arabic", () => {
  test("login and register: lang=ar, dir=rtl, the Arabic catalog; the session keeps the choice", async () => {
    const visitor = t.as("visitor");
    const login = await visitor.page("/auth/login?lang=ar");
    expect(login.status).toBe(200);
    expect(login.html).toContain('<html lang="ar" dir="rtl">');
    expect(login.html).toContain("<h1>تسجيل الدخول</h1>");
    snapshot(stable(login.html), { role: "login ar" });
    // No ?lang= now: the page session's stored choice.
    const register = await visitor.page("/auth/register");
    expect(register.html).toContain('<html lang="ar" dir="rtl">');
    expect(register.html).toContain("<h1>إنشاء حساب</h1>");
    snapshot(stable(register.html), { role: "register ar" });
    // Another visitor, no choice: English.
    expect((await t.as("other").page("/auth/login")).html).toContain('<html lang="en" dir="ltr">');
    // Accept-Language decides when nothing is stored.
    expect((await t.as("accept").request("GET", "/auth/login", { headers: { "accept-language": "ar-AE,ar;q=0.9,en;q=0.5" } })).html).toContain('<html lang="ar" dir="rtl">');
  });

  test("account: the user's stored choice follows them to another browser", async () => {
    const amal = t.as("amal");
    await amal.action("/auth/register", "default", { email: "amal@example.com", password: "correct horse battery", display_name: "Amal" });
    expect((await amal.action("/auth/login", "default", { email: "amal@example.com", password: "correct horse battery" })).status).toBe(303);
    const account = await amal.page("/auth/account?lang=ar");
    expect(account.html).toContain('<html lang="ar" dir="rtl">');
    expect(account.html).toContain("<h2>الجلسات</h2>");
    snapshot(stable(account.html), { role: "account ar" });
    // Signed in from a new browser: Arabic from the user's preference.
    const phone = t.as("amal-phone");
    await phone.action("/auth/login", "default", { email: "amal@example.com", password: "correct horse battery" });
    expect((await phone.page("/auth/account")).html).toContain('<html lang="ar" dir="rtl">');
  });

  test("in both digit sets (#266): ar-u-nu-arab carries Eastern Arabic digits in the page tag", async () => {
    const v = t.as("digits-visitor");
    const arab = await v.page("/auth/login?lang=ar-u-nu-arab");
    expect(arab.html).toContain('<html lang="ar-u-nu-arab" dir="rtl">');
    expect(arab.html).toContain("<h1>تسجيل الدخول</h1>");
    snapshot(stable(arab.html), { role: "login ar-u-nu-arab" });
    const latn = await t.as("digits-latn").page("/auth/login?lang=ar-u-nu-latn");
    expect(latn.html).toContain('<html lang="ar" dir="rtl">');
    snapshot(stable(latn.html), { role: "login ar latn" });
  });
});
