// B5 and B11 on renox-worker (#35): the examples/hello function under
// closed-loop keep-alive load. Per run: a warm-up, then the measurement;
// the result is the median run (docs/14-benchmarks.md, "Methodology").
//   B11 judges req/s; B5 judges p50/p99 of the same kind of run, and adds
//   1,000 sequential requests (one connection) as the latency floor over HTTP.
//
// usage: bun load-scenario.ts B5|B11 <out.json>
// env: BENCH_RUNS (3), LOAD_CONNECTIONS (64), LOAD_WARMUP_S (30), LOAD_DURATION_S (60)

import { load, medianBy, round, Worker, writeResult, type LoadResult } from "./harness.ts";

const [id, out] = process.argv.slice(2) as [string, string];
if ((id !== "B5" && id !== "B11") || !out) {
  console.error("usage: bun load-scenario.ts B5|B11 <out.json>");
  process.exit(2);
}
const runs = Number(process.env.BENCH_RUNS ?? 3);
const connections = Number(process.env.LOAD_CONNECTIONS ?? 64);
const warmupS = Number(process.env.LOAD_WARMUP_S ?? 30);
const durationS = Number(process.env.LOAD_DURATION_S ?? 60);
const host = "hello.bench.test";

const w = await Worker.start([{ host, tenant: "t_hello", app: "hello" }]);
const results: LoadResult[] = [];
const sequential: number[] = [];
const notes: string[] = [];
let mem = { rss_mb: 0, pss_mb: 0 };
try {
  const first = await w.request(host, "/api/hello");
  if (first.status !== 200) throw new Error(`hello answered ${first.status}: ${first.body}`);
  for (let run = 1; run <= runs; run++) {
    await load(w, host, "/api/hello", connections, warmupS);
    const r = await load(w, host, "/api/hello", connections, durationS);
    results.push(r);
    mem = w.memory();
    notes.push(
      `run ${run}: ${Math.round(r.req_per_s)} req/s, p50 ${round(r.p50_ms)} ms, p99 ${round(r.p99_ms)} ms, ${r.errors} errors (${r.generator})`,
    );
    console.error(`${id}: ${notes[notes.length - 1]}`);
  }
  if (id === "B5") {
    for (let i = 0; i < 100; i++) await w.request(host, "/api/hello");
    for (let i = 0; i < 1000; i++) sequential.push((await w.request(host, "/api/hello")).ms);
  }
} finally {
  w.stop();
}

const median = medianBy(results, (r) => (id === "B11" ? r.req_per_s : r.p50_ms));
const sortedSeq = [...sequential].sort((a, b) => a - b);
const seqP = (p: number): number => sortedSeq[Math.max(0, Math.ceil((p / 100) * sortedSeq.length) - 1)] ?? NaN;
const summary: Record<string, number> =
  id === "B11"
    ? { req_per_s: Math.round(median.req_per_s), p50_ms: round(median.p50_ms), p99_ms: round(median.p99_ms) }
    : {
        p50_ms: round(median.p50_ms),
        p99_ms: round(median.p99_ms),
        req_per_s: Math.round(median.req_per_s),
        sequential_p50_ms: round(seqP(50)),
        sequential_p99_ms: round(seqP(99)),
      };
summary.worker_rss_mb = round(mem.rss_mb, 1);
results.forEach((r, i) => {
  summary[`run${i + 1}_req_per_s`] = Math.round(r.req_per_s);
  summary[`run${i + 1}_p99_ms`] = round(r.p99_ms);
});
await writeResult(out, {
  id,
  scenario: `examples/hello GET /api/hello on renox-worker (release), ${connections} keep-alive connections, ${warmupS} s warm-up + ${durationS} s per run, median of ${runs} runs (${median.generator} load generator on the same machine)${id === "B5" ? "; plus 1,000 sequential requests on one connection" : ""}`,
  notes: notes.join("; "),
  samples: {
    ...(id === "B5" ? { sequential_ms: sequential.map((x) => round(x)) } : {}),
    req_per_s: results.map((r) => Math.round(r.req_per_s)),
  },
  summary,
});
