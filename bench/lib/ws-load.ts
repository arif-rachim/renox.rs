// B14 load generator (#282; docs/14-benchmarks.md B14): signs one user in
// to examples/chat on a running worker, opens N idle WebSocket connections
// to one room, holds them, and reports the worker's RSS before and after
// and the isolate heap seen by a page request before and after (the meter
// record's `peak_heap_bytes`): connections are owned by Rust (the realtime
// hub), so the heap must not grow with them.
//
//   bun bench/lib/ws-load.ts <worker dir> <port> <host> <connections> <hold_s> <out.json>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (argv.length !== 6 || argv.some((a) => a === "")) {
  console.error("usage: ws-load.ts <worker dir> <port> <host> <connections> <hold_s> <out.json>");
  process.exit(2);
}
const [dir, portArg, host, nArg, holdArg, out] = argv as [string, string, string, string, string, string];
const base = `http://127.0.0.1:${portArg}`;
const n = Number(nArg);
const hold = Number(holdArg);
const pid = Number(readFileSync(join(dir, "worker.pid"), "utf8").trim());

const rssMb = (): number => {
  const m = /VmRSS:\s+(\d+) kB/u.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
  return m ? Number(m[1]) / 1024 : Number.NaN;
};

const jar = new Map<string, string>();
async function req(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<Response> {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${base}${path}`, { method, redirect: "manual", headers: { host, ...(cookie ? { cookie } : {}), ...headers }, ...(body !== undefined ? { body } : {}) });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = (pair ?? "").indexOf("=");
    if (i > 0) jar.set((pair as string).slice(0, i), (pair as string).slice(i + 1));
  }
  return res;
}

async function action(path: string, name: string, form: Record<string, string>): Promise<Response> {
  if (!jar.has("__Host-renox_csrf")) await (await req("GET", path)).text();
  return req("POST", `${path}?/${name}`, new URLSearchParams(form).toString(), { "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": jar.get("__Host-renox_csrf") ?? "" });
}

/**
 * The isolate heap a page request sees: the smallest `peak_heap_bytes` of
 * the meter records of `route` after `after` (several requests: one
 * request's peak depends on when V8 last collected).
 */
async function heapOf(route: string, after: number): Promise<number | null> {
  for (let i = 0; i < 40; i++) {
    let best: { at: number; heap: number } | null = null;
    for (const f of readdirSync(join(dir, "meters"))) {
      for (const line of readFileSync(join(dir, "meters", f), "utf8").split("\n")) {
        if (!line.includes(route)) continue;
        try {
          // One flushed batch per line: { records: [...] }.
          const batch = JSON.parse(line) as { records?: { route?: string; peak_heap_bytes?: number; started_at?: number }[] };
          for (const r of batch.records ?? []) {
            const at = r.started_at ?? 0;
            if (r.route === route && typeof r.peak_heap_bytes === "number" && at >= after && (best === null || r.peak_heap_bytes < best.heap)) best = { at, heap: r.peak_heap_bytes };
          }
        } catch {
          // a partial line
        }
      }
    }
    if (best !== null) return best.heap;
    await Bun.sleep(250);
  }
  return null;
}

const password = "correct horse battery";
await (await action("/auth/register", "default", { email: "bench@example.com", password, display_name: "Bench" })).text();
const login = await action("/auth/login", "default", { email: "bench@example.com", password });
if (login.status !== 303) throw new Error(`login failed: ${login.status}`);
const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

// Warm the isolate (the page and one socket), then the baseline.
const t0 = Date.now();
for (let i = 0; i < 5; i++) await (await req("GET", "/rooms/general")).text();
const warm = new WebSocket(`ws://127.0.0.1:${portArg}/ws/chat/general`, { headers: { host, cookie, origin: `http://${host}` } } as unknown as string[]);
await new Promise((r) => warm.addEventListener("open", r));
warm.close();
await Bun.sleep(2000);
const heapBefore = await heapOf("GET /rooms/:room", t0);
const rssBefore = rssMb();

// N idle connections, opened in batches.
const sockets: WebSocket[] = [];
let opened = 0;
let failed = 0;
const tOpen = Date.now();
for (let i = 0; i < n; i += 500) {
  const batch = Array.from({ length: Math.min(500, n - i) }, () => {
    const s = new WebSocket(`ws://127.0.0.1:${portArg}/ws/chat/general`, { headers: { host, cookie, origin: `http://${host}` } } as unknown as string[]);
    sockets.push(s);
    return new Promise<void>((resolve) => {
      s.addEventListener("open", () => {
        opened++;
        resolve();
      });
      s.addEventListener("close", () => resolve());
      s.addEventListener("error", () => {
        failed++;
        resolve();
      });
    });
  });
  await Promise.all(batch);
}
const openMs = Date.now() - tOpen;
const samples: number[] = [];
for (let i = 0; i < hold; i++) {
  await Bun.sleep(1000);
  samples.push(rssMb());
}
const alive = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
const t1 = Date.now();
for (let i = 0; i < 5; i++) await (await req("GET", "/rooms/general")).text();
const heapAfter = await heapOf("GET /rooms/:room", t1);
const rssAfter = samples.length ? samples[samples.length - 1] as number : rssMb();
for (const s of sockets) s.close();

const result = {
  connections: n,
  opened,
  failed,
  alive_at_end: alive,
  open_ms: openMs,
  rss_before_mb: Number(rssBefore.toFixed(1)),
  rss_after_mb: Number(rssAfter.toFixed(1)),
  rss_delta_mb: Number((rssAfter - rssBefore).toFixed(1)),
  rss_samples_mb: samples.map((x) => Number(x.toFixed(1))),
  heap_before_bytes: heapBefore,
  heap_after_bytes: heapAfter,
  heap_delta_mb: heapBefore !== null && heapAfter !== null ? Number(((heapAfter - heapBefore) / 1048576).toFixed(2)) : null,
};
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exit(0);
