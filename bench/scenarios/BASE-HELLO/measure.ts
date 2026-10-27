// Driver for BASE-HELLO. For each runtime: startup samples (spawn -> first
// 200), then BENCH_RUNS runs of warm-up + measured load with oha, sampling
// the server's RSS every second. Writes the scenario contract JSON.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarize } from "../../lib/stats.ts";

const [appDir, out] = process.argv.slice(2);
if (!appDir || !out) throw new Error("usage: measure.ts <app-dir> <out.json>");

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const runs = env("BENCH_RUNS", 3);
const warmupS = env("BASE_WARMUP_S", 30);
const durationS = env("BASE_DURATION_S", 60);
const connections = env("BASE_CONNECTIONS", 64);
const startupSamples = env("BASE_STARTUP_SAMPLES", 50);
const PORT = 8787;
const URL_ = `http://127.0.0.1:${PORT}/`;

interface Runtime {
  name: "bun" | "node";
  cmd: string[];
}
const runtimes: Runtime[] = [
  { name: "bun", cmd: ["bun", join(appDir, "start-bun.ts")] },
  { name: "node", cmd: ["node", join(appDir, "start-node.ts")] },
];

function rssMb(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const kb = Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1] ?? Number.NaN);
  return kb / 1024;
}

const median = (xs: number[]) => summarize(xs).p50;
const round = (x: number, digits = 3) => Number(x.toFixed(digits));

async function waitClosed(): Promise<void> {
  for (let i = 0; i < 500; i++) {
    try {
      await fetch(URL_);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`port ${PORT} still in use`);
}

/** Spawns the server and returns it once GET / answers, with the elapsed ms. */
async function start(rt: Runtime): Promise<{ proc: Bun.Subprocess; ms: number }> {
  await waitClosed();
  const t0 = performance.now();
  const proc = Bun.spawn(rt.cmd, { env: { ...process.env, PORT: String(PORT) }, stdout: "ignore", stderr: "inherit" });
  for (;;) {
    try {
      const res = await fetch(URL_);
      if (res.status === 200 && (await res.text()) === '{"ok":true}') {
        return { proc, ms: performance.now() - t0 };
      }
    } catch {
      // not listening yet
    }
    if (proc.exitCode !== null) throw new Error(`${rt.name} exited with ${proc.exitCode}`);
    if (performance.now() - t0 > 10_000) throw new Error(`${rt.name} did not answer within 10 s`);
    await Bun.sleep(1);
  }
}

async function stop(proc: Bun.Subprocess): Promise<void> {
  proc.kill();
  await proc.exited;
}

interface OhaResult {
  summary: { requestsPerSec: number; successRate: number };
  latencyPercentiles: { p50: number; p99: number };
}

async function oha(seconds: number): Promise<OhaResult> {
  const proc = Bun.spawn(
    ["oha", "--no-tui", "--output-format", "json", "-c", String(connections), "-z", `${seconds}s`, URL_],
    { stdout: "pipe", stderr: "inherit" },
  );
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("oha failed");
  return JSON.parse(text) as OhaResult;
}

const samples: Record<string, number[]> = {};
const summary: Record<string, number> = {};
const notes: string[] = [];

for (const rt of runtimes) {
  const version = Bun.spawnSync([rt.name, "--version"]).stdout.toString().trim();
  notes.push(`${rt.name} ${version}`);

  // Startup: spawn -> first successful response.
  const startup: number[] = [];
  for (let i = 0; i < startupSamples; i++) {
    const { proc, ms } = await start(rt);
    startup.push(ms);
    await stop(proc);
  }
  samples[`${rt.name}_startup_ms`] = startup;

  const idle: number[] = [];
  const load: number[] = [];
  const p50: number[] = [];
  const p99: number[] = [];
  const rps: number[] = [];
  for (let run = 0; run < runs; run++) {
    const { proc } = await start(rt);
    await Bun.sleep(1000);
    idle.push(rssMb(proc.pid)); // after the first request, idle
    await oha(warmupS);
    const rssDuringLoad: number[] = [];
    const sampler = setInterval(() => rssDuringLoad.push(rssMb(proc.pid)), 1000);
    const result = await oha(durationS);
    clearInterval(sampler);
    if (result.summary.successRate < 1) throw new Error(`${rt.name}: success rate ${result.summary.successRate}`);
    load.push(rssDuringLoad.length ? rssDuringLoad[rssDuringLoad.length - 1]! : rssMb(proc.pid));
    p50.push(result.latencyPercentiles.p50 * 1000);
    p99.push(result.latencyPercentiles.p99 * 1000);
    rps.push(result.summary.requestsPerSec);
    samples[`${rt.name}_rss_during_load_mb_run${run + 1}`] = rssDuringLoad.map((x) => round(x, 1));
    await stop(proc);
  }
  Object.assign(samples, {
    [`${rt.name}_rss_idle_mb`]: idle.map((x) => round(x, 1)),
    [`${rt.name}_rss_load_mb`]: load.map((x) => round(x, 1)),
    [`${rt.name}_p50_ms`]: p50.map((x) => round(x)),
    [`${rt.name}_p99_ms`]: p99.map((x) => round(x)),
    [`${rt.name}_req_per_s`]: rps.map((x) => Math.round(x)),
  });
  const s = summarize(startup);
  Object.assign(summary, {
    [`${rt.name}_rss_idle_mb`]: round(median(idle), 1),
    [`${rt.name}_rss_load_mb`]: round(median(load), 1),
    [`${rt.name}_startup_p50_ms`]: round(s.p50, 1),
    [`${rt.name}_startup_p99_ms`]: round(s.p99, 1),
    [`${rt.name}_p50_ms`]: round(median(p50)),
    [`${rt.name}_p99_ms`]: round(median(p99)),
    [`${rt.name}_req_per_s`]: Math.round(median(rps)),
  });
}

await Bun.write(
  out,
  `${JSON.stringify({
    id: "BASE-HELLO",
    scenario: `bench/baselines/hello-hono, GET / -> {"ok":true}; startup ${startupSamples} samples; oha -c ${connections}, ${warmupS} s warm-up + ${durationS} s, ${runs} run(s), median of runs`,
    notes: notes.join(", "),
    samples,
    summary,
  })}\n`,
);
