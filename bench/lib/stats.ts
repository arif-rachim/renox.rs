// Percentile summary shared by every scenario, so results are computed the
// same way everywhere (docs/14-benchmarks.md, "Methodology").
//
// CLI: `bun bench/lib/stats.ts [file.json]` reads a JSON array of numbers
// (from the file, or stdin when no file is given) and prints
// {"count","p50","p99","mean","min","max"} as JSON.

export interface Summary {
  count: number;
  p50: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
}

/** Nearest-rank percentile on an ascending-sorted array; `p` in (0, 100]. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("percentile of an empty sample set");
  if (!(p > 0 && p <= 100)) throw new Error(`percentile out of range: ${p}`);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1] as number;
}

export function summarize(samples: readonly number[]): Summary {
  if (samples.length === 0) throw new Error("no samples");
  for (const s of samples) {
    if (typeof s !== "number" || !Number.isFinite(s)) {
      throw new Error(`sample is not a finite number: ${String(s)}`);
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, s) => acc + s, 0);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p99: percentile(sorted, 99),
    mean: sum / sorted.length,
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
  };
}

if (import.meta.main) {
  const file = process.argv[2];
  const text = file ? await Bun.file(file).text() : await Bun.stdin.text();
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    console.error("stats: input must be a JSON array of numbers");
    process.exit(2);
  }
  console.log(JSON.stringify(summarize(parsed as number[])));
}
