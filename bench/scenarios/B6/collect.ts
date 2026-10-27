// B6 first cut (issue #11): reads criterion's estimates for every saved
// baseline, the page metadata the benchmark wrote, and the latest B9 raw
// result; writes the scenario JSON (bench/scenarios/README.md contract).
//
// The raw `id` is "B6-first-cut", not "B6": it has no entry in
// bench/targets.json, so bench/lib/report.sh prints it as informational
// instead of judging a render-only number against the end-to-end B6 target.
//
// usage: bun collect.ts <criterionDir> <meta.json> <b9.json> <out.json> <baseline>...

import { join } from "node:path";
import { readdirSync } from "node:fs";
import { summarize } from "../../lib/stats.ts";

/** Budget for render + marshal at p50 that leaves room for the rest of the request path. */
export const BUDGET_US = 1000;

export interface Meta {
  page_100_bytes: number;
  page_1000_bytes: number;
  fragment_100_bytes: number;
  page_100_fuel: number;
}

export async function medians(criterionDir: string, baselines: string[]): Promise<Record<string, number[]>> {
  if (baselines.length === 0) throw new Error("no baselines given");
  const samples: Record<string, number[]> = {};
  for (const bench of readdirSync(criterionDir).sort()) {
    if (bench === "report") continue;
    for (const items of readdirSync(join(criterionDir, bench))) {
      if (!/^\d+$/.test(items)) continue;
      const key = `${bench}_${items}_us`;
      samples[key] = [];
      for (const baseline of baselines) {
        const file = Bun.file(join(criterionDir, bench, items, baseline, "estimates.json"));
        if (!(await file.exists())) throw new Error(`missing ${file.name}`);
        const est = (await file.json()) as { median: { point_estimate: number } };
        samples[key].push(round(est.median.point_estimate / 1000));
      }
    }
  }
  return samples;
}

export function build(
  samples: Record<string, number[]>,
  meta: Meta,
  b9: { summary: Record<string, number> },
  b9Path: string,
) {
  const med = (key: string) => {
    const values = samples[key];
    if (!values) throw new Error(`no samples for ${key}`);
    return round(summarize(values).p50);
  };
  const page = med("page_100_us");
  const pageFuel = med("page_fuel_100_us");
  const marshal = b9.summary.marshal_us;
  if (marshal === undefined) throw new Error(`${b9Path} has no summary.marshal_us`);
  const predicted = round(page + marshal);
  const verdict = predicted <= BUDGET_US ? "PASS" : "FAIL";
  return {
    id: "B6-first-cut",
    scenario:
      "B6 first cut (render stage only): shop-products.html via template-proto + minijinja, products already minijinja::Value; criterion median, median of runs",
    notes:
      `derived check render + marshal p50 = ${page} + ${marshal} = ${predicted} µs vs ≤ ${BUDGET_US} µs → ${verdict}; ` +
      `marshal_us from ${b9Path}; fuel overhead ${round(((pageFuel - page) / page) * 100)}%`,
    samples,
    summary: {
      page_100_us: page,
      fragment_100_us: med("fragment_100_us"),
      fragment_captured_100_us: med("fragment_captured_100_us"),
      page_1000_us: med("page_1000_us"),
      page_fuel_100_us: pageFuel,
      fuel_overhead_pct: round(((pageFuel - page) / page) * 100),
      page_100_kb: round(meta.page_100_bytes / 1024),
      fragment_100_kb: round(meta.fragment_100_bytes / 1024),
      page_1000_kb: round(meta.page_1000_bytes / 1024),
      page_100_fuel: meta.page_100_fuel,
      marshal_us: marshal,
      render_plus_marshal_us: predicted,
    },
  };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

if (import.meta.main) {
  const [criterionDir, metaPath, b9Path, out, ...baselines] = process.argv.slice(2);
  if (!criterionDir || !metaPath || !b9Path || !out || baselines.length === 0) {
    console.error("usage: bun collect.ts <criterionDir> <meta.json> <b9.json> <out.json> <baseline>...");
    process.exit(2);
  }
  const meta = (await Bun.file(metaPath).json()) as Meta;
  const b9 = (await Bun.file(b9Path).json()) as { summary: Record<string, number> };
  const result = build(await medians(criterionDir, baselines), meta, b9, b9Path);
  await Bun.write(out, `${JSON.stringify(result, null, 2)}\n`);
}
