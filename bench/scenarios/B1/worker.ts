// B1 on renox-worker (#35; F0 gate condition from #14): memory per warm
// isolate. For each app (shop, hello) and each N (1, 10, 50, 100): start a
// fresh worker with N tenants of the app, sample its RSS and PSS, give each
// tenant one request (its isolate stays warm: idle_timeout 600 s), wait,
// sample again: (after - before) / N. V8 heap per isolate from the meter
// records (peak_heap_bytes). Judged: rss_delta_mb = shop at N = 100 (the
// F1 gate condition, #37: <= 20 MB).
//
// The shop artifact is esm-dir as `renox build` writes it (#143): the
// function modules share one copy of each dependency (code/chunks/), and
// the source maps are outside the artifact.
//
// usage: bun worker.ts <out.json>
// env: BENCH_RUNS (3), B1_APPS (shop,hello), B1_SIZES (1,10,50,100), B1_SETTLE_S (5)

import { medianBy, round, sleep, Worker, writeResult } from "../B11/harness.ts";

const out = process.argv[2];
if (!out) {
  console.error("usage: bun worker.ts <out.json>");
  process.exit(2);
}
const runs = Number(process.env.BENCH_RUNS ?? 3);
const apps = (process.env.B1_APPS ?? "shop,hello").split(",");
const sizes = (process.env.B1_SIZES ?? "1,10,50,100").split(",").map(Number);
const settleS = Number(process.env.B1_SETTLE_S ?? 5);
const PATH: Record<string, string> = { shop: "/api/products", hello: "/api/hello" };

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const samples: Record<string, number[]> = {};
const summary: Record<string, number> = {};
const notes: string[] = [];

for (const app of apps) {
  for (const n of sizes) {
    const perRun: { rss: number; pss: number; heap: number }[] = [];
    for (let run = 1; run <= runs; run++) {
      const tenants = Array.from({ length: n }, (_, i) => ({ host: `${app}${i}.bench.test`, tenant: `t_${app}_${i}`, app }));
      const w = await Worker.start(tenants);
      try {
        await sleep(2000);
        const before = { rss: [] as number[], pss: [] as number[] };
        for (let i = 0; i < 3; i++) {
          const m = w.memory();
          before.rss.push(m.rss_mb);
          before.pss.push(m.pss_mb);
          await sleep(500);
        }
        for (const t of tenants) {
          const r = await w.request(t.host, PATH[app] as string);
          if (r.status !== 200) throw new Error(`${app} answered ${r.status}: ${r.body}`);
        }
        await sleep(settleS * 1000);
        const after = { rss: [] as number[], pss: [] as number[] };
        for (let i = 0; i < 5; i++) {
          const m = w.memory();
          after.rss.push(m.rss_mb);
          after.pss.push(m.pss_mb);
          await sleep(1000);
        }
        const heaps = w
          .meters()
          .map((m) => m.peak_heap_bytes / (1024 * 1024))
          .sort((a, b) => a - b);
        perRun.push({
          rss: (mean(after.rss) - mean(before.rss)) / n,
          pss: (mean(after.pss) - mean(before.pss)) / n,
          heap: heaps[Math.floor(heaps.length / 2)] ?? NaN,
        });
      } finally {
        w.stop();
      }
    }
    const med = medianBy(perRun, (r) => r.rss);
    samples[`${app}_n${n}_rss_delta_mb`] = perRun.map((r) => round(r.rss, 2));
    summary[`${app}_n${n}_rss_delta_mb`] = round(med.rss, 2);
    summary[`${app}_n${n}_pss_delta_mb`] = round(med.pss, 2);
    summary[`${app}_n${n}_v8_heap_mb`] = round(med.heap, 2);
    notes.push(`${app} N=${n}: RSS ${round(med.rss, 2)} MB, PSS ${round(med.pss, 2)} MB, V8 heap ${round(med.heap, 2)} MB per isolate`);
    console.error(`B1: ${notes[notes.length - 1]}`);
  }
}
const judged = summary[`${apps[0]}_n${sizes[sizes.length - 1]}_rss_delta_mb`] as number;

await writeResult(out, {
  id: "B1",
  scenario: `renox-worker (release), N tenants per app each with one warm isolate after one request; ${apps.join(", ")} at N = ${sizes.join(", ")}; esm-dir artifacts from the CLI; median of ${runs} runs; judged: ${apps[0]} at N = ${sizes[sizes.length - 1]}`,
  notes: notes.join("; "),
  samples,
  summary: { rss_delta_mb: judged, ...summary },
});
