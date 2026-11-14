// #810, the epic's Definition of Done (#805): a technician works a whole visit with no signal and nothing is lost
// or done twice.
//
// 1. The full offline visit. Online, Ali opens /me (the service worker keeps today's visits); `context.setOffline(true)`;
//    he opens the visit, checks in, adds a part, writes a note, adds two photos, types the customer's name as the
//    signature and checks out; the page shows everything as waiting. Back online, within 15 s the status line says
//    "All sent" and the database holds the visit, the part, the note, the two photos, the signature name and the
//    check-out, with the times in the order they were made, once each; the dispatcher's board shows the job done.
//    This needs a worker with the PDF engine (the check-out builds the visit report): without it the test fails
//    with a message that says so, it does not pass.
// 2. The office cancels the job while the phone is offline. Back online the check-in is refused with job_cancelled,
//    the later actions are not sent, /me lists them under "Needs attention" (the job, what each was, why, Discard and
//    Call the office, no Try again), the sign-out link warns first, the dispatcher has one notification and the job's
//    timeline shows the refusal; Discard asks in the page (no browser dialog) and empties the list.
// 3. The queue's records put on the device again and replayed change nothing (also needs the PDF engine).
// 4. The office gives the job to another technician meanwhile and back: the check-in is refused with job_reassigned,
//    "Try again" sends the same action ids and the visit is on the server once.
//
// The queue, public/me.js, the service worker, the visit page, /me and the job page in Chromium, against this app
// under `renox dev` with its demo seed. Runs when RENOX_WORKER_PATH points at a renox-worker and Playwright is
// installed (PLAYWRIGHT_PATH, as in cli/tests/browser/); under RENOX_JOURNEY=1 (`make journey`, journey.yml) it fails
// instead of skipping. It needs this repository (the CLI's `renox dev`), so it skips in a copy of the example that has
// no cli/ beside it, and inside `renox test` (which sets RENOX_TEST_SPEC). The service worker stores a page only when it
// carries `x-hs-offline-ok` (STAND-IN, to be removed with #832: ./stand-in.ts adds that header).
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
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
  click(): Promise<void>;
  fill(v: string): Promise<void>;
  setInputFiles(f: { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
  first(): Locator;
}
interface Dialog {
  message(): string;
  dismiss(): Promise<void>;
}
interface Page {
  on(event: "dialog", handler: (d: Dialog) => void): void;
  goto(url: string, o?: { waitUntil?: string }): Promise<{ status(): number; headers(): Record<string, string> } | null>;
  locator(s: string): Locator;
  evaluate<T>(f: string | ((a: unknown) => T | Promise<T>), arg?: unknown): Promise<T>;
  waitForFunction(f: string | ((a: unknown) => unknown), arg?: unknown, o?: { timeout?: number }): Promise<unknown>;
  waitForURL(u: string | RegExp, o?: { timeout?: number }): Promise<void>;
  reload(): Promise<unknown>;
  close(): Promise<void>;
}
interface Route {
  fetch(): Promise<unknown>;
  abort(): Promise<void>;
  continue(): Promise<void>;
}
interface Context {
  newPage(): Promise<Page>;
  route(url: RegExp, handler: (route: Route) => Promise<void>): Promise<void>;
  unroute(url: RegExp): Promise<void>;
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


/** What the device keeps for one photo (public/offline-queue-core.js), the blob read as its type and size. */
interface Photo {
  id: number;
  user_id: string;
  job_id: string;
  phase: string;
  caption: string;
  type: string;
  size: number;
  taken_at: number;
  action_id: string;
  state: string;
  attempts?: number;
  refused_reason?: string;
  refused_message?: string;
  blob: { type: string; size: number; width: number; height: number } | null;
}

const DINA = { email: "dispatcher.dubai@fixit.example" };

describe.skipIf(!worker || !playwright || !inRepo || insideRenoxTest)("a whole visit with no signal, in Chromium", () => {
  let dev: Dev;
  let proxy: { port: number; stop: () => void };
  let browser: Browser;
  let base: string;
  let sqlite: Database;

  beforeAll(async () => {
    // A copy of the example at the repository's depth (tsconfig.base.json is two levels up), seeded like `renox db seed`.
    const root = mkdtempSync(join(tmpdir(), "renox-offline-visit-"));
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
  const count = (sql: string, ...params: (string | number)[]): number => Number((rows<{ n: number }>(sql, ...params)[0] as { n: number }).n);

  let serial = 0;
  /** A scheduled job of Ali's today in Dubai of its own (a copy of the seed's jb_seed_10), so a test never meets another's state. */
  function newJob(): string {
    serial += 1;
    const id = `jb_visit_${serial}`;
    sqlite.run(
      "insert into app__jobs (id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, scheduled_start, scheduled_end, technician_user_id, booking_id, created_by, created_at, updated_at, source) select ?, branch_id, customer_id, site_id, null, ?, 'scheduled', priority, service_id, description, scheduled_start, scheduled_end, 'u_dxb_ali', null, created_by, created_at, updated_at, source from app__jobs where id = 'jb_seed_10'",
      [id, `J-8${String(serial).padStart(5, "0")}`],
    );
    return id;
  }

  async function signInAs(ctx: Context, who: { email: string }, next: string, landed: RegExp): Promise<Page> {
    const page = await ctx.newPage();
    await page.goto(`${base}/auth/login?next=${next}`);
    await page.locator('input[name="email"]').fill(who.email);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(landed, { timeout: 20_000 });
    return page;
  }
  /** A phone: its own context, signed in as Ali, on /me. */
  const phone = (ctx: Context): Promise<Page> => signInAs(ctx, ALI, "/me", /\/me$/u);

  /**
   * Today's list opened online with the service worker in control: /me and the visits it lists are kept, with the
   * scripts. `job` is a visit of today's list.
   */
  async function openToday(ctx: Context, job: string): Promise<Page> {
    const page = await phone(ctx);
    await until("the service worker is active", () => page.evaluate(`navigator.serviceWorker.ready.then((r) => r.active !== null)`), 20_000);
    await page.reload();
    await until("the worker controls the page", () => page.evaluate(`navigator.serviceWorker.controller !== null`), 15_000);
    await page.reload();
    await until(
      "/me, the visit and the scripts are kept",
      () =>
        page.evaluate(`(async () => {
          const shell = (await (await caches.open("hs-shell-v1")).keys()).map((r) => new URL(r.url).pathname);
          const kept = new Set();
          for (const n of (await caches.keys()).filter((k) => k.startsWith("hs-day-v1-"))) for (const r of await (await caches.open(n)).keys()) kept.add(new URL(r.url).pathname);
          return kept.has("/me") && kept.has("/me/visits/${job}") && ["offline-queue-core", "offline-queue", "visit", "me", "upload"].every((f) => f === "upload" || shell.some((p) => new RegExp("^/" + f + "\\.[0-9a-f]{16}\\.js$").test(p)));
        })()`),
      30_000,
    );
    return page;
  }

  /** The device's records of one store, in the order they were made (blobs as their size and type). */
  const device = <T>(page: Page, store: "actions" | "photos"): Promise<T[]> =>
    page.evaluate(`new Promise((ok, no) => {
      const open = indexedDB.open("hs-offline");
      open.onerror = () => no(open.error);
      open.onsuccess = () => {
        const all = open.result.transaction("${store}").objectStore("${store}").getAll();
        all.onsuccess = () => { open.result.close(); ok(all.result.map((r) => ({ ...r, blob: r.blob ? { type: r.blob.type, size: r.blob.size } : null })).sort((a, b) => (a.seq ?? a.id) - (b.seq ?? b.id))); };
      };
    })`);
  const actions = (page: Page): Promise<Stored[]> => device<Stored>(page, "actions");
  const photos = (page: Page): Promise<Photo[]> => device<Photo>(page, "photos");

  /** An image drawn in the page, as the bytes of a file. */
  async function image(page: Page, width: number, height: number, type: "image/jpeg" | "image/png"): Promise<Buffer> {
    const url = await page.evaluate<string>(`(() => {
      const c = document.createElement("canvas");
      c.width = ${width}; c.height = ${height};
      const x = c.getContext("2d");
      const g = x.createLinearGradient(0, 0, ${width}, ${height});
      g.addColorStop(0, "#c0392b"); g.addColorStop(0.5, "#f1c40f"); g.addColorStop(1, "#2980b9");
      x.fillStyle = g; x.fillRect(0, 0, ${width}, ${height});
      return c.toDataURL("${type}", 0.9);
    })()`);
    return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  }

  const status = (page: Page): Promise<string> => page.locator("#queue-status").innerText();
  const statusIs = (page: Page, text: string, timeout = 30_000): Promise<void> => until(`the status line is "${text}"`, async () => (await status(page)) === text, timeout);
  const text = (page: Page, selector: string): Promise<string> => page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
  const attr = (page: Page, selector: string, name: string): Promise<string | null> => page.evaluate<string | null>(`document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`);

  /** The refusal notifications of the dispatchers of the branch for a job. */
  const told = (job: string) => rows<{ user_id: string; title: string }>("select user_id, title from notifications__items where link = ? and title like '%was refused%' order by id", `/jobs/${job}`);
  const events = (job: string) => rows<{ note: string; by_user_id: string }>("select note, by_user_id from app__job_events where job_id = ? and note like 'offline_action_refused%' order by id", job);
  const clock = (ms: number): string => new Date(ms + 4 * 3_600_000).toISOString().slice(11, 16);

  /** Waits for the replay of a phone whose queue ends in a check-out that a worker without the PDF engine cannot build. */
  async function sentOrNoPdf(page: Page): Promise<void> {
    let noPdf = false;
    await until(
      "the queue is sent (or the check-out fails for want of the PDF engine)",
      async () => {
        const left = await actions(page);
        noPdf = left.length === 1 && left[0]?.action === "checkout" && left[0].attempts >= 1;
        return noPdf || left.length === 0;
      },
      60_000,
    );
    if (noPdf) throw new Error("the full offline visit needs a worker with the PDF engine (renox-worker built with the default features): the server could not build the check-out's report");
  }

  test("a whole visit with no signal: check-in, part, note, two photos, signature, check-out; back online it all reaches the server once, in order; the board shows the job done", async () => {
    const JOB = "jb_seed_10";
    const ctx = await (browser as Browser).newContext();
    const office = await (browser as Browser).newContext();
    try {
      const page = await openToday(ctx, JOB);
      expect(count("select count(*) as n from app__visits where job_id = ?", JOB)).toBe(0);
      const first = await image(page, 1800, 1200, "image/jpeg");
      const second = await image(page, 900, 1400, "image/png");

      await ctx.setOffline(true);
      // From the kept /me to the kept visit page.
      await page.locator(`#visit-${JOB} a`).click();
      await until("the visit page, from the phone's copy", async () => (await page.locator("#checkin-form").count()) === 1);
      await until("the banner says the page is a saved copy", async () => (await page.locator("#offline-banner").isVisible()) === true);

      await page.locator("#checkin-form button[type=submit]").click();
      await statusIs(page, "1 action waiting to be sent");
      await until("the photo forms", async () => (await page.locator("#photo-form-before input[type=file]").count()) === 1 && (await page.locator("#photo-form-after input[type=file]").count()) === 1);
      await sleep(1100);

      await page.locator("#f-description").fill("Copper joint 15 mm");
      await page.locator("#f-qty").fill("2");
      await page.locator("#f-price").fill("12.50");
      await page.locator("#part-form button[type=submit]").click();
      await statusIs(page, "2 actions waiting to be sent");
      await sleep(1100);

      await page.locator("#f-notes").fill("Replaced the leaking joint under the sink.");
      await page.locator("#notes form button[type=submit]").click();
      await statusIs(page, "3 actions waiting to be sent");
      expect(await page.locator("#notes").innerText()).toContain("not sent yet");
      await sleep(1100);

      // Two photos: the before one with a caption, the after one too.
      await page.locator("#photo-form-before input[type=file]").setInputFiles({ name: "joint.jpg", mimeType: "image/jpeg", buffer: first });
      await until("the first photo is kept", async () => (await photos(page)).length === 1);
      await page.locator("#photo-form-before input[name=caption]").fill("The leaking joint");
      await page.locator("#photo-form-before button[type=submit]").click();
      await until("its caption is kept", async () => (await photos(page))[0]?.caption === "The leaking joint");
      await sleep(1100);
      await page.locator("#photo-form-after input[type=file]").setInputFiles({ name: "dry.png", mimeType: "image/png", buffer: second });
      await until("the second photo is kept", async () => (await photos(page)).length === 2);
      await page.locator("#photo-form-after input[name=caption]").fill("The new joint, dry");
      await page.locator("#photo-form-after button[type=submit]").click();
      await until("its caption is kept", async () => (await photos(page))[1]?.caption === "The new joint, dry");
      await statusIs(page, "5 actions waiting to be sent");
      await sleep(1100);

      await page.locator("#f-signed_by").fill("Omar Al Farsi");
      await page.locator("#sig-typed").click();
      await page.locator("#signature-form button[type=submit]").click();
      await statusIs(page, "6 actions waiting to be sent");
      expect(await page.locator("#signature").innerText()).toContain("not sent yet");
      await sleep(1100);

      await page.locator("#checkout-form button[type=submit]").click();
      await statusIs(page, "7 actions waiting to be sent");

      // The page shows everything as waiting.
      expect(await page.locator("#checkin").innerText()).toMatch(/Checked in \d{4}-\d{2}-\d{2} \d{2}:\d{2} · not sent yet/u);
      expect(await page.locator("#checkout").innerText()).toMatch(/Checked out \d{4}-\d{2}-\d{2} \d{2}:\d{2} · not sent yet/u);
      expect(await page.locator("#offline-parts li").first().innerText()).toMatch(/^Copper joint 15 mm · 2 × 12\.50 · not sent yet$/u);
      expect(await page.locator("[data-offline-key=notes]").count()).toBe(1);
      expect(await page.locator("[data-offline-key=signature]").count()).toBe(1);
      for (const phase of ["before", "after"]) expect(await page.locator(`#offline-photos-${phase} li`).innerText(), phase).toContain("not sent yet");
      const queued = await actions(page);
      const kept = await photos(page);
      expect(queued.map((r) => r.action)).toEqual(["checkin", "part", "notes", "signature", "checkout"]);
      expect(kept.map((p) => [p.phase, p.caption, p.state])).toEqual([["before", "The leaking joint", "pending"], ["after", "The new joint, dry", "pending"]]);
      expect(count("select count(*) as n from app__visits where job_id = ?", JOB)).toBe(0);

      // Online again: within 15 s "All sent".
      await ctx.setOffline(false);
      const online = Date.now();
      await sentOrNoPdf(page);
      await statusIs(page, "All sent", 15_000);
      expect(Date.now() - online).toBeLessThan(45_000);

      // The server holds it, once each, with the times in the order they were made.
      const visit = rows<{ id: string; checkin_at: number; checkout_at: number; notes: string; signed_by_name: string; signature_key: string | null }>("select id, checkin_at, checkout_at, notes, signed_by_name, signature_key from app__visits where job_id = ?", JOB);
      expect(visit.length).toBe(1);
      const v = visit[0] as (typeof visit)[number];
      expect(v.notes).toBe("Replaced the leaking joint under the sink.");
      expect(v.signed_by_name).toBe("Omar Al Farsi");
      expect(v.signature_key).not.toBeNull();
      const made = (action: string) => Math.floor((queued.find((r) => r.action === action) as Stored).performed_at / 1000);
      expect(v.checkin_at).toBe(made("checkin"));
      expect(v.checkout_at).toBe(made("checkout"));
      expect(made("checkin")).toBeLessThan(made("part"));
      expect(made("part")).toBeLessThan(made("notes"));
      expect(made("notes")).toBeLessThan(Math.floor((kept[0] as Photo).taken_at / 1000));
      expect(Math.floor((kept[0] as Photo).taken_at / 1000)).toBeLessThan(Math.floor((kept[1] as Photo).taken_at / 1000));
      expect(Math.floor((kept[1] as Photo).taken_at / 1000)).toBeLessThan(made("signature"));
      expect(made("signature")).toBeLessThan(v.checkout_at);
      expect(rows("select description, qty, unit_price_fils from app__visit_parts where visit_id = ?", v.id)).toEqual([{ description: "Copper joint 15 mm", qty: 2, unit_price_fils: 1250 }]);
      const shots = rows<{ phase: string; caption: string; file_key: string }>("select phase, caption, file_key from app__visit_photos where visit_id = ? order by id", v.id);
      expect(shots.map((p) => [p.phase, p.caption])).toEqual([["before", "The leaking joint"], ["after", "The new joint, dry"]]);
      expect(shots.every((p) => p.file_key.startsWith(`storage/${v.id}/`))).toBe(true);
      expect(rows<{ status: string }>("select status from app__jobs where id = ?", JOB)[0]?.status).toBe("done");
      // Every action once, in the order they were made, under the ids the phone gave them.
      const log = rows<{ action_id: string; action: string; status: number }>("select action_id, action, status from app__action_log where visit_job_id = ? order by rowid", JOB);
      expect(log.map((l) => l.action)).toEqual(["checkin", "part", "notes", "photo", "photo", "signature", "checkout"]);
      expect(log.every((l) => l.status === 200)).toBe(true);
      expect(log.map((l) => l.action_id)).toEqual([queued[0], queued[1], queued[2], kept[0], kept[1], queued[3], queued[4]].map((r) => (r as { action_id: string }).action_id));
      expect(await actions(page)).toEqual([]);
      expect(await photos(page)).toEqual([]);
      // Nothing was refused, so the office was told nothing.
      expect(events(JOB)).toEqual([]);
      expect(told(JOB)).toEqual([]);

      // The dispatcher's board shows the job in the done column.
      const board = await signInAs(office, DINA, "/dispatch", /\/dispatch$/u);
      await until("the job is in the done column", async () => (await board.evaluate<string | null>(`document.getElementById("job-${JOB}")?.closest("section")?.getAttribute("aria-labelledby") ?? null`)) === "head-done");
    } finally {
      await ctx.close();
      await office.close();
    }
  }, 240_000);

  test("the office cancels the job meanwhile: the check-in is refused, the later steps are not sent, /me lists them under Needs attention, the dispatcher is told once; Discard asks in the page and empties the list", async () => {
    const JOB = "jb_seed_05";
    const number = "J-000005";
    const ctx = await (browser as Browser).newContext();
    const office = await (browser as Browser).newContext();
    try {
      const page = await openToday(ctx, JOB);
      const dialogs: string[] = [];
      page.on("dialog", (d) => {
        dialogs.push(d.message());
        void d.dismiss();
      });
      const small = await image(page, 400, 300, "image/png");
      await ctx.setOffline(true);
      await page.locator(`#visit-${JOB} a`).click();
      await until("the visit page, from the phone's copy", async () => (await page.locator("#checkin-form").count()) === 1);
      await page.locator("#checkin-form button[type=submit]").click();
      await statusIs(page, "1 action waiting to be sent");
      await until("the photo forms", async () => (await page.locator("#photo-form-after input[type=file]").count()) === 1);
      const done = Date.now();
      await sleep(1100);
      await page.locator("#f-description").fill("Filter");
      await page.locator("#f-qty").fill("2");
      await page.locator("#part-form button[type=submit]").click();
      await statusIs(page, "2 actions waiting to be sent");
      await sleep(1100);
      await page.locator("#photo-form-after input[type=file]").setInputFiles({ name: "unit.png", mimeType: "image/png", buffer: small });
      await until("the photo is kept", async () => (await photos(page)).length === 1);
      await page.locator("#photo-form-after button[type=submit]").click();
      await statusIs(page, "3 actions waiting to be sent");

      // The dispatcher cancels the job from the office page.
      const desk = await signInAs(office, DINA, `/jobs/${JOB}`, new RegExp(`/jobs/${JOB}$`, "u"));
      await desk.locator("#cancel button[type=submit]").click();
      await until("the job is cancelled", async () => rows<{ status: string }>("select status from app__jobs where id = ?", JOB)[0]?.status === "cancelled");

      // Back online: the check-in is refused with its reason; nothing after it is sent.
      await ctx.setOffline(false);
      await until("the check-in is refused", async () => (await actions(page))[0]?.state === "refused");
      const left = await actions(page);
      expect(left.map((r) => [r.action, r.state, r.refused_reason ?? null])).toEqual([["checkin", "refused", "job_cancelled"], ["part", "pending", null]]);
      expect((await photos(page)).map((p) => [p.state, p.refused_reason ?? null])).toEqual([["pending", null]]);
      expect(left[0]?.job_id).toBe(JOB);
      await sleep(1200);
      expect(count("select count(*) as n from app__visits where job_id = ?", JOB)).toBe(0);
      expect(count("select count(*) as n from app__action_log where visit_job_id = ?", JOB)).toBe(0);
      expect(count("select count(*) as n from app__visit_parts where description = 'Filter'")).toBe(0);

      // The office knows: one event, one notification (and no more for the steps behind it).
      await until("the office was told", async () => told(JOB).length === 1);
      const note = told(JOB)[0] as { user_id: string; title: string };
      expect(note.user_id).toBe("u_dxb_dispatcher");
      expect(note.title).toBe(`Ali Hassan's check-in for ${number}, done offline at ${clock(left[0]?.performed_at as number)}, was refused: the job was cancelled`);
      expect(events(JOB).length).toBe(1);
      expect(events(JOB)[0]?.by_user_id).toBe(ALI.id);
      expect(count("select count(*) as n from notifications__items where user_id = 'u_shj_dispatcher' and title like '%was refused%'")).toBe(0);
      await desk.goto(`${base}/jobs/${JOB}`);
      expect(await text(desk, "#timeline")).toContain(`Offline check-in refused: the job was cancelled (done on the phone at ${clock(left[0]?.performed_at as number)})`);

      // /me: the list.
      await page.goto(`${base}/me`);
      await until("Needs attention is shown", async () => (await page.locator("#needs-attention").isVisible()) === true);
      expect(await attr(page, "#needs-attention", "aria-live")).toBe("polite");
      const list = await text(page, "#needs-attention");
      expect(list).toContain("Needs attention");
      expect(list).toContain(number);
      expect(list).toContain("Check-in");
      expect(list).toContain("Part: Filter × 2");
      expect(list).toContain("Photo (after)");
      expect(list).toContain("done on the phone at");
      expect(list).toContain("The office cancelled this job. Nothing was saved.");
      expect(list).toContain("The later steps of this visit were not sent either.");
      expect(await page.locator("#needs-attention li").count()).toBe(3);
      expect(await page.locator("#needs-attention [data-attention=discard]").count()).toBe(1);
      expect(await page.locator("#needs-attention [data-attention=retry]").count()).toBe(0);
      expect(await attr(page, "#needs-attention [data-attention=call]", "href")).toMatch(/^tel:\+?\d+$/u);
      expect(await text(page, "#needs-attention [data-attention=call]")).toBe("Call the office");
      // The customer is named too.
      expect(await text(page, "#needs-attention h3")).toMatch(/J-000005 · \S/u);
      // The refused job is not on today's list any more, yet the list names it: the phone kept the job's number.
      expect(await page.locator(`#visit-${JOB}`).count()).toBe(0);
      await sleep(1000);
      expect((await actions(page)).map((r) => r.state)).toEqual(["refused", "pending"]);

      // Signing out: the link is the warning page while something is saved and not sent.
      await until("the sign-out link warns", async () => (await attr(page, '.site-header .renox-user-menu a', "href")) === "/me/signout");
      await page.locator(".site-header .renox-user-menu a").click();
      await page.waitForURL(/\/me\/signout$/u);
      await until("the count is written", async () => (await text(page, "#signout-text")) === "3 actions are saved on this phone and not sent. Sign out anyway?");
      expect(await page.locator("form[action='/auth/account?/logout'] button").count()).toBe(1);
      await page.locator("#signout-stay").click();
      await page.waitForURL(/\/me$/u);
      await until("Needs attention is shown again", async () => (await page.locator("#needs-attention").isVisible()) === true);

      // Discard asks in the page first. Keep: nothing changes. Yes: the list empties, the device too.
      await page.locator("#needs-attention [data-attention=discard]").click();
      await until("the question is in the page", async () => (await page.locator("#needs-attention [data-attention-confirm]").count()) === 1);
      expect(await text(page, "#needs-attention [data-attention-confirm]")).toContain("Discard these 3 saved steps of this visit from this phone? This cannot be undone.");
      await page.locator("#needs-attention [data-attention=discard-no]").click();
      await until("the question is closed", async () => (await page.locator("#needs-attention [data-attention-confirm]").count()) === 0);
      expect((await actions(page)).length).toBe(2);
      await page.locator("#needs-attention [data-attention=discard]").click();
      await until("the question is in the page again", async () => (await page.locator("#needs-attention [data-attention-confirm]").count()) === 1);
      await page.locator("#needs-attention [data-attention=discard-yes]").click();
      await until("the list is empty and hidden", async () => (await page.locator("#needs-attention").isHidden()) === true);
      expect(await actions(page)).toEqual([]);
      expect(await photos(page)).toEqual([]);
      expect(await status(page)).toBe("");
      await until("the sign-out link is the account page again", async () => (await attr(page, ".site-header .renox-user-menu a", "href")) === "/auth/account");
      await page.reload();
      await until("the page is back", async () => (await page.locator("#queue-status").count()) === 1);
      expect(await page.locator("#needs-attention").isHidden()).toBe(true);
      // No browser dialog was used, and discarding told the office nothing more.
      expect(dialogs).toEqual([]);
      expect(told(JOB).length).toBe(1);
    } finally {
      await ctx.close();
      await office.close();
    }
  }, 240_000);

  test("the queue's records put on the device again and replayed change nothing", async () => {
    const JOB = newJob();
    const ctx = await (browser as Browser).newContext();
    try {
      const page = await openToday(ctx, JOB);
      const picture = await image(page, 300, 200, "image/jpeg");
      await ctx.setOffline(true);
      await page.locator(`#visit-${JOB} a`).click();
      await until("the visit page, from the phone's copy", async () => (await page.locator("#checkin-form").count()) === 1);
      await page.locator("#checkin-form button[type=submit]").click();
      await statusIs(page, "1 action waiting to be sent");
      await until("the photo forms", async () => (await page.locator("#photo-form-before input[type=file]").count()) === 1);
      await sleep(1100);
      await page.locator("#f-description").fill("Gasket");
      await page.locator("#part-form button[type=submit]").click();
      await statusIs(page, "2 actions waiting to be sent");
      await sleep(1100);
      await page.locator("#photo-form-before input[type=file]").setInputFiles({ name: "gasket.jpg", mimeType: "image/jpeg", buffer: picture });
      await until("the photo is kept", async () => (await photos(page)).length === 1);
      await page.locator("#photo-form-before button[type=submit]").click();
      await statusIs(page, "3 actions waiting to be sent");
      await sleep(1100);
      await page.locator("#checkout-form button[type=submit]").click();
      await statusIs(page, "4 actions waiting to be sent");

      // A copy of the records (the photo's blob too) in a database of the test's own, to put them back later.
      await page.evaluate(`new Promise((ok, no) => {
        const src = indexedDB.open("hs-offline");
        src.onerror = () => no(src.error);
        src.onsuccess = () => {
          const db = src.result;
          const a = db.transaction("actions").objectStore("actions").getAll();
          a.onsuccess = () => {
            const p = db.transaction("photos").objectStore("photos").getAll();
            p.onsuccess = () => {
              db.close();
              const dst = indexedDB.open("hs-test-copy", 1);
              dst.onupgradeneeded = () => dst.result.createObjectStore("copy");
              dst.onerror = () => no(dst.error);
              dst.onsuccess = () => {
                const tx = dst.result.transaction("copy", "readwrite");
                tx.objectStore("copy").put({ actions: a.result, photos: p.result }, "queue");
                tx.oncomplete = () => { dst.result.close(); ok(); };
              };
            };
          };
        };
      })`);

      await ctx.setOffline(false);
      await sentOrNoPdf(page);
      await until("the photos are sent", async () => (await photos(page)).length === 0);
      await statusIs(page, "All sent", 20_000);
      const snapshot = () =>
        JSON.stringify([
          rows("select * from app__visits where job_id = ?", JOB),
          rows("select p.id, p.phase, p.caption, p.file_key, p.created_at from app__visit_photos p join app__visits v on v.id = p.visit_id where v.job_id = ?", JOB),
          rows("select * from app__visit_parts where visit_id in (select id from app__visits where job_id = ?)", JOB),
          rows("select * from app__action_log where visit_job_id = ?", JOB),
          rows("select * from app__jobs where id = ?", JOB),
          rows("select * from app__job_events where job_id = ?", JOB),
        ]);
      const before = snapshot();
      expect(count("select count(*) as n from app__action_log where visit_job_id = ?", JOB)).toBe(4);

      // The same records, as they were, back on the device; the phone replays them.
      await page.evaluate(`new Promise((ok, no) => {
        const copy = indexedDB.open("hs-test-copy", 1);
        copy.onerror = () => no(copy.error);
        copy.onsuccess = () => {
          const g = copy.result.transaction("copy").objectStore("copy").get("queue");
          g.onsuccess = () => {
            copy.result.close();
            const open = indexedDB.open("hs-offline");
            open.onerror = () => no(open.error);
            open.onsuccess = () => {
              const tx = open.result.transaction(["actions", "photos"], "readwrite");
              for (const r of g.result.actions) { const { seq, ...rest } = r; tx.objectStore("actions").add(rest); }
              for (const r of g.result.photos) { const { id, ...rest } = r; tx.objectStore("photos").add(rest); }
              tx.oncomplete = () => { open.result.close(); ok(); };
              tx.onerror = () => no(tx.error);
            };
          };
        };
      })`);
      expect((await actions(page)).length).toBe(3);
      expect((await photos(page)).length).toBe(1);
      await page.evaluate(`window.dispatchEvent(new Event("online"))`);
      await until("the replayed records are answered and gone", async () => (await actions(page)).length === 0 && (await photos(page)).length === 0, 60_000);
      await sleep(500);
      expect(snapshot()).toBe(before);
      expect(count("select count(*) as n from app__action_log where visit_job_id = ?", JOB)).toBe(4);
      expect(count("select count(*) as n from app__visits where job_id = ?", JOB)).toBe(1);
      expect(count("select count(*) as n from app__visit_photos p join app__visits v on v.id = p.visit_id where v.job_id = ?", JOB)).toBe(1);
      // Nothing was refused: the office was told nothing.
      expect(events(JOB)).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 240_000);

  test("a job given to another technician and back: the check-in is refused with job_reassigned; Try again sends the same ids and the visit is on the server once", async () => {
    const JOB = newJob();
    const number = rows<{ number: string }>("select number from app__jobs where id = ?", JOB)[0]?.number as string;
    const ctx = await (browser as Browser).newContext();
    try {
      const page = await openToday(ctx, JOB);
      await ctx.setOffline(true);
      await page.locator(`#visit-${JOB} a`).click();
      await until("the visit page, from the phone's copy", async () => (await page.locator("#checkin-form").count()) === 1);
      await page.locator("#checkin-form button[type=submit]").click();
      await statusIs(page, "1 action waiting to be sent");
      await sleep(1100);
      await page.locator("#f-description").fill("Valve");
      await page.locator("#part-form button[type=submit]").click();
      await statusIs(page, "2 actions waiting to be sent");

      sqlite.run("update app__jobs set technician_user_id = 'u_dxb_bilal' where id = ?", [JOB]);
      await ctx.setOffline(false);
      await until("the check-in is refused", async () => (await actions(page))[0]?.state === "refused");
      expect((await actions(page)).map((r) => [r.action, r.state, r.refused_reason ?? null])).toEqual([["checkin", "refused", "job_reassigned"], ["part", "pending", null]]);
      const ids = (await actions(page)).map((r) => r.action_id);
      await until("the office was told", async () => told(JOB).length === 1);
      expect((told(JOB)[0] as { title: string }).title).toBe(`Ali Hassan's check-in for ${number}, done offline at ${clock((await actions(page))[0]?.performed_at as number)}, was refused: the job was given to another technician`);

      await page.goto(`${base}/me`);
      await until("Needs attention is shown", async () => (await page.locator("#needs-attention").isVisible()) === true);
      expect(await text(page, "#needs-attention")).toContain("This job was given to another technician. Nothing was saved.");
      expect(await page.locator("#needs-attention [data-attention=retry]").count()).toBe(1);

      // The office gives the job back; Try again sends the saved steps with their own ids.
      sqlite.run("update app__jobs set technician_user_id = 'u_dxb_ali' where id = ?", [JOB]);
      await page.locator("#needs-attention [data-attention=retry]").click();
      await until("everything is sent", async () => (await actions(page)).length === 0, 60_000);
      await until("the list is hidden", async () => (await page.locator("#needs-attention").isHidden()) === true);
      const visit = rows<{ id: string }>("select id from app__visits where job_id = ?", JOB);
      expect(visit.length).toBe(1);
      expect(rows("select description from app__visit_parts where visit_id = ?", (visit[0] as { id: string }).id)).toEqual([{ description: "Valve" }]);
      expect(rows<{ action_id: string }>("select action_id from app__action_log where visit_job_id = ? order by rowid", JOB).map((l) => l.action_id)).toEqual(ids);
      // Told once for the job and the reason, and nothing again for the success.
      expect(told(JOB).length).toBe(1);
      expect(events(JOB).length).toBe(1);
    } finally {
      await ctx.close();
    }
  }, 240_000);
});
