// auth's pages in Arabic (#244; docs/08-template-engine.md, RTL;
// docs/21-uae-gcc-strategy.md): login, register and account with
// `?lang=ar` render `<html lang="ar" dir="rtl">` and the Arabic catalog,
// snapshotted; the choice is stored (per page session signed out, per
// user signed in), so the next page stays Arabic without `?lang=`.
// #336: then every page of the module in `en` (ltr) and `ar` (rtl),
// snapshotted, with no English message of its keys left.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { bothDirections, stableIds } from "../../i18n/tests/rtl.ts";
import { app, snapshot, type TestApp } from "../../../sdk/src/test.ts";
import { challengeOf } from "../lib/agents.ts";

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

/** The per-request values of the auth pages: WebAuthn challenges and user handles, agent client ids. */
const stableAuth = (html: string): string =>
  stableIds(stable(html))
    .replace(/(&quot;|")(challenge|id|user_id)(&quot;|"):(&quot;|")[A-Za-z0-9_-]{8,}(&quot;|")/gu, "$1$2$3:$4<random>$5")
    .replace(/(client_id(?:=|" value="))[A-Za-z0-9_-]+/gu, "$1<client>");

describe.skipIf(!worker)("every auth page in both directions (#336)", () => {
  test("en (ltr) and ar (rtl), snapshotted, no English left", async () => {
    const visitor = t.as("rtl-visitor");
    const user = t.as("rtl-user");
    await user.action("/auth/register", "default", { email: "rtl@example.com", password: "correct horse battery", display_name: "Rtl" });
    expect((await user.action("/auth/login", "default", { email: "rtl@example.com", password: "correct horse battery" })).status).toBe(303);
    const reg = await t.request("POST", "/auth/oauth/register", { body: { client_name: "Test Agent", redirect_uris: ["https://agent.example/callback"] } });
    const clientId = reg.json<{ client_id: string }>().client_id;
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://agent.example/callback", state: "s1", code_challenge: await challengeOf("v".repeat(43)), code_challenge_method: "S256", scope: "tools:*" });
    const consent = (await user.request("GET", `/auth/oauth/authorize?${q}`)).headers.get("location") as string;
    expect(consent).toStartWith("/auth/oauth/consent?");
    await bothDirections(
      MODULE,
      [
        { name: "page login", path: "/auth/login", as: visitor, template: "pages/login.html", arabic: "<h1>تسجيل الدخول</h1>" },
        { name: "page register", path: "/auth/register", as: visitor, template: "pages/register.html" },
        { name: "page magic", path: "/auth/magic", as: visitor, template: "pages/magic/index.html" },
        { name: "page reset", path: "/auth/reset", as: visitor, template: "pages/reset/index.html" },
        { name: "page reset confirm", path: "/auth/reset/confirm?token=t0k3n", as: visitor, template: "pages/reset/confirm.html" },
        { name: "page phone", path: "/auth/phone", as: visitor, template: "pages/phone/index.html" },
        { name: "page phone verify", path: "/auth/phone/verify?phone=%2B971501234567", as: visitor, template: "pages/phone/verify.html" },
        { name: "page passkey login", path: "/auth/passkeys/login", as: visitor, template: "pages/passkeys/login.html" },
        { name: "page account", path: "/auth/account", as: user, template: "pages/account.html" },
        { name: "page passkey register", path: "/auth/passkeys/register", as: user, template: "pages/passkeys/register.html" },
        { name: "page consent", path: consent, as: user, template: "pages/oauth/consent.html", arabic: "كل أدوات هذا التطبيق، باسمك" },
      ],
      stableAuth,
    );
  });
});
