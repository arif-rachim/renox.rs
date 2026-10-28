// renox dev [--port 8787]: build, write a local route table and worker
// config under .renox/, start the prebuilt renox-worker, watch the project,
// rebuild the changed module, point the route at the new hash, and SIGHUP
// the worker so the next request goes to a fresh isolate (D19: hot reload
// discards the isolate). The old cell drains and is evicted.
//
// Saves are debounced (DEBOUNCE_MS) and builds run one at a time, so a burst
// of saves gives one rebuild and one route switch; the route table is
// replaced atomically and only after a build succeeded, so the worker never
// sees a half-updated state. A worker that exits is restarted with a message;
// one that keeps crashing ends `renox dev` with exit code 3.
//
// Browser side (#43): the proxy serves an SSE channel and a small client
// script, injected into HTML responses only here (lib/templates-dev.ts): a
// failed build shows an overlay, a template-only change swaps the changed
// fragments, anything else reloads. `.renox/types/` is regenerated after
// every successful build (lib/types/generate.ts), and server stacks in the
// terminal are mapped back to the TypeScript sources (lib/sourcemap.ts).
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
//   types/                  routes.d.ts, db.d.ts, index.d.ts (#43)
//   worker.toml             generated worker config
//   meters/, logs/          meter batches, tenant log lines

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";

import { CliError, EnvironmentError, EXIT, formatError, location } from "../errors.ts";
import { artifactsDir, BuildCache, buildArtifact } from "../lib/build.ts";
import { Symbolicator } from "../lib/sourcemap.ts";
import { TemplateError } from "../lib/templates-compile.ts";
import { allHints, CLIENT_EVENTS_PATH, clientLine, handleBatch, injectDevMeta, type PageRoute } from "../dev/client-events.ts";
import { BROWSER_TAB_PATH, browserTabJs } from "../dev/overlay/browser-tab.ts";
import { collectErrorDetails } from "../dev/overlay/details.ts";
import { ERROR_DETAILS_PATH, ERROR_OVERLAY_JS, ERROR_OVERLAY_PATH, injectErrorOverlay } from "../dev/overlay/overlay.ts";
import { changeEvent, DEV_CLIENT_JS, DEV_CLIENT_PATH, DEV_EVENTS_PATH, injectDevClient, sse } from "../lib/templates-dev.ts";
import { writeTypes } from "../lib/types/generate.ts";
import { DOWNLOAD_HINT, workerPath } from "../lib/worker.ts";
import { clearDevState, type DevState, problemOf, writeDevState } from "../mcp/devstate.ts";

export { workerPath };

export const DEV_TENANT = "dev";

/** Quiet time after the last save before a rebuild starts. */
export const DEBOUNCE_MS = 30;
/** More worker exits than this within RESTART_WINDOW_MS end `renox dev` (exit 3). */
export const MAX_RESTARTS = 5;
export const RESTART_WINDOW_MS = 30_000;


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

/** Replaces the route table atomically (write, then rename): a reader sees the old or the new table. */
function writeRoutes(path: string, hostname: string, hash: string): void {
  const entries = [{ hostname, tenant_id: DEV_TENANT, deployment_hash: hash, status: "active", updated_at: Date.now() }];
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 0, entries }, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Whether something accepts connections on `host:port` (false when the address family is missing). */
const accepts = (host: string, port: number): Promise<boolean> =>
  new Promise((r) => {
    const s = connect({ host, port });
    const done = (ok: boolean): void => {
      s.destroy();
      r(ok);
    };
    s.setTimeout(500, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });

/**
 * A port taken on either loopback family. `localhost` resolves to both
 * 127.0.0.1 and ::1 on most machines; binding one family can succeed while
 * another server holds the other, and a browser would then reach that server.
 */
export const portTaken = async (port: number): Promise<boolean> =>
  (await Promise.all([accepts("127.0.0.1", port), accepts("::1", port)])).some(Boolean);

/** Resolves when the worker listens; rejects when it exits first or takes longer than `ms`. */
const waitForPort = async (port: number, ms: number, exited: Promise<number>): Promise<void> => {
  const t0 = Date.now();
  let exitCode: number | undefined;
  void exited.then((c) => {
    exitCode = c;
  });
  for (;;) {
    if (exitCode !== undefined)
      throw new EnvironmentError(`renox-worker exited during startup (exit code ${exitCode})`, {
        hint: "run it by hand with --config .renox/worker.toml to see why, or download the release build again",
      });
    const ok = await new Promise<boolean>((r) => {
      const s = connect(port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        r(true);
      });
      s.once("error", () => r(false));
    });
    if (ok) return;
    if (Date.now() - t0 > ms) throw new EnvironmentError(`renox-worker did not listen on port ${port} within ${ms} ms`);
    await Bun.sleep(50);
  }
};

/** Files that change the artifact: sources, templates, migrations, public files, renox.toml. */
export function isAppInput(file: string): boolean {
  if (/^(\.renox|node_modules|\.git|dist|tests)(\/|$)/u.test(file)) return false;
  if (file === "renox.toml" || file.startsWith("migrations/") || file.startsWith("public/")) return true;
  if (/^(pages|partials|modules|overrides)\/.*\.html$/u.test(file)) return true;
  return /\.(ts|js|mjs|json)$/u.test(file) && !/\.(test|spec)\.(ts|js|mjs)$/u.test(file) && file !== "package.json";
}

export interface DevServer {
  port: number;
  hash: () => string;
  /** Resolves after the next rebuild (and its SIGHUP), with what the browser was told. */
  nextReload: () => Promise<{ hash: string; ms: number; event: string | null }>;
  /** Resolves after the next worker restart, with the new worker's pid. */
  nextRestart: () => Promise<number>;
  /** Resolves when `renox dev` gives up (the worker keeps crashing), with the error. */
  failed: Promise<CliError>;
  stop: () => Promise<void>;
}

export interface DevOptions {
  project: string;
  port: number;
  worker?: string;
  log?: (line: string) => void;
  /** Overrides DEBOUNCE_MS (tests). */
  debounceMs?: number;
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
  let last = first;
  writeTypes(project, first.manifest.routes, first.templates);
  const symbols = new Symbolicator(() => join(artifacts, "..", "sourcemaps", current));
  // Browsers listening on DEV_EVENTS_PATH.
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const broadcast = (event: string, data: unknown): void => {
    for (const c of clients) {
      try {
        c.enqueue(enc.encode(sse(event, data)));
      } catch {
        clients.delete(c);
      }
    }
  };
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
  const binary = opts.worker ?? workerPath();
  const spawnWorker = (): Bun.Subprocess<"ignore", "ignore", "pipe"> => {
    let w: Bun.Subprocess<"ignore", "ignore", "pipe">;
    try {
      w = Bun.spawn([binary, "--config", toml], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "warn" },
      });
    } catch (e) {
      throw new EnvironmentError(`cannot start renox-worker (${binary}): ${(e as Error).message}`, { hint: DOWNLOAD_HINT });
    }
    // Worker warnings and errors to the terminal.
    void (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of w.stderr) {
        buf += dec.decode(chunk);
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (/"level":"(WARN|ERROR)"/u.test(line)) log(`worker: ${line}`);
        }
      }
    })();
    return w;
  };
  let worker = spawnWorker();
  try {
    await waitForPort(workerPort, 30_000, worker.exited);
  } catch (e) {
    worker.kill("SIGKILL");
    throw e;
  }
  const portInUse = (): EnvironmentError =>
    new EnvironmentError(`port ${opts.port} is in use`, { hint: "stop the other process, or pass --port <port>" });
  if (await portTaken(opts.port)) {
    worker.kill("SIGKILL");
    throw portInUse();
  }
  let proxy: ReturnType<typeof Bun.serve>;
  try {
    proxy = Bun.serve({
      hostname: "localhost",
      port: opts.port,
      idleTimeout: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === DEV_CLIENT_PATH)
          return new Response(DEV_CLIENT_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
        // Browser events (#127): batches are handled here (terminal, .renox/logs/browser.ndjson);
        // CSP reports go on to the worker without the proxy's Origin (the worker's own host differs).
        if (u.pathname === CLIENT_EVENTS_PATH && req.method === "POST" && u.searchParams.get("kind") !== "csp")
          return handleBatch(req, { browserLog: join(state, "logs", "browser.ndjson"), routes: () => last.manifest.routes as PageRoute[], log });
        if (u.pathname === BROWSER_TAB_PATH)
          return new Response(browserTabJs(allHints()), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
        // Error overlay (#93): the script, and the details of one request from .renox/logs and .renox/meters.
        if (u.pathname === ERROR_OVERLAY_PATH)
          return new Response(ERROR_OVERLAY_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
        if (u.pathname === ERROR_DETAILS_PATH) {
          const id = u.searchParams.get("id") ?? "";
          if (!/^[0-9A-Za-z]{26}$/u.test(id)) return new Response("bad id\n", { status: 400 });
          return Response.json(await collectErrorDetails(state, id), { headers: { "cache-control": "no-store" } });
        }
        if (u.pathname === DEV_EVENTS_PATH) {
          let self: ReadableStreamDefaultController<Uint8Array> | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              self = c;
              clients.add(c);
              c.enqueue(enc.encode(": renox dev\n\n"));
              if (!status.lastBuild.ok) c.enqueue(enc.encode(sse("error", { problems: status.lastBuild.problems })));
            },
            cancel() {
              if (self) clients.delete(self);
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
        }
        const headers = new Headers(req.headers);
        headers.set("host", host);
        if (u.pathname === CLIENT_EVENTS_PATH) headers.delete("origin");
        const init: RequestInit = { method: req.method, headers, redirect: "manual" };
        if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.arrayBuffer();
        let res: Response;
        try {
          res = await fetch(`http://127.0.0.1:${workerPort}${u.pathname}${u.search}`, init);
        } catch {
          return new Response("renox dev: the worker is not reachable (restarting?)\n", { status: 502 });
        }
        // Full HTML documents get the dev client; htmx fragments do not.
        if (req.method === "HEAD" || headers.get("hx-request") === "true" || !(res.headers.get("content-type") ?? "").startsWith("text/html")) return res;
        const csp = res.headers.get("content-security-policy");
        const nonce = csp ? /'nonce-([A-Za-z0-9+/=_-]+)'/u.exec(csp)?.[1] : undefined;
        // First in <head>: the dev marker the client script reads, and the Browser tab, which must listen before it.
        let html = injectDevMeta(await res.text(), `<script src="${BROWSER_TAB_PATH}"${nonce ? ` nonce="${nonce}"` : ""}></script>`);
        html = injectDevClient(html, csp);
        // Error pages get the error overlay (#93); production pages never do.
        const requestId = res.headers.get("x-renox-request-id");
        if (res.status >= 400 && requestId) html = injectErrorOverlay(html, requestId, res.status, csp);
        const out = new Headers(res.headers);
        out.delete("content-length");
        out.delete("content-encoding");
        return new Response(html, { status: res.status, statusText: res.statusText, headers: out });
      },
    });
  } catch (e) {
    worker.kill("SIGKILL");
    const inUse = /EADDRINUSE|in use/iu.test(String((e as Error).message ?? e)) || (e as NodeJS.ErrnoException).code === "EADDRINUSE";
    throw inUse ? portInUse() : new EnvironmentError(`cannot listen on port ${opts.port}: ${(e as Error).message}`, { hint: "stop the other process, or pass --port <port>" });
  }
  // .renox/dev.json for the MCP tools dev_status and dev_errors.
  const status: DevState = {
    pid: process.pid,
    port: opts.port,
    url: `http://localhost:${opts.port}`,
    startedAt: new Date().toISOString(),
    artifact: current,
    routes: first.manifest.routes.length,
    lastBuild: { ok: true, at: new Date().toISOString(), ms: Math.round(first.ms), problems: [] },
    workerRestarts: 0,
  };
  writeDevState(project, status);
  log(`renox dev: http://localhost:${opts.port}  (artifact ${current.slice(0, 12)}, ${first.manifest.routes.length} routes)`);
  for (const r of first.manifest.routes) log(`  ${(r.kind === "function" ? r.method : "PAGE").padEnd(7)} ${r.path}`);

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
        const l = JSON.parse(line) as { level: string; message: string; request_id?: string | null; fields?: Record<string, unknown> };
        // Browser events the worker logged (CSP reports): the [browser] form.
        const browser = clientLine(l, last.manifest.routes as PageRoute[]);
        if (browser) {
          log(browser);
          continue;
        }
        const { stack, ...rest } = l.fields ?? {};
        const f = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
        log(`[${l.level}] ${l.message}${f}`);
        // Server stacks point at the TypeScript sources (.renox/sourcemaps/<hash>/).
        if (typeof stack === "string" && stack) log(symbols.stack(stack).replace(/^/gmu, "    "));
      } catch {
        log(line);
      }
    }
  }, 200);

  // Worker supervision: restart on exit, give up after MAX_RESTARTS in RESTART_WINDOW_MS.
  let stopping = false;
  const restarts: number[] = [];
  const restartWaiters: Array<(pid: number) => void> = [];
  let giveUp: (e: CliError) => void = () => {};
  const failed = new Promise<CliError>((r) => {
    giveUp = r;
  });
  const supervise = (w: Bun.Subprocess<"ignore", "ignore", "pipe">): void => {
    void w.exited.then(async (code) => {
      if (stopping || w !== worker) return;
      const now = Date.now();
      restarts.push(now);
      while (restarts.length && (restarts[0] as number) < now - RESTART_WINDOW_MS) restarts.shift();
      if (restarts.length > MAX_RESTARTS) {
        const e = new EnvironmentError(`renox-worker keeps exiting (${restarts.length} times in ${RESTART_WINDOW_MS / 1000} s); stopping`, {
          hint: "see the worker lines above; run it by hand with --config .renox/worker.toml to see why",
        });
        log(formatError("dev", e));
        giveUp(e);
        return;
      }
      log(`renox dev: renox-worker exited (${w.signalCode ?? `exit code ${code}`}); restarting`);
      await Bun.sleep(100 * restarts.length);
      if (stopping) return;
      try {
        worker = spawnWorker();
        supervise(worker);
        await waitForPort(workerPort, 30_000, worker.exited);
      } catch (e) {
        // Exited again during startup (its exit handler counts it), or never
        // listened: killed, so the exit handler retries.
        log(`renox dev: ${(e as Error).message}`);
        worker.kill("SIGKILL");
        return;
      }
      status.workerRestarts++;
      writeDevState(project, status);
      log(`renox dev: renox-worker restarted (artifact ${current.slice(0, 12)})`);
      for (const r of restartWaiters.splice(0)) r(worker.pid);
    });
  };
  supervise(worker);

  const waiters: Array<(r: { hash: string; ms: number; event: string | null }) => void> = [];
  let pending: ReturnType<typeof setTimeout> | undefined;
  let building = Promise.resolve();
  const rebuild = (): void => {
    building = building.then(async () => {
      const t0 = performance.now();
      try {
        const r = await buildArtifact(project, artifacts, cache);
        const change = changeEvent(last, r, r.codeHash !== last.codeHash);
        last = r;
        if (r.hash !== current) {
          current = r.hash;
          writeRoutes(routes, host, current);
          worker.kill("SIGHUP");
        }
        writeTypes(project, r.manifest.routes, r.templates);
        const wasFailing = !status.lastBuild.ok;
        if (change?.event === "templates") broadcast("templates", { targets: change.targets });
        else if (change) broadcast("reload", {});
        else if (wasFailing) broadcast("ok", {});
        const ms = Math.round(performance.now() - t0);
        log(`rebuilt in ${ms} ms (${r.rebuilt} module${r.rebuilt === 1 ? "" : "s"}, artifact ${current.slice(0, 12)})`);
        status.artifact = current;
        status.routes = r.manifest.routes.length;
        status.lastBuild = { ok: true, at: new Date().toISOString(), ms, problems: [] };
        writeDevState(project, status);
        for (const w of waiters.splice(0)) w({ hash: current, ms, event: change?.event ?? null });
      } catch (e) {
        log(e instanceof CliError ? `build failed: ${location(e) ? `${location(e)}: ` : ""}${e.message}${e.hint ? `\n  hint: ${e.hint}` : ""}` : `build failed: ${(e as Error).message}`);
        const problems = e instanceof TemplateError ? e.locations().map((d) => problemOf(new CliError(d.message, EXIT.VALIDATION, d.where))) : [problemOf(e)];
        status.lastBuild = { ok: false, at: new Date().toISOString(), ms: Math.round(performance.now() - t0), problems };
        writeDevState(project, status);
        broadcast("error", { problems });
      }
    });
  };
  const watcher = watch(project, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const f = filename.split("\\").join("/");
    if (!isAppInput(f)) return;
    // The bundle is reused until a function source changes; another source
    // file may be imported by any module, so the cache is dropped. Set per
    // event, not per rebuild: one burst can touch lib/ and then functions/.
    if (!f.startsWith("functions/") && !f.startsWith("pages/") && !f.endsWith(".html")) cache.invalidateAll = true;
    if (pending) clearTimeout(pending);
    pending = setTimeout(rebuild, opts.debounceMs ?? DEBOUNCE_MS);
  });

  return {
    port: opts.port,
    hash: () => current,
    nextReload: () => new Promise((r) => waiters.push(r)),
    nextRestart: () => new Promise((r) => restartWaiters.push(r)),
    failed,
    stop: async () => {
      stopping = true;
      if (pending) clearTimeout(pending);
      watcher.close();
      clearInterval(tail);
      clearDevState(project);
      for (const c of clients) {
        try {
          c.close();
        } catch {
          // Already closed by the browser.
        }
      }
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
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || args.some((a, i) => a.startsWith("-") && a !== "--port" && args[i - 1] !== "--port")) {
    console.error("usage: renox dev [--port <port>]");
    return EXIT.USER;
  }
  // Ctrl-C during the first build or the worker start: stop at once.
  const early = (): never => process.exit(EXIT.INTERRUPTED);
  process.once("SIGINT", early);
  const dev = await startDev({ project: process.cwd(), port });
  process.off("SIGINT", early);
  const outcome = await Promise.race([
    new Promise<"interrupted">((r) => process.once("SIGINT", () => r("interrupted"))),
    dev.failed,
  ]);
  await dev.stop();
  // A give-up was already printed by the supervisor.
  return outcome === "interrupted" ? EXIT.INTERRUPTED : outcome.exitCode;
}
