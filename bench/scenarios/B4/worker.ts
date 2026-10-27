// B4 on renox-worker (#35): cold start. 200 tenants on the examples/hello
// artifact; each tenant's first request is a cold start of a fresh cell:
// tenant database opened, migrations checked, secrets read, isolate created
// from the platform snapshot, module evaluated, request dispatched. Timed
// from the client (time to the full response) and by the worker (meter
// wall_ms). Sequential, so one cold start never waits for another.
//
// usage: bun worker.ts <out.json>
// env: BENCH_RUNS (3), B4_SAMPLES (200)

import { medianBy, round, sleep, Worker, writeResult } from "../B11/harness.ts";

const out = process.argv[2];
if (!out) {
  console.error("usage: bun worker.ts <out.json>");
  process.exit(2);
}
const runs = Number(process.env.BENCH_RUNS ?? 3);
const n = Number(process.env.B4_SAMPLES ?? 200);
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? NaN;
};

const samples: Record<string, number[]> = {};
const perRun: { p50: number; p99: number; server_p50: number; server_p99: number; warm_p50: number }[] = [];
const notes: string[] = [];
for (let run = 1; run <= runs; run++) {
  const tenants = Array.from({ length: n }, (_, i) => ({ host: `c${i}.bench.test`, tenant: `t_cold_${i}`, app: "hello" }));
  const w = await Worker.start(tenants);
  const cold: number[] = [];
  const warm: number[] = [];
  try {
    // One unmeasured cold start: the process's first isolate pays for
    // lazily loaded extension sources and first-use page faults.
    await w.request("c0.bench.test", "/api/hello");
    for (const t of tenants.slice(1)) {
      const r = await w.request(t.host, "/api/hello");
      if (r.status !== 200) throw new Error(`cold request answered ${r.status}`);
      cold.push(r.ms);
      warm.push((await w.request(t.host, "/api/hello")).ms);
    }
    await sleep(1500);
  } finally {
    w.stop();
  }
  const firsts = new Map<string, number>();
  for (const m of w.meters()) if (!firsts.has(m.tenant_id)) firsts.set(m.tenant_id, m.wall_ms);
  firsts.delete("t_cold_0");
  const server = [...firsts.values()];
  samples[`run${run}_cold_ms`] = cold.map((x) => round(x));
  perRun.push({ p50: pct(cold, 50), p99: pct(cold, 99), server_p50: pct(server, 50), server_p99: pct(server, 99), warm_p50: pct(warm, 50) });
  const r = perRun[perRun.length - 1] as (typeof perRun)[number];
  notes.push(`run ${run}: cold p50 ${round(r.p50)} / p99 ${round(r.p99)} ms (worker wall p50 ${round(r.server_p50)} / p99 ${round(r.server_p99)} ms), warm p50 ${round(r.warm_p50)} ms`);
  console.error(`B4: ${notes[notes.length - 1]}`);
}
const med = medianBy(perRun, (r) => r.p50);

await writeResult(out, {
  id: "B4",
  scenario: `renox-worker (release): first request of ${n - 1} fresh tenants on examples/hello (esm-dir), sequential, client-side time to the full response; median of ${runs} runs`,
  notes: notes.join("; "),
  samples,
  summary: {
    p50_ms: round(med.p50),
    p99_ms: round(med.p99),
    worker_wall_p50_ms: round(med.server_p50),
    worker_wall_p99_ms: round(med.server_p99),
    warm_p50_ms: round(med.warm_p50),
  },
});
