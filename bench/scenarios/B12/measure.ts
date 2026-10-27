// B12 (#35): noisy neighbour. Tenant B (examples/shop, GET /api/products
// with 100 products: the B6 proxy until pages exist) under closed-loop load,
// first alone (baseline), then while tenant A's examples/evil /api/loop and
// /api/alloc are hammered at 50 req/s in total. Judged: the change of B's
// p99, and how close A's terminations land to its CPU limit (from A's meter
// records: status cpu_limit, cpu_ms vs the 50 ms free-tier limit).
//
// usage: bun measure.ts <out.json>
// env: BENCH_RUNS (3), B12_CONNECTIONS (16), B12_WARMUP_S (10), B12_DURATION_S (60), B12_RATE (50)

import { load, medianBy, rateLoad, round, Worker, writeResult, type LoadResult } from "../B11/harness.ts";

const out = process.argv[2];
if (!out) {
  console.error("usage: bun measure.ts <out.json>");
  process.exit(2);
}
const runs = Number(process.env.BENCH_RUNS ?? 3);
const connections = Number(process.env.B12_CONNECTIONS ?? 16);
const warmupS = Number(process.env.B12_WARMUP_S ?? 10);
const durationS = Number(process.env.B12_DURATION_S ?? 60);
const rate = Number(process.env.B12_RATE ?? 50);
const CPU_LIMIT_MS = 50;

// B's hostname is under .localhost so the shop's dev seed endpoint answers.
const B = "shop-b.localhost";
const A = "evil-a.bench.test";
const w = await Worker.start([
  { host: B, tenant: "t_b", app: "shop" },
  { host: A, tenant: "t_a", app: "evil" },
]);

interface Run {
  base: LoadResult;
  attack: LoadResult;
  change_pct: number;
  a: { sent: number; statuses: Record<string, number> };
}
const runsOut: Run[] = [];
const notes: string[] = [];
try {
  const seeded = await w.request(B, "/api/dev/seed", { method: "POST" });
  if (seeded.status !== 200) throw new Error(`seed answered ${seeded.status}: ${seeded.body}`);
  for (let run = 1; run <= runs; run++) {
    await load(w, B, "/api/products", connections, warmupS);
    const base = await load(w, B, "/api/products", connections, durationS);
    const [attack, a] = await Promise.all([
      load(w, B, "/api/products", connections, durationS),
      rateLoad(w, A, ["/api/loop", "/api/alloc"], rate, durationS),
    ]);
    const change_pct = ((attack.p99_ms - base.p99_ms) / base.p99_ms) * 100;
    runsOut.push({ base, attack, change_pct, a });
    notes.push(
      `run ${run}: B alone p50 ${round(base.p50_ms)} / p99 ${round(base.p99_ms)} ms (${Math.round(base.req_per_s)} req/s); ` +
        `with A p50 ${round(attack.p50_ms)} / p99 ${round(attack.p99_ms)} ms (${Math.round(attack.req_per_s)} req/s); ` +
        `p99 change ${round(change_pct, 1)} %; A ${a.sent} requests ${JSON.stringify(a.statuses)}`,
    );
    console.error(`B12: ${notes[notes.length - 1]}`);
  }
  await new Promise((r) => setTimeout(r, 1500)); // meter flush
} finally {
  w.stop();
}

const meters = w.meters().filter((m) => m.tenant_id === "t_a");
const loops = meters.filter((m) => m.route === "GET /api/loop");
const allocs = meters.filter((m) => m.route === "GET /api/alloc");
// A termination ends every request in flight on the isolate with
// cpu_limit (ops.md section 10); the request that ran into the limit is the
// one charged about the limit, the others are collateral with little CPU.
// The termination error is judged on the requests that hit the limit.
const killed = meters.filter((m) => m.status === "cpu_limit");
const triggers = killed.filter((m) => m.cpu_ms >= CPU_LIMIT_MS / 2);
const errors = triggers.map((m) => Math.abs(m.cpu_ms - CPU_LIMIT_MS));
const sortedErr = [...errors].sort((a, b) => a - b);
const pct = (s: number[], p: number): number => s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? NaN;
const count = (rs: typeof meters, status: string): number => rs.filter((m) => m.status === status).length;
const median = medianBy(runsOut, (r) => r.change_pct);
const bLeaked = w
  .meters()
  .filter((m) => m.tenant_id === "t_b")
  .filter((m) => m.status !== "ok").length;

await writeResult(out, {
  id: "B12",
  scenario: `tenant B examples/shop GET /api/products (100 rows) with ${connections} keep-alive connections, ${warmupS} s warm-up, ${durationS} s alone then ${durationS} s while tenant A's examples/evil /api/loop and /api/alloc get ${rate} req/s; median of ${runs} runs; A's termination from its meter records (free tier, CPU limit ${CPU_LIMIT_MS} ms)`,
  notes: [
    ...notes,
    `A meter records: loop ${loops.length} (cpu_limit ${count(loops, "cpu_limit")}), alloc ${allocs.length} (oom ${count(allocs, "oom")}, cpu_limit ${count(allocs, "cpu_limit")})`,
    `A cpu_limit records: ${killed.length}, of which ${triggers.length} ran into the limit themselves (cpu_ms ${round(Math.min(...triggers.map((m) => m.cpu_ms)))}-${round(Math.max(...triggers.map((m) => m.cpu_ms)))} ms) and ${killed.length - triggers.length} were collateral (in flight on the terminated isolate)`,
    `A loop cpu_ms at termination: min ${round(Math.min(...loops.map((m) => m.cpu_ms)))} median ${round(pct([...loops.map((m) => m.cpu_ms)].sort((a, b) => a - b), 50))} max ${round(Math.max(...loops.map((m) => m.cpu_ms)))}`,
    `B requests that did not end ok: ${bLeaked}`,
  ].join("; "),
  samples: {
    b_p99_change_pct: runsOut.map((r) => round(r.change_pct, 2)),
    a_loop_cpu_ms: loops.map((m) => m.cpu_ms),
    a_trigger_cpu_ms: triggers.map((m) => m.cpu_ms),
  },
  summary: {
    b_p99_change_pct: round(median.change_pct, 2),
    a_termination_error_ms: round(pct(sortedErr, 99)),
    a_termination_error_median_ms: round(pct(sortedErr, 50)),
    a_terminations: triggers.length,
    a_collateral: killed.length - triggers.length,
    b_p99_alone_ms: round(median.base.p99_ms),
    b_p99_with_a_ms: round(median.attack.p99_ms),
    b_p50_alone_ms: round(median.base.p50_ms),
    b_p50_with_a_ms: round(median.attack.p50_ms),
    b_not_ok: bLeaked,
  },
});
