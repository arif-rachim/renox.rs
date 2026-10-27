// renox dev [--port 8787]: build, write a local route table and worker
// config under .renox/, start the prebuilt renox-worker, watch the project,
// rebuild the changed module, point the route at the new hash, and SIGHUP
// the worker so the next request goes to a fresh isolate (D19: hot reload
// discards the isolate). The old cell drains and is evicted.
//
// The route table needs a dotted hostname (route-table.schema.json), so the
// app is routed as `<app>.localhost`; `renox dev` listens on
// `localhost:<port>` and forwards every request to the worker with that
// Host header. The worker itself listens on a free loopback port.
//
// .renox/
//   artifact/<hash>/        built artifacts (content-addressed)
//   data/dev/app.db         the tenant file (tenant id `dev`)
//   data/dev/secrets.json   from .env, mode 0600
//   routes.json             <app>.localhost -> dev -> <hash>
//   worker.toml             generated worker config
//   meters/, logs/          meter batches, tenant log lines

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";

import { artifactsDir, BuildCache, buildArtifact } from "../lib/build.ts";

export const DEV_TENANT = "dev";

/** The hostname the app is routed under in the local route table. */
export const devHost = (app: string): string => `${app}.localhost`;

/** A free loopback port. */
function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

/** `.env`: `KEY=value` lines, `#` comments, optional single or double quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!m) continue;
    let v = (m[2] as string).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1] as string] = v;
  }
  return out;
}

/** The worker binary: RENOX_WORKER_PATH, else cli/bin/<platform>-<arch>/renox-worker. */
export function workerPath(): string {
  const env = process.env.RENOX_WORKER_PATH;
  if (env) return resolve(env);
  const p = join(import.meta.dir, "..", "..", "bin", `${process.platform}-${process.arch}`, "renox-worker");
  if (existsSync(p)) return p;
  throw new Error(
    "no renox-worker binary: set RENOX_WORKER_PATH, or run `bun cli/scripts/fetch-worker.ts <version>` to download the release build",
  );
}

function writeRoutes(path: string, hostname: string, hash: string): void {
  const entries = [{ hostname, tenant_id: DEV_TENANT, deployment_hash: hash, status: "active", updated_at: Date.now() }];
  writeFileSync(path, `${JSON.stringify({ version: 0, entries }, null, 2)}\n`);
}

const waitForPort = async (port: number, ms: number): Promise<void> => {
  const t0 = Date.now();
  for (;;) {
    const ok = await new Promise<boolean>((r) => {
      const s = connect(port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        r(true);
      });
      s.once("error", () => r(false));
    });
    if (ok) return;
    if (Date.now() - t0 > ms) throw new Error(`renox-worker did not listen on port ${port} within ${ms} ms`);
    await Bun.sleep(50);
  }
};

/** Files that change the artifact: sources, migrations, public files, renox.toml. */
export function isAppInput(file: string): boolean {
  if (/^(\.renox|node_modules|\.git|dist|tests)(\/|$)/u.test(file)) return false;
  if (file === "renox.toml" || file.startsWith("migrations/") || file.startsWith("public/")) return true;
  return /\.(ts|js|mjs|json)$/u.test(file) && !/\.(test|spec)\.(ts|js|mjs)$/u.test(file) && file !== "package.json";
}

export interface DevServer {
  port: number;
  hash: () => string;
  /** Resolves after the next rebuild (and its SIGHUP). */
  nextReload: () => Promise<{ hash: string; ms: number }>;
  stop: () => Promise<void>;
}

export interface DevOptions {
  project: string;
  port: number;
  worker?: string;
  log?: (line: string) => void;
}

export async function startDev(opts: DevOptions): Promise<DevServer> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const project = resolve(opts.project);
  const state = join(project, ".renox");
  const artifacts = artifactsDir(project);
  const tenantDir = join(state, "data", DEV_TENANT);
  for (const d of [artifacts, tenantDir, join(state, "meters"), join(state, "logs")]) mkdirSync(d, { recursive: true });

  // Secrets from .env (never printed).
  const secretsPath = join(tenantDir, "secrets.json");
  const envFile = join(project, ".env");
  const secrets = existsSync(envFile) ? parseDotenv(readFileSync(envFile, "utf8")) : {};
  writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
  chmodSync(secretsPath, 0o600);

  const cache = new BuildCache();
  const first = await buildArtifact(project, artifacts, cache);
  let current = first.hash;
  const host = devHost(first.manifest.app.name);
  const routes = join(state, "routes.json");
  writeRoutes(routes, host, current);
  const workerPort = freePort();
  const toml = join(state, "worker.toml");
  writeFileSync(
    toml,
    [
      `listen = "127.0.0.1:${workerPort}"`,
      `data_dir = "data"`,
      `artifacts_dir = "artifact"`,
      `routes_file = "routes.json"`,
      `meters_dir = "meters"`,
      `logs_dir = "logs"`,
      `node_id = "dev"`,
      `idle_timeout_secs = 600`,
      `meter_flush_ms = 1000`,
      `default_tier = "free"`,
      "",
    ].join("\n"),
  );
  const worker = Bun.spawn([opts.worker ?? workerPath(), "--config", toml], {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "warn" },
  });
  // Worker warnings and errors to the terminal.
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of worker.stderr) {
      buf += dec.decode(chunk);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (/"level":"(WARN|ERROR)"/u.test(line)) log(`worker: ${line}`);
      }
    }
  })();
  await waitForPort(workerPort, 30_000);
  const proxy = Bun.serve({
    hostname: "localhost",
    port: opts.port,
    async fetch(req) {
      const u = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.set("host", host);
      const init: RequestInit = { method: req.method, headers, redirect: "manual" };
      if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.arrayBuffer();
      try {
        return await fetch(`http://127.0.0.1:${workerPort}${u.pathname}${u.search}`, init);
      } catch {
        return new Response("renox dev: the worker is not reachable\n", { status: 502 });
      }
    },
  });
  log(`renox dev: http://localhost:${opts.port}  (artifact ${current.slice(0, 12)}, ${first.manifest.routes.length} routes)`);
  for (const r of first.manifest.routes) log(`  ${r.method.padEnd(7)} ${r.path}`);

  // Tenant log lines to the terminal.
  const tenantLog = join(state, "logs", "tenant.ndjson");
  let offset = existsSync(tenantLog) ? statSync(tenantLog).size : 0;
  const tail = setInterval(() => {
    if (!existsSync(tenantLog)) return;
    const size = statSync(tenantLog).size;
    if (size <= offset) return;
    const fd = openSync(tenantLog, "r");
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        const l = JSON.parse(line) as { level: string; message: string; fields?: unknown };
        const f = l.fields && Object.keys(l.fields).length ? ` ${JSON.stringify(l.fields)}` : "";
        log(`[${l.level}] ${l.message}${f}`);
      } catch {
        log(line);
      }
    }
  }, 200);

  const waiters: Array<(r: { hash: string; ms: number }) => void> = [];
  let pending: ReturnType<typeof setTimeout> | undefined;
  let building = Promise.resolve();
  const rebuild = (file: string): void => {
    // A module under functions/ is rebuilt alone; another source file may be
    // imported by any module, so every module is rebuilt.
    if (!file.startsWith("functions/")) cache.invalidateAll = true;
    building = building.then(async () => {
      const t0 = performance.now();
      try {
        const r = await buildArtifact(project, artifacts, cache);
        if (r.hash !== current) {
          current = r.hash;
          writeRoutes(routes, host, current);
          worker.kill("SIGHUP");
        }
        const ms = Math.round(performance.now() - t0);
        log(`rebuilt in ${ms} ms (${r.rebuilt} module${r.rebuilt === 1 ? "" : "s"}, artifact ${current.slice(0, 12)})`);
        for (const w of waiters.splice(0)) w({ hash: current, ms });
      } catch (e) {
        log(`build failed: ${(e as Error).message}`);
      }
    });
  };
  const watcher = watch(project, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const f = filename.split("\\").join("/");
    if (!isAppInput(f)) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => rebuild(f), 30);
  });

  return {
    port: opts.port,
    hash: () => current,
    nextReload: () => new Promise((r) => waiters.push(r)),
    stop: async () => {
      watcher.close();
      clearInterval(tail);
      proxy.stop(true);
      worker.kill("SIGINT");
      const exited = await Promise.race([worker.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!exited) worker.kill("SIGKILL");
    },
  };
}

export async function run(args: string[]): Promise<number> {
  const p = args.indexOf("--port");
  const port = p >= 0 ? Number(args[p + 1]) : 8787;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error("usage: renox dev [--port <port>]");
    return 2;
  }
  const dev = await startDev({ project: process.cwd(), port });
  await new Promise<void>((r) => process.once("SIGINT", () => r()));
  await dev.stop();
  return 0;
}
