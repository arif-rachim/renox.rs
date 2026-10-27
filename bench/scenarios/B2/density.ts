// B2 and B3 (#35): idle and warm density on renox-worker.
//   1. Register N tenants (route entries for examples/hello; their data
//      directories are created on first use), sample the worker's RSS.
//   2. Warm each with one request (8 at a time).
//   3. Wait past idle_timeout until every cell is evicted (threads back to
//      the baseline), then DENSITY_SETTLE_S more for the worker's allocator
//      trims after evictions (#144: 2 s, 12 s, and 32 s after the last
//      eviction), sample RSS: B2 idle_mb = (idle RSS - baseline) / N.
//   4. B3 only: keep M tenants warm with a 1 req/s trickle each, sample RSS,
//      threads, and open files every second; steady state = mean of the
//      last half. warm_tenants = how many warm tenants fit a node-small
//      (8 GB) with 1 GB headroom at the measured cost per warm tenant
//      (steady RSS minus the baseline, divided by M).
//
// usage: bun density.ts B2|B3 <out.json>
// env: BENCH_RUNS (1), DENSITY_TENANTS (1000), DENSITY_WARM (300),
//      DENSITY_IDLE_S (30), DENSITY_TRICKLE_S (60), DENSITY_SETTLE_S (35)

import { rateLoad, round, sleep, Worker, writeResult } from "../B11/harness.ts";

const [id, out] = process.argv.slice(2) as [string, string];
if ((id !== "B2" && id !== "B3") || !out) {
  console.error("usage: bun density.ts B2|B3 <out.json>");
  process.exit(2);
}
const n = Number(process.env.DENSITY_TENANTS ?? 1000);
const m = Number(process.env.DENSITY_WARM ?? 300);
const idleS = Number(process.env.DENSITY_IDLE_S ?? 30);
const trickleS = Number(process.env.DENSITY_TRICKLE_S ?? 60);
const settleS = Number(process.env.DENSITY_SETTLE_S ?? 35);
const NODE_SMALL_MB = 8 * 1024;
const HEADROOM_MB = 1024;

const pad = (i: number): string => String(i).padStart(4, "0");
const tenants = Array.from({ length: n }, (_, i) => ({ host: `t${pad(i)}.bench.test`, tenant: `t_${pad(i)}`, app: "hello" }));
const w = await Worker.start(tenants, { idleS });
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const sampleRss = async (seconds: number): Promise<number> => {
  const xs: number[] = [];
  for (let i = 0; i < seconds; i++) {
    xs.push(w.memory().rss_mb);
    await sleep(1000);
  }
  return mean(xs);
};

const notes: string[] = [];
const summary: Record<string, number> = {};
const samples: Record<string, number[]> = {};
try {
  await sleep(2000);
  const baseThreads = w.threads();
  const baseFiles = w.openFiles();
  const rss0 = await sampleRss(5);

  // Warm every tenant once.
  let failed = 0;
  // Failed first requests by error code (#146), as B4 records them.
  const failures: Record<string, number> = {};
  let peak = rss0;
  const warmMs: number[] = [];
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < n) {
        const t = tenants[next++] as (typeof tenants)[number];
        const r = await w.request(t.host, "/api/hello");
        warmMs.push(r.ms);
        if (r.status !== 200) {
          failed++;
          const code = /"code":"([A-Z_]+)"/u.exec(r.body)?.[1] ?? String(r.status);
          failures[code] = (failures[code] ?? 0) + 1;
        }
        if (warmMs.length % 50 === 0) peak = Math.max(peak, w.memory().rss_mb);
      }
    }),
  );
  const warmS = (performance.now() - t0) / 1000;
  peak = Math.max(peak, w.memory().rss_mb);
  const peakThreads = w.threads();
  notes.push(`warmed ${n} tenants in ${round(warmS, 1)} s (${failed} failed: ${JSON.stringify(failures)}), peak RSS ${round(peak, 1)} MB, ${peakThreads} threads`);

  // Idle: every cell evicted.
  const deadline = performance.now() + (idleS * 3 + 60) * 1000;
  while (w.threads() > baseThreads + 2 && performance.now() < deadline) await sleep(1000);
  const rssEvicted = w.memory().rss_mb;
  await sleep(settleS * 1000);
  const rssIdle = await sampleRss(10);
  const idleThreads = w.threads();
  const idleFiles = w.openFiles();
  notes.push(
    `baseline RSS ${round(rss0, 1)} MB (${baseThreads} threads, ${baseFiles} files); right after the last eviction ${round(rssEvicted, 1)} MB; ${settleS} s later ${round(rssIdle, 1)} MB (${idleThreads} threads, ${idleFiles} files)`,
  );
  summary.registered_tenants = n - failed;
  summary.failed_cold_first_requests = failed;
  summary.idle_mb = round((rssIdle - rss0) / n, 4);
  summary.baseline_rss_mb = round(rss0, 1);
  summary.idle_rss_mb = round(rssIdle, 1);
  summary.peak_rss_mb = round(peak, 1);
  samples.warm_first_request_ms = warmMs.map((x) => round(x));

  if (id === "B3") {
    const warm = tenants.slice(0, m);
    const rss: number[] = [];
    const threads: number[] = [];
    const files: number[] = [];
    let stop = false;
    const sampler = (async () => {
      while (!stop) {
        rss.push(w.memory().rss_mb);
        threads.push(w.threads());
        files.push(w.openFiles());
        await sleep(1000);
      }
    })();
    // M tenants x 1 req/s: one open-loop stream per tenant.
    const results = await Promise.all(warm.map((t) => rateLoad(w, t.host, ["/api/hello"], 1, trickleS)));
    stop = true;
    await sampler;
    const ok = results.reduce((a, r) => a + (r.statuses["200"] ?? 0), 0);
    const sent = results.reduce((a, r) => a + r.sent, 0);
    const half = Math.floor(rss.length / 2);
    const rssWarm = mean(rss.slice(half));
    // Cost per warm tenant against the baseline before any tenant ran: an
    // upper bound, since it also carries whatever the earlier warm-up left
    // in the allocator (see idle_mb).
    const perWarm = (rssWarm - rss0) / m;
    const capacity = Math.floor((NODE_SMALL_MB - HEADROOM_MB - rss0) / perWarm);
    notes.push(
      `${m} warm tenants at 1 req/s for ${trickleS} s: ${ok}/${sent} ok, steady RSS ${round(rssWarm, 1)} MB (${round(perWarm, 2)} MB per warm tenant), threads ${Math.max(...threads)}, open files ${Math.max(...files)}`,
    );
    summary.warm_tenants = capacity;
    summary.measured_warm_tenants = m;
    summary.warm_rss_mb = round(rssWarm, 1);
    summary.mb_per_warm_tenant = round(perWarm, 3);
    summary.warm_threads = Math.max(...threads);
    summary.warm_open_files = Math.max(...files);
    summary.trickle_ok_pct = round((ok / sent) * 100, 2);
    samples.warm_rss_mb = rss.map((x) => round(x, 1));
    samples.warm_open_files = files;
  }
  console.error(`${id}: ${notes.join("; ")}`);
} finally {
  w.stop();
}

await writeResult(out, {
  id,
  scenario:
    id === "B2"
      ? `${n} tenants registered on renox-worker (release), each warmed with one request, then idle past idle_timeout ${idleS} s: RSS per idle tenant`
      : `${n} tenants registered and warmed once, evicted after ${idleS} s; then ${m} kept warm with 1 req/s each for ${trickleS} s; warm capacity extrapolated to node-small (8 GB, 1 GB headroom)`,
  notes: notes.join("; "),
  samples,
  summary,
});
