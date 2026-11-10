// Starting the home-services app, signing in and launching Chromium for the
// Lighthouse runs (#725). Exported in small functions: #728 adds extra seed
// files (`extraSeeds`), #729 reuses launchChromium and signIn.
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { seedDev } from "../../cli/src/commands/db.ts";
import { type DevServer, startDev } from "../../cli/src/commands/dev.ts";

export const REPO = join(import.meta.dir, "../..");
export const APP_DIR = join(REPO, "examples/home-services");
export const PASSWORD = "correct horse battery";
export const DISPATCHER = "dispatcher.dubai@fixit.example";
export const TECHNICIAN = "ali.dubai@fixit.example";
export const TECHNICIAN_ID = "u_dxb_ali";

/** A port the OS just reported free on 127.0.0.1. */
export function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

/** RENOX_WORKER_PATH, or an error that says what to set. */
export function workerPathOrThrow(env: Record<string, string | undefined> = process.env): string {
  const w = env.RENOX_WORKER_PATH;
  if (!w) throw new Error("RENOX_WORKER_PATH is not set: point it at a renox-worker binary (e.g. cli/bin/linux-x64/renox-worker, see `bun cli/scripts/fetch-worker.ts --pdf`)");
  if (!existsSync(w)) throw new Error(`RENOX_WORKER_PATH=${w} does not exist`);
  return w;
}

export interface App {
  base: string;
  /** The app's folder (a copy, so the example's own .renox stays untouched). */
  dir: string;
  /** The dev database, for reads such as the technician's first visit. */
  db: string;
  stop: () => Promise<void>;
}

export interface StartAppOptions {
  worker: string;
  /** Extra seed SQL files applied after seeds/001_demo.sql, in this order (#728). */
  extraSeeds?: string[];
}

/** Copies the app, seeds it and starts `renox dev` on a free port. */
export async function startApp(opts: StartAppOptions): Promise<App> {
  const dir = mkdtempSync(join(tmpdir(), "renox-lighthouse-"));
  let dev: DevServer | undefined;
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  try {
    cpSync(APP_DIR, dir, { recursive: true, filter: (p) => !/(^|\/)(node_modules|\.renox)(\/|$)/u.test(p.slice(APP_DIR.length)) });
    symlinkSync(join(APP_DIR, "node_modules"), join(dir, "node_modules"));
    (opts.extraSeeds ?? []).forEach((f, i) => cpSync(f, join(dir, "seeds", `${String(900 + i)}_${basename(f)}`)));
    const db = join(dir, ".renox/data/dev/app.db");
    await seedDev(dir, { db });
    const port = freePort();
    dev = await startDev({ project: dir, port, worker: opts.worker, log: () => {} });
    const started = dev;
    return {
      base: `http://localhost:${port}`,
      dir,
      db,
      stop: async () => {
        await started.stop();
        cleanup();
      },
    };
  } catch (e) {
    await dev?.stop();
    cleanup();
    throw e;
  }
}

// Playwright, typed by the few calls used here.
export interface PwCookie {
  name: string;
  value: string;
}
export interface PwPage {
  goto(url: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForURL(url: (u: URL) => boolean, opts?: { timeout?: number }): Promise<void>;
  url(): string;
}
export interface PwContext {
  newPage(): Promise<PwPage>;
  cookies(): Promise<PwCookie[]>;
  close(): Promise<void>;
}
export interface PwBrowser {
  newContext(): Promise<PwContext>;
  close(): Promise<void>;
}
interface Pw {
  chromium: { launch(opts?: { args?: string[] }): Promise<PwBrowser> };
}

function loadPlaywright(): Pw {
  const require = createRequire(import.meta.url);
  const candidates = [process.env.PLAYWRIGHT_PATH, "playwright", ...(process.env.NODE_PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "playwright"))];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return require(c) as Pw;
    } catch {
      // next
    }
  }
  const r = Bun.which("node") ? Bun.spawnSync(["node", "-e", "process.stdout.write(require.resolve('playwright'))"], { stdout: "pipe", stderr: "ignore" }) : undefined;
  if (r?.exitCode === 0) return require(r.stdout.toString()) as Pw;
  throw new Error("Playwright is not installed (set PLAYWRIGHT_PATH to the package, or install it with its Chromium)");
}

/** Playwright's Chromium with the remote debugging port Lighthouse connects to. */
export async function launchChromium(debugPort: number): Promise<PwBrowser> {
  return loadPlaywright().chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
}

/** Signs in through the real login form in its own browser context; returns the context (it holds the cookies). */
export async function signIn(browser: PwBrowser, base: string, email: string): Promise<PwContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}/auth/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/login"), { timeout: 30_000 });
  return ctx;
}

/** The `Cookie` header of a signed-in context. */
export async function cookieHeader(ctx: PwContext): Promise<string> {
  return (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
}
