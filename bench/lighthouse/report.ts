// The pure parts of `make lighthouse` (#725): medians, the threshold check and
// the Markdown table. No I/O, so run.test.ts covers them from fixtures.

export const THRESHOLDS = { accessibility: 90, performance: 80 } as const;

export interface RunSummary {
  /** Category scores, 0 to 100. */
  accessibility: number;
  performance: number;
  lcpMs: number;
  tbtMs: number;
  cls: number;
  totalBytes: number;
}

export interface TargetResult {
  /** Path and query, e.g. `/dispatch?lang=ar`. */
  target: string;
  role: string;
  runs: RunSummary[];
}

/** The subset of a Lighthouse report the summary reads. */
export interface LhrLike {
  finalDisplayedUrl?: string;
  finalUrl?: string;
  categories: Record<string, { score: number | null } | undefined>;
  audits: Record<string, { numericValue?: number } | undefined>;
}

/** Median of a non-empty list; the mean of the two middle values for an even count. */
export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of no runs: a target needs at least one Lighthouse run");
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** One report to the numbers the table shows. Throws when a category has no score. */
export function summarize(lhr: LhrLike): RunSummary {
  const score = (id: string): number => {
    const s = lhr.categories[id]?.score;
    if (typeof s !== "number") throw new Error(`the Lighthouse report has no score for ${id}`);
    return Math.round(s * 100);
  };
  const num = (id: string): number => lhr.audits[id]?.numericValue ?? 0;
  return {
    accessibility: score("accessibility"),
    performance: score("performance"),
    lcpMs: Math.round(num("largest-contentful-paint")),
    tbtMs: Math.round(num("total-blocking-time")),
    cls: Math.round(num("cumulative-layout-shift") * 1000) / 1000,
    totalBytes: Math.round(num("total-byte-weight")),
  };
}

/** The median of every column over a target's runs. */
export function medianOf(runs: RunSummary[]): RunSummary {
  const col = (k: keyof RunSummary): number => median(runs.map((r) => r[k]));
  return {
    accessibility: col("accessibility"),
    performance: col("performance"),
    lcpMs: Math.round(col("lcpMs")),
    tbtMs: Math.round(col("tbtMs")),
    cls: Math.round(col("cls") * 1000) / 1000,
    totalBytes: Math.round(col("totalBytes")),
  };
}

/** One message per target and category whose median is under its threshold. */
export function failures(results: TargetResult[], thresholds: { accessibility: number; performance: number } = THRESHOLDS): string[] {
  const out: string[] = [];
  for (const r of results) {
    const m = medianOf(r.runs);
    for (const cat of ["accessibility", "performance"] as const) {
      if (m[cat] < thresholds[cat]) out.push(`${r.target} (${r.role}): ${cat} ${m[cat]} is under ${thresholds[cat]}`);
    }
  }
  return out;
}

export interface ReportMeta {
  date: string;
  commit: string;
  worker: string;
  runs: number;
}

const bytes = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

/** The result file: a header, the median table, and every run's scores. */
export function markdown(results: TargetResult[], meta: ReportMeta): string {
  const lines: string[] = [
    `# Lighthouse of the home-services dispatch board and technician visit page: ${meta.date}`,
    "",
    `Commit ${meta.commit}; renox-worker ${meta.worker}; Lighthouse mobile emulation and throttling (the default phone profile); the app under \`renox dev\` with \`seeds/001_demo.sql\`; ${meta.runs} run${meta.runs === 1 ? "" : "s"} per target, median per column. Thresholds: accessibility >= ${THRESHOLDS.accessibility}, performance >= ${THRESHOLDS.performance}.`,
    "",
    "| Target | Role | Accessibility | Performance | LCP ms | TBT ms | CLS | Total bytes |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of results) {
    const m = medianOf(r.runs);
    lines.push(`| \`${r.target}\` | ${r.role} | ${m.accessibility} | ${m.performance} | ${m.lcpMs} | ${m.tbtMs} | ${m.cls} | ${bytes(m.totalBytes)} |`);
  }
  lines.push("", "Every run (accessibility / performance):", "");
  for (const r of results) lines.push(`- \`${r.target}\`: ${r.runs.map((x) => `${x.accessibility}/${x.performance}`).join(", ")}`);
  lines.push("");
  return lines.join("\n");
}
