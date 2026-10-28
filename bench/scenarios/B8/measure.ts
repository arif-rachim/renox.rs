// B8 (#42, ADR D7): the same page through render path A and path B,
// end to end on renox-worker.
//
//   A: GET /b8?n=N              loader -> JSON -> minijinja in Rust (render pool)
//   B: GET /b8/render?n=N       same loader -> emit_js module in the isolate
//
// for the full page and the product_list fragment (A: HX-Target, B:
// ?fragment=), at 100 and 1,000 items. Per variant: B8_WARMUP untimed
// requests, then B8_SAMPLES sequential timed requests (client-side, to the
// last body byte), then B8_LOAD_S seconds of closed-loop load with
// B8_CONNECTIONS keep-alive connections (req/s). CPU per request comes from
// the meter records: cpu_ms (isolate thread: loader, marshaling, and on path B
// the render) and render_ms (render pool, path A only).
//
// usage: bun measure.ts <out.json> <staged app dir>
// env: BENCH_RUNS (3), B8_SAMPLES (500), B8_WARMUP (100), B8_CONNECTIONS (8), B8_LOAD_S (10)

import { medianBy, round, sleep, Worker, writeResult, type MeterRecord } from "../B11/harness.ts";
import { summarize } from "../../lib/stats.ts";

const [out, app] = process.argv.slice(2);
if (!out || !app) {
  console.error("usage: bun measure.ts <out.json> <staged app dir>");
  process.exit(2);
}
const runs = Number(process.env.BENCH_RUNS ?? 3);
const samplesPerRun = Number(process.env.B8_SAMPLES ?? 500);
const warmup = Number(process.env.B8_WARMUP ?? 100);
const connections = Number(process.env.B8_CONNECTIONS ?? 8);
const loadS = Number(process.env.B8_LOAD_S ?? 10);

const HOST = "shop-b8.localhost";

interface Variant {
  key: string;
  path: "a" | "b";
  url: string;
  headers: Record<string, string>;
}
const variants: Variant[] = [];
for (const n of [100, 1000]) {
  variants.push({ key: `a_page_${n}`, path: "a", url: `/b8?n=${n}`, headers: {} });
  variants.push({ key: `b_page_${n}`, path: "b", url: `/b8/render?n=${n}`, headers: {} });
  variants.push({ key: `a_fragment_${n}`, path: "a", url: `/b8?n=${n}`, headers: { "hx-request": "true", "hx-target": "product-list" } });
  variants.push({ key: `b_fragment_${n}`, path: "b", url: `/b8/render?n=${n}&fragment=product_list`, headers: {} });
}

const w = await Worker.start([{ host: HOST, tenant: "t_b8", app }]);

async function get(v: Variant): Promise<{ status: number; ms: number; body: string }> {
  return w.request(HOST, v.url, { headers: v.headers });
}

/** Meter records not seen before, after the 500 ms flush. */
const seen = new Set<string>();
async function newMeters(): Promise<MeterRecord[]> {
  await sleep(1500);
  const fresh = w.meters().filter((m) => !seen.has(m.request_id));
  for (const m of fresh) seen.add(m.request_id);
  return fresh;
}

const median = (xs: number[]): number => (xs.length === 0 ? NaN : summarize(xs).p50);

/**
 * Closed-loop load with the variant's headers (the shared harness's load()
 * sends none, and the path A fragment needs HX-Target): `connections`
 * keep-alive clients, each sending the next request when the last one ends.
 * Bun, in this process: client and worker share the machine's cores.
 */
async function closedLoop(v: Variant): Promise<number> {
  const url = w.url(v.url);
  const headers = { ...v.headers, host: HOST };
  const end = performance.now() + loadS * 1000;
  let done = 0;
  const client = async (): Promise<void> => {
    while (performance.now() < end) {
      const r = await fetch(url, { headers });
      await r.arrayBuffer();
      if (r.status !== 200) throw new Error(`${v.key} under load: ${r.status}`);
      done++;
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: connections }, client));
  return done / ((performance.now() - t0) / 1000);
}
const notes: string[] = [];
interface VariantRun {
  p50_ms: number;
  p99_ms: number;
  cpu_ms: number;
  render_ms: number;
  req_per_s: number;
  bytes: number;
}
const results: Record<string, VariantRun[]> = Object.fromEntries(variants.map((v) => [v.key, []]));
const samples: Record<string, number[]> = {};

try {
  for (const path of ["/api/dev/seed", "/b8/seed"]) {
    const r = await w.request(HOST, path, { method: "POST" });
    if (r.status !== 200) throw new Error(`${path} answered ${r.status}: ${r.body}`);
  }
  // Both paths must send the same HTML. Path A's page carries the
  // per-request CSP nonce on its <script>; path B's function does not.
  for (const n of [100, 1000]) {
    for (const kind of ["page", "fragment"]) {
      const a = (await get(variants.find((v) => v.key === `a_${kind}_${n}`) as Variant)).body;
      const b = (await get(variants.find((v) => v.key === `b_${kind}_${n}`) as Variant)).body;
      const strip = (s: string): string => s.replace(/ nonce="[^"]*"/gu, "");
      if (strip(a) !== strip(b)) {
        await Bun.write(`${out}.a-${kind}-${n}.html`, a);
        await Bun.write(`${out}.b-${kind}-${n}.html`, b);
        throw new Error(`path A and path B differ on the ${kind} at ${n} items (bodies written next to ${out})`);
      }
      notes.push(`${kind} ${n}: ${a.length} bytes, identical on both paths (nonce aside)`);
    }
  }
  await newMeters();

  for (let run = 1; run <= runs; run++) {
    for (const v of variants) {
      for (let i = 0; i < warmup; i++) await get(v);
      await newMeters();
      const lat: number[] = [];
      let bytes = 0;
      for (let i = 0; i < samplesPerRun; i++) {
        const r = await get(v);
        if (r.status !== 200) throw new Error(`${v.key}: ${r.status} ${r.body.slice(0, 200)}`);
        lat.push(r.ms);
        bytes = r.body.length;
      }
      const meters = (await newMeters()).filter((m) => m.status === "ok");
      const reqPerS = await closedLoop(v);
      await newMeters();
      const s = summarize(lat);
      const run_: VariantRun = {
        p50_ms: s.p50,
        p99_ms: s.p99,
        cpu_ms: median(meters.map((m) => m.cpu_ms)),
        render_ms: median(meters.map((m) => (m as MeterRecord & { render_ms?: number }).render_ms ?? 0)),
        req_per_s: reqPerS,
        bytes,
      };
      results[v.key]?.push(run_);
      samples[`run${run}_${v.key}_ms`] = lat.map((x) => round(x, 3));
      console.error(
        `B8 run ${run} ${v.key}: p50 ${round(s.p50)} p99 ${round(s.p99)} ms, cpu ${round(run_.cpu_ms)} + render ${round(run_.render_ms)} ms, ${Math.round(reqPerS)} req/s`,
      );
    }
  }
} finally {
  w.stop();
}

const summary: Record<string, number> = {};
for (const v of variants) {
  const m = medianBy(results[v.key] as VariantRun[], (r) => r.p50_ms);
  summary[`${v.key}_p50_ms`] = round(m.p50_ms);
  summary[`${v.key}_p99_ms`] = round(m.p99_ms);
  summary[`${v.key}_cpu_ms`] = round(m.cpu_ms);
  summary[`${v.key}_render_ms`] = round(m.render_ms);
  summary[`${v.key}_req_per_s`] = Math.round(m.req_per_s);
  summary[`${v.key}_bytes`] = m.bytes;
}
// The judged keys of targets.json: the B6 page, 100 items.
summary.path_a_p50_ms = summary.a_page_100_p50_ms as number;
summary.path_b_p50_ms = summary.b_page_100_p50_ms as number;

await writeResult(out, {
  id: "B8",
  scenario: `examples/shop list page (pages/products/index.html with partials/product-card and the main layout) at 100 and 1,000 items, page and product_list fragment; path A GET /b8 (loader, JSON marshaling, minijinja on the render pool), path B GET /b8/render (same loader, emit_js module in the isolate); ${warmup} warm-up then ${samplesPerRun} sequential requests per variant, client-side time to the last byte; ${loadS} s closed-loop load with ${connections} connections for req/s; median run of ${runs}`,
  notes: notes.join("; "),
  samples,
  summary,
});
