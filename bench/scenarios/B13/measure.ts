// B13 (#46): template DoS on renox-worker. The `evil` app's `GET /nested`
// hands its template two lists of 10,000 numbers (10^8 cells); the render
// limits must stop it with 500 RENOX_RENDER_LIMIT within 50 ms of render
// time (fail: > 500 ms), and the node must stay unaffected.
//
// Per run:
//   1. Probe: PROBES sequential `GET /api/hello` to a second tenant on the
//      same worker, one request in flight (a latency probe, not load).
//   2. Attack: ATTACKS sequential `GET /nested` to the `evil` tenant while
//      the same sequential probe runs beside it. Each attack must answer
//      500 RENOX_RENDER_LIMIT; its meter record gives render_ms (render
//      time, outside cpu_ms) and status.
//   3. After: `evil`'s `GET /api/slow?ms=1` must answer 200 (the tenant is
//      still served) and a last probe series is taken.
// Judged: render_ms, the median over runs of each run's p50 meter render_ms.
//
// usage: bun measure.ts <out.json>
// env: BENCH_RUNS (3), B13_ATTACKS (20), B13_PROBES (200)

import { round, sleep, Worker, writeResult } from "../B11/harness.ts";
import { summarize } from "../../lib/stats.ts";

const out = process.argv[2];
if (!out) {
  console.error("usage: bun measure.ts <out.json>");
  process.exit(2);
}
const runs = Number(process.env.BENCH_RUNS ?? 3);
const attacks = Number(process.env.B13_ATTACKS ?? 20);
const probes = Number(process.env.B13_PROBES ?? 200);

const EVIL = { host: "evil.bench.test", tenant: "t_evil", app: "evil" };
const HELLO = { host: "hello.bench.test", tenant: "t_hello", app: "hello" };

interface RenderMeter {
  request_id: string;
  tenant_id: string;
  route: string;
  status: string;
  http_status: number;
  wall_ms: number;
  cpu_ms: number;
  render_ms?: number;
  render_fuel?: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

async function probe(w: Worker, n: number): Promise<number[]> {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await w.request(HELLO.host, "/api/hello");
    if (r.status !== 200) throw new Error(`probe answered ${r.status}: ${r.body}`);
    ms.push(r.ms);
  }
  return ms;
}

const samples: Record<string, number[]> = {
  render_ms_p50: [],
  render_ms_max: [],
  attack_client_ms_p50: [],
  probe_before_p50_ms: [],
  probe_during_p50_ms: [],
  probe_during_p99_ms: [],
  probe_after_p50_ms: [],
};
const notes: string[] = [];
const all: { render_ms: number[]; client_ms: number[]; fuel: number[]; status: Record<string, number> } = {
  render_ms: [],
  client_ms: [],
  fuel: [],
  status: {},
};

for (let run = 1; run <= runs; run++) {
  const w = await Worker.start([EVIL, HELLO]);
  try {
    await sleep(1000);
    // Warm both tenants: the first request of a tenant builds its cell.
    await w.request(HELLO.host, "/api/hello");
    await w.request(EVIL.host, "/api/slow?ms=1");
    const before = await probe(w, probes);

    const clientMs: number[] = [];
    let attacking = true;
    const attack = (async () => {
      for (let i = 0; i < attacks; i++) {
        const r = await w.request(EVIL.host, "/nested");
        clientMs.push(r.ms);
        if (r.status !== 500 || !r.body.includes("RENOX_RENDER_LIMIT")) {
          throw new Error(`attack ${i} answered ${r.status}: ${r.body.slice(0, 300)}`);
        }
      }
      attacking = false;
    })();
    const during: number[] = [];
    while (attacking) {
      const r = await w.request(HELLO.host, "/api/hello");
      if (r.status !== 200) throw new Error(`probe during the attack answered ${r.status}: ${r.body}`);
      during.push(r.ms);
    }
    await attack;

    const alive = await w.request(EVIL.host, "/api/slow?ms=1");
    if (alive.status !== 200) throw new Error(`evil after the attack answered ${alive.status}: ${alive.body}`);
    const after = await probe(w, probes);

    // Meter records are flushed every 500 ms (worker.sh).
    await sleep(1500);
    const meters = (w.meters() as unknown as RenderMeter[]).filter((m) => m.tenant_id === EVIL.tenant && m.route.includes("nested"));
    if (meters.length !== attacks) throw new Error(`expected ${attacks} meter records for /nested, found ${meters.length}`);
    const render = meters.map((m) => m.render_ms ?? Number.NaN);
    if (render.some((x) => !Number.isFinite(x))) throw new Error("a /nested meter record has no render_ms");
    for (const m of meters) {
      all.status[m.status] = (all.status[m.status] ?? 0) + 1;
      all.fuel.push(m.render_fuel ?? 0);
    }
    all.render_ms.push(...render);
    all.client_ms.push(...clientMs);

    const r = summarize(render);
    const c = summarize(clientMs);
    const b = summarize(before);
    const d = summarize(during);
    const a = summarize(after);
    samples.render_ms_p50!.push(round(r.p50, 2));
    samples.render_ms_max!.push(round(r.max, 2));
    samples.attack_client_ms_p50!.push(round(c.p50, 2));
    samples.probe_before_p50_ms!.push(round(b.p50, 3));
    samples.probe_during_p50_ms!.push(round(d.p50, 3));
    samples.probe_during_p99_ms!.push(round(d.p99, 3));
    samples.probe_after_p50_ms!.push(round(a.p50, 3));
    console.error(
      `B13 run ${run}/${runs}: render_ms p50 ${round(r.p50, 2)} max ${round(r.max, 2)}; client p50 ${round(c.p50, 2)} ms; ` +
        `probe p50 before ${round(b.p50, 3)} / during ${round(d.p50, 3)} (p99 ${round(d.p99, 3)}, n=${d.count}) / after ${round(a.p50, 3)} ms`,
    );
  } finally {
    w.stop();
  }
}

const statusText = Object.entries(all.status)
  .map(([k, v]) => `${k} ${v}`)
  .join(", ");
notes.push(
  `${runs} runs × ${attacks} sequential GET /nested (10,000 × 10,000 cells); every one answered 500 RENOX_RENDER_LIMIT; meter status: ${statusText}`,
  `render fuel at the stop: ${Math.min(...all.fuel)}–${Math.max(...all.fuel)}`,
  `client-side time per attack (loader, marshaling, render, HTTP): median ${round(median(all.client_ms), 2)} ms, max ${round(Math.max(...all.client_ms), 2)} ms`,
  `probe: ${probes} sequential GET /api/hello to a second tenant before and after, and one in flight at a time during the attack`,
);

await writeResult(out, {
  id: "B13",
  notes: notes.join("; "),
  samples: { ...samples, render_ms: all.render_ms.map((x) => round(x, 2)), attack_client_ms: all.client_ms.map((x) => round(x, 2)) },
  summary: {
    render_ms: round(median(samples.render_ms_p50!), 2),
    render_ms_max: round(Math.max(...samples.render_ms_max!), 2),
    attack_client_ms_p50: round(median(samples.attack_client_ms_p50!), 2),
    probe_before_p50_ms: round(median(samples.probe_before_p50_ms!), 3),
    probe_during_p50_ms: round(median(samples.probe_during_p50_ms!), 3),
    probe_during_p99_ms: round(median(samples.probe_during_p99_ms!), 3),
    probe_after_p50_ms: round(median(samples.probe_after_p50_ms!), 3),
  },
});
