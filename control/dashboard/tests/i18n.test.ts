// #336: the dashboard in English and Arabic. The catalogs (i18n/en.json,
// i18n/ar.json) have the same keys and every Arabic message is Arabic; the
// locale choice of lib/locale.ts; and pages rendered in Arabic by the worker
// (`renox dev`, as the other render tests do: templates are compiled and
// rendered only by `renox-worker`), with `<html lang="ar" dir="rtl">` and no
// English message of the template's keys left.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { LoaderContext } from "renox";

import { acceptLocale, applyLocale, chooseLocale, cookieLocale } from "../lib/locale.ts";
import { devWithData } from "./helpers.ts";

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
  const args = (s: string) => [...s.matchAll(/\{([a-z_]+)\}/gu)].map((m) => m[1]).sort();
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
      notice: null,
      action_problem: null,
      detail: null,
      detail_problem: null,
      deployments: [
        { hash: "a".repeat(64), short: "aaaaaaaaaaaa", when: "2026-10-31 09:00", state: "active", label: "active", size: "12 KB", error: null, can_activate: false, can_rollback: true },
        { hash: "b".repeat(64), short: "bbbbbbbbbbbb", when: "2026-10-30 09:00", state: "superseded", label: "superseded", size: "12 KB", error: null, can_activate: true, can_rollback: false },
      ],
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
    } finally {
      await dev.stop();
    }
  },
  120_000,
);
