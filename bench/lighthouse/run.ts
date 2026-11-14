// `make lighthouse` (#725): Lighthouse accessibility and performance of the
// home-services dispatch board, technician list `/me` (#810) and visit page and, signed out, step 1
// of the customer's booking page `/book` (#779), English and Arabic, on the
// phone profile. Usage:
//   RENOX_WORKER_PATH=<renox-worker> bun bench/lighthouse/run.ts [--assert] [--busy] [--seed <sql>]... [--runs <n>] [--out <dir>]
//
// Starts the app under `renox dev` with the demo seed, signs in through the real
// login form (dispatcher and technician, two browser contexts of Playwright's
// Chromium), then runs Lighthouse (in Node: lh-node.mjs, Lighthouse targets Node
// and not Bun) against that Chromium's debugging port, the signed-in cookies
// passed as an extra header. Writes <out>/<date>-lighthouse-home-services.md and
// the raw reports under <out>/raw/lighthouse/<date>/. --assert exits 1 when a
// median accessibility is under 90 or a performance under 80. --busy (#728) adds
// busy-day.sql: 200 jobs today and a visit with 12 photos; the result file is then
// <date>-lighthouse-home-services-busy.md.
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  type App,
  cookieHeader,
  DISPATCHER,
  freePort,
  launchChromium,
  type PwBrowser,
  REPO,
  signIn,
  startApp,
  TECHNICIAN,
  TECHNICIAN_ID,
  workerPathOrThrow,
} from "./app.ts";
import { failures, type LhrLike, markdown, summarize, type TargetResult } from "./report.ts";

/** The busy-day seed (#728), applied by --busy after the demo seed. */
export const BUSY_SEED = join(import.meta.dir, "busy-day.sql");

export interface Options {
  assert: boolean;
  /** --busy: the busy-day seed is among extraSeeds. */
  busy: boolean;
  runs: number;
  out: string;
  /** Extra seed SQL files applied after the demo seed (#728). */
  extraSeeds: string[];
}

export function parseArgs(argv: string[]): Options {
  const o: Options = { assert: false, busy: false, runs: 3, out: join(REPO, "bench/results"), extraSeeds: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--assert") o.assert = true;
    else if (a === "--busy") {
      if (!o.busy) o.extraSeeds.push(BUSY_SEED);
      o.busy = true;
    }
    else if (a === "--runs") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("--runs takes a positive integer");
      o.runs = n;
    } else if (a === "--out") {
      const v = argv[++i];
      if (!v) throw new Error("--out takes a directory");
      o.out = v;
    } else if (a === "--seed") {
      const v = argv[++i];
      if (!v) throw new Error("--seed takes an SQL file");
      o.extraSeeds.push(v);
    } else throw new Error(`unknown argument ${a} (usage: run.ts [--assert] [--busy] [--seed <sql>] [--runs <n>] [--out <dir>])`);
  }
  return o;
}

/** The technician's first scheduled visit in the seed: the job id of `/me/visits/<id>`. */
export function firstScheduledVisit(db: string, technicianId: string = TECHNICIAN_ID): string {
  const sqlite = new Database(db, { readonly: true });
  try {
    const row = sqlite
      .query<{ id: string }, [string]>("select id from app__jobs where technician_user_id = ? and status = 'scheduled' order by scheduled_start, id limit 1")
      .get(technicianId);
    if (!row) throw new Error(`the seed has no scheduled job for ${technicianId}`);
    return row.id;
  } finally {
    sqlite.close();
  }
}

/** One Lighthouse run in a Node child process; returns the parsed report. */
export async function lighthouseRun(url: string, port: number, cookie: string, out: string): Promise<LhrLike> {
  // A signed-out target (the booking page) sends no cookie.
  const args = JSON.stringify({ url, port, headers: cookie === "" ? {} : { Cookie: cookie }, out, categories: ["accessibility", "performance"] });
  const p = Bun.spawn(["node", join(import.meta.dir, "lh-node.mjs"), args], { stdout: "pipe", stderr: "pipe", cwd: REPO });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`lighthouse failed for ${url} (exit ${code}): ${err.trim().split("\n").slice(-5).join("\n")}`);
  return (await Bun.file(out).json()) as LhrLike;
}

const git = (...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { cwd: REPO, stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "unknown";
};

async function workerVersion(worker: string): Promise<string> {
  const p = Bun.spawn([worker, "--version"], { stdout: "pipe", stderr: "ignore" });
  const text = (await new Response(p.stdout).text()).trim();
  await p.exited;
  return text.replace(/^renox-worker\s+/u, "") || "unknown";
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const worker = workerPathOrThrow();
  const date = new Date().toISOString().slice(0, 10);
  const rawDir = join(opts.out, "raw/lighthouse", date);
  mkdirSync(rawDir, { recursive: true });

  let app: App | undefined;
  let browser: PwBrowser | undefined;
  stopAll = async () => {
    await browser?.close().catch(() => {});
    await app?.stop().catch(() => {});
  };
  try {
    app = await startApp({ worker, extraSeeds: opts.extraSeeds });
    const visit = firstScheduledVisit(app.db);
    const debugPort = freePort();
    browser = await launchChromium(debugPort);
    const dispatcher = await cookieHeader(await signIn(browser, app.base, DISPATCHER));
    const technician = await cookieHeader(await signIn(browser, app.base, TECHNICIAN));

    const targets = [
      { path: "/dispatch", role: "dispatcher", cookie: dispatcher },
      { path: "/dispatch?lang=ar", role: "dispatcher", cookie: dispatcher },
      { path: `/me/visits/${visit}`, role: "technician", cookie: technician },
      { path: `/me/visits/${visit}?lang=ar`, role: "technician", cookie: technician },
      // The technician's list (#810): it carries the offline queue's scripts and the "Needs attention" container.
      { path: "/me", role: "technician", cookie: technician },
      { path: "/me?lang=ar", role: "technician", cookie: technician },
      // The customer's way in (#779): /book step 1, signed out.
      { path: "/book", role: "visitor", cookie: "" },
      { path: "/book?lang=ar", role: "visitor", cookie: "" },
    ];
    const results: TargetResult[] = [];
    for (const t of targets) {
      const runs = [];
      for (let n = 1; n <= opts.runs; n++) {
        const file = join(rawDir, `${t.path.replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_|_$/gu, "")}-${t.role}-${n}.json`);
        const lhr = await lighthouseRun(`${app.base}${t.path}`, debugPort, t.cookie, file);
        const final = new URL(lhr.finalDisplayedUrl ?? lhr.finalUrl ?? "http://invalid/");
        if (`${final.pathname}${final.search}` !== t.path) throw new Error(`${t.path} (${t.role}) ended on ${final.pathname}${final.search}, not the target: the sign-in did not hold`);
        runs.push(summarize(lhr));
      }
      results.push({ target: t.path, role: t.role, runs });
    }

    const file = join(opts.out, `${date}-lighthouse-home-services${opts.busy ? "-busy" : ""}.md`);
    writeFileSync(file, markdown(results, { date, commit: git("rev-parse", "--short", "HEAD"), worker: await workerVersion(worker), runs: opts.runs, extraSeeds: opts.extraSeeds.map((f) => basename(f)) }));
    console.log(`wrote ${file}`);

    const bad = failures(results);
    for (const f of bad) console.error(`FAIL ${f}`);
    return opts.assert && bad.length > 0 ? 1 : 0;
  } finally {
    await stopAll();
  }
}

/** Stops the browser and the dev server; set by main, also run on SIGINT and SIGTERM. */
let stopAll: () => Promise<void> = async () => {};

if (import.meta.main) {
  const onSignal = (): void => void stopAll().finally(() => process.exit(130));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
