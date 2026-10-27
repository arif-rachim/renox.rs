// B1 (issue #6): memory per warm isolate under the Edge Runtime spike.
//
// For each app (hello, npm-compat) and each N (1, 10, 50, 100): start a fresh
// runtime, sample its baseline RSS, create N pinned user workers (one request
// each), wait, sample RSS again, and report (rss_N - rss_0) / N. Repeated
// BENCH_RUNS times; the summary holds the median of runs. Judged metric:
// rss_delta_mb = hello at N = 100 (the closest thing to "example app loaded,
// idle" that exists in F0); npm-compat is reported next to it.
//
// usage: bun measure.ts <out.json>
// env: BENCH_RUNS (3), B1_APPS (hello,npm-compat), B1_SIZES (1,10,50,100),
//      B1_SETTLE_S (10), B1_SAMPLE_S (10), EDGE_RUNTIME_MODE (source|docker)

import { summarize } from "../../lib/stats.ts";
import { callApp, memAvailableMb, metrics, readMemory, round, sleep, startRuntime, stopRuntime, type Runtime } from "../../edge-runtime/lib.ts";

const out = process.argv[2];
if (!out) {
  console.error("usage: bun measure.ts <out.json>");
  process.exit(2);
}
const runs = Number(process.env.BENCH_RUNS ?? 3);
const apps = (process.env.B1_APPS ?? "hello,npm-compat").split(",");
const sizes = (process.env.B1_SIZES ?? "1,10,50,100").split(",").map(Number);
const settleS = Number(process.env.B1_SETTLE_S ?? 10);
const sampleS = Number(process.env.B1_SAMPLE_S ?? 10);

const samples: Record<string, number[]> = {};
const notes: string[] = [];
let runtime: Runtime | null = null;

async function sampleMedian(rt: Runtime): Promise<{ rss: number; pss: number | null }> {
  const rss: number[] = [];
  const pss: number[] = [];
  for (let i = 0; i < sampleS; i++) {
    const m = readMemory(rt);
    rss.push(m.vmRssMb);
    if (m.pssMb !== null) pss.push(m.pssMb);
    await sleep(1000);
  }
  return { rss: summarize(rss).p50, pss: pss.length ? summarize(pss).p50 : null };
}

function push(key: string, value: number): void {
  (samples[key] ??= []).push(round(value));
}

const log = (s: string): void => console.error(`B1: ${s}`);

try {
  for (const app of apps) {
    const path = app === "npm-compat" ? "/api/check" : "/";
    let perWorkerEstimate = 0;
    for (const n of sizes) {
      for (let run = 1; run <= runs; run++) {
        const need = n * perWorkerEstimate + 1024;
        if (perWorkerEstimate > 0 && memAvailableMb() < need) {
          notes.push(`${app} N=${n} run ${run} skipped: MemAvailable ${Math.round(memAvailableMb())} MB < ${Math.round(need)} MB needed`);
          log(notes[notes.length - 1] as string);
          continue;
        }
        runtime = await startRuntime({ policy: "per_worker" });
        await sleep(3000);
        const base = await sampleMedian(runtime);
        const createMs: number[] = [];
        for (let i = 1; i <= n; i++) {
          const r = await callApp(runtime, app, path, `${app}-${run}-${i}`);
          if (r.status !== 200) throw new Error(`${app} worker ${i}: HTTP ${r.status} ${r.body.slice(0, 200)}`);
          createMs.push(r.ms);
        }
        await sleep(settleS * 1000);
        const warm = await sampleMedian(runtime);
        const m = await metrics(runtime);
        const workers = Object.values(m.workers).filter((w) => w.servicePath.endsWith(`/${app}/_spike`));
        const heapMb = workers.length ? workers.reduce((a, w) => a + w.stats.totalHeapSize, 0) / workers.length / 1048576 : 0;
        const delta = (warm.rss - base.rss) / n;
        const pssDelta = warm.pss !== null && base.pss !== null ? (warm.pss - base.pss) / n : null;
        const key = `${app.replace("-", "_")}_n${n}`;
        push(`${key}_rss_delta_mb`, delta);
        if (pssDelta !== null) push(`${key}_pss_delta_mb`, pssDelta);
        push(`${key}_baseline_rss_mb`, base.rss);
        push(`${key}_total_rss_mb`, warm.rss);
        push(`${key}_heap_total_mb`, heapMb);
        push(`${key}_create_p50_ms`, summarize(createMs).p50);
        if (workers.length !== n) notes.push(`${app} N=${n} run ${run}: runtime reports ${workers.length} workers, expected ${n}`);
        log(`${app} N=${n} run ${run}: baseline ${base.rss} MB, total ${warm.rss} MB, ${round(delta)} MB per worker, heap ${round(heapMb)} MB, mode ${runtime.mode}`);
        perWorkerEstimate = Math.max(perWorkerEstimate, delta);
        await stopRuntime();
        runtime = null;
      }
    }
  }
} finally {
  if (runtime) await stopRuntime();
}

const summary: Record<string, number> = {};
for (const [k, v] of Object.entries(samples)) summary[k] = round(summarize(v).p50);
const judged = summary.hello_n100_rss_delta_mb ?? summary.hello_n50_rss_delta_mb ?? summary.hello_n10_rss_delta_mb;
if (judged === undefined) throw new Error("no hello measurement to judge");
summary.rss_delta_mb = judged;

// Leak check: per-worker delta drift between the first and last run at the largest N.
for (const app of apps) {
  const key = `${app.replace("-", "_")}_n${Math.max(...sizes)}_rss_delta_mb`;
  const v = samples[key];
  if (v && v.length > 1) {
    const first = v[0] as number;
    const last = v[v.length - 1] as number;
    notes.push(`${app}: per-worker delta drift across runs at N=${Math.max(...sizes)}: ${round(first)} → ${round(last)} MB (${round(((last - first) / first) * 100, 1)}%)`);
  }
}

await Bun.write(
  out,
  `${JSON.stringify(
    {
      id: "B1",
      scenario: `RSS delta per pinned user worker, apps ${apps.join("+")}, N = ${sizes.join("/")}, settle ${settleS} s, ${sampleS} samples at 1 s, median of ${runs} runs; judged: hello at N = ${Math.max(...sizes)}`,
      notes: notes.join("; "),
      samples,
      summary,
    },
    null,
    2,
  )}\n`,
);
