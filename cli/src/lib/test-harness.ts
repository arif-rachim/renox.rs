// The engine behind `renox test` and `@renoxium/sdk/test` (#238;
// docs/12-developer-experience.md, "renox test"): the app's artifact plus a
// test-only service route, the same prebuilt renox-worker as `renox dev`
// (rule 5) on a temporary tenant file per test file, seeds, and the module
// install/upgrade helper.
//
// The service route (`POST /__renox_test/service`) is a function route of
// the *test* artifact only: it imports `renox:modules` and calls the
// service like any app code, so the broker's checks apply (it is not a
// bypass). It never exists in what `renox build` or `renox deploy` produce.
//
// `runJob` (`t.job`, #593) writes a tick of a scheduled job into the tenant
// file the way `renox jobs run` does. It is not a route: app code cannot
// write `renox__*` tables (the SQLite authorizer refuses them), so the tick
// is written from this process, and the test worker looks for due outbox
// rows every `JOBS_POLL_MS` (`[jobs] poll_ms`, as `renox dev` does) to pick
// it up.

import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { addModule } from "../commands/add.ts";
import { ulid } from "../commands/jobs.ts";
import { check, type CheckReport } from "../commands/check.ts";
import { migrateArtifact, type MigrateReport } from "../commands/migrate.ts";
import { EnvironmentError, UserError } from "../errors.ts";
import { readModulesTable } from "./modules/resolve.ts";
import { removeRetry } from "./rename.ts";
import { buildArtifact } from "./build.ts";
import { hashFiles } from "./hash.ts";
import { toPosix } from "./paths.ts";
import { checkPolicies, type PolicyCase, type PolicyResult, readPolicyCases } from "./policies.ts";
import { workerPath } from "./worker.ts";

/** What `renox test` hands to the test process (`RENOX_TEST_SPEC`, a JSON file). */
export interface TestSpec {
  project: string;
  /** The folder holding `<hash>/`. */
  artifacts: string;
  hash: string;
  worker: string;
  /** SQL files run after the migrations, in order: `seeds/*.sql`, then `--seed` files. */
  seeds: string[];
}

export const SERVICE_PATH = "/__renox_test/service";
export const TEST_TENANT = "test";
export const TEST_HOST = "test.localhost";
/** How often the test worker looks for outbox rows written from another connection (a `runJob` tick). */
export const JOBS_POLL_MS = 50;
/** How long a connection of the harness waits for the worker's write lock. */
export const BUSY_TIMEOUT_MS = 5000;

const SERVICE_JS = `import * as modules from "renox:modules";
export async function POST(ctx) {
  const { module, service, args } = await ctx.req.json();
  const m = modules[module];
  if (m === undefined) return Response.json({ ok: false, error: { name: "Error", code: null, message: "module " + module + " is not installed" } }, { status: 404 });
  try {
    return Response.json({ ok: true, value: (await m[service](...args)) ?? null });
  } catch (e) {
    return Response.json({ ok: false, error: { name: e?.name ?? "Error", code: e?.code ?? null, message: String(e?.message ?? e), details: e?.details ?? null } }, { status: 500 });
  }
}
`;

function filesOf(dir: string, rel = ""): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) for (const [k, v] of filesOf(dir, r)) out.set(k, v);
    else if (d.isFile()) out.set(r, new Uint8Array(readFileSync(join(dir, r))));
  }
  return out;
}

/** The test artifact: `artifactDir` plus the service route, written next to it under its own hash. */
export function testArtifact(artifactDir: string, out: string): string {
  const files = filesOf(artifactDir);
  const enc = new TextEncoder();
  const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as {
    code: { entry: Record<string, string> };
    entries?: Record<string, { exports: string[]; eager?: boolean }>;
    routes: unknown[];
  };
  manifest.code.entry["functions/__renox_test/service"] = "functions/__renox_test/service.js";
  // Artifact 1.2 (V23): every code entry has its exports recorded.
  if (manifest.entries) manifest.entries["functions/__renox_test/service"] = { exports: ["POST"], eager: false };
  manifest.routes.push({ kind: "function", method: "POST", path: SERVICE_PATH, module: "functions/__renox_test/service", export: "POST" });
  files.set("code/functions/__renox_test/service.js", enc.encode(SERVICE_JS));
  files.set("manifest.json", enc.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  const hash = hashFiles(files);
  const dir = join(out, hash);
  if (!existsSync(dir)) {
    for (const [p, b] of files) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), b);
    }
  }
  return hash;
}

/**
 * A module's own tests run in the app of `<module>/tests/app/`. It is
 * copied to a temporary folder, its `path:` sources rewritten to stay
 * relative from there, and installed (`renox add`) on every run, so
 * nothing is written under the module tree (whose hash covers every file
 * in it, manifest.md section 5).
 */
async function moduleTestApp(module: string): Promise<string> {
  const src = join(module, "tests", "app");
  if (!existsSync(join(src, "renox.toml"))) {
    throw new UserError("a module's tests run in tests/app/: a renox.toml that installs the module from path:../..", { file: "tests/app/renox.toml" });
  }
  const app = mkdtempSync(join(tmpdir(), "renox-module-test-"));
  cpSync(src, app, { recursive: true, filter: (p) => !/\/(\.renox|renox\.lock|node_modules)(\/|$)/u.test(toPosix(p).slice(toPosix(src).length)) });
  // The SDK as `node_modules/@renoxium/sdk`, as an app has it: module code may import
  // its helpers (auth's passkeys use `verifyAssertion`, #291).
  const sdk = resolve(import.meta.dir, "../../../sdk");
  if (!existsSync(join(app, "node_modules", "@renoxium", "sdk")) && existsSync(join(sdk, "package.json"))) {
    mkdirSync(join(app, "node_modules", "@renoxium"), { recursive: true });
    const link = join(app, "node_modules", "@renoxium", "sdk");
    try {
      symlinkSync(sdk, link, "dir");
    } catch (e) {
      // Windows without Developer Mode refuses symlinks: copy the SDK instead.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES") throw e;
      cpSync(sdk, link, { recursive: true, dereference: true });
    }
  }
  const toml = readFileSync(join(src, "renox.toml"), "utf8").replace(/"path:([^"]+)"/gu, (_m, rel: string) => JSON.stringify(`path:${toPosix(relative(app, resolve(src, rel)))}`));
  writeFileSync(join(app, "renox.toml"), toml);
  const { specs } = readModulesTable(app);
  const log = console.log;
  console.log = () => {};
  try {
    for (const name of Object.keys(specs)) await addModule(app, name, { yes: true }, async () => true);
  } finally {
    console.log = log;
  }
  return app;
}

/** Build the project (or, for a module, its test app) and the test artifact. */
export async function prepare(project: string, seeds: string[] = [], worker = workerPath()): Promise<TestSpec> {
  if (existsSync(join(project, "module.toml")) && !existsSync(join(project, "renox.toml"))) project = await moduleTestApp(project);
  const artifacts = join(project, ".renox", "test", "artifact");
  const built = await buildArtifact(project, artifacts);
  const hash = testArtifact(built.dir, artifacts);
  const seedDir = join(project, "seeds");
  const own = existsSync(seedDir) ? readdirSync(seedDir).filter((n) => n.endsWith(".sql")).sort().map((n) => join(seedDir, n)) : [];
  return { project, artifacts, hash, worker, seeds: [...own, ...seeds.map((s) => resolve(project, s))] };
}

/** One evaluated policy test case (`policies/tests/*.json`, #283). */
export interface PolicyOutcome {
  file: string;
  case: PolicyCase;
  result: PolicyResult;
  ok: boolean;
}

/**
 * Runs `policies/tests/*.json` of `casesFrom` (the project, or a module's
 * own tree) against the policies of the
 * built artifact with `renox-worker check-policies`: the engine the cell
 * builds, the principal and resource of each case as written.
 */
export async function evaluatePolicies(spec: TestSpec, casesFrom = spec.project): Promise<PolicyOutcome[]> {
  // A module's cases are in its own tree; its tests run in a temporary app.
  const groups = readPolicyCases(casesFrom);
  if (groups.length === 0) return [];
  const files = filesOf(join(spec.artifacts, spec.hash));
  const cases = groups.flatMap((g) => g.cases);
  const { errors, results } = await checkPolicies(files, cases, spec.worker);
  if (errors.length) throw new UserError(`policies do not validate: ${errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join("; ")}`);
  let i = 0;
  return groups.flatMap((g) =>
    g.cases.map((c) => {
      const result = results[i++] as PolicyResult;
      return { file: g.file, case: c, result, ok: (result.allow ? "allow" : "deny") === c.expected };
    }),
  );
}

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

async function listening(port: number, exited: () => number | undefined, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const code = exited();
    if (code !== undefined) throw new EnvironmentError(`renox-worker exited during startup (exit code ${code})`);
    try {
      const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
      s.end();
      return;
    } catch {
      if (Date.now() - t0 > ms) throw new EnvironmentError(`renox-worker did not listen on ${port} within ${ms} ms`);
      await Bun.sleep(25);
    }
  }
}

/** A worker log line (JSON from `tracing`) as `message: error`, or the line itself. */
export function workerError(line: string): string {
  try {
    const v = JSON.parse(line) as { fields?: Record<string, unknown> };
    const { message, error, ...rest } = v.fields ?? {};
    const parts = [message, error, ...Object.entries(rest).map(([k, x]) => `${k}=${typeof x === "string" ? x : JSON.stringify(x)}`)].filter((p) => typeof p === "string" && p !== "");
    return parts.length ? parts.join(": ") : line;
  } catch {
    return line;
  }
}

/** One running test worker on a fresh tenant file. */
export interface TestWorker {
  base: string;
  host: string;
  /** The tenant file (read it with `readonly`). */
  db: string;
  /** Tenant log lines so far (ndjson objects). */
  logs(): Record<string, unknown>[];
  /** Meter records written so far (`meter.md`; flushed about every second). */
  meters(): Record<string, unknown>[];
  stop(): Promise<void>;
}

/**
 * The worker configuration of one test run (#462). The artifacts live in the
 * app, the state under the temp dir, and the two must never be joined by a
 * relative path: on macOS `$TMPDIR` is under `/var`, a symlink to
 * `/private/var`, so `../../..` from it lands in `/private/Users/...` and the
 * worker's start-up `create_dir_all` is refused. Every path is absolute.
 */
export function testWorkerConfig(state: string, artifacts: string, port: number): string {
  return [
    `listen = "127.0.0.1:${port}"`,
    `data_dir = ${JSON.stringify(join(state, "data"))}`,
    `artifacts_dir = ${JSON.stringify(resolve(artifacts))}`,
    `routes_file = ${JSON.stringify(join(state, "routes.json"))}`,
    `meters_dir = ${JSON.stringify(join(state, "meters"))}`,
    `logs_dir = ${JSON.stringify(join(state, "logs"))}`,
    `node_id = "test"`,
    `idle_timeout_secs = 600`,
    `meter_flush_ms = 1000`,
    `default_tier = "free"`,
    // The scheduler as in production (enabled is the worker's default), and a
    // poll for the ticks `runJob` writes from another connection (#593).
    "",
    "[jobs]",
    "enabled = true",
    `poll_ms = ${JOBS_POLL_MS}`,
    "",
  ].join("\n");
}

/** Start the worker of `spec` on a new temporary tenant file: migrations applied, seeds run. */
export async function startTestWorker(spec: TestSpec): Promise<TestWorker> {
  // realpath: the physical directory, so nothing below depends on a symlinked temp dir.
  const state = realpathSync(mkdtempSync(join(tmpdir(), "renox-test-")));
  for (const d of ["data", "meters", "logs"]) mkdirSync(join(state, d), { recursive: true });
  mkdirSync(join(state, "data", TEST_TENANT), { recursive: true });
  // Test secrets: `.env.test` of the app (KEY=value lines), never the real `.env`.
  const envTest = join(spec.project, ".env.test");
  const secrets: Record<string, string> = {};
  if (existsSync(envTest)) {
    for (const line of readFileSync(envTest, "utf8").split("\n")) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
      if (m) secrets[m[1] as string] = (m[2] as string).replace(/^(["'])(.*)\1$/u, "$2");
    }
  }
  writeFileSync(join(state, "data", TEST_TENANT, "secrets.json"), JSON.stringify(secrets), { mode: 0o600 });
  writeFileSync(
    join(state, "routes.json"),
    JSON.stringify({ version: 0, entries: [{ hostname: TEST_HOST, tenant_id: TEST_TENANT, deployment_hash: spec.hash, status: "active", updated_at: Date.now() }] }),
  );
  const port = freePort();
  const toml = join(state, "worker.toml");
  writeFileSync(toml, testWorkerConfig(state, spec.artifacts, port));
  const w = Bun.spawn([spec.worker, "--config", toml], { cwd: state, stdin: "ignore", stdout: "ignore", stderr: "pipe", env: { ...process.env, RUST_LOG: "error" } });
  let code: number | undefined;
  void w.exited.then((c) => {
    code = c;
  });
  // The worker's errors (RUST_LOG=error): kept for the start-up failure below,
  // never printed while the tests run (#462).
  const errors: string[] = [];
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of w.stderr) {
      buf += dec.decode(chunk);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) errors.push(line);
        if (errors.length > 20) errors.shift();
      }
    }
    if (buf.trim()) errors.push(buf.trim());
  })();
  try {
    await listening(port, () => code);
  } catch (e) {
    w.kill("SIGKILL");
    if (e instanceof EnvironmentError && errors.length) {
      throw new EnvironmentError(e.message, { hint: `the worker said: ${workerError(errors[errors.length - 1] as string)} (config: ${toml})` });
    }
    throw e;
  }
  const base = `http://127.0.0.1:${port}`;
  // The first request creates the cell: the file is opened and migrated.
  await fetch(`${base}${SERVICE_PATH}`, { method: "POST", headers: { host: TEST_HOST, "content-type": "application/json" }, body: JSON.stringify({ module: "", service: "", args: [] }) });
  const db = join(state, "data", TEST_TENANT, "app.db");
  if (spec.seeds.length) {
    const sqlite = new Database(db);
    sqlite.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`);
    try {
      for (const s of spec.seeds) sqlite.exec(readFileSync(s, "utf8"));
    } finally {
      sqlite.close();
    }
  }
  return {
    base,
    host: TEST_HOST,
    db,
    logs: () => {
      const p = join(state, "logs", "tenant.ndjson");
      if (!existsSync(p)) return [];
      return readFileSync(p, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    meters: () => {
      const dir = join(state, "meters");
      const out: Record<string, unknown>[] = [];
      if (!existsSync(dir)) return out;
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".ndjson"))) {
        for (const line of readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean)) {
          out.push(...((JSON.parse(line) as { records: Record<string, unknown>[] }).records ?? []));
        }
      }
      return out;
    },
    async stop() {
      w.kill("SIGTERM");
      await Promise.race([w.exited, Bun.sleep(3000)]);
      if (code === undefined) w.kill("SIGKILL");
      // On Windows the exited worker's files stay locked for a moment (EBUSY).
      removeRetry(state);
    },
  };
}

/** The scheduled jobs of the test artifact, as `<module>:<name>`. */
function jobsOf(spec: TestSpec): Set<string> {
  const manifest = JSON.parse(readFileSync(join(spec.artifacts, spec.hash, "manifest.json"), "utf8")) as { routes: { kind: string; module?: string; name?: string }[] };
  // The owner as the runtime reads it (`route_owner`): `modules/<name>/...` is a module's code, anything else the app's.
  const owner = (code = ""): string => /^modules\/([^/]+)\//u.exec(code)?.[1] ?? "app";
  return new Set(manifest.routes.filter((r) => r.kind === "job").map((r) => `${owner(r.module)}:${r.name}`));
}

/**
 * A tick of the scheduled job `module`/`name` now, written into the tenant
 * file `db` with the statements of `renox jobs run` (`runNow` in
 * commands/jobs.ts): one `job:<name>` row of `renox__outbox` and the
 * `job_tick:<module>:<name>` meta row, or the waiting row's tick moved
 * (coalescing). With `payload` (#770) it writes a queued run instead, as
 * `ctx.jobs.enqueue(name, payload)` does (ops.md section 20): a new row whose
 * `payload` is the JSON text, no meta row and no coalescing, so each call is
 * one run. An IMMEDIATE transaction that waits on the worker's lock.
 * Returns the row id and its attempts so far (a coalesced row may have
 * failed before).
 */
export function runJob(spec: TestSpec, db: string, module: string, name: string, now = Date.now(), payload?: unknown): { id: string; attempts: number } {
  const jobs = jobsOf(spec);
  if (!jobs.has(`${module}:${name}`)) {
    const known = [...jobs].sort().join(", ") || "none";
    throw new UserError(`no scheduled job ${name} in ${module === "app" ? "the app" : `module ${module}`} (jobs: ${known})`);
  }
  const sqlite = new Database(db);
  sqlite.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`);
  try {
    return sqlite.transaction(() => {
      if (payload !== undefined) {
        const json = JSON.stringify(payload);
        if (json === undefined || Buffer.byteLength(json) > 64 * 1024) throw new UserError(`the payload of ${name} is not JSON of at most 64 KiB`);
        const id = ulid(now);
        sqlite.query("insert into renox__outbox (id, target, name, payload, module, created_at, attempts, next_at) values (?, ?, ?, ?, ?, ?, 0, ?)").run(id, module, `job:${name}`, json, module, now, now);
        return { id, attempts: 0 };
      }
      const key = `job_tick:${module}:${name}`;
      const tick = sqlite.query("select value from renox__outbox_meta where key = ?").get(key) as { value: number } | null;
      const waiting = sqlite.query("select id, attempts from renox__outbox where name = ? and target = ? and payload = 'null'").get(`job:${name}`, module) as { id: string; attempts: number } | null;
      if (tick !== null && waiting) {
        sqlite.query("update renox__outbox_meta set value = max(value, ?) where key = ?").run(now, key);
        sqlite.query("update renox__outbox set next_at = min(next_at, ?) where id = ?").run(now, waiting.id);
        return waiting;
      }
      const id = ulid(now);
      sqlite.query("insert into renox__outbox (id, target, name, payload, module, created_at, attempts, next_at) values (?, ?, ?, 'null', ?, ?, 0, ?)").run(id, module, `job:${name}`, module, now, now);
      sqlite.query("insert into renox__outbox_meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, now);
      return { id, attempts: 0 };
    }).immediate();
  } finally {
    sqlite.close();
  }
}

/** The event handlers (`on`) of the test artifact: `app` and module name -> the event names its `hooks` entry handles, or null when the entry does not record them. */
function handlersOf(spec: TestSpec): Map<string, string[] | null> {
  const manifest = JSON.parse(readFileSync(join(spec.artifacts, spec.hash, "manifest.json"), "utf8")) as { entries?: Record<string, { exports: string[]; on?: string[] }> };
  const out = new Map<string, string[] | null>();
  for (const [id, e] of Object.entries(manifest.entries ?? {})) {
    const owner = id === "hooks" ? "app" : /^modules\/([^/]+)\/hooks$/u.exec(id)?.[1];
    if (owner === undefined) continue;
    if (e.on !== undefined) out.set(owner, e.on);
    else if (e.exports.includes("on")) out.set(owner, null);
  }
  return out;
}

/**
 * One durable delivery of the module event `event` (emitted by `module`) to
 * `to` (`app` or a module name), written into the tenant file `db` the way the
 * outbox worker writes the delivery of one handler (ops.md section 15.4,
 * "Delivery"): a `renox__outbox` row with `target` the handler, `name` the
 * event and `module` its emitter, in an IMMEDIATE transaction that waits on
 * the worker's lock. Rejects (a `UserError`) when `to` has no handler for the
 * event in the test artifact, so a typo fails the test. Returns the row id.
 */
export function runDeliver(spec: TestSpec, db: string, event: string, payload: unknown, module: string, to = "app", now = Date.now()): { id: string; attempts: number } {
  const handlers = handlersOf(spec);
  const on = handlers.get(to);
  const who = to === "app" ? "the app" : `module ${to}`;
  if (on === undefined || (on !== null && !on.includes(event))) {
    const known = [...handlers].flatMap(([h, names]) => (names ?? []).map((n) => `${h}:${n}`)).sort().join(", ") || "none";
    throw new UserError(`${who} has no handler for the event ${event} (handlers: ${known})`);
  }
  const json = JSON.stringify(payload ?? null);
  if (Buffer.byteLength(json) > 64 * 1024) throw new UserError(`the payload of ${event} is not JSON of at most 64 KiB`);
  const sqlite = new Database(db);
  sqlite.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`);
  try {
    return sqlite.transaction(() => {
      const id = ulid(now);
      sqlite.query("insert into renox__outbox (id, target, name, payload, module, created_at, attempts, next_at) values (?, ?, ?, ?, ?, ?, 0, ?)").run(id, to, event, json, module, now, now);
      return { id, attempts: 0 };
    }).immediate();
  } finally {
    sqlite.close();
  }
}

/** What installing or upgrading a module reported. */
export interface ModuleChange {
  /** `renox check` on the app after the change (drift, broken contracts). */
  check: CheckReport;
  /** The migration plan run on the scratch tenant file. */
  migrate: MigrateReport | null;
  /** The scratch copy of the app (kept for the next upgrade). */
  project: string;
}

/**
 * Install `name` from `source` (a `path:` relative to the app) into a scratch copy of the app, then build and migrate a scratch
 * tenant file: what `renox add` + `renox build` + `renox migrate` would do.
 * Pass the returned `project` to upgrade it again.
 */
export async function changeModule(
  project: string,
  name: string,
  source: string,
  scratch?: { project: string; db: string },
  worker = workerPath(),
  version?: string,
): Promise<ModuleChange & { db: string }> {
  const work = scratch?.project ?? mkdtempSync(join(tmpdir(), "renox-test-module-"));
  if (!scratch) cpSync(project, work, { recursive: true, filter: (p) => !/\/(\.renox|\.git)(\/|$)/u.test(toPosix(p).slice(toPosix(project).length)) });
  // A `path:` source is relative to the app; from the scratch copy it is made
  // relative again (a tree inside the app was copied with it).
  const src = source.startsWith("path:") ? `path:${toPosix(relative(work, existsSync(join(work, source.slice(5))) ? join(work, source.slice(5)) : resolve(project, source.slice(5))))}` : source;
  // The range: `^<version>` of the tree's module.toml (an upgrade may cross a major).
  let range = version;
  if (range === undefined && src.startsWith("path:")) {
    const toml = resolve(work, src.slice("path:".length), "module.toml");
    const v = existsSync(toml) ? /^version\s*=\s*"([^"]+)"/mu.exec(readFileSync(toml, "utf8"))?.[1] : undefined;
    if (v) range = `^${v}`;
  }
  const log = console.log;
  console.log = () => {};
  try {
    await addModule(work, name, { source: src, yes: true, ...(range ? { version: range } : {}) }, async () => true);
  } finally {
    console.log = log;
  }
  const report = await check(work);
  const db = scratch?.db ?? join(work, ".renox", "test", "module.db");
  let migrate: MigrateReport | null = null;
  if (report.errors.length === 0) {
    const built = await buildArtifact(work, join(work, ".renox", "test", "artifact"));
    migrate = await migrateArtifact(built.dir, db, worker);
  }
  return { check: report, migrate, project: work, db };
}
