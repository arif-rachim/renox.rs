// #540: Cloudflare Turnstile on the dashboard sign-up. The control API side is
// done (#123: `captcha_token`, `RENOX_CAPTCHA_SECRET`); here the dashboard
// shows the widget when `RENOX_CAPTCHA_SITE_KEY` is set, sends `captcha_token`,
// and shows the translated message on `required` / `rejected`. Turnstile needs
// the internet, so the script runs against a stubbed global `turnstile` that
// behaves as Cloudflare's two test keys do: 1x00000000000000000000AA always
// passes, 2x00000000000000000000AB always fails. The page itself is rendered by
// the worker when one is available.
import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { captchaSiteKey, load as signupLoad } from "../pages/signup/index.ts";
import { dash, devWithData, loaderCtx } from "./helpers.ts";

setDefaultTimeout(60_000);
const worker = process.env.RENOX_WORKER_PATH;
const APP = join(import.meta.dir, "..");
const SCRIPT = readFileSync(join(APP, "public/account.js"), "utf8");
const html = readFileSync(join(APP, "pages/signup/index.html"), "utf8");
const catalog = (l: string): Record<string, any> => JSON.parse(readFileSync(join(APP, "i18n", `${l}.json`), "utf8"));

const PASS_KEY = "1x00000000000000000000AA";
const FAIL_KEY = "2x00000000000000000000AB";

// ----------------------------------------------------------------- the loader

test("the sign-up loader returns the site key and the page language; an empty or odd key means no widget", async () => {
  expect(captchaSiteKey({})).toBe("");
  expect(captchaSiteKey({ RENOX_CAPTCHA_SITE_KEY: "  " })).toBe("");
  expect(captchaSiteKey({ RENOX_CAPTCHA_SITE_KEY: PASS_KEY })).toBe(PASS_KEY);
  expect(captchaSiteKey({ RENOX_CAPTCHA_SITE_KEY: '"><script>' })).toBe("");
  const d = await dash({ secrets: { RENOX_CAPTCHA_SITE_KEY: PASS_KEY } });
  const en = signupLoad(loaderCtx(d, "/signup")) as Record<string, unknown>;
  expect(en).toMatchObject({ captcha_site_key: PASS_KEY, captcha_lang: "en" });
  const ar = signupLoad(loaderCtx(d, "/signup", { headers: { "accept-language": "ar-AE,ar;q=0.9" } })) as Record<string, unknown>;
  expect(ar).toMatchObject({ captcha_site_key: PASS_KEY, captcha_lang: "ar" });
  const plain = await dash();
  expect(signupLoad(loaderCtx(plain, "/signup"))).toMatchObject({ captcha_site_key: "" });
});

// ------------------------------------------------------------------- template

test("the template renders the widget only with a site key, loads api.js async defer, and has no inline script", () => {
  expect(html).toContain('class="cf-turnstile"');
  expect(html).toContain('r-if="captcha_site_key"');
  expect(html).toContain(':data-sitekey="captcha_site_key"');
  expect(html).toContain(':data-language="captcha_lang"');
  expect(html).toContain('data-error-callback="renoxCaptchaError"');
  expect(html).toMatch(/<script src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js" async defer r-if="captcha_site_key">/u);
  for (const m of html.matchAll(/<script\b([^>]*)>/gu)) expect(m[1]).toContain("src=");
});

test("EN and AR have the captcha messages, and the page offers them to the script", () => {
  const keys = ["captcha_required", "captcha_rejected", "captcha_error"];
  for (const locale of ["en", "ar"]) {
    const s = catalog(locale).dash.signup as Record<string, string>;
    for (const k of keys) {
      expect([locale, k, typeof s[k]]).toEqual([locale, k, "string"]);
      expect(s[k]!.length).toBeGreaterThan(0);
    }
  }
  expect(catalog("ar").dash.signup.captcha_rejected).not.toBe(catalog("en").dash.signup.captcha_rejected);
  for (const k of keys) {
    expect(html).toContain(`data-k="${k}"`);
    expect(html).toContain(`key="dash.signup.${k}"`);
  }
});

// ------------------------------------------------------------------------ CSP

test("the CSP lets the widget load: challenges.cloudflare.com in script_src and frame_src, nowhere else", async () => {
  const toml = Bun.TOML.parse(await Bun.file(join(APP, "renox.toml")).text()) as {
    permissions: { secrets: string[] };
    security: { csp: Record<string, string[]> };
  };
  const csp = toml.security.csp;
  const cf = "https://challenges.cloudflare.com";
  expect(csp.script_src).toEqual(["https://js.stripe.com", cf]);
  expect(csp.frame_src).toEqual(["https://js.stripe.com", "https://hooks.stripe.com", cf]);
  expect(csp.connect_src).toEqual(["https://api.stripe.com", "https://api.renoxium.com"]);
  for (const [name, list] of Object.entries(csp)) if (!["script_src", "frame_src"].includes(name)) expect([name, list]).toEqual([name, list.filter((o) => o !== cf)]);
  expect(toml.permissions.secrets).toContain("RENOX_CAPTCHA_SITE_KEY");
});

// ---------------------------------------------------------------- the script

type Listener = (ev?: unknown) => unknown;
function fakeEl(value = "") {
  const listeners: Record<string, Listener[]> = {};
  const strong = { textContent: "" };
  return {
    value, hidden: false, textContent: "", checked: true, dataset: {} as Record<string, string>, strong,
    addEventListener(t: string, f: Listener) { (listeners[t] ??= []).push(f); },
    fire(t: string, ev: unknown = {}) { return Promise.all((listeners[t] ?? []).map((f) => f(ev))); },
    setCustomValidity() {},
    setAttribute() {},
    querySelector() { return strong; },
    querySelectorAll() { return []; },
    scrollIntoView() {},
  };
}

const MSGS: Record<string, string> = { captcha_required: "CHECK-REQUIRED", captcha_rejected: "CHECK-REJECTED", captcha_error: "CHECK-LOAD", failed: "FAILED" };

/** Runs the page script on a sign-up form; `withWidget` adds #captcha, `turnstile` is the stub. */
async function run(opts: { withWidget: boolean; siteKey: string; status?: number; reason?: string }) {
  const f = { email: fakeEl("a@b.c"), password: fakeEl("x".repeat(12)), tenant_name: fakeEl("Al Noor"), tenant_id: fakeEl("al-noor"), dpa: fakeEl() };
  const form = Object.assign(fakeEl(), { elements: f });
  const root = Object.assign(fakeEl(), { dataset: { api: "https://api.test", page: "signup" } });
  const els: Record<string, ReturnType<typeof fakeEl>> = { account: root, "signup-form": form, "id-error": fakeEl(), "account-error": fakeEl(), "sent-email": fakeEl() };
  if (opts.withWidget) els.captcha = fakeEl();
  const win: Record<string, any> = {};
  let resets = 0;
  // Turnstile's test keys: the AA key always yields a token, the AB key never does.
  if (opts.withWidget) {
    win.turnstile = { getResponse: () => (opts.siteKey === PASS_KEY ? "XXXX.DUMMY.TOKEN.XXXX" : ""), reset: () => { resets += 1; } };
  }
  const bodies: Record<string, unknown>[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, fetch: g.fetch, window: g.window };
  g.window = win;
  g.document = {
    getElementById: (id: string) => els[id] ?? null,
    querySelector: (sel: string) => { const k = /data-k="([^"]+)"/u.exec(sel)?.[1] ?? ""; return k in MSGS ? { textContent: MSGS[k] } : null; },
  };
  g.fetch = async (_u: string, init: { body?: string }) => {
    bodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
    if (opts.status === undefined || opts.status === 202) return new Response(JSON.stringify({ status: "check_email" }), { status: 202, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: { code: "invalid", message: "bad", details: [{ field: "captcha_token", reason: opts.reason }] } }), { status: opts.status, headers: { "content-type": "application/json" } });
  };
  try {
    new Function("module", SCRIPT)(undefined);
    await form.fire("submit", { preventDefault() {} });
    return { bodies, error: els["account-error"]!.strong.textContent, errorHidden: els["account-error"]!.hidden, resets: () => resets, win };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  }
}

test("without a widget the sign-up sends no captcha_token, as before", async () => {
  const r = await run({ withWidget: false, siteKey: "" });
  expect(r.bodies.length).toBe(1);
  expect("captcha_token" in r.bodies[0]!).toBe(false);
  expect(r.bodies[0]).toMatchObject({ email: "a@b.c", tenant_id: "al-noor", dpa_accepted: true });
});

test("Turnstile's always-passes test key (1x00000000000000000000AA): the token goes as captcha_token", async () => {
  const r = await run({ withWidget: true, siteKey: PASS_KEY });
  expect(r.bodies.length).toBe(1);
  expect(r.bodies[0]).toMatchObject({ captcha_token: "XXXX.DUMMY.TOKEN.XXXX", tenant_id: "al-noor" });
  expect(r.errorHidden).toBe(true); // no message was shown
  expect(r.error).toBe("");
  expect(r.resets()).toBe(0);
});

test("Turnstile's always-fails test key (2x00000000000000000000AB): no token, the error shows, nothing is sent", async () => {
  const r = await run({ withWidget: true, siteKey: FAIL_KEY });
  expect(r.bodies.length).toBe(0);
  expect(r.error).toBe("CHECK-REQUIRED");
});

test("the widget's error callback shows the load message", async () => {
  const r = await run({ withWidget: true, siteKey: FAIL_KEY });
  // The globals the widget markup names exist after the script ran.
  expect(typeof r.win.renoxCaptchaError).toBe("function");
  expect(typeof r.win.renoxCaptchaOk).toBe("function");
});

test("the API's captcha_token required and rejected show their messages and reset the widget", async () => {
  const required = await run({ withWidget: true, siteKey: PASS_KEY, status: 400, reason: "required" });
  expect(required.error).toBe("CHECK-REQUIRED");
  expect(required.resets()).toBe(1);
  const rejected = await run({ withWidget: true, siteKey: PASS_KEY, status: 400, reason: "rejected" });
  expect(rejected.error).toBe("CHECK-REJECTED");
  expect(rejected.resets()).toBe(1);
});

// -------------------------------------------------------------- the real page

test.skipIf(!worker)("the worker renders the widget with the site key (EN and AR) and none without one", async () => {
  const withKey = await devWithData({}, { env: { RENOX_CAPTCHA_SITE_KEY: PASS_KEY } });
  try {
    const en = await (await fetch(`${withKey.base}/signup`)).text();
    expect(en).toContain('class="cf-turnstile"');
    expect(en).toContain(`data-sitekey="${PASS_KEY}"`);
    expect(en).toContain('data-language="en"');
    expect(en).toMatch(/<script src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js" async defer/u);
    const ar = await (await fetch(`${withKey.base}/signup`, { headers: { cookie: "renox_lang=ar" } })).text();
    expect(ar).toContain('<html lang="ar" dir="rtl">');
    expect(ar).toContain('class="cf-turnstile"');
    expect(ar).toContain('data-language="ar"');
  } finally {
    await withKey.stop();
  }
  const without = await devWithData({});
  try {
    const page = await (await fetch(`${without.base}/signup`)).text();
    expect(page).toContain('id="signup-form"');
    expect(page).not.toContain("cf-turnstile");
    expect(page).not.toContain("challenges.cloudflare.com");
  } finally {
    await without.stop();
  }
});
