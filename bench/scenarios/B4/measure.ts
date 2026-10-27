// B4 (issue #7): cold start of the hello function under the Edge Runtime spike.
//
// Eviction: the runtime is started with `--policy oneshot`, which terminates a
// user worker after it has served one request, so every request through the
// pool path (no `__worker` pin) boots a fresh isolate: module graph load plus
// first request. The scenario verifies this per run by checking that the
// runtime's retired-worker counter advanced by the number of samples.
//
// Timing: client-side monotonic clock around one fetch, from send to response
// headers (first byte), through the loopback port (plus Docker port mapping
// in docker mode). BENCH_RUNS runs of B4_SAMPLES samples; the summary holds
// p50/p99 of the median run (by p50), and the per-run p50/p99 next to it.
//
// usage: bun measure.ts <out.json>
// env: BENCH_RUNS (3), B4_SAMPLES (200), EDGE_RUNTIME_MODE (source|docker)

import { summarize } from "../../lib/stats.ts";
import { metrics, round, sleep, startRuntime, stopRuntime, timeToHeaders, type Runtime } from "../../edge-runtime/lib.ts";

const out = process.argv[2];
if (!out) {
  console.error("usage: bun measure.ts <out.json>");
  process.exit(2);
}
const runs = Number(process.env.BENCH_RUNS ?? 3);
const perRun = Number(process.env.B4_SAMPLES ?? 200);
const log = (s: string): void => console.error(`B4: ${s}`);

const samples: Record<string, number[]> = {};
const notes: string[] = [];
const runSummaries: { p50: number; p99: number }[] = [];
let runtime: Runtime | null = null;

try {
  for (let run = 1; run <= runs; run++) {
    runtime = await startRuntime({ policy: "oneshot" });
    // One untimed request so the main worker itself is warm; it is evicted too.
    await timeToHeaders(runtime, "hello");
    await sleep(500);
    const before = await metrics(runtime);
    const cold: number[] = [];
    for (let i = 0; i < perRun; i++) {
      cold.push(await timeToHeaders(runtime, "hello"));
    }
    await sleep(500);
    const after = await metrics(runtime);
    const retired = (after.runtime.retiredUserWorkersCount ?? 0) - (before.runtime.retiredUserWorkersCount ?? 0);
    const active = after.runtime.activeUserWorkersCount ?? -1;
    const s = summarize(cold);
    samples[`run${run}_cold_start_ms`] = cold.map((x) => round(x));
    runSummaries.push({ p50: s.p50, p99: s.p99 });
    const evictionOk = retired >= perRun - 1;
    notes.push(
      `run ${run}: p50 ${round(s.p50)} ms, p99 ${round(s.p99)} ms, retired workers +${retired} for ${perRun} requests, active ${active} (${evictionOk ? "eviction verified" : "EVICTION NOT VERIFIED"})`,
    );
    log(notes[notes.length - 1] as string);
    if (!evictionOk) throw new Error(`oneshot policy did not evict: retired +${retired} for ${perRun} requests`);
    await stopRuntime();
    runtime = null;
  }
} finally {
  if (runtime) await stopRuntime();
}

const byP50 = [...runSummaries].sort((a, b) => a.p50 - b.p50);
const median = byP50[Math.floor((byP50.length - 1) / 2)] as { p50: number; p99: number };
const summary: Record<string, number> = { p50_ms: round(median.p50), p99_ms: round(median.p99) };
runSummaries.forEach((r, i) => {
  summary[`run${i + 1}_p50_ms`] = round(r.p50);
  summary[`run${i + 1}_p99_ms`] = round(r.p99);
});

await Bun.write(
  out,
  `${JSON.stringify(
    {
      id: "B4",
      scenario: `hello function, ${perRun} cold samples per run, worker evicted after every request (--policy oneshot), client-side time to response headers, median run of ${runs}`,
      notes: notes.join("; "),
      samples,
      summary,
    },
    null,
    2,
  )}\n`,
);
