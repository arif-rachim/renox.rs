// The engine behind `renox test` and `renox/test` (#238;
// docs/12-developer-experience.md, "renox test"): the app's artifact plus a
// test-only service route, the same prebuilt renox-worker as `renox dev`
// (rule 5) on a temporary tenant file per test file, seeds, and the module
// install/upgrade helper.
//
// The service route (`POST /__renox_test/service`) is a function route of
// the *test* artifact only: it imports `renox:modules` and calls the
// service like any app code, so the broker's checks apply (it is not a
// bypass). It never exists in what `renox build` or `renox deploy` produce.

import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { addModule } from "../commands/add.ts";
import { check, type CheckReport } from "../commands/check.ts";
import { migrateArtifact, type MigrateReport } from "../commands/migrate.ts";
import { EnvironmentError } from "../errors.ts";
import { buildArtifact } from "./build.ts";
import { hashFiles } from "./hash.ts";
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
    routes: unknown[];
  };
  manifest.code.entry["functions/__renox_test/service"] = "functions/__renox_test/service.js";
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

/** Build the project and its test artifact. */
export async function prepare(project: string, seeds: string[] = [], worker = workerPath()): Promise<TestSpec> {
  const artifacts = join(project, ".renox", "test", "artifact");
  const built = await buildArtifact(project, artifacts);
  const hash = testArtifact(built.dir, artifacts);
  const seedDir = join(project, "seeds");
  const own = existsSync(seedDir) ? readdirSync(seedDir).filter((n) => n.endsWith(".sql")).sort().map((n) => join(seedDir, n)) : [];
  return { project, artifacts, hash, worker, seeds: [...own, ...seeds.map((s) => resolve(project, s))] };
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

/** Start the worker of `spec` on a new temporary tenant file: migrations applied, seeds run. */
export async function startTestWorker(spec: TestSpec): Promise<TestWorker> {
  const state = mkdtempSync(join(tmpdir(), "renox-test-"));
  for (const d of ["data", "meters", "logs"]) mkdirSync(join(state, d), { recursive: true });
  mkdirSync(join(state, "data", TEST_TENANT), { recursive: true });
  writeFileSync(join(state, "data", TEST_TENANT, "secrets.json"), "{}", { mode: 0o600 });
  writeFileSync(
    join(state, "routes.json"),
    JSON.stringify({ version: 0, entries: [{ hostname: TEST_HOST, tenant_id: TEST_TENANT, deployment_hash: spec.hash, status: "active", updated_at: Date.now() }] }),
  );
  const port = freePort();
  writeFileSync(
    join(state, "worker.toml"),
    [
      `listen = "127.0.0.1:${port}"`,
      `data_dir = "data"`,
      `artifacts_dir = ${JSON.stringify(relative(state, spec.artifacts))}`,
      `routes_file = "routes.json"`,
      `meters_dir = "meters"`,
      `logs_dir = "logs"`,
      `node_id = "test"`,
      `idle_timeout_secs = 600`,
      `meter_flush_ms = 1000`,
      `default_tier = "free"`,
      "",
    ].join("\n"),
  );
  const w = Bun.spawn([spec.worker, "--config", join(state, "worker.toml")], { cwd: state, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, RUST_LOG: "error" } });
  let code: number | undefined;
  void w.exited.then((c) => {
    code = c;
  });
  try {
    await listening(port, () => code);
  } catch (e) {
    w.kill("SIGKILL");
    throw e;
  }
  const base = `http://127.0.0.1:${port}`;
  // The first request creates the cell: the file is opened and migrated.
  await fetch(`${base}${SERVICE_PATH}`, { method: "POST", headers: { host: TEST_HOST, "content-type": "application/json" }, body: JSON.stringify({ module: "", service: "", args: [] }) });
  const db = join(state, "data", TEST_TENANT, "app.db");
  if (spec.seeds.length) {
    const sqlite = new Database(db);
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
      rmSync(state, { recursive: true, force: true });
    },
  };
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
  if (!scratch) cpSync(project, work, { recursive: true, filter: (p) => !/\/(\.renox|\.git)(\/|$)/u.test(p.slice(project.length)) });
  // A `path:` source is relative to the app; the scratch copy has the same tree.
  const src = source;
  // The range: `^<version>` of the tree's module.toml (an upgrade may cross a major).
  let range = version;
  if (range === undefined && src.startsWith("path:")) {
    const toml = join(work, src.slice("path:".length), "module.toml");
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
