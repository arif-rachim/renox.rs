// #808: a technician with no signal checks in, adds a part, writes a note, types the customer's name as the
// signature and checks out; the page shows each step as done but "not sent yet" and keeps showing it after a
// reload; when the phone is online again the actions reach the server once each, in the order they were made;
// the same queue put back on the device and sent again changes nothing. The queue (public/offline-queue.js
// and its core), public/me.js, the service worker and the visit page in Chromium, with
// `context.setOffline(true)`, against this app under `renox dev` with its demo seed.
//
// Two more scenarios of the queue's rules in the browser: the actions of another account stay on the device
// and are never sent under this session; an action for a job the office cancelled meanwhile is refused, its
// reason is on the status line, and the later actions of that job are not sent.
//
// Runs when RENOX_WORKER_PATH points at a renox-worker and Playwright is installed (PLAYWRIGHT_PATH, as in
// cli/tests/browser/); under RENOX_JOURNEY=1 (`make journey`, journey.yml) it fails instead of skipping. It
// needs this repository (the CLI's `renox dev`), so it skips in a copy of the example that has no cli/ beside
// it, and inside `renox test` (which sets RENOX_TEST_SPEC: that run has fixed counts; this file is run by
// `make journey`). The service worker stores a page only when it carries `x-hs-offline-ok` (STAND-IN, to be
// removed with #832: ./stand-in.ts adds that header, which a page loader cannot set yet).
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { withLoaderHeader } from "./stand-in";

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
  inputValue(): Promise<string>;
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
  close(): Promise<void>;
}
interface Context {
  newPage(): Promise<Page>;
  setOffline(v: boolean): Promise<void>;
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
const ALI = { email: "ali.dubai@fixit.example", id: "u_dxb_ali" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `check` until it is true (a page that is reloading meanwhile makes it throw: that is a "not yet"). */
async function until(what: string, check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // the page is navigating
    }
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(100);
  }
}

/** What the device keeps for one action (public/offline-queue-core.js). */
interface Stored {
  seq: number;
  action_id: string;
  user_id: string;
  job_id: string;
  url: string;
  action: string;
  fields: Record<string, string>;
  performed_at: number;
  state: string;
  attempts: number;
  refused_reason?: string;
  refused_message?: string;
}

describe.skipIf(!worker || !playwright || !inRepo || insideRenoxTest)("the offline action queue in Chromium", () => {
  let dev: Dev;
  let proxy: { port: number; stop: () => void };
  let browser: Browser;
  let base: string;
  let sqlite: Database;

  beforeAll(async () => {
    // A copy of the example at the repository's depth (tsconfig.base.json is two levels up), seeded like `renox db seed`.
    const root = mkdtempSync(join(tmpdir(), "renox-offline-queue-"));
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
    // The tenant's file, to see what the server holds (the dev server keeps it at .renox/data/dev/app.db).
    sqlite = new Database(join(dir, ".renox/data/dev/app.db"));
    sqlite.exec("pragma busy_timeout = 5000");
    browser = await (playwright as Pw).chromium.launch();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    sqlite?.close();
    proxy?.stop();
    await dev?.stop();
  });

  const rows = <T>(sql: string, ...params: (string | number)[]): T[] => sqlite.query(sql).all(...params) as T[];

  /** A phone: its own context, signed in as Ali, on /me. */
  async function signIn(ctx: Context): Promise<Page> {
    const page = await ctx.newPage();
    await page.goto(`${base}/auth/login?next=/me`);
    await page.locator('input[name="email"]').fill(ALI.email);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/me$/u, { timeout: 20_000 });
    return page;
  }

  /** Opens a visit page online, with the service worker in control and the page's scripts kept for offline. */
  async function openVisit(ctx: Context, job: string): Promise<Page> {
    const page = await signIn(ctx);
    await page.goto(`${base}/me/visits/${job}`);
    // The worker takes control of the next navigation, once it is active.
    await until("the service worker is active", () => page.evaluate(`navigator.serviceWorker.ready.then((r) => r.active !== null)`), 20_000);
    await page.reload();
    await until("the worker controls the page", () => page.evaluate(`navigator.serviceWorker.controller !== null`), 15_000);
    await page.reload();
    // The worker keeps the hashed scripts when the page asks for them through it, and the page itself under hs-day-*.
    await until(
      "the page and its scripts are kept",
      () =>
        page.evaluate(`(async () => {
          const shell = (await (await caches.open("hs-shell-v1")).keys()).map((r) => new URL(r.url).pathname);
          let kept = false;
          for (const n of (await caches.keys()).filter((k) => k.startsWith("hs-day-v1-"))) kept = kept || (await (await caches.open(n)).keys()).some((r) => new URL(r.url).pathname === "/me/visits/${job}");
          return kept && ["offline-queue-core", "offline-queue", "visit", "me"].every((f) => shell.some((p) => new RegExp("^/" + f + "\\\\.[0-9a-f]{16}\\\\.js$").test(p)));
        })()`),
      20_000,
    );
    expect(await page.locator("#queue-status").count()).toBe(1);
    return page;
  }

  /** The records on the device, in seq order. */
  const stored = (page: Page): Promise<Stored[]> =>
    page.evaluate(`new Promise((ok, no) => {
      const open = indexedDB.open("hs-offline");
      open.onerror = () => no(open.error);
      open.onsuccess = () => {
        const all = open.result.transaction("actions").objectStore("actions").getAll();
        all.onsuccess = () => { open.result.close(); ok(all.result.sort((a, b) => a.seq - b.seq)); };
      };
    })`);

  /** Puts records on the device as new ones (their `seq` is the device's to give). */
  const putBack = (page: Page, records: Stored[]): Promise<void> =>
    page.evaluate(`new Promise((ok, no) => {
      const open = indexedDB.open("hs-offline");
      open.onerror = () => no(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("actions", "readwrite");
        for (const r of ${JSON.stringify(records)}) { const { seq, ...rest } = r; tx.objectStore("actions").add(rest); }
        tx.oncomplete = () => { open.result.close(); ok(); };
        tx.onerror = () => no(tx.error);
      };
    })`);

  const status = (page: Page): Promise<string> => page.locator("#queue-status").innerText();
  const statusIs = (page: Page, text: string): Promise<unknown> =>
    page.waitForFunction((want) => document.getElementById("queue-status")?.textContent === want, text, { timeout: 30_000 });
  const statusHas = (page: Page, text: string): Promise<unknown> =>
    page.waitForFunction((want) => document.getElementById("queue-status")?.textContent?.includes(want as string) === true, text, { timeout: 30_000 });
  /** Waits until the device holds no record, or only a check-out that failed to send once or more. */
  const queueSettles = (page: Page): Promise<void> =>
    until("the queue is sent", async () => {
      const left = await stored(page);
      return left.length === 0 || (left.length === 1 && left[0]?.action === "checkout" && left[0].attempts >= 1);
    }, 60_000);
  const queueEmpty = (page: Page): Promise<void> => until("the queue is empty", async () => (await stored(page)).length === 0);

  test("offline: check in, a part, a note, the signature name, check out; online: once each, in order; the same queue again changes nothing", async () => {
    const JOB = "jb_seed_10";
    const ctx = await (browser as Browser).newContext();
    try {
      const page = await openVisit(ctx, JOB);
      expect(rows("select count(*) as n from app__visits where job_id = ?", JOB)[0]).toEqual({ n: 0 });
      expect(await status(page)).toBe("");

      await ctx.setOffline(true);

      // Check in: the page shows the visit as started, not sent yet.
      await page.locator("#checkin-form button[type=submit]").click();
      await statusIs(page, "1 action waiting to be sent");
      await page.waitForFunction(() => document.getElementById("visit")?.hidden === false, undefined, { timeout: 5000 });
      expect(await page.locator("#checkin").innerText()).toMatch(/Checked in \d{4}-\d{2}-\d{2} \d{2}:\d{2} · not sent yet/u);
      expect(await page.locator("#checkin-form").isVisible()).toBe(false);
      expect(await page.locator("#job-status").innerText()).toBe("In progress");
      await sleep(1100);

      // A part: a row of its own, not sent yet; the form is empty for the next one.
      await page.locator("#f-description").fill("Copper joint 15 mm");
      await page.locator("#f-qty").fill("2");
      await page.locator("#f-price").fill("12.50");
      await page.locator("#part-form button[type=submit]").click();
      await statusIs(page, "2 actions waiting to be sent");
      expect(await page.locator("#offline-parts li").count()).toBe(1);
      expect(await page.locator("#offline-parts li").first().innerText()).toMatch(/^Copper joint 15 mm · 2 × 12\.50 · not sent yet$/u);
      expect(await page.locator("#f-description").inputValue()).toBe("");
      await sleep(1100);

      // A note keeps its text and says so.
      await page.locator("#f-notes").fill("Replaced the leaking joint under the sink.");
      await page.locator("#notes form button[type=submit]").click();
      await statusIs(page, "3 actions waiting to be sent");
      expect(await page.locator("#notes").innerText()).toContain("not sent yet");
      expect(await page.locator("#f-notes").inputValue()).toBe("Replaced the leaking joint under the sink.");
      await sleep(1100);

      // The signature: the typed name stands in for the drawing (public/visit.js writes it onto the canvas).
      await page.locator("#f-signed_by").fill("Omar Al Farsi");
      await page.locator("#sig-typed").click();
      await page.locator("#signature-form button[type=submit]").click();
      await statusIs(page, "4 actions waiting to be sent");
      expect(await page.locator("#signature").innerText()).toContain("not sent yet");
      expect(await page.locator("#f-signed_by").inputValue()).toBe("Omar Al Farsi");
      await sleep(1100);

      // Check out: the finished state, not sent yet; the forms that need an open visit are gone.
      await page.locator("#checkout-form button[type=submit]").click();
      await statusIs(page, "5 actions waiting to be sent");
      expect(await page.locator("#checkout").innerText()).toMatch(/Checked out \d{4}-\d{2}-\d{2} \d{2}:\d{2} · not sent yet/u);
      expect(await page.locator("#job-status").innerText()).toBe("Done");
      expect(await page.locator("#part-form").isVisible()).toBe(false);
      expect(await page.locator("#signature-form").isVisible()).toBe(false);
      expect(await page.locator("#visit-times").innerText()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} → \d{4}-\d{2}-\d{2} \d{2}:\d{2} not sent yet$/u);

      // What the device keeps: five records in the order they were made, text fields only, no token.
      const queued = await stored(page);
      expect(queued.map((r) => r.action)).toEqual(["checkin", "part", "notes", "signature", "checkout"]);
      expect(queued.every((r) => r.state === "pending" && r.attempts === 0 && r.user_id === ALI.id && r.job_id === JOB && r.url === `/me/visits/${JOB}`)).toBe(true);
      expect(queued.every((r) => /^[0-9a-f]{32}$/u.test(r.action_id))).toBe(true);
      expect(new Set(queued.map((r) => r.action_id)).size).toBe(5);
      for (let i = 1; i < queued.length; i++) expect((queued[i] as Stored).performed_at).toBeGreaterThanOrEqual((queued[i - 1] as Stored).performed_at + 1000);
      expect(queued.map((r) => Object.keys(r.fields).filter((k) => k.startsWith("_") || k === "action_id" || k === "performed_at"))).toEqual([[], [], [], [], []]);
      expect(queued[1]?.fields).toEqual({ description: "Copper joint 15 mm", qty: "2", price: "12.50" });
      expect(queued[2]?.fields).toEqual({ notes: "Replaced the leaking joint under the sink." });
      expect(queued[3]?.fields.signed_by).toBe("Omar Al Farsi");
      expect(queued[3]?.fields.signature).toMatch(/^data:image\/png;base64,/u);
      expect(rows("select count(*) as n from app__visits where job_id = ?", JOB)[0]).toEqual({ n: 0 });

      // Reload the page that was made offline: it comes from the saved copy, and shows each action once.
      await page.reload();
      await statusIs(page, "5 actions waiting to be sent");
      expect(await page.locator("#offline-parts li").count()).toBe(1);
      for (const key of ["checkin", "notes", "signature", "checkout"]) expect(await page.locator(`[data-offline-key="${key}"]`).count(), key).toBe(1);
      expect(await page.locator("#checkin").innerText()).toContain("not sent yet");
      expect(await page.locator("#f-notes").inputValue()).toBe("Replaced the leaking joint under the sink.");
      expect(await page.locator("#job-status").innerText()).toBe("Done");
      expect((await stored(page)).length).toBe(5);

      // Online again: the queue goes in order, once each; the page reloads with what the server holds.
      await ctx.setOffline(false);
      // A worker without a PDF engine (the journey may run on one) cannot build the check-out's report: the server
      // answers that action 500, and the queue must keep it, count the attempt and stop there (the rule for a 5xx).
      await queueSettles(page);
      const rest = await stored(page);
      if (rest.length > 0) {
        expect(rest.map((r) => [r.action, r.state])).toEqual([["checkout", "pending"]]);
        expect(rest[0]?.attempts).toBeGreaterThanOrEqual(1);
        expect(await status(page)).toBe("1 action waiting to be sent");
        const half = rows<{ id: string; checkout_at: number | null; notes: string; signed_by_name: string }>("select id, checkout_at, notes, signed_by_name from app__visits where job_id = ?", JOB);
        expect(half.map((h) => [h.checkout_at, h.notes, h.signed_by_name])).toEqual([[null, "Replaced the leaking joint under the sink.", "Omar Al Farsi"]]);
        expect(rows("select count(*) as n from app__visit_parts where visit_id = ?", (half[0] as { id: string }).id)[0]).toEqual({ n: 1 });
        expect(rows<{ action: string }>("select action from app__action_log where visit_job_id = ? order by rowid", JOB).map((l) => l.action)).toEqual(["checkin", "part", "notes", "signature"]);
        console.warn("offline-queue: this worker has no PDF engine; the check-out stayed queued (the 5xx rule), the rest of the scenario needs the pdf worker");
        return;
      }
      await statusIs(page, "All sent");
      const visit = rows<{ id: string; checkin_at: number; checkout_at: number; notes: string; signed_by_name: string; signature_key: string | null }>("select id, checkin_at, checkout_at, notes, signed_by_name, signature_key from app__visits where job_id = ?", JOB);
      expect(visit.length).toBe(1);
      const v = visit[0] as (typeof visit)[number];
      expect(v.notes).toBe("Replaced the leaking joint under the sink.");
      expect(v.signed_by_name).toBe("Omar Al Farsi");
      expect(v.signature_key).not.toBeNull();
      const made = (action: string) => Math.floor((queued.find((r) => r.action === action) as Stored).performed_at / 1000);
      // The times are the ones of the phone, not of the replay, in the order they were made.
      expect(v.checkin_at).toBe(made("checkin"));
      expect(v.checkout_at).toBe(made("checkout"));
      expect(v.checkin_at).toBeLessThan(made("part"));
      expect(made("signature")).toBeLessThan(v.checkout_at);
      const parts = rows<{ description: string; qty: number; unit_price_fils: number }>("select description, qty, unit_price_fils from app__visit_parts where visit_id = ?", v.id);
      expect(parts).toEqual([{ description: "Copper joint 15 mm", qty: 2, unit_price_fils: 1250 }]);
      expect(rows<{ status: string }>("select status from app__jobs where id = ?", JOB)[0]?.status).toBe("done");
      const log = rows<{ action_id: string; action: string; status: number }>("select action_id, action, status from app__action_log where visit_job_id = ? order by rowid", JOB);
      expect(log.map((l) => l.action)).toEqual(["checkin", "part", "notes", "signature", "checkout"]);
      expect(log.map((l) => l.action_id)).toEqual(queued.map((r) => r.action_id));
      expect(log.every((l) => l.status === 200)).toBe(true);

      // The page the replay reloaded is the server's: one part row, no mark left.
      expect(await page.locator("#parts tbody tr").count()).toBe(1);
      expect(await page.locator("[data-offline-seq]").count()).toBe(0);
      expect(await page.locator("#visit-closed").count()).toBe(1);

      // The same queue put on the device again and sent again: every answer is the stored one, nothing changes.
      const before = JSON.stringify([
        rows("select * from app__visits where job_id = ?", JOB),
        rows("select * from app__visit_parts where visit_id = ?", v.id),
        rows("select * from app__action_log where visit_job_id = ?", JOB),
        rows("select * from app__jobs where id = ?", JOB),
      ]);
      await putBack(page, queued);
      expect((await stored(page)).length).toBe(5);
      await page.evaluate(`window.dispatchEvent(new Event("online"))`);
      await queueEmpty(page);
      await sleep(500);
      const after = JSON.stringify([
        rows("select * from app__visits where job_id = ?", JOB),
        rows("select * from app__visit_parts where visit_id = ?", v.id),
        rows("select * from app__action_log where visit_job_id = ?", JOB),
        rows("select * from app__jobs where id = ?", JOB),
      ]);
      expect(after).toBe(before);
      expect(rows("select count(*) as n from app__action_log where visit_job_id = ?", JOB)[0]).toEqual({ n: 5 });
    } finally {
      await ctx.close();
    }
  }, 180_000);

  test("online, a form posts as it always did, with an action id: the page navigates; a form with errors shows the server's page", async () => {
    const JOB = "jb_seed_05";
    const ctx = await (browser as Browser).newContext();
    try {
      const page = await signIn(ctx);
      await page.goto(`${base}/me/visits/${JOB}`);
      await page.locator("#checkin-form button[type=submit]").click();
      // The server's page: the visit is there, nothing waits on the device.
      await until("the visit page of the server", async () => (await page.locator("#visit-times").innerText()).length > 0 && (await page.locator("#checkin").count()) === 0);
      expect(await status(page)).toBe("");
      expect(await page.locator("[data-offline-seq]").count()).toBe(0);
      expect((await stored(page)).length).toBe(0);
      const first = rows<{ action_id: string; action: string; status: number }>("select action_id, action, status from app__action_log where visit_job_id = ?", JOB);
      expect(first.map((l) => [l.action, l.status])).toEqual([["checkin", 200]]);
      expect(first[0]?.action_id).toMatch(/^[0-9a-f]{32}$/u);
      const at = rows<{ checkin_at: number }>("select checkin_at from app__visits where job_id = ?", JOB)[0]?.checkin_at ?? 0;
      expect(Math.abs(at - Date.now() / 1000)).toBeLessThan(60);

      // A part with a quantity the server refuses (422): the page the server renders, with the error and what was typed.
      await page.locator("#f-description").fill("Hose clip");
      await page.locator("#f-qty").fill("0");
      await page.locator("#part-form button[type=submit]").click();
      await until("the server's error page", async () => (await page.locator("#form-errors").count()) === 1);
      expect(await page.locator("#f-description").inputValue()).toBe("Hose clip");
      expect(rows("select count(*) as n from app__visit_parts where description = ?", "Hose clip")[0]).toEqual({ n: 0 });
      expect((await stored(page)).length).toBe(0);

      // And a good one: the visit page shows the part as the server has it.
      await page.locator("#f-qty").fill("3");
      await page.locator("#part-form button[type=submit]").click();
      await until("the part row", async () => (await page.locator("#parts tbody tr").count()) === 1);
      expect(rows<{ qty: number }>("select qty from app__visit_parts where description = ?", "Hose clip")).toEqual([{ qty: 3 }]);
      expect(rows("select count(*) as n from app__action_log where visit_job_id = ? and action = 'part'", JOB)[0]).toEqual({ n: 1 });
    } finally {
      await ctx.close();
    }
  }, 60_000);

  test("the actions of another account stay on the device and are never sent under this session", async () => {
    const ctx = await (browser as Browser).newContext();
    try {
      const page = await signIn(ctx);
      const mine = "a".repeat(32);
      const theirs = {
        seq: 0,
        action_id: mine,
        user_id: "u_dxb_bilal",
        job_id: "jb_bilals_job",
        url: "/me/visits/jb_bilals_job",
        action: "checkin",
        fields: {},
        performed_at: Date.now(),
        state: "pending",
        attempts: 0,
      } satisfies Stored;
      await putBack(page, [theirs]);
      await page.reload();
      await statusIs(page, "1 actions of another account are waiting; sign in as that user to send them");
      // Give a replay time to (wrongly) go: the ping answers, nothing is sent.
      await sleep(1500);
      const left = await stored(page);
      expect(left.length).toBe(1);
      expect(left[0]?.state).toBe("pending");
      expect(left[0]?.attempts).toBe(0);
      expect(rows("select count(*) as n from app__action_log where action_id = ?", mine)[0]).toEqual({ n: 0 });
      expect(rows("select count(*) as n from app__visits where job_id = ?", "jb_bilals_job")[0]).toEqual({ n: 0 });
      expect(await status(page)).not.toContain("Sending");
    } finally {
      await ctx.close();
    }
  }, 60_000);

  test("a job the office cancelled meanwhile: the action is refused with its reason, the later ones of that job are not sent", async () => {
    const JOB = "jb_seed_06";
    const ctx = await (browser as Browser).newContext();
    try {
      const page = await openVisit(ctx, JOB);
      await ctx.setOffline(true);
      await page.locator("#checkin-form button[type=submit]").click();
      await statusIs(page, "1 action waiting to be sent");
      await sleep(1100);
      await page.locator("#f-description").fill("Bait station");
      await page.locator("#part-form button[type=submit]").click();
      await statusIs(page, "2 actions waiting to be sent");

      // The office cancels the job while the phone has no signal.
      sqlite.run("update app__jobs set status = 'cancelled' where id = ?", [JOB]);
      await ctx.setOffline(false);
      await statusHas(page, "The office cancelled this job. Nothing was saved.");
      expect(await status(page)).toBe("2 saved actions were not accepted by the server: The office cancelled this job. Nothing was saved.");
      const left = await stored(page);
      expect(left.map((r) => [r.action, r.state, r.refused_reason ?? null])).toEqual([
        ["checkin", "refused", "job_cancelled"],
        ["part", "pending", null],
      ]);
      expect(rows("select count(*) as n from app__visits where job_id = ?", JOB)[0]).toEqual({ n: 0 });
      expect(rows("select count(*) as n from app__action_log where visit_job_id = ?", JOB)[0]).toEqual({ n: 0 });
      expect(rows("select count(*) as n from app__visit_parts where description = ?", "Bait station")[0]).toEqual({ n: 0 });
      // Nothing keeps trying: a second look a moment later finds the same.
      await sleep(1500);
      expect((await stored(page)).map((r) => r.state)).toEqual(["refused", "pending"]);
    } finally {
      await ctx.close();
    }
  }, 90_000);
});
