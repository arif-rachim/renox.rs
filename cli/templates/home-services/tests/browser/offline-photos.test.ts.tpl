// #809: photos taken with no signal. A technician offline checks in, takes a before and an after photo (two
// generated images, much larger than 1600 px, chosen with `setInputFiles`) and checks out; the page lists
// both photos as "not sent yet" with a Remove button, and keeps them after a reload; online again they reach
// the server once each, attached to the right phase with their captions, in the order they were taken, as JPEGs
// no wider than 1600 px; the same photos put on the device again and sent again change nothing. Also: the
// 21st waiting photo is refused with its message (and Remove makes room); a photo of a job the office
// cancelled meanwhile ends `refused` with its reason, and stays on the device until the technician removes it.
// The queue (public/offline-queue.js and its core), upload.js, public/me.js, the service worker and the visit
// page in Chromium, with `context.setOffline(true)`, against this app under `renox dev` with its demo seed.
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
  setInputFiles(f: { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
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

/** The pixel size a JPEG file says (its first start-of-frame marker), or null when the bytes are not a JPEG. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] as number;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const length = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number), width: ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number) };
    }
    i += 2 + length;
  }
  return null;
}

describe.skipIf(!worker || !playwright || !inRepo || insideRenoxTest)("photos taken offline in Chromium", () => {
  let dev: Dev;
  let proxy: { port: number; stop: () => void };
  let browser: Browser;
  let base: string;
  let sqlite: Database;
  let dir: string;

  beforeAll(async () => {
    // A copy of the example at the repository's depth (tsconfig.base.json is two levels up), seeded like `renox db seed`.
    const root = mkdtempSync(join(tmpdir(), "renox-offline-photos-"));
    copyFileSync(join(repo, "tsconfig.base.json"), join(root, "tsconfig.base.json"));
    const src = join(repo, "examples/home-services");
    dir = join(root, "examples/home-services");
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

  /**
   * Opens a visit page online, with the service worker in control and the page's scripts kept for offline;
   * `checkedIn` checks in first (online), so the page is the one of an open visit, with its photo forms and upload.js.
   */
  async function openVisit(ctx: Context, job: string, checkedIn: boolean): Promise<Page> {
    const page = await signIn(ctx);
    await page.goto(`${base}/me/visits/${job}`);
    if (checkedIn) {
      await page.locator("#checkin-form button[type=submit]").click();
      await until("the open visit of the server", async () => (await page.locator("#checkin").count()) === 0 && (await page.locator("#photo-form-before").count()) === 1);
    }
    // The worker takes control of the next navigation, once it is active.
    await until("the service worker is active", () => page.evaluate(`navigator.serviceWorker.ready.then((r) => r.active !== null)`), 20_000);
    await page.reload();
    await until("the worker controls the page", () => page.evaluate(`navigator.serviceWorker.controller !== null`), 15_000);
    await page.reload();
    const scripts = checkedIn ? ["offline-queue-core", "offline-queue", "visit", "me", "upload"] : ["offline-queue-core", "offline-queue", "visit", "me"];
    await until(
      "the page and its scripts are kept",
      () =>
        page.evaluate(`(async () => {
          const shell = (await (await caches.open("hs-shell-v1")).keys()).map((r) => new URL(r.url).pathname);
          let kept = false;
          for (const n of (await caches.keys()).filter((k) => k.startsWith("hs-day-v1-"))) kept = kept || (await (await caches.open(n)).keys()).some((r) => new URL(r.url).pathname === "/me/visits/${job}");
          return kept && ${JSON.stringify(scripts)}.every((f) => shell.some((p) => new RegExp("^/" + f + "\\.[0-9a-f]{16}\\.js$").test(p)));
        })()`),
      20_000,
    );
    expect(await page.locator("#queue-status").count()).toBe(1);
    return page;
  }

  /** The actions on the device, in seq order. */
  const actions = (page: Page): Promise<Stored[]> =>
    page.evaluate(`new Promise((ok, no) => {
      const open = indexedDB.open("hs-offline");
      open.onerror = () => no(open.error);
      open.onsuccess = () => {
        const all = open.result.transaction("actions").objectStore("actions").getAll();
        all.onsuccess = () => { open.result.close(); ok(all.result.sort((a, b) => a.seq - b.seq)); };
      };
    })`);

  /** The photos on the device, in the order they were taken; each blob as `{ type, size, width, height }` (read by the browser). */
  const photos = (page: Page): Promise<Photo[]> =>
    page.evaluate(`new Promise((ok, no) => {
      const open = indexedDB.open("hs-offline");
      open.onerror = () => no(open.error);
      open.onsuccess = () => {
        const all = open.result.transaction("photos").objectStore("photos").getAll();
        all.onsuccess = async () => {
          open.result.close();
          const out = [];
          for (const p of all.result.sort((a, b) => a.taken_at - b.taken_at || a.id - b.id)) {
            let blob = null;
            if (p.blob instanceof Blob) {
              const bitmap = await createImageBitmap(p.blob);
              blob = { type: p.blob.type, size: p.blob.size, width: bitmap.width, height: bitmap.height };
              bitmap.close();
            }
            out.push({ ...p, blob });
          }
          ok(out);
        };
      };
    })`);

  /** An image drawn in the page (a gradient with stripes, so it compresses like a picture does), as the bytes of a file. */
  async function image(page: Page, width: number, height: number, type: "image/jpeg" | "image/png"): Promise<Buffer> {
    const url = await page.evaluate<string>(`(() => {
      const c = document.createElement("canvas");
      c.width = ${width}; c.height = ${height};
      const x = c.getContext("2d");
      const g = x.createLinearGradient(0, 0, ${width}, ${height});
      g.addColorStop(0, "#c0392b"); g.addColorStop(0.5, "#f1c40f"); g.addColorStop(1, "#2980b9");
      x.fillStyle = g; x.fillRect(0, 0, ${width}, ${height});
      x.fillStyle = "rgba(0,0,0,0.35)";
      for (let i = 0; i < ${width}; i += 97) x.fillRect(i, 0, 17, ${height});
      return c.toDataURL("${type}", 0.92);
    })()`);
    return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  }

  /** The bytes the server stored under a key (`storage/<visit>/<name>`): the dev server keeps its files under .renox. */
  async function storedObject(_page: Page, key: string): Promise<{ type: string; bytes: Uint8Array }> {
    const name = key.slice(key.lastIndexOf("/") + 1);
    const found = Bun.spawnSync(["find", join(dir, ".renox"), "-type", "f", "-name", `*${name}*`]).stdout.toString().trim().split("\n").filter(Boolean);
    if (found.length === 0) throw new Error(`no stored file for ${key}: ${Bun.spawnSync(["find", join(dir, ".renox"), "-type", "f"]).stdout.toString()}`);
    return { type: "image/jpeg", bytes: new Uint8Array(await Bun.file(found[0] as string).arrayBuffer()) };
  }

  const status = (page: Page): Promise<string> => page.locator("#queue-status").innerText();
  const statusIs = (page: Page, text: string): Promise<void> => until(`the status line is "${text}"`, async () => (await status(page)) === text);
  const statusHas = (page: Page, text: string): Promise<void> => until(`the status line has "${text}"`, async () => (await status(page)).includes(text));

  /** Chooses a file in the photo form of a phase and waits until the device holds `count` photos. */
  async function choose(page: Page, phase: string, file: { name: string; mimeType: string; buffer: Buffer }, count: number): Promise<void> {
    await page.locator(`#photo-form-${phase} input[type=file]`).setInputFiles(file);
    await until(`${count} photo(s) on the device`, async () => (await photos(page)).length === count);
  }

  test("offline: check in, a before and an after photo, check out; both wait on the page and on the device; online: once each, in order, as JPEGs of at most 1600 px; the same photos sent again change nothing", async () => {
    const JOB = "jb_seed_10";
    const ctx = await (browser as Browser).newContext();
    try {
      const page = await openVisit(ctx, JOB, false);
      // Before the check-in the page has no photo form: it is made once a check-in is queued.
      expect(await page.locator("#photo-form-before").count()).toBe(0);
      const big = await image(page, 2400, 1800, "image/jpeg");
      const tall = await image(page, 1200, 3000, "image/png");
      expect(jpegSize(big)).toEqual({ width: 2400, height: 1800 });

      await ctx.setOffline(true);
      await page.locator("#checkin-form button[type=submit]").click();
      await statusIs(page, "1 action waiting to be sent");
      await until("the photo forms", async () => (await page.locator("#photo-form-before input[type=file]").count()) === 1 && (await page.locator("#photo-form-after input[type=file]").count()) === 1);
      expect(await page.locator("#photo-form-before").isVisible()).toBe(true);

      // The before photo: chosen (kept at once), then its caption and "Add a photo".
      await choose(page, "before", { name: "leak.jpg", mimeType: "image/jpeg", buffer: big }, 1);
      await page.locator("#photo-form-before input[name=caption]").fill("The leaking joint");
      await page.locator("#photo-form-before button[type=submit]").click();
      await until("its caption is kept", async () => (await photos(page))[0]?.caption === "The leaking joint");
      await until("the caption field is empty for the next photo", async () => (await page.locator("#photo-form-before input[name=caption]").inputValue()) === "");
      await sleep(60);
      // The after photo, with its caption typed before the file is chosen.
      await page.locator("#photo-form-after input[name=caption]").fill("The new joint, dry");
      await choose(page, "after", { name: "dry.png", mimeType: "image/png", buffer: tall }, 2);
      await page.locator("#photo-form-after button[type=submit]").click();
      await statusIs(page, "3 actions waiting to be sent");
      await sleep(60);
      await page.locator("#checkout-form button[type=submit]").click();
      await statusIs(page, "4 actions waiting to be sent");

      // Both photos wait on the page, each in its phase: the picture, its caption, "not sent yet" and Remove.
      for (const [phase, caption] of [["before", "The leaking joint"], ["after", "The new joint, dry"]] as const) {
        expect(await page.locator(`#offline-photos-${phase} li`).count(), phase).toBe(1);
        const text = await page.locator(`#offline-photos-${phase} li`).innerText();
        expect(text, phase).toContain(caption);
        expect(text, phase).toContain("not sent yet");
        expect(text, phase).toContain("Remove");
        expect(await page.locator(`#offline-photos-${phase} li canvas`).count(), phase).toBe(1);
        expect(await page.locator(`#offline-photos-${phase} li button[data-offline-remove]`).count(), phase).toBe(1);
      }
      // What the device keeps: two pending photos, JPEGs of at most 1600 px (the originals were larger), in the order taken.
      const kept = await photos(page);
      expect(kept.map((p) => [p.phase, p.caption, p.state, p.user_id, p.job_id])).toEqual([
        ["before", "The leaking joint", "pending", ALI.id, JOB],
        ["after", "The new joint, dry", "pending", ALI.id, JOB],
      ]);
      for (const p of kept) {
        expect(p.type).toBe("image/jpeg");
        expect(p.blob?.type).toBe("image/jpeg");
        expect(p.size).toBe(p.blob?.size as number);
        expect(Math.max(p.blob?.width as number, p.blob?.height as number)).toBe(1600);
        expect(p.size).toBeLessThan(big.length);
        expect(p.action_id).toMatch(/^[0-9a-f]{32}$/u);
      }
      expect([kept[0]?.blob?.width, kept[0]?.blob?.height]).toEqual([1600, 1200]);
      expect([kept[1]?.blob?.width, kept[1]?.blob?.height]).toEqual([640, 1600]);
      expect(kept[0]?.taken_at).toBeLessThan(kept[1]?.taken_at as number);
      expect(new Set(kept.map((p) => p.action_id)).size).toBe(2);
      const queued = await actions(page);
      expect(queued.map((r) => r.action)).toEqual(["checkin", "checkout"]);
      expect(rows("select count(*) as n from app__visits where job_id = ?", JOB)[0]).toEqual({ n: 0 });

      // A reload offline: the page comes from its saved copy and shows the photos again, once each.
      await page.reload();
      await statusIs(page, "4 actions waiting to be sent");
      await until("the photos are listed again", async () => (await page.locator("#offline-photos-before li").count()) === 1 && (await page.locator("#offline-photos-after li").count()) === 1);
      expect(await page.locator("#photo-form-before").count()).toBe(1);
      expect((await photos(page)).length).toBe(2);

      // Online again: the check-in, the two photos, the check-out, in the order they were made. The answer to the
      // first photo's `photo` action is lost on the way (the server has done it, the phone never hears): the phone
      // keeps the photo and sends it again, with the same action id, and the server must not make a second photo.
      const photoAction = new RegExp(`/me/visits/${JOB}\\?/photo$`, "u");
      let lost = 0;
      await ctx.route(photoAction, async (route) => {
        if (lost++ > 0) return route.continue();
        await route.fetch();
        await route.abort();
      });
      await ctx.setOffline(false);
      await until("the first photo was sent and its answer lost", async () => lost >= 1 && (await photos(page))[0]?.attempts === 1, 60_000);
      expect(rows("select count(*) as n from app__visit_photos p join app__visits v on v.id = p.visit_id where v.job_id = ?", JOB)[0]).toEqual({ n: 1 });
      await ctx.unroute(photoAction);
      await page.evaluate(`window.dispatchEvent(new Event("online"))`);
      // A worker without a PDF engine cannot build the check-out's report (the server answers 500 and the queue keeps it).
      await until(
        "the photos and the actions are sent",
        async () => {
          const left = await actions(page);
          return (await photos(page)).length === 0 && (left.length === 0 || (left.length === 1 && left[0]?.action === "checkout" && left[0].attempts >= 1));
        },
        60_000,
      );
      const visit = rows<{ id: string }>("select id from app__visits where job_id = ?", JOB);
      expect(visit.length).toBe(1);
      const visitId = (visit[0] as { id: string }).id;
      const server = rows<{ phase: string; caption: string; file_key: string; width: number; height: number }>("select phase, caption, file_key, width, height from app__visit_photos where visit_id = ? order by id", visitId);
      expect(server.map((p) => [p.phase, p.caption])).toEqual([
        ["before", "The leaking joint"],
        ["after", "The new joint, dry"],
      ]);
      expect(server.every((p) => p.file_key.startsWith(`storage/${visitId}/`))).toBe(true);
      expect(new Set(server.map((p) => p.file_key)).size).toBe(2);
      // The stored objects are the downsized JPEGs.
      expect(server.map((p) => [p.width, p.height])).toEqual([
        [1600, 1200],
        [640, 1600],
      ]);
      for (const p of server) {
        const object = await storedObject(page, p.file_key);
        expect(object.type).toContain("image/jpeg");
        const size = jpegSize(object.bytes);
        expect(size, p.file_key).not.toBeNull();
        expect((size as { width: number }).width).toBeLessThanOrEqual(1600);
        expect(Math.max((size as { width: number }).width, (size as { height: number }).height)).toBe(1600);
      }
      // Each photo's action is in the log once, under the id the device gave it, between the check-in and the check-out.
      const log = rows<{ action_id: string; action: string; status: number }>("select action_id, action, status from app__action_log where visit_job_id = ? order by rowid", JOB);
      expect(log.slice(0, 3).map((l) => l.action)).toEqual(["checkin", "photo", "photo"]);
      expect(log.slice(1, 3).map((l) => l.action_id)).toEqual(kept.map((p) => p.action_id));
      expect(log.every((l) => l.status === 200)).toBe(true);
      // (The page reloads itself once everything is sent: read the device again if it was just navigating.)
      let leftover = -1;
      await until("the device can be read", async () => ((leftover = (await actions(page)).length), true));
      if (leftover > 0) console.warn("offline-photos: this worker has no PDF engine; the check-out stayed queued (the 5xx rule); the photos are what this test is about");

      // The photo that was sent twice is one photo (its first PUT stays in the store unreferenced: issue #833).
      expect(rows("select count(*) as n from app__action_log where visit_job_id = ? and action = 'photo'", JOB)[0]).toEqual({ n: 2 });
      expect(rows("select count(*) as n from app__visit_photos where visit_id = ?", visitId)[0]).toEqual({ n: 2 });
    } finally {
      await ctx.close();
    }
  }, 240_000);

  test("the 21st waiting photo is refused, with its message; removing one makes room", async () => {
    const JOB = "jb_seed_05";
    const ctx = await (browser as Browser).newContext();
    try {
      const page = await openVisit(ctx, JOB, false);
      const small = await image(page, 120, 90, "image/png");
      await ctx.setOffline(true);
      await page.locator("#checkin-form button[type=submit]").click();
      await until("the photo forms", async () => (await page.locator("#photo-form-before input[type=file]").count()) === 1);
      for (let n = 1; n <= 20; n++) await choose(page, n % 2 === 0 ? "after" : "before", { name: `p${n}.png`, mimeType: "image/png", buffer: small }, n);
      expect(await page.locator("[data-offline-photo]").count()).toBe(20);
      expect(await status(page)).toBe("21 actions waiting to be sent");

      // The 21st: refused, nothing kept, the message under the form.
      await page.locator("#photo-form-before input[type=file]").setInputFiles({ name: "p21.png", mimeType: "image/png", buffer: small });
      await until("the refusal", async () => (await page.locator("#photo-form-before [data-offline-error]").count()) === 1);
      expect(await page.locator("#photo-form-before [data-offline-error]").innerText()).toBe("20 photos are waiting to be sent. Get a connection before taking more.");
      await sleep(300);
      expect((await photos(page)).length).toBe(20);
      expect(await page.locator("[data-offline-photo]").count()).toBe(20);

      // Remove one (the first of the before list): there is room for one more.
      await page.locator("#offline-photos-before li button[data-offline-remove]").first().click();
      await until("one photo removed", async () => (await photos(page)).length === 19 && (await page.locator("[data-offline-photo]").count()) === 19);
      await choose(page, "before", { name: "p22.png", mimeType: "image/png", buffer: small }, 20);
      expect(await page.locator("#photo-form-before [data-offline-error]").count()).toBe(0);
      expect((await photos(page)).every((p) => p.state === "pending")).toBe(true);
    } finally {
      await ctx.close();
    }
  }, 120_000);

  test("a photo of a job the office cancelled meanwhile ends refused, with the reason, and stays on the device until it is removed", async () => {
    const JOB = "jb_seed_06";
    const ctx = await (browser as Browser).newContext();
    try {
      // Checked in online: the visit is open on the server when the office cancels the job.
      const page = await openVisit(ctx, JOB, true);
      const picture = await image(page, 1800, 1200, "image/jpeg");

      // Online, a photo is made at most 1600 px at once and sent as it always was; "Add a photo" posts the form.
      await page.locator("#photo-form-after input[type=file]").setInputFiles({ name: "door.jpg", mimeType: "image/jpeg", buffer: picture });
      await until("the upload is done", async () => (await page.locator("#photo-form-after input[name=key]").inputValue()).startsWith("storage/"));
      expect((await photos(page)).length).toBe(0);
      await page.locator("#photo-form-after input[name=caption]").fill("The door, online");
      await page.locator("#photo-form-after button[type=submit]").click();
      await until("the photo of the server's page", async () => (await page.locator("#photos-after li").count()) === 1);
      const visitId = (rows<{ id: string }>("select id from app__visits where job_id = ?", JOB)[0] as { id: string }).id;
      const online = rows<{ phase: string; caption: string; file_key: string; width: number; height: number }>("select phase, caption, file_key, width, height from app__visit_photos where visit_id = ?", visitId);
      expect(online.map((p) => [p.phase, p.caption, p.width, p.height])).toEqual([["after", "The door, online", 1600, 1067]]);
      expect((jpegSize((await storedObject(page, (online[0] as { file_key: string }).file_key)).bytes) as { width: number }).width).toBe(1600);

      await ctx.setOffline(true);
      await choose(page, "before", { name: "ants.jpg", mimeType: "image/jpeg", buffer: picture }, 1);
      await page.locator("#photo-form-before input[name=caption]").fill("Ant trail at the door");
      await page.locator("#photo-form-before button[type=submit]").click();
      await statusIs(page, "1 action waiting to be sent");
      await until("its caption is kept", async () => (await photos(page))[0]?.caption === "Ant trail at the door");

      // The office cancels the job while the phone has no signal.
      sqlite.run("update app__jobs set status = 'cancelled' where id = ?", [JOB]);
      await ctx.setOffline(false);
      const reason = "The office cancelled this job. Nothing was saved.";
      await statusHas(page, reason);
      expect(await status(page)).toBe(`1 saved actions were not accepted by the server: ${reason}`);
      const left = await photos(page);
      expect(left.map((p) => [p.state, p.refused_reason ?? null, p.refused_message ?? null, p.caption])).toEqual([["refused", "job_cancelled", reason, "Ant trail at the door"]]);
      // The picture itself is still on the device, and the page lists it, with the reason and Remove.
      expect(left[0]?.blob?.type).toBe("image/jpeg");
      expect(left[0]?.blob?.size).toBeGreaterThan(0);
      const item = await page.locator("#offline-photos-before li").innerText();
      expect(item).toContain("Ant trail at the door");
      expect(item).toContain(`not accepted by the server: ${reason}`);
      expect(item).toContain("Remove");
      expect(rows("select count(*) as n from app__visit_photos where visit_id = ?", visitId)[0]).toEqual({ n: 1 });
      expect(rows("select count(*) as n from app__visit_photos where visit_id = ? and caption = ?", visitId, "Ant trail at the door")[0]).toEqual({ n: 0 });
      expect(rows("select count(*) as n from app__action_log where visit_job_id = ? and action = 'photo'", JOB)[0]).toEqual({ n: 0 });

      // Nothing sends it again, and a reload still shows it.
      await sleep(1500);
      expect((await photos(page)).map((p) => [p.state, p.attempts])).toEqual([["refused", 0]]);
      await page.reload();
      await until("the refused photo is listed after a reload", async () => (await page.locator("#offline-photos-before li").count()) === 1);
      expect(await page.locator("#offline-photos-before li").innerText()).toContain(reason);

      // Remove deletes it from the device and the page.
      await page.locator("#offline-photos-before li button[data-offline-remove]").click();
      await until("the photo is removed", async () => (await photos(page)).length === 0 && (await page.locator("#offline-photos-before li").count()) === 0);
      await until("the status line is empty", async () => (await status(page)) === "");
    } finally {
      await ctx.close();
    }
  }, 120_000);
});
