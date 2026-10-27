// B5 (recorded by issue #7, informational): warm latency of the hello function
// under the Edge Runtime spike. One pinned worker, B5_WARMUP untimed requests,
// then B5_SAMPLES timed sequential requests per run, client-side time to
// response headers through the loopback port (plus Docker port mapping in
// docker mode). The B5 target in docs/14-benchmarks.md is in-node without
// HTTP, so this number is an upper bound, never a pass/fail.
//
// usage: bun measure.ts <out.json>
// env: BENCH_RUNS (3), B5_SAMPLES (1000), B5_WARMUP (100), EDGE_RUNTIME_MODE

import { summarize } from "../../lib/stats.ts";
import { round, startRuntime, stopRuntime, timeToHeaders, type Runtime } from "../../edge-runtime/lib.ts";

const out = process.argv[2];
if (!out) {
  console.error("usage: bun measure.ts <out.json>");
  process.exit(2);
}
const runs = Number(process.env.BENCH_RUNS ?? 3);
const perRun = Number(process.env.B5_SAMPLES ?? 1000);
const warmup = Number(process.env.B5_WARMUP ?? 100);

const samples: Record<string, number[]> = {};
const runSummaries: { p50: number; p99: number }[] = [];
const notes: string[] = [];
let runtime: Runtime | null = null;

try {
  for (let run = 1; run <= runs; run++) {
    runtime = await startRuntime({ policy: "per_worker" });
    const worker = `b5-${run}`;
    for (let i = 0; i < warmup; i++) await timeToHeaders(runtime, "hello", "/", worker);
    const warm: number[] = [];
    for (let i = 0; i < perRun; i++) warm.push(await timeToHeaders(runtime, "hello", "/", worker));
    const s = summarize(warm);
    samples[`run${run}_warm_ms`] = warm.map((x) => round(x, 3));
    runSummaries.push({ p50: s.p50, p99: s.p99 });
    notes.push(`run ${run}: p50 ${round(s.p50, 3)} ms, p99 ${round(s.p99, 3)} ms`);
    console.error(`B5: ${notes[notes.length - 1]}`);
    await stopRuntime();
    runtime = null;
  }
} finally {
  if (runtime) await stopRuntime();
}

const byP50 = [...runSummaries].sort((a, b) => a.p50 - b.p50);
const median = byP50[Math.floor((byP50.length - 1) / 2)] as { p50: number; p99: number };
const summary: Record<string, number> = { p50_ms: round(median.p50, 3), p99_ms: round(median.p99, 3) };
runSummaries.forEach((r, i) => {
  summary[`run${i + 1}_p50_ms`] = round(r.p50, 3);
  summary[`run${i + 1}_p99_ms`] = round(r.p99, 3);
});

await Bun.write(
  out,
  `${JSON.stringify(
    {
      id: "B5",
      scenario: `hello function, one pinned warm worker, ${perRun} sequential requests per run after ${warmup} warm-up requests, client-side time to headers over HTTP (informational: the target is in-node), median run of ${runs}`,
      notes: `informational, measured over HTTP not in-node; ${notes.join("; ")}`,
      samples,
      summary,
    },
    null,
    2,
  )}\n`,
);
