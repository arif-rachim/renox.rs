// B9 (issue #10): reads criterion's estimates for every saved baseline and
// writes the scenario JSON (bench/scenarios/README.md contract).
//
// Layout read: <criterionDir>/<path>/<items>/<baseline>/estimates.json, whose
// `median.point_estimate` is the per-iteration median in nanoseconds.
//
// usage: bun collect.ts <criterionDir> <out.json> <baseline>...

import { join } from "node:path";
import { readdirSync } from "node:fs";
import { summarize } from "../../lib/stats.ts";

/** Paths named in issue #10; the extra one is reported but labelled. */
export const ISSUE_PATHS = ["serde_json", "struct", "walker", "json_string"] as const;
export const JUDGED_ITEMS = 100;

export interface B9Result {
  id: "B9";
  scenario: string;
  notes: string;
  samples: Record<string, number[]>;
  summary: Record<string, number>;
}

export async function collect(criterionDir: string, baselines: string[]): Promise<B9Result> {
  if (baselines.length === 0) throw new Error("no baselines given");
  const samples: Record<string, number[]> = {};
  for (const path of readdirSync(criterionDir).sort()) {
    if (path === "report") continue;
    for (const items of readdirSync(join(criterionDir, path)).sort((a, b) => Number(a) - Number(b))) {
      if (!/^\d+$/.test(items)) continue;
      const key = `${path}_${items}_us`;
      samples[key] = [];
      for (const baseline of baselines) {
        const file = Bun.file(join(criterionDir, path, items, baseline, "estimates.json"));
        if (!(await file.exists())) throw new Error(`missing ${file.name}`);
        const est = (await file.json()) as { median: { point_estimate: number } };
        samples[key].push(round(est.median.point_estimate / 1000));
      }
    }
  }
  const summary: Record<string, number> = {};
  let best: { path: string; us: number } | undefined;
  for (const [key, values] of Object.entries(samples)) {
    const median = round(summarize(values).p50);
    summary[key] = median;
    const m = key.match(/^(.+)_(\d+)_us$/);
    if (m && Number(m[2]) === JUDGED_ITEMS && (!best || median < best.us)) best = { path: m[1] as string, us: median };
  }
  if (!best) throw new Error(`no ${JUDGED_ITEMS}-item measurement found under ${criterionDir}`);
  const extra = (ISSUE_PATHS as readonly string[]).includes(best.path) ? "" : " (extra path, not in the issue)";
  return {
    id: "B9",
    scenario: "100 items × 10 fields V8 → minijinja::Value; criterion median per path at 10/100/1000 items, median of runs",
    notes: `best path at ${JUDGED_ITEMS} items: ${best.path}${extra}`,
    samples,
    summary: { marshal_us: best.us, ...summary },
  };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

if (import.meta.main) {
  const [criterionDir, out, ...baselines] = process.argv.slice(2);
  if (!criterionDir || !out || baselines.length === 0) {
    console.error("usage: bun collect.ts <criterionDir> <out.json> <baseline>...");
    process.exit(2);
  }
  const result = await collect(criterionDir, baselines);
  await Bun.write(out, `${JSON.stringify(result, null, 2)}\n`);
}
