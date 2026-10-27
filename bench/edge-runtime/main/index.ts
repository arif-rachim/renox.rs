// F0 spike (issue #3): the Edge Runtime "main service". It owns no tenant
// code; for every request it obtains a user worker for one of our example apps
// and forwards the request to it, with explicit per-worker limits. Pattern
// taken from upstream examples/main/index.ts at the version in ../VERSION.
//
// Routing (spike only, not the Renox router):
//   GET /_renox/health          readiness probe for run.sh and smoke.sh
//   GET /_renox/metrics         EdgeRuntime.getRuntimeMetrics() + userWorkers.memStats()
//   any other path              forwarded to examples/<app>/_spike
// Query parameters, stripped before forwarding:
//   __app=<name>     example app; default "hello" (allowlist below)
//   __worker=<key>   pin the request to a dedicated worker per (app, key), so a
//                    benchmark can hold N distinct isolates alive (B1)

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): unknown;
};

interface UserWorker {
  fetch(req: Request, options?: { signal?: AbortSignal }): Promise<Response>;
}

declare const EdgeRuntime: {
  applySupabaseTag(orig: Request, cloned: Request): void;
  userWorkers: {
    create(options: Record<string, unknown>): Promise<UserWorker>;
    memStats(): Promise<unknown>;
  };
  getRuntimeMetrics(): Promise<unknown>;
};

// Only these directories can become user workers; nothing from the request
// path or query is ever used as a file path.
const APPS = new Set(["hello", "npm-compat"]);

// Per-worker limits (docs/04-isolation-security.md, "Per-tenant limits").
// Option names are the ones the pinned upstream accepts (NOTES.md).
const LIMITS = {
  memoryLimitMb: 128,
  lowMemoryMultiplier: 5,
  workerTimeoutMs: 5 * 60 * 1000,
  cpuTimeSoftLimitMs: 1000,
  cpuTimeHardLimitMs: 2000,
};

// Directory holding one staged copy per app (<app>/_spike), with no
// package.json above it (NOTES.md, "The root package.json trap").
const appsDir = Deno.env.get("RENOX_APPS_DIR");
if (!appsDir) throw new Error("RENOX_APPS_DIR is not set; start through run.sh");

const pinned = new Map<string, UserWorker>();

async function workerFor(app: string, key: string | null): Promise<UserWorker> {
  const options = {
    ...LIMITS,
    servicePath: `${appsDir}/${app}/_spike`,
    // No secrets or host environment reach the user worker.
    envVars: [],
    noModuleCache: false,
    forceCreate: key !== null,
  };
  if (key === null) return EdgeRuntime.userWorkers.create(options);
  const id = `${app}:${key}`;
  let worker = pinned.get(id);
  if (!worker) {
    worker = await EdgeRuntime.userWorkers.create(options);
    pinned.set(id, worker);
  }
  return worker;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === "/_renox/health") return Response.json({ ok: true });
  if (url.pathname === "/_renox/metrics") {
    const [runtime, workers] = await Promise.all([
      EdgeRuntime.getRuntimeMetrics(),
      EdgeRuntime.userWorkers.memStats(),
    ]);
    return Response.json({ runtime, workers });
  }

  const app = url.searchParams.get("__app") ?? "hello";
  if (!APPS.has(app)) return Response.json({ error: "unknown app" }, { status: 404 });
  const key = url.searchParams.get("__worker");
  url.searchParams.delete("__app");
  url.searchParams.delete("__worker");

  try {
    const worker = await workerFor(app, key);
    // A cloned request must carry the runtime's internal tag, or the user
    // worker cannot read its body stream (upstream examples/main/index.ts).
    const forwarded = new Request(url, req);
    EdgeRuntime.applySupabaseTag(req, forwarded);
    return await worker.fetch(forwarded);
  } catch (e) {
    // A retired pinned worker is recreated on the next request.
    if (key !== null) pinned.delete(`${app}:${key}`);
    return Response.json({ error: String(e) }, { status: 502 });
  }
});
