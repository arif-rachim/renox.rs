// The right-to-left audit of the home-services app (#729). Usage:
//   RENOX_WORKER_PATH=<renox-worker> bun bench/lighthouse/rtl-audit.ts [--screens [<dir>]]
//
// Starts the app under `renox dev` with the demo seed (the launch code of run.ts: app.ts),
// signs in as each role through the real login form, then opens every route under pages/
// with ?lang=ar at 390 px and at 1280 px and checks: <html lang="ar" dir="rtl">, no
// horizontal page scroll (document.documentElement.scrollWidth <= innerWidth; /dispatch is
// the exception, its board scrolls inside its own container, which is checked instead),
// no element wider than the viewport outside a scroll container, and that Noto Sans Arabic
// was the face the browser used. Exits 1 and lists every route that fails.
// --screens writes the twelve screenshots of the six key pages (two widths, device scale
// factor 2) under docs/reference-app/screens/ar/ (or the directory given).
// Not part of `make ts-test`: run by hand and by the nightly lighthouse.yml.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { totp } from "../../sdk/src/totp.ts";
import { tokenHash } from "../../examples/home-services/lib/links.ts";
import { type App, freePort, launchChromium, type PwBrowser, REPO, signIn, startApp, workerPathOrThrow } from "./app.ts";

export const SCREENS_DIR = join(REPO, "docs/reference-app/screens/ar");
export const WIDTHS = [390, 1280] as const;
const INVOICE_TOKEN = `inv${"a".repeat(40)}`;
const REPORT_TOKEN = `rep${"b".repeat(40)}`;

export type Role = "anonymous" | "dispatcher" | "owner" | "accountant" | "ali";
export interface Route {
  path: string;
  as: Role;
  /** The page's board (or table) scrolls inside its own container: the page itself may still not scroll. */
  note?: string;
  /** A key page: a screenshot per width. */
  key?: string;
  /** Not translated: the platform's own error page. */
  en?: true;
}

/** Every route under pages/, with the role that opens it (the same list as the accessibility test). */
export const ROUTES: Route[] = [
  { path: "/", as: "anonymous" },
  { path: "/", as: "dispatcher", note: "signed in" },
  { path: "/nothing-here", as: "anonymous", note: "404", en: true },
  { path: "/l/approve/demo-q000002-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", as: "anonymous" },
  { path: "/l/approve/demo-q000004-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", as: "anonymous" },
  { path: `/l/invoice/${INVOICE_TOKEN}`, as: "anonymous" },
  { path: `/l/report/${REPORT_TOKEN}`, as: "anonymous" },
  { path: "/customers", as: "dispatcher" },
  { path: "/customers/new", as: "dispatcher" },
  { path: "/customers/cu_dxb_04", as: "dispatcher", key: "customer" },
  { path: "/quotes", as: "dispatcher" },
  { path: "/quotes/new", as: "dispatcher" },
  { path: "/quotes/qt_seed_02", as: "dispatcher" },
  { path: "/jobs", as: "dispatcher" },
  { path: "/jobs/new", as: "dispatcher" },
  { path: "/jobs/jb_seed_05", as: "dispatcher" },
  { path: "/jobs/jb_seed_10", as: "dispatcher", key: "job" },
  { path: "/jobs/jb_seed_12", as: "dispatcher" },
  { path: "/dispatch", as: "dispatcher", note: "board", key: "dispatch" },
  { path: "/services", as: "owner" },
  { path: "/contracts", as: "owner" },
  { path: "/contracts/new", as: "owner" },
  { path: "/contracts/ct_seed_01", as: "owner" },
  { path: "/invoices", as: "accountant" },
  { path: "/invoices/INV-000001", as: "accountant", key: "invoice" },
  { path: "/reports/technicians", as: "owner" },
  { path: "/reports/amc", as: "owner" },
  { path: "/reports/outstanding", as: "accountant" },
  { path: "/admin/tile", as: "owner" },
  { path: "/admin/settings", as: "owner" },
  { path: "/admin/branches", as: "owner" },
  { path: "/admin/people", as: "owner" },
  { path: "/admin/import", as: "owner" },
  { path: "/admin/import/im_00000000000a11b0", as: "owner" },
  { path: "/admin/import/im_00000000000a11c0", as: "owner" },
  { path: "/me", as: "ali", key: "me" },
  { path: "/me/visits/jb_seed_10", as: "ali", key: "visit" },
  { path: "/me/visits/jb_seed_12", as: "ali" },
];

// Playwright, typed by the calls used here (app.ts types the few it needs).
interface Page {
  goto(url: string, opts?: { waitUntil?: string }): Promise<{ status(): number } | null>;
  evaluate<T>(fn: string): Promise<T>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  waitForLoadState(state: string): Promise<void>;
  close(): Promise<void>;
}
interface Ctx {
  newPage(): Promise<Page>;
  cookies(): Promise<Record<string, unknown>[]>;
  addCookies(c: Record<string, unknown>[]): Promise<void>;
  close(): Promise<void>;
}
interface Browser {
  newContext(o?: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<Ctx>;
  close(): Promise<void>;
}

/** What the page says about itself, evaluated in the browser. */
const PROBE = `(() => {
  const vw = innerWidth;
  const root = document.documentElement;
  const scrolls = (e) => { for (let p = e; p && p !== root; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll") return true; } return false; };
  const wide = [...document.body.querySelectorAll("*")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1) && !scrolls(e); }).slice(0, 5).map((e) => e.tagName.toLowerCase() + (e.className ? "." + String(e.className).trim().split(/\\s+/).join(".") : ""));
  const board = document.querySelector(".board");
  return {
    lang: root.lang, dir: root.dir, scrollWidth: root.scrollWidth, innerWidth: vw, wide,
    boardScrolls: board ? board.scrollWidth > board.clientWidth : false,
    arabicFace: document.fonts.check('16px "Noto Sans Arabic"', "\\u0627"),
    h1: document.querySelectorAll("h1").length,
  };
})()`;

interface Probe {
  lang: string;
  dir: string;
  scrollWidth: number;
  innerWidth: number;
  wide: string[];
  boardScrolls: boolean;
  arabicFace: boolean;
  h1: number;
}

const shotName = (key: string, width: number): string => `${key}-${String(width)}.png`;

/** The problems of one route at one width ([] when it is right). */
export function problems(r: Route, width: number, status: number, p: Probe): string[] {
  const bad: string[] = [];
  if (status !== (r.note === "404" ? 404 : 200)) bad.push(`status ${String(status)}`);
  // The error pages are rendered by the platform with the default locale (no ?lang, no loader): English, left to right.
  const [lang, dir] = r.en ? ["en", "ltr"] : ["ar", "rtl"];
  if (p.lang !== lang || p.dir !== dir) bad.push(`html lang/dir are ${p.lang}/${p.dir}, expected ${lang}/${dir}`);
  if (r.path !== "/dispatch" && p.scrollWidth > p.innerWidth) bad.push(`scrolls horizontally (${String(p.scrollWidth)} > ${String(p.innerWidth)})`);
  if (r.path === "/dispatch" && p.scrollWidth > p.innerWidth) bad.push(`the board overflows the page (${String(p.scrollWidth)} > ${String(p.innerWidth)}): it must scroll in its own container`);
  if (p.wide.length > 0 && !(r.path === "/dispatch" && p.boardScrolls)) bad.push(`outside the viewport at ${String(width)} px: ${p.wide.join(", ")}`);
  if (!r.en && !p.arabicFace) bad.push("Noto Sans Arabic did not load");
  return bad;
}

async function ownerWithSecondFactor(browser: PwBrowser, base: string): Promise<Ctx> {
  const email = "owner@fixit.example";
  const ctx = (await signIn(browser, base, email)) as unknown as Ctx;
  const page = await ctx.newPage();
  await page.goto(`${base}/2fa/enroll/totp`);
  const secret = (await page.evaluate<string>(`(document.querySelector("#secret")?.textContent ?? "").replace(/ /g, "")`)).trim();
  if (!secret) throw new Error("the second-factor page shows no secret");
  const fill = async (code: string, form: string): Promise<void> => {
    await page.evaluate(`(() => { const f = document.querySelector(${JSON.stringify(form)}); const i = f.querySelector('input[name="code"]'); i.value = ${JSON.stringify(code)}; f.requestSubmit(); })()`);
    await page.waitForLoadState("load");
  };
  await fill(await totp(secret), "main form");
  await page.close();
  return ctx;
}

export async function main(argv: string[]): Promise<number> {
  const si = argv.indexOf("--screens");
  const screens = si < 0 ? undefined : (argv[si + 1] && !argv[si + 1]?.startsWith("--") ? (argv[si + 1] as string) : SCREENS_DIR);
  const worker = workerPathOrThrow();
  let app: App | undefined;
  let browser: PwBrowser | undefined;
  try {
    app = await startApp({ worker, env: { TWOFA_KEY: "rtl-audit-throwaway-second-factor-key-0123456789" } });
    browser = await launchChromium(freePort());
    const base = app.base;
    const db = new Database(app.db);
    const now = Math.floor(Date.now() / 1000);
    db.exec("pragma busy_timeout = 5000");
    db.run("insert into app__links (token_hash, kind, ref_id, expires_at, used_at) values (?, 'invoice', 'INV-000001', ?, null)", [await tokenHash(INVOICE_TOKEN), now + 86_400]);
    db.run("insert into app__links (token_hash, kind, ref_id, expires_at, used_at) values (?, 'report', 'vs_seed_12', ?, null)", [await tokenHash(REPORT_TOKEN), now + 86_400]);
    const bad = JSON.stringify({ errors: [{ row: 2, column: "phone", code: "bad_phone" }, { row: 0, column: "", code: "required" }], insert: 1, update: 0, exists: 0 });
    const ok = JSON.stringify({ errors: [], insert: 2, update: 0, exists: 1 });
    db.run("insert into app__imports (id, kind, file_key, file_name, status, rows, ok, skipped, errors, report, created_by, created_at) values ('im_00000000000a11b0', 'customers', 'k1', 'bad.xlsx', 'checked', 3, 1, 0, 2, ?, 'u_owner', ?)", [bad, now]);
    db.run("insert into app__imports (id, kind, file_key, file_name, status, rows, ok, skipped, errors, report, created_by, created_at) values ('im_00000000000a11c0', 'customers', 'k2', 'ok.xlsx', 'checked', 3, 1, 0, 0, ?, 'u_owner', ?)", [ok, now]);
    db.close();

    const jars: Record<Exclude<Role, "anonymous">, Ctx> = {
      dispatcher: (await signIn(browser, base, "dispatcher.dubai@fixit.example")) as unknown as Ctx,
      accountant: (await signIn(browser, base, "accountant.dubai@fixit.example")) as unknown as Ctx,
      ali: (await signIn(browser, base, "ali.dubai@fixit.example")) as unknown as Ctx,
      owner: await ownerWithSecondFactor(browser, base),
    };
    const cookies = Object.fromEntries(await Promise.all(Object.entries(jars).map(async ([k, c]) => [k, await c.cookies()] as const)));
    if (screens) mkdirSync(screens, { recursive: true });

    const failed: string[] = [];
    let count = 0;
    for (const width of WIDTHS) {
      for (const role of ["anonymous", "dispatcher", "accountant", "ali", "owner"] as const) {
        const routes = ROUTES.filter((r) => r.as === role);
        if (routes.length === 0) continue;
        const ctx = await (browser as unknown as Browser).newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
        if (role !== "anonymous") await ctx.addCookies(cookies[role] ?? []);
        for (const r of routes) {
          const page = await ctx.newPage();
          const res = await page.goto(`${base}${r.path}${r.path.includes("?") ? "&" : "?"}lang=ar`, { waitUntil: "load" });
          await page.evaluate("document.fonts.ready.then(() => true)");
          const probe = await page.evaluate<Probe>(PROBE);
          count++;
          for (const msg of problems(r, width, res?.status() ?? 0, probe)) failed.push(`${r.path} @${String(width)}: ${msg}`);
          if (screens && r.key) await page.screenshot({ path: join(screens, shotName(r.key, width)), fullPage: true });
          await page.close();
        }
        await ctx.close();
      }
    }
    for (const f of failed) console.error(`FAIL ${f}`);
    console.log(`rtl-audit: ${String(count)} page loads (${String(ROUTES.length)} routes x ${String(WIDTHS.length)} widths), ${String(failed.length)} problems${screens ? `, screenshots in ${screens}` : ""}`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    await browser?.close().catch(() => {});
    await app?.stop().catch(() => {});
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
