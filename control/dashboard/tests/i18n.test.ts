// #336: the dashboard in English and Arabic. The catalogs (i18n/en.json,
// i18n/ar.json) have the same keys and every Arabic message is Arabic; the
// locale choice of lib/locale.ts; and pages rendered in Arabic by the worker
// (`renox dev`, as the other render tests do: templates are compiled and
// rendered only by `renox-worker`), with `<html lang="ar" dir="rtl">` and no
// English message of the template's keys left. The strings built in
// TypeScript (lib/i18n.ts): a notice, a form error, a problem message,
// `ago()` with the Arabic plural forms, and the deployment state labels.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Deployment } from "../lib/api.ts";
import type { LoaderContext } from "renox";

import { createApp_, scopedToken, tenant } from "../../api/tests/helpers.ts";
import { problem } from "../lib/guard.ts";
import { EN, format, pluralCategory, translator } from "../lib/i18n.ts";
import { acceptLocale, applyLocale, chooseLocale, cookieLocale } from "../lib/locale.ts";
import { ago, deploymentRows, stateLabel } from "../lib/view.ts";
import { actions as secretsActions } from "../pages/apps/[app]/secrets.ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actionCtx, dash, devWithData } from "./helpers.ts";

const worker = process.env.RENOX_WORKER_PATH;
const APP = join(import.meta.dir, "..");

type Catalog = { [k: string]: string | Catalog };

function flatten(c: Catalog, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(c)) {
    if (prefix === "" && k === "_meta") continue;
    const key = prefix === "" ? k : `${prefix}.${k}`;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv);
  }
  return out;
}

const catalog = (locale: string): Map<string, string> => flatten(JSON.parse(readFileSync(join(APP, "i18n", `${locale}.json`), "utf8")) as Catalog);
const en = catalog("en");
const ar = catalog("ar");
const ARABIC = /[؀-ۿ]/u;

/** The catalog keys a template uses: `<r-t key>` and `'key' | t`. */
function keysOf(file: string): string[] {
  const src = readFileSync(join(APP, file), "utf8");
  return [...src.matchAll(/key="(dash\.[a-z0-9_.]+)"|'(dash\.[a-z0-9_.]+)'/gu)].map((m) => (m[1] ?? m[2]) as string);
}

/** HTML text escaping as the renderer writes a message. */
const escaped = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** English messages (of more than one word) of `files`' keys found in `html`. */
function englishLeft(html: string, files: string[]): string[] {
  const keys = new Set(files.flatMap(keysOf));
  return [...keys].flatMap((k) => {
    const message = en.get(k) ?? "";
    // Only plain text: a message with arguments renders with them filled in.
    if (!message.includes(" ") || message.includes("{")) return [];
    return html.includes(escaped(message)) ? [`${k}: ${message}`] : [];
  });
}

test("en.json and ar.json have the same keys; every Arabic message is Arabic", () => {
  expect(en.size).toBeGreaterThan(300);
  expect([...ar.keys()].sort()).toEqual([...en.keys()].sort());
  const notArabic = [...ar].filter(([, v]) => v.trim() === "" || !ARABIC.test(v)).map(([k]) => k);
  expect(notArabic).toEqual([]);
  // The same arguments on both sides.
  // `{name}` and the number of a `{n, plural, …}` (#336: Arabic plural forms where English has one).
  const args = (s: string) => [...new Set([...s.matchAll(/\{([a-z_]+)(?:\}|,)/gu)].map((m) => m[1]))].sort();
  const mismatched = [...en].filter(([k, v]) => JSON.stringify(args(v)) !== JSON.stringify(args(ar.get(k) ?? ""))).map(([k]) => k);
  expect(mismatched).toEqual([]);
  // Every key a template uses has a message.
  const templates = [
    "pages/_layouts/main.html", "pages/_404.html", "pages/_error.html", "pages/index.html", "pages/signin.html", "pages/signup/index.html", "pages/signup/verify.html",
    "pages/legal/dpa.html", "pages/legal/terms.html", "pages/apps/index.html", "pages/apps/new.html", "pages/apps/[app]/index.html", "pages/apps/[app]/deployments.html",
    "pages/apps/[app]/logs.html", "pages/apps/[app]/client-errors.html", "pages/apps/[app]/usage.html", "pages/apps/[app]/secrets.html", "pages/apps/[app]/database.html",
    "pages/apps/[app]/settings.html", "pages/apps/[app]/modules/index.html", "pages/billing/index.html", "pages/account/security.html", "pages/ops/registry/index.html",
    "pages/ops/tenants/[tenant].html", "partials/app-nav.html", "partials/deployment-actions.html", "partials/log-rows.html", "partials/problem.html",
  ];
  expect(templates.flatMap(keysOf).filter((k) => !en.has(k))).toEqual([]);
});

const ctxFor = (path: string, headers: Record<string, string> = {}, fragment: string | null = null) => {
  const req = new Request(`https://dashboard.renox.test${path}`, { headers });
  const set: [string, string | undefined][] = [];
  const ctx = { req, url: new URL(req.url), headers: req.headers, fragment, setLocale: (l: string, d?: "ltr" | "rtl") => void set.push([l, d]) } as unknown as LoaderContext;
  return { ctx, set };
};

test("the locale: ?lang=, then the cookie, then Accept-Language, then English", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  expect(chooseLocale(new URL("https://d.test/apps?lang=ar"), h({ cookie: "renox_lang=en" }))).toEqual({ locale: "ar", fromQuery: true });
  expect(chooseLocale(new URL("https://d.test/apps?lang=fr"), h({ cookie: "a=1; renox_lang=ar" }))).toEqual({ locale: "ar", fromQuery: false });
  expect(chooseLocale(new URL("https://d.test/apps"), h({ "accept-language": "fr-FR, ar-AE;q=0.8, en;q=0.5" }))).toEqual({ locale: "ar", fromQuery: false });
  expect(chooseLocale(new URL("https://d.test/apps"), h({ "accept-language": "de, fr" }))).toEqual({ locale: "en", fromQuery: false });
  expect(acceptLocale("en;q=0.2, ar;q=0.9")).toBe("ar");
  expect(acceptLocale("ar;q=0, en")).toBe("en");
  expect(cookieLocale(h({ cookie: "renox_lang=xx" }))).toBeNull();

  // A full-page GET with ?lang= keeps the choice in a cookie and drops `lang`.
  const a = ctxFor("/apps/shop/logs?level=warn&lang=ar");
  const r = applyLocale(a.ctx);
  expect(a.set).toEqual([["ar", "rtl"]]);
  expect(r?.status).toBe(303);
  expect(r?.headers.get("location")).toBe("/apps/shop/logs?level=warn");
  expect(r?.headers.get("set-cookie")).toBe("renox_lang=ar; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  // A fragment request renders in place; without ?lang= nothing is redirected.
  expect(applyLocale(ctxFor("/apps?lang=ar", {}, "page").ctx)).toBeNull();
  const b = ctxFor("/apps", { cookie: "renox_lang=ar" });
  expect(applyLocale(b.ctx)).toBeNull();
  expect(b.set).toEqual([["ar", "rtl"]]);
  const c = ctxFor("/apps");
  expect(applyLocale(c.ctx)).toBeNull();
  expect(c.set).toEqual([["en", "ltr"]]);
});

test("messages built in TypeScript: the ICU subset and the Arabic plural categories", () => {
  // CLDR: ar has zero, one, two, few (3-10), many (11-99), other (100-102, ...).
  expect([0, 1, 2, 3, 10, 11, 99, 100, 102, 103].map((n) => pluralCategory(n, "ar"))).toEqual(["zero", "one", "two", "few", "few", "many", "many", "other", "other", "few"]);
  expect([0, 1, 2].map((n) => pluralCategory(n, "en"))).toEqual(["other", "one", "other"]);
  const m = "{n, plural, =0 {none} one {# item} other {# items}} for {who}";
  expect(format(m, { n: 0, who: "Amal" }, "en")).toBe("none for Amal");
  expect(format(m, { n: 1, who: "Amal" }, "en")).toBe("1 item for Amal");
  expect(format(m, { n: 7, who: "Amal" }, "en")).toBe("7 items for Amal");
  // A missing argument stays visible; a key missing everywhere renders the key.
  expect(format("{a} and {b}", { a: 1 }, "en")).toBe("1 and {b}");
  expect(EN("dash.no.such.key")).toBe("dash.no.such.key");
});

test("ago() and the state labels in Arabic, English unchanged", () => {
  const AR = translator("ar");
  const now = Date.parse("2026-10-31T12:00:00Z");
  const before = (s: number) => now - s * 1000;
  expect([before(12), before(180), before(5 * 3600), before(2 * 86_400)].map((t) => ago(t, now))).toEqual(["12s ago", "3m ago", "5h ago", "2d ago"]);
  expect(ago(before(0), now, AR)).toBe("الآن");
  expect(ago(before(1), now, AR)).toBe("منذ ثانية");
  expect(ago(before(60), now, AR)).toBe("منذ دقيقة");
  expect(ago(before(180), now, AR)).toBe("منذ 3 دقائق");
  expect(ago(before(2 * 3600), now, AR)).toBe("منذ ساعتين");
  expect(ago(before(11 * 86_400), now, AR)).toBe("منذ 11 يومًا");
  expect(ago(null, now, AR)).toBe("—");
  expect(stateLabel("active")).toBe("● live");
  expect(stateLabel("active", AR)).toBe("● يعمل");
  expect(stateLabel("rejected", AR)).toBe("✗ مرفوض");
  const d = (state: Deployment["state"], violations: number): Deployment =>
    ({ hash: "c".repeat(64), state, created_at: before(240), size_bytes: 2048, violations: Array.from({ length: violations }, () => ({ rule: "V1", reason: "x" })), last_error: null }) as unknown as Deployment;
  expect(deploymentRows([d("rejected", 3)], now)[0]).toMatchObject({ label: "✗ rejected", when: "4m ago", error: "3 violation(s)" });
  expect(deploymentRows([d("rejected", 3)], now, AR)[0]).toMatchObject({ label: "✗ مرفوض", when: "منذ 4 دقائق", error: "3 مخالفات" });
  expect(deploymentRows([d("rejected", 1)], now, AR)[0]?.error).toBe("مخالفة واحدة");
});

test("problem() in the request's locale: an unreachable API and a refused role", async () => {
  const ctx = (headers: Record<string, string>) => {
    const req = new Request("https://dashboard.renox.test/apps", { headers });
    return { req, url: new URL(req.url), headers: req.headers, secrets: {}, session: { id: "s" }, db: {} } as unknown as LoaderContext;
  };
  const failure = (status: number) => ({ ok: false as const, status, code: status === 0 ? "RENOX_UPSTREAM" : "RENOX_FORBIDDEN", message: "apps:write", requestId: null, details: [] });
  const AR = { cookie: "renox_lang=ar" };
  expect((await problem(ctx({}), failure(403))).message).toBe("Your token or role does not allow this (apps:write).");
  expect((await problem(ctx(AR), failure(403))).message).toBe("لا يسمح رمزك أو دورك بذلك (apps:write).");
  expect((await problem(ctx({ "accept-language": "ar-AE" }), failure(0))).message).toBe("تعذّر الوصول إلى واجهة التحكم البرمجية على api.renox.app (RENOX_UPSTREAM).");
});

test("a notice, a form error and a problem message of an action, in Arabic", async () => {
  const d = await dash();
  const owner = await tenant(d.h, "t_hello");
  await createApp_(d.h, owner, "hello");
  expect(await signinActions.default(actionCtx(d, "/signin", "default", { token: owner, next: "/apps" }))).toBeInstanceOf(Response);
  const AR = { params: { app: "hello" }, headers: { cookie: "renox_lang=ar" } };
  const VALUE = "sk_test_value_never_shown_0123456789";
  const set = (await secretsActions.set(actionCtx(d, "/apps/hello/secrets", "set", { name: "STRIPE_KEY", value: VALUE }, AR))) as { notice: string };
  expect(set.notice).toBe("حُفظ STRIPE_KEY (المجموعة v1). ويُستخدم بدءًا من النشر أو التراجع التالي.");
  const bad = (await secretsActions.set(actionCtx(d, "/apps/hello/secrets", "set", { name: "lower", value: VALUE }, AR))) as { form_error: string };
  expect(bad.form_error).toBe("يتكون اسم السر من أحرف لاتينية كبيرة وأرقام و_، ويبدأ بحرف (64 على الأكثر).");
  // English without the cookie, as before.
  expect(((await secretsActions.remove(actionCtx(d, "/apps/hello/secrets", "remove", { name: "STRIPE_KEY" }, { params: { app: "hello" } }))) as { notice: string }).notice).toContain("STRIPE_KEY deleted (set v2)");
  // A token that can only read: the API's 403, worded in Arabic.
  const reader = await scopedToken(d.h, "t_hello", ["apps:read", "secrets:read"]);
  expect(await signinActions.default(actionCtx(d, "/signin", "default", { token: reader, next: "/apps" }))).toBeInstanceOf(Response);
  const refused = (await secretsActions.set(actionCtx(d, "/apps/hello/secrets", "set", { name: "KEY", value: VALUE }, AR))) as { action_problem: { status: number; message: string } };
  expect(refused.action_problem.status).toBe(403);
  expect(refused.action_problem.message).toStartWith("لا يسمح رمزك أو دورك بذلك (");
}, 30_000);

test.skipIf(!worker)(
  "the worker renders the dashboard in Arabic: lang, dir, and no English left",
  async () => {
    const deployments = {
      signed_in: true,
      impersonation: null,
      api_host: "api.renox.app",
      app: "shop",
      section: "deployments",
      problem: null,
      action_problem: null,
      detail: null,
      detail_problem: null,
      // The rows as the loader builds them for an Arabic request (lib/view.ts).
      deployments: deploymentRows(
        [
          { hash: "a".repeat(64), state: "active", created_at: Date.now() - 3 * 3_600_000, size_bytes: 12_288, violations: [], last_error: null },
          { hash: "b".repeat(64), state: "superseded", created_at: Date.now() - 2 * 86_400_000, size_bytes: 12_288, violations: [], last_error: null },
        ] as unknown as Deployment[],
        Date.now(),
        translator("ar"),
      ).map((r) => ({ ...r, short: r.hash.slice(0, 12) })),
      notice: translator("ar")("dash.deploy.rolled_back", { short: "aaaaaaa" }),
    };
    const dev = await devWithData({ "pages/apps/[app]/deployments.ts": deployments });
    const AR = { cookie: "renox_lang=ar" };
    const get = async (path: string, headers: Record<string, string> = {}) => {
      const r = await fetch(`${dev.base}${path}`, { headers, redirect: "manual" });
      return { status: r.status, headers: r.headers, html: await r.text() };
    };
    try {
      // English by default, as before.
      const enPage = await get("/signin");
      expect(enPage.html).toContain('<html lang="en" dir="ltr">');
      expect(enPage.html).toContain("<h1>Sign in</h1>");

      // ?lang=ar: the redirect that stores the choice.
      const moved = await get("/signin?lang=ar&next=/apps/shop");
      expect(moved.status).toBe(303);
      expect(moved.headers.get("location")).toBe("/signin?next=%2Fapps%2Fshop");
      expect(moved.headers.get("set-cookie")).toContain("renox_lang=ar;");

      const layout = ["pages/_layouts/main.html"];
      const pages: [string, Record<string, string>, string[], string][] = [
        ["/signin", AR, ["pages/signin.html"], "<h1>تسجيل الدخول</h1>"],
        // Accept-Language alone chooses Arabic too.
        ["/signup", { "accept-language": "ar-AE,ar;q=0.9,en;q=0.5" }, ["pages/signup/index.html"], "أنشئ حسابك في Renox"],
        ["/legal/dpa", AR, ["pages/legal/dpa.html"], "اتفاقية معالجة البيانات"],
        ["/legal/terms", AR, ["pages/legal/terms.html"], "الإصدار 2026-10-30."],
        ["/apps/shop/deployments", AR, ["pages/apps/[app]/deployments.html", "partials/app-nav.html", "partials/deployment-actions.html"], "<h1>عمليات النشر</h1>"],
      ];
      for (const [path, headers, files, arabic] of pages) {
        const page = await get(path, headers);
        expect(`${path} ${page.status}`).toBe(`${path} 200`);
        expect(page.html).toContain('<html lang="ar" dir="rtl">');
        expect(page.html).toContain(arabic);
        expect(englishLeft(page.html, [...layout, ...files])).toEqual([]);
      }
      // A message with an argument, in an attribute.
      const dep = (await get("/apps/shop/deployments", AR)).html;
      expect(dep).toContain('title="اجعل bbbbbbbbbbbb النشر الفعّال"');
      expect(dep).toContain("تسجيل الخروج");
      // The state labels, ago() and the notice built in TypeScript.
      expect(dep).toContain("● يعمل");
      expect(dep).toContain("مستبدل");
      expect(dep).toContain("منذ 3 ساعات");
      expect(dep).toContain("منذ يومين");
      expect(dep).toContain("تم التراجع: aaaaaaa يعمل من جديد.");
      expect(dep).not.toContain("● live");
      expect(dep).not.toContain(" ago<");
    } finally {
      await dev.stop();
    }
  },
  120_000,
);
