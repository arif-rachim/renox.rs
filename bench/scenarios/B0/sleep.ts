import { summarize } from "../../lib/stats.ts";

const [runsArg, perRunArg, out] = process.argv.slice(2);
const runs = Number(runsArg);
const perRun = Number(perRunArg);
if (!out || !(runs > 0) || !(perRun > 0)) {
  console.error("usage: sleep.ts <runs> <per_run> <out.json>");
  process.exit(2);
}

const samples: number[] = [];
for (let i = 0; i < runs * perRun; i++) {
  const start = performance.now();
  await Bun.sleep(1);
  samples.push(performance.now() - start);
}

const s = summarize(samples);
await Bun.write(
  out,
  `${JSON.stringify({
    id: "B0",
    scenario: `harness self-test: ${runs} run(s) × ${perRun} timed 1 ms sleeps`,
    samples: { sleep_ms: samples },
    summary: { p50_ms: s.p50, p99_ms: s.p99, mean_ms: s.mean },
  })}\n`,
);
