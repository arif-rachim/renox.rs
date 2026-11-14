// #807: a technician opens /me online, loses the signal, and still reads today's
// list and each visit; a different technician who signs in on the same phone
// never gets the first one's copy. The service worker (public/sw.js), public/me.js
// and /me/ping in Chromium, with `context.setOffline(true)`, against this app under
// `renox dev` with its demo seed.
//
// Runs when RENOX_WORKER_PATH points at a renox-worker and Playwright is installed
// (PLAYWRIGHT_PATH, as in cli/tests/browser/); under RENOX_JOURNEY=1 (`make journey`,
// journey.yml) it fails instead of skipping. It needs this repository (the CLI's
// `renox dev`), so it skips in a copy of the example that has no cli/ beside it, and
// inside `renox test` (which sets RENOX_TEST_SPEC: that run is the one with fixed
// counts; this file is run by `make journey`).
//
// STAND-IN, to be removed with #832 (platform gap): a page loader cannot set a response
// header (docs/contracts/ops.md section 14: a loader returns an object or a whole
// Response), so the app cannot send `x-hs-offline-ok: 1` yet. `withLoaderHeader` below
// is a small reverse proxy that adds exactly that header to the two day pages, and the
// browser talks to the proxy. Nothing else about the worker, me.js or the pages is faked.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const repo = join(import.meta.dir, "../../../..");
const cli = join(repo, "cli/src/commands");
const inRepo = existsSync(join(cli, "dev.ts")) && existsSync(join(repo, "control/dashboard/tests/playwright.ts"));
const worker = process.env.RENOX_WORKER_PATH || undefined;
const insideRenoxTest = process.env.RENOX_TEST_SPEC !== undefined && process.env.RENOX_JOURNEY !== "1";

interface Locator {
  count(): Promise<number>;
  isHidden(): Promise<boolean>;
  isVisible(): Promise<boolean>;
  innerText(): Promise<string>;
  click(): Promise<void>;
  fill(v: string): Promise<void>;
  first(): Locator;
}
interface Page {
  goto(url: string, o?: { waitUntil?: string }): Promise<{ status(): number; headers(): Record<string, string> } | null>;
  locator(s: string): Locator;
  evaluate<T>(f: string | ((a: unknown) => T | Promise<T>), arg?: unknown): Promise<T>;
  waitForFunction(f: string | ((a: unknown) => unknown), arg?: unknown, o?: { timeout?: number }): Promise<unknown>;
  waitForURL(u: string | RegExp, o?: { timeout?: number }): Promise<void>;
  reload(): Promise<unknown>;
  url(): string;
  close(): Promise<void>;
}
interface Context {
  newPage(): Promise<Page>;
  setOffline(v: boolean): Promise<void>;
  clearCookies(): Promise<void>;
  close(): Promise<void>;
}
interface Browser {
  newContext(): Promise<Context>;
  close(): Promise<void>;
}
type Pw = { chromium: { launch: () => Promise<Browser> } };
interface Dev {
  stop(): Promise<void>;
}

const playwright = ((): Pw | null => {
  const require = createRequire(import.meta.url);
  // `bun test` does not search NODE_PATH: try its entries by hand.
  const candidates = [process.env.PLAYWRIGHT_PATH, "playwright", ...(process.env.NODE_PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "playwright"))];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return require(c) as Pw;
    } catch {
      // next
    }
  }
  return null;
})();

// Under RENOX_JOURNEY=1 the file fails instead of skipping (#586).
if (process.env.RENOX_JOURNEY === "1" && (!process.env.PLAYWRIGHT_PATH || playwright === null || !worker || !inRepo)) {
  test("the browser tests can run (RENOX_JOURNEY=1)", () => {
    throw new Error(!inRepo ? "this repository's cli/ is required" : !worker ? "renox-worker is required (RENOX_WORKER_PATH)" : "Playwright is required (PLAYWRIGHT_PATH)");
  });
}

const PASSWORD = "correct horse battery";
const ALI = { email: "ali.dubai@fixit.example", id: "u_dxb_ali", visit: "jb_seed_10" };
const BILAL = { email: "bilal.dubai@fixit.example" };

const OFFLINE_OK_PAGE = /^\/me(\/visits\/[^/]+)?$/u;

/**
 * STAND-IN (see the header): a reverse proxy to `upstream` that adds `x-hs-offline-ok: 1` to a 200
 * HTML answer for `/me` and `/me/visits/<id>` only, as the two loaders will when the platform lets a
 * page set a header. Redirects stay redirects; Origin and Referer are rewritten to the upstream's.
 */
function withLoaderHeader(upstream: string): { port: number; stop: () => void } {
  const up = new URL(upstream);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.delete("host");
      if (headers.has("origin")) headers.set("origin", up.origin);
      if (headers.has("referer")) headers.set("referer", up.origin + new URL(headers.get("referer") as string).pathname + new URL(headers.get("referer") as string).search);
      headers.delete("accept-encoding");
      const res = await fetch(up.origin + url.pathname + url.search, { method: req.method, headers, body: req.body, redirect: "manual" });
      const out = new Headers(res.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      const location = out.get("location");
      if (location) out.set("location", location.replace(up.origin, `http://localhost:${server.port}`));
      if (req.method === "GET" && res.status === 200 && OFFLINE_OK_PAGE.test(url.pathname) && (out.get("content-type") ?? "").startsWith("text/html")) out.set("x-hs-offline-ok", "1");
      return new Response(res.body, { status: res.status, headers: out });
    },
  });
  return { port: server.port as number, stop: () => void server.stop(true) };
}

describe.skipIf(!worker || !playwright || !inRepo || insideRenoxTest)("offline reading of the technician pages in Chromium", () => {
  let dev: Dev;
  let proxy: { port: number; stop: () => void };
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    // A copy of the example at the repository's depth (tsconfig.base.json is two levels up), seeded like `renox db seed`.
    const root = mkdtempSync(join(tmpdir(), "renox-offline-read-"));
    copyFileSync(join(repo, "tsconfig.base.json"), join(root, "tsconfig.base.json"));
    const src = join(repo, "examples/home-services");
    const dir = join(root, "examples/home-services");
    cpSync(src, dir, { recursive: true, filter: (p) => !/(^|\/)(node_modules|\.renox)(\/|$)/u.test(relative(src, p)) });
    mkdirSync(join(dir, "node_modules/@renoxium"), { recursive: true });
    symlinkSync(join(repo, "sdk"), join(dir, "node_modules/@renoxium/sdk"));
    const { seedDev } = (await import(join(cli, "db.ts"))) as { seedDev: (project: string) => Promise<string[]> };
    const { startDev } = (await import(join(cli, "dev.ts"))) as { startDev: (o: { project: string; port: number; worker?: string; log?: (l: string) => void }) => Promise<Dev> };
    const { freePort } = (await import(join(repo, "cli/tests/free-port.ts"))) as { freePort: () => number };
    await seedDev(dir);
    const port = freePort();
    dev = await startDev({ project: dir, port, worker, log: () => {} });
    proxy = withLoaderHeader(`http://localhost:${port}`);
    base = `http://localhost:${proxy.port}`;
    browser = await (playwright as Pw).chromium.launch();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    proxy?.stop();
    await dev?.stop();
  });

  /** A fresh phone: its own context, signed in as the technician, on /me. */
  async function signIn(ctx: Context, email: string): Promise<Page> {
    const page = await ctx.newPage();
    await page.goto(`${base}/auth/login?next=/me`);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/me$/u, { timeout: 20_000 });
    return page;
  }

  /** Whether going to `url` gives a saved copy (the worker's `x-hs-from-cache`); false when the navigation fails. */
  const servedFromCache = async (page: Page, url: string): Promise<boolean> => {
    try {
      const res = await page.goto(url);
      return res !== null && res.headers()["x-hs-from-cache"] === "1";
    } catch {
      return false;
    }
  };

  /** The day caches: name -> the paths stored in it. */
  const dayCaches = (page: Page): Promise<Record<string, string[]>> =>
    page.evaluate(`(async () => {
      const out = {};
      for (const n of await caches.keys()) if (n.startsWith("hs-day-")) out[n] = (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
      return out;
    })()`);

  /** Waits until the worker has kept `paths` for `user` (the first /me and the prefetched visits). */
  const kept = (page: Page, user: string, paths: string[]): Promise<unknown> =>
    page.waitForFunction(
      `(async () => {
        const name = "hs-day-v1-${user}";
        if (!(await caches.keys()).includes(name)) return false;
        const have = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
        return ${JSON.stringify(paths)}.every((p) => have.includes(p));
      })()`,
      undefined,
      { timeout: 20_000 },
    );

  test("today's /me and a visit open offline as a saved copy with the banner; /jobs never enters the cache", async () => {
    const ctx = await (browser as Browser).newContext();
    try {
      const page = await signIn(ctx, ALI.email);
      // Online: no banner; the worker keeps /me and the visit pages listed on it, and me.js keeps the user id.
      await kept(page, ALI.id, ["/me", `/me/visits/${ALI.visit}`]);
      expect(await page.locator("#offline-banner").isHidden()).toBe(true);
      await page.waitForFunction(`new Promise((ok) => { const r = indexedDB.open("hs-offline", 1); r.onsuccess = () => { const g = r.result.transaction("kv").objectStore("kv").get("user"); g.onsuccess = () => ok(g.result === "${ALI.id}"); }; })`, undefined, { timeout: 10_000 });

      // The worker must control the page for the requests below to go through it.
      await page.reload();
      await page.waitForFunction("navigator.serviceWorker.controller !== null", undefined, { timeout: 10_000 });

      // /jobs through the worker: a fetch from the controlled page, and a prefetch request naming it, other routes
      // of /me and the visit's sub-paths. None enters hs-day-*.
      await page.evaluate(`(async () => { await fetch("/jobs").catch(() => null); })()`);
      await page.evaluate(`(async () => {
        const reg = await navigator.serviceWorker.ready;
        reg.active.postMessage({ type: "prefetch", urls: ["/jobs", "/me/manifest", "/me/ping", "/me/visits/${ALI.visit}/x", "/me?x=1", "/auth/account"] });
        await new Promise((r) => setTimeout(r, 1500));
      })()`);
      const stored = await dayCaches(page);
      const paths = Object.values(stored).flat();
      expect(Object.keys(stored)).toEqual([`hs-day-v1-${ALI.id}`]);
      expect(paths.filter((p) => p !== "/__hs-day-stamp").sort()).toEqual(["/me", `/me/visits/${ALI.visit}`, "/me/visits/jb_seed_05"].sort());
      expect(paths.some((p) => p.startsWith("/jobs"))).toBe(false);

      // No signal: a visit opens from the saved copy, with the banner and the time it was saved at.
      await ctx.setOffline(true);
      const visit = await page.goto(`${base}/me/visits/${ALI.visit}`);
      expect(visit?.status()).toBe(200);
      expect(visit?.headers()["x-hs-from-cache"]).toBe("1");
      await page.waitForFunction(`document.getElementById("offline-banner") && !document.getElementById("offline-banner").hidden`, undefined, { timeout: 10_000 });
      const text = await page.locator("#offline-banner").innerText();
      expect(text).toMatch(/^You are offline\. Showing the copy saved at \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.$/u);
      expect(await page.locator("h1").first().innerText()).toBe("J-000010");

      // The list too, from /me and from the manifest's start_url /me/.
      for (const path of ["/me", "/me/"]) {
        const list = await page.goto(`${base}${path}`);
        expect(list?.headers()["x-hs-from-cache"], path).toBe("1");
        await page.waitForFunction(`!document.getElementById("offline-banner").hidden`, undefined, { timeout: 10_000 });
        expect(await page.locator("#visit-jb_seed_05").count(), path).toBe(1);
      }

      // Not saved, so not served: an office page, the login page and a visit the phone never opened fail offline.
      for (const path of ["/jobs", "/auth/login", "/me/visits/jb_seed_99"]) expect(await servedFromCache(page, `${base}${path}`), path).toBe(false);

      // Back online: the banner goes (the ping answers 204).
      await ctx.setOffline(false);
      await page.goto(`${base}/me`);
      await page.waitForFunction(`document.getElementById("offline-banner").hidden`, undefined, { timeout: 10_000 });
    } finally {
      await ctx.close();
    }
  }, 90_000);

  test("another technician on the same phone never gets the first one's copy", async () => {
    const ctx = await (browser as Browser).newContext();
    try {
      const page = await signIn(ctx, ALI.email);
      await kept(page, ALI.id, ["/me", `/me/visits/${ALI.visit}`]);

      // Signing in as someone else offline is impossible: the login page itself does not load.
      await ctx.setOffline(true);
      await expect(page.goto(`${base}/auth/login`)).rejects.toThrow();
      await ctx.setOffline(false);

      // Signed out (the session is gone) and signed in as Bilal, online.
      await ctx.clearCookies();
      await page.goto(`${base}/auth/login?next=/me`);
      // The login page is not a technician page, but the saved copies are there: me.js asks /me/ping, which refuses, and clears them.
      await page.waitForFunction(`(async () => !(await caches.keys()).some((n) => n.startsWith("hs-day-")))()`, undefined, { timeout: 15_000 });
      await page.locator('input[name="email"]').fill(BILAL.email);
      await page.locator('input[name="password"]').fill(PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/me$/u, { timeout: 20_000 });
      await page.waitForFunction(`(async () => (await caches.keys()).some((n) => n.startsWith("hs-day-v1-")))()`, undefined, { timeout: 15_000 });
      const names = Object.keys(await dayCaches(page));
      expect(names.length).toBe(1);
      expect(names[0]).not.toBe(`hs-day-v1-${ALI.id}`);

      // Offline, Bilal gets his own copy of /me and nothing of Ali's visit.
      await page.reload();
      await page.waitForFunction("navigator.serviceWorker.controller !== null", undefined, { timeout: 10_000 });
      await ctx.setOffline(true);
      const mine = await page.goto(`${base}/me`);
      expect(mine?.headers()["x-hs-from-cache"]).toBe("1");
      expect(await page.locator(`#visit-${ALI.visit}`).count()).toBe(0);
      expect(await servedFromCache(page, `${base}/me/visits/${ALI.visit}`)).toBe(false);
    } finally {
      await ctx.close();
    }
  }, 120_000);
});
