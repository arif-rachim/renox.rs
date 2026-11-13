// The account pages in a real browser (#445, #446): Chromium (Playwright)
// on the dashboard rendered by the real worker (`renox dev`), talking to the
// real control API served on localhost, as public/account.js does in
// production (ADR D23: the browser signs in against the API directly).
//
// One hop cannot run here: the dashboard's server-side check of the token it
// receives (`GET /v1/apps` through tenant `fetch`), because the worker refuses
// loopback for every tenant. The test catches the browser's POST to /signin
// instead and checks that token against the API itself: valid, one day, the
// role's dashboard scopes (lib/scopes.ts), never `tokens:write`.
//
// The page's CSP is bypassed: the manifest allows only https origins in
// `connect-src`, and the local API is plain http. A test below checks that the
// production CSP names the production API.
//
// Skipped without RENOX_WORKER_PATH or without Playwright; under RENOX_JOURNEY=1
// (journey.yml) it fails instead.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

import { totp } from "../../../sdk/src/totp.ts";
import { assertScoped, harness, PASSWORD, signup, type Harness } from "../../api/tests/helpers.ts";
import { GRANTABLE_SCOPES, ROLE_GRANTABLE, ROLE_SCOPES } from "../lib/scopes.ts";
import { devWithData } from "./helpers.ts";
import { journeyMissing, loadPlaywright, type PwBrowser } from "./playwright.ts";

setDefaultTimeout(120_000);

const worker = process.env.RENOX_WORKER_PATH;
const pw = loadPlaywright();
const skip = !worker || pw === null;
// Under RENOX_JOURNEY=1 the file fails instead of skipping (#586).
const missing = journeyMissing(pw, worker);
if (missing !== null) test("the browser tests can run (RENOX_JOURNEY=1)", () => {
  throw new Error(missing ?? "");
});

let h: Harness;
let api: ReturnType<typeof Bun.serve>;
let dev: { base: string; stop: () => Promise<void> };
let browser: PwBrowser;

beforeAll(async () => {
  if (skip) return;
  h = await harness();
  // The whole flow runs on the harness clock: the API's sessions and the TOTP codes agree.
  api = Bun.serve({ hostname: "localhost", port: 0, fetch: (req, srv) => h.app.fetch(req, srv) });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const apiUrl = `http://localhost:${api.port}`;
  (h.deps.config as { dashboardUrl: string }).dashboardUrl = `http://localhost:${port}`;
  // #446: /device and /account/tokens only check the dashboard sign-in, which
  // needs the server-side hop the worker refuses here; their loaders are
  // stubbed with what the real loader returns. Every other page is live.
  const frame = { signed_in: true, impersonation: null, api_host: new URL(apiUrl).host, ops_on: false, nav: "tokens" };
  const grantable_json = JSON.stringify(ROLE_GRANTABLE);
  dev = await devWithData(
    {
      "pages/device.ts": { ...frame, api: apiUrl, code: "", grantable_json, signin_href: "/signin?next=%2Fdevice" },
      "pages/account/tokens.ts": { ...frame, api: apiUrl, grantable_json },
    },
    { port, env: { RENOX_API_URL: apiUrl } },
  );
  browser = await pw!.chromium.launch();
});

afterAll(async () => {
  if (skip) return;
  await browser?.close();
  await dev?.stop();
  api?.stop(true);
  assertScoped();
});

/** A fresh browser context whose POST to /signin is caught; resolves with the token it carried. */
async function page() {
  // The manifest's CSP allows only https origins in connect-src (production names
  // https://api.renoxium.com, tests/scopes.test.ts); the local API is plain http.
  const ctx = await browser.newContext({ bypassCSP: true });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  let resolve: (token: string) => void = () => {};
  const posted = new Promise<string>((r) => {
    resolve = r;
  });
  await p.route("**/signin", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    resolve(new URLSearchParams(req.postData() ?? "").get("token") ?? "");
    return route.fulfill({ status: 200, contentType: "text/html", body: "<p>signed in</p>" });
  });
  return { p, ctx, errors, posted };
}

/** The token reached /signin: valid at the API, one day, the role's dashboard scopes. */
async function expectDashboardToken(token: string, role: keyof typeof ROLE_SCOPES): Promise<void> {
  expect(token).toMatch(/^renox_pat_[a-z2-7]{32}$/u);
  expect((await h.request("GET", "/v1/apps", { token })).status).toBe(200);
  const [row] = await h.db.query<{ name: string; scopes: string[]; created_at: unknown; expires_at: unknown }>(
    "select name, scopes, created_at, expires_at from tokens order by created_at desc limit 1",
  );
  expect(row?.name).toBe("dashboard");
  expect([...(row?.scopes ?? [])].sort()).toEqual([...ROLE_SCOPES[role]].sort());
  expect(Number(row?.expires_at) - Number(row?.created_at)).toBe(86_400_000);
}

const code = (secret: string) => totp(secret, h.clock.now / 1000);

describe.skipIf(skip)("account pages in Chromium", () => {
  test("sign up, verify from the mail, and land signed in: no detour through the CLI", async () => {
    const { p, ctx, errors, posted } = await page();
    await p.goto(`${dev.base}/signup`);
    await p.fill('#signup-form [name="email"]', "new@example.test");
    await p.fill('#signup-form [name="password"]', PASSWORD);
    // #488: the workspace name is required and comes first; the id is derived from it.
    await p.fill('#signup-form [name="tenant_name"]', "T Browser");
    expect(await p.inputValue('#signup-form [name="tenant_id"]')).toBe("t-browser");
    await p.fill('#signup-form [name="tenant_id"]', "t-browser");
    await p.check('#signup-form [name="dpa"]');
    await p.click('#signup-form button[type="submit"]');
    await p.waitForSelector("#signup-sent:not([hidden])");
    expect(await p.textContent("#sent-email")).toBe("new@example.test");
    const mail = h.mailer.last("new@example.test", "verify_email")?.text ?? "";
    const link = /\/signup\/verify#token=([a-z2-7]{32})/u.exec(mail);
    expect(link).not.toBeNull();
    await p.goto(`${dev.base}/signup/verify#token=${link?.[1]}`);
    await expectDashboardToken(await posted, "owner");
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test("password sign-in: a wrong password is named; the right one signs in", async () => {
    await signup(h, "pw@example.test", "t-pw");
    const { p, ctx, errors, posted } = await page();
    await p.goto(`${dev.base}/signin`);
    await p.fill('#password-form [name="email"]', "pw@example.test");
    await p.fill('#password-form [name="password"]', "not the password");
    await p.click('#password-form button[type="submit"]');
    await p.waitForSelector("#account-error:not([hidden])");
    expect(await p.textContent("#account-error")).toContain("Wrong email or password");
    await p.fill('#password-form [name="password"]', PASSWORD);
    await p.click('#password-form button[type="submit"]');
    await expectDashboardToken(await posted, "owner");
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test("an account with an authenticator app: a wrong code is refused, the right code signs in; a recovery code works too", async () => {
    const s = await signup(h, "mfa@example.test", "t-mfa");
    const start = await h.request("POST", "/v1/account/mfa/totp", { session: s, json: {} });
    const { secret } = (await start.json()) as { secret: string };
    const confirmed = await h.request("POST", "/v1/account/mfa/totp/confirm", { session: s, json: { code: await code(secret) } });
    const { recovery_codes } = (await confirmed.json()) as { recovery_codes: string[] };
    h.clock.now += 60_000; // the confirm used this step's code

    const { p, ctx, errors, posted } = await page();
    await p.goto(`${dev.base}/signin`);
    await p.fill('#password-form [name="email"]', "mfa@example.test");
    await p.fill('#password-form [name="password"]', PASSWORD);
    await p.click('#password-form button[type="submit"]');
    await p.waitForSelector("#mfa-verify:not([hidden])");
    await p.fill('#mfa-verify [name="code"]', "000000");
    await p.click('#mfa-verify button[type="submit"]');
    await p.waitForSelector("#account-error:not([hidden])");
    expect(await p.textContent("#account-error")).toContain("code is wrong");
    await p.fill('#mfa-verify [name="code"]', await code(secret));
    await p.click('#mfa-verify button[type="submit"]');
    await expectDashboardToken(await posted, "owner");
    expect(errors).toEqual([]);
    await ctx.close();

    const second = await page();
    await second.p.goto(`${dev.base}/signin`);
    await second.p.fill('#password-form [name="email"]', "mfa@example.test");
    await second.p.fill('#password-form [name="password"]', PASSWORD);
    await second.p.click('#password-form button[type="submit"]');
    await second.p.waitForSelector("#mfa-verify:not([hidden])");
    await second.p.fill('#mfa-verify [name="code"]', recovery_codes[0] as string);
    await second.p.click('#mfa-verify button[type="submit"]');
    await expectDashboardToken(await second.posted, "owner");
    await second.ctx.close();
  });

  test("an owner past the grace period without a factor sets one up in the page, sees the recovery codes, then is signed in", async () => {
    await signup(h, "late@example.test", "t-late");
    h.clock.now += 15 * 86_400_000; // MFA_GRACE_DAYS is 14
    const { p, ctx, errors, posted } = await page();
    await p.goto(`${dev.base}/signin`);
    await p.fill('#password-form [name="email"]', "late@example.test");
    await p.fill('#password-form [name="password"]', PASSWORD);
    await p.click('#password-form button[type="submit"]');
    await p.waitForSelector("#mfa-enrol:not([hidden])");
    const secret = (await p.textContent("#totp-secret")) ?? "";
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/u);
    expect(await p.getAttribute("#totp-uri", "href")).toStartWith("otpauth://totp/");
    await p.fill('#mfa-enrol [name="code"]', await code(secret));
    await p.click('#mfa-enrol button[type="submit"]');
    await p.waitForSelector("#recovery:not([hidden])");
    expect(await p.locator("#recovery-list li").count()).toBeGreaterThan(5);
    await p.click("#recovery-done");
    await expectDashboardToken(await posted, "owner");
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test("forgot password: the mail's link sets a new password; the old one stops working", async () => {
    await signup(h, "forgot@example.test", "t-forgot");
    const { p, ctx, errors } = await page();
    await p.goto(`${dev.base}/signin`);
    await p.click('a[href="/forgot-password"]');
    await p.fill('#forgot-form [name="email"]', "forgot@example.test");
    await p.click('#forgot-form button[type="submit"]');
    await p.waitForSelector("#forgot-sent:not([hidden])");
    const mail = h.mailer.last("forgot@example.test", "password_reset")?.text ?? "";
    const link = /\/reset-password#token=([a-z2-7]{32})/u.exec(mail);
    expect(link).not.toBeNull();
    await p.goto(`${dev.base}/reset-password#token=${link?.[1]}`);
    expect(p.url()).not.toContain("token="); // the fragment is dropped at once
    await p.fill('#reset-form [name="password"]', "a brand new password");
    await p.fill('#reset-form [name="again"]', "a different password");
    await p.click('#reset-form button[type="submit"]');
    await p.waitForSelector("#account-error:not([hidden])");
    await p.fill('#reset-form [name="again"]', "a brand new password");
    await p.click('#reset-form button[type="submit"]');
    await p.waitForSelector("#reset-done:not([hidden])");
    expect((await h.request("POST", "/v1/account/login", { json: { email: "forgot@example.test", password: PASSWORD } })).status).toBe(401);
    expect((await h.request("POST", "/v1/account/login", { json: { email: "forgot@example.test", password: "a brand new password" } })).status).toBe(200);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});

// #446: /device and /account/tokens (loaders stubbed above); the browser's API
// session comes from a real password sign-in on /signin.
describe.skipIf(skip)("device approval and tokens in Chromium", () => {
  const pages = { get base() {
    return dev.base;
  } };

  /** A browser context signed in to the API with the password (its POST to /signin caught). */
  async function signedInPage(email: string, tenant: string) {
    await signup(h, email, tenant);
    const s = await page();
    await s.p.goto(`${pages.base}/signin`);
    await s.p.fill('#password-form [name="email"]', email);
    await s.p.fill('#password-form [name="password"]', PASSWORD);
    await s.p.click('#password-form button[type="submit"]');
    await s.posted;
    return s;
  }

  test("renox login: the device page shows the device's name and the scopes, Approve gives the CLI its token", async () => {
    const { login } = await import("../../../cli/src/commands/login.ts");
    const s = await signedInPage("cli@example.test", "t-cli");
    const lines: string[] = [];
    const io = { fetch: (u: string, i?: RequestInit) => fetch(u, i), sleep: (ms: number) => Bun.sleep(Math.min(ms, 200)), out: (l: string) => void lines.push(l), readStdin: async () => "", env: {} };
    const pending = login(`http://localhost:${api.port}`, io);
    await Bun.sleep(300);
    const url = /Open (\S+)/u.exec(lines[0] ?? "")?.[1] ?? "";
    expect(url).toMatch(/\/device\?code=[A-Z]{4}-[A-Z]{4}$/u);
    const code = new URL(url).searchParams.get("code") ?? "";
    await s.p.goto(`${pages.base}/device`);
    await s.p.fill('#device-code [name="code"]', code.toLowerCase());
    await s.p.click('#device-code button[type="submit"]');
    await s.p.waitForSelector("#device-request:not([hidden])");
    expect(await s.p.textContent("#device-user-code")).toBe(code);
    expect(await s.p.textContent("#device-name")).toStartWith("renox CLI on ");
    // Every grantable scope (13 since app:settings and app:people, #700), not a count written by hand.
    expect(await s.p.locator('#device-scopes input[name="scope"]').count()).toBe(GRANTABLE_SCOPES.length);
    expect(await s.p.isChecked('#device-scopes input[value="registry:publish"]')).toBe(true);
    await s.p.click('#device-scopes input[value="registry:publish"]');
    await s.p.click("#device-approve");
    await s.p.waitForSelector("#device-approved:not([hidden])");
    const creds = await pending;
    expect(creds.tenant_id).toBe("t-cli");
    expect((await h.request("GET", "/v1/apps", { token: creds.token })).status).toBe(200);
    const [row] = await h.db.query<{ scopes: string[] }>("select scopes from tokens where name like 'renox CLI on %' order by created_at desc limit 1");
    expect(row?.scopes).not.toContain("registry:publish");
    expect(row?.scopes).toContain("deploy");
    expect(s.errors).toEqual([]);
    await s.ctx.close();
  });

  test("Deny stops renox login at once with a user error", async () => {
    const { login } = await import("../../../cli/src/commands/login.ts");
    const s = await signedInPage("deny-cli@example.test", "t-deny-cli");
    const lines: string[] = [];
    const io = { fetch: (u: string, i?: RequestInit) => fetch(u, i), sleep: (ms: number) => Bun.sleep(Math.min(ms, 200)), out: (l: string) => void lines.push(l), readStdin: async () => "", env: {} };
    const pending = login(`http://localhost:${api.port}`, io).catch((e: unknown) => e as Error);
    await Bun.sleep(300);
    const code = new URL(/Open (\S+)/u.exec(lines[0] ?? "")?.[1] ?? "http://x").searchParams.get("code") ?? "";
    await s.p.goto(`${pages.base}/device`);
    await s.p.fill('#device-code [name="code"]', code);
    await s.p.click('#device-code button[type="submit"]');
    await s.p.waitForSelector("#device-request:not([hidden])");
    await s.p.click("#device-deny");
    await s.p.waitForSelector("#device-denied:not([hidden])");
    expect(((await pending) as Error).message).toBe("the login request was denied in the dashboard");
    await s.ctx.close();
  });

  test("Tokens: create shows the value once, the list shows it, revoke ends it", async () => {
    const s = await signedInPage("tok@example.test", "t-tok");
    await s.p.goto(`${pages.base}/account/tokens`);
    await s.p.waitForSelector("#token-create:not([hidden])");
    await s.p.fill('#token-create [name="name"]', "github-actions");
    await s.p.fill('#token-create [name="days"]', "7");
    await s.p.click('#token-create button[type="submit"]');
    await s.p.waitForSelector("#token-new:not([hidden])");
    const value = (await s.p.textContent("#token-value")) ?? "";
    expect(value).toMatch(/^renox_pat_[a-z2-7]{32}$/u);
    expect((await h.request("GET", "/v1/apps", { token: value })).status).toBe(200);
    await s.p.waitForSelector("#token-rows tr");
    expect(await s.p.textContent("#token-rows")).toContain("github-actions");
    const [row] = await h.db.query<{ id: string }>("select id from tokens where name = 'github-actions'");
    (s.p as unknown as { on(e: "dialog", f: (d: { accept(): Promise<void> }) => void): void }).on("dialog", (d) => void d.accept());
    await s.p.click(`#token-rows button[data-token="${row?.id}"]`);
    await s.p.waitForSelector("#account-notice:not([hidden])");
    expect((await h.request("GET", "/v1/apps", { token: value })).status).toBe(401);
    // Reloaded, the page never shows the value again.
    await s.p.goto(`${pages.base}/account/tokens`);
    await s.p.waitForSelector("#token-create:not([hidden])");
    expect(await s.p.textContent("body")).not.toContain(value);
    expect(s.errors).toEqual([]);
    await s.ctx.close();
  });
});
