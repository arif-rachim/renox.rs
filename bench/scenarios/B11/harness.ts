// Shared by the F1 worker benchmarks (B1, B2, B3, B4, B5, B11, B12; #35):
// start renox-worker through bench/lib/worker.sh for a set of tenants,
// sample the process (RSS, PSS, threads, open files), read its meter
// records, and generate HTTP load.
//
// Load: `oha` when it is on PATH (docs/14-benchmarks.md, "Methodology"),
// otherwise a Bun keep-alive load generator in this process. The result
// notes say which one ran; the Bun generator shares the machine's cores
// with the worker, so its numbers are a lower bound on what the worker can
// serve.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const benchDir = join(import.meta.dir, "../..");

// Worker directories (data, artifacts, meters: one record per request, GBs
// under load) are removed when the scenario process exits, after it has
// read what it needs. BENCH_KEEP=1 keeps them for inspection.
const created: string[] = [];
process.on("exit", () => {
  if (process.env.BENCH_KEEP === "1") return;
  for (const d of created) rmSync(d, { recursive: true, force: true });
});
const workerSh = join(benchDir, "lib/worker.sh");

export const round = (x: number, digits = 3): number => Math.round(x * 10 ** digits) / 10 ** digits;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Tenant {
  host: string;
  tenant: string;
  app: string;
}

function sh(args: string[]): string {
  const p = Bun.spawnSync([workerSh, ...args], { stdout: "pipe", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`worker.sh ${args[0]} failed (${p.exitCode})`);
  return p.stdout.toString().trim();
}

export const freePort = (): number => {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
};

export class Worker {
  private constructor(
    readonly dir: string,
    readonly port: number,
    readonly pid: number,
  ) {}

  /** Build (once), set up, and start a worker serving `tenants`. */
  static async start(tenants: Tenant[], opts: { idleS?: number } = {}): Promise<Worker> {
    const dir = mkdtempSync(join(tmpdir(), "renox-bench-"));
    created.push(dir);
    const port = freePort();
    const file = join(dir, "tenants.txt");
    writeFileSync(file, tenants.map((t) => `${t.host} ${t.tenant} ${t.app}`).join("\n") + "\n");
    sh(["setup", dir, String(port), String(opts.idleS ?? 600), file]);
    const pid = Number(sh(["start", dir]));
    return new Worker(dir, port, pid);
  }

  stop(): void {
    sh(["stop", this.dir]);
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  /** One request with the tenant's Host; returns status and client-side ms. */
  async request(host: string, path: string, init: RequestInit = {}): Promise<{ status: number; ms: number; body: string }> {
    const t0 = performance.now();
    const r = await fetch(this.url(path), { ...init, headers: { ...(init.headers as Record<string, string>), host } });
    const body = await r.text();
    return { status: r.status, ms: performance.now() - t0, body };
  }

  /** RSS and PSS of the worker process, MB. */
  memory(): { rss_mb: number; pss_mb: number } {
    const status = readFileSync(`/proc/${this.pid}/status`, "utf8");
    const rss = Number(/VmRSS:\s+(\d+)/u.exec(status)?.[1] ?? 0);
    let pss = 0;
    try {
      pss = Number(/Pss:\s+(\d+)/u.exec(readFileSync(`/proc/${this.pid}/smaps_rollup`, "utf8"))?.[1] ?? 0);
    } catch {
      pss = 0;
    }
    return { rss_mb: rss / 1024, pss_mb: pss / 1024 };
  }

  threads(): number {
    return Number(/Threads:\s+(\d+)/u.exec(readFileSync(`/proc/${this.pid}/status`, "utf8"))?.[1] ?? 0);
  }

  openFiles(): number {
    return readdirSync(`/proc/${this.pid}/fd`).length;
  }

  /** Every meter record written so far. */
  meters(): MeterRecord[] {
    const dir = join(this.dir, "meters");
    const out: MeterRecord[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ndjson")) continue;
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (line) out.push(...(JSON.parse(line) as { records: MeterRecord[] }).records);
      }
    }
    return out;
  }
}

export interface MeterRecord {
  request_id: string;
  tenant_id: string;
  route: string;
  cpu_ms: number;
  wall_ms: number;
  peak_heap_bytes: number;
  http_status: number;
  status: string;
}

export interface LoadResult {
  generator: "oha" | "bun";
  requests: number;
  errors: number;
  req_per_s: number;
  p50_ms: number;
  p99_ms: number;
  /** Bun generator only: every latency, ms. */
  latencies?: number[];
}

const percentile = (sorted: number[], p: number): number => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

export const hasOha = (): boolean => Bun.which("oha") !== null;

/**
 * Closed-loop load: `connections` concurrent keep-alive clients for
 * `durationS`, each sending the next request when the previous one ends.
 */
export async function load(w: Worker, host: string, path: string, connections: number, durationS: number): Promise<LoadResult> {
  if (hasOha()) {
    const p = Bun.spawnSync(
      ["oha", "-c", String(connections), "-z", `${durationS}s`, "--no-tui", "--output-format", "json", "-H", `Host: ${host}`, w.url(path)],
      { stdout: "pipe", stderr: "inherit" },
    );
    if (p.exitCode !== 0) throw new Error("oha failed");
    const j = JSON.parse(p.stdout.toString()) as {
      summary: { requestsPerSec: number; successRate: number };
      latencyPercentiles: Record<string, number>;
      statusCodeDistribution: Record<string, number>;
    };
    const total = Object.values(j.statusCodeDistribution).reduce((a, b) => a + b, 0);
    const ok = j.statusCodeDistribution["200"] ?? 0;
    return {
      generator: "oha",
      requests: total,
      errors: total - ok,
      req_per_s: j.summary.requestsPerSec,
      p50_ms: (j.latencyPercentiles.p50 ?? NaN) * 1000,
      p99_ms: (j.latencyPercentiles.p99 ?? NaN) * 1000,
    };
  }
  const url = w.url(path);
  const headers = { host };
  const end = performance.now() + durationS * 1000;
  const lat: number[] = [];
  let errors = 0;
  const client = async (): Promise<void> => {
    while (performance.now() < end) {
      const t0 = performance.now();
      try {
        const r = await fetch(url, { headers });
        await r.arrayBuffer();
        if (r.status !== 200) errors++;
      } catch {
        errors++;
      }
      lat.push(performance.now() - t0);
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: connections }, client));
  const elapsed = (performance.now() - t0) / 1000;
  const sorted = [...lat].sort((a, b) => a - b);
  return {
    generator: "bun",
    requests: lat.length,
    errors,
    req_per_s: lat.length / elapsed,
    p50_ms: percentile(sorted, 50),
    p99_ms: percentile(sorted, 99),
    latencies: lat,
  };
}

/** Open-loop load at a fixed rate: one request every 1000/rate ms, whatever the answers. */
export async function rateLoad(
  w: Worker,
  host: string,
  paths: string[],
  rate: number,
  durationS: number,
): Promise<{ sent: number; statuses: Record<string, number> }> {
  const statuses: Record<string, number> = {};
  const pending: Promise<void>[] = [];
  const interval = 1000 / rate;
  const t0 = performance.now();
  let sent = 0;
  while (performance.now() - t0 < durationS * 1000) {
    const path = paths[sent % paths.length] as string;
    sent++;
    pending.push(
      fetch(w.url(path), { headers: { host } })
        .then(async (r) => {
          await r.arrayBuffer();
          statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        })
        .catch(() => {
          statuses.error = (statuses.error ?? 0) + 1;
        }),
    );
    const next = t0 + sent * interval;
    await sleep(Math.max(0, next - performance.now()));
  }
  await Promise.all(pending);
  return { sent, statuses };
}

/** Median run by a key. */
export function medianBy<T>(items: T[], key: (t: T) => number): T {
  const sorted = [...items].sort((a, b) => key(a) - key(b));
  return sorted[Math.floor((sorted.length - 1) / 2)] as T;
}

export async function writeResult(out: string, result: unknown): Promise<void> {
  await Bun.write(out, `${JSON.stringify(result, null, 2)}\n`);
}

export const benchRoot = benchDir;
