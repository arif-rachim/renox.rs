// Turns a scenario's raw JSON plus the hardware JSON into the result markdown
// of docs/14-benchmarks.md, "Recording results", with PASS/FAIL computed from
// bench/targets.json. Called by bench/lib/report.sh.

export interface MetricTarget {
  unit: string;
  better: "lower" | "higher";
  target: number | null;
  fail: number | null;
}

export interface TargetEntry {
  metric: string;
  scenario: string;
  target_text: string;
  fail_text: string;
  metrics: Record<string, MetricTarget>;
}

export interface RawResult {
  id: string;
  scenario?: string;
  notes?: string;
  samples: Record<string, number[]>;
  summary: Record<string, number>;
}

export interface Hardware {
  cpu: string;
  cpus: number;
  ram_mb: number;
  kernel: string;
  rustc: string | null;
  bun: string | null;
  node: string | null;
  deno: string | null;
  git: string;
}

export interface Verdict {
  status: "PASS" | "FAIL" | "INFO";
  reasons: string[];
}

/** PASS when every metric with a number meets its target and no fail threshold is crossed. */
export function judge(entry: TargetEntry | undefined, summary: Record<string, number>): Verdict {
  if (!entry) return { status: "INFO", reasons: ["no target in bench/targets.json (informational)"] };
  const reasons: string[] = [];
  let judged = 0;
  for (const [name, t] of Object.entries(entry.metrics)) {
    if (t.target === null && t.fail === null) continue;
    judged++;
    const value = summary[name];
    if (value === undefined || !Number.isFinite(value)) {
      reasons.push(`${name}: missing from summary`);
      continue;
    }
    const worse = (limit: number) => (t.better === "lower" ? value > limit : value < limit);
    if (t.fail !== null && worse(t.fail)) {
      reasons.push(`${name} ${value} ${t.unit} crosses the fail threshold ${t.fail} ${t.unit}`);
    } else if (t.target !== null && worse(t.target)) {
      reasons.push(`${name} ${value} ${t.unit} misses the target ${t.target} ${t.unit}`);
    }
  }
  if (judged === 0) return { status: "INFO", reasons: ["target has no numbers (informational)"] };
  return { status: reasons.length === 0 ? "PASS" : "FAIL", reasons };
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(4)));
}

function shortVersion(v: string | null): string {
  if (v === null) return "n/a";
  const m = v.match(/\d+\.\d+(\.\d+)?/);
  return m ? m[0] : v;
}

export function render(opts: {
  raw: RawResult;
  hw: Hardware;
  entry: TargetEntry | undefined;
  profile: string;
  runs: string;
  date: string;
  rawPath: string;
}): string {
  const { raw, hw, entry, profile, runs, date, rawPath } = opts;
  const verdict = judge(entry, raw.summary);
  const units = entry?.metrics ?? {};
  const result = Object.entries(raw.summary)
    .map(([k, v]) => `${k} ${fmt(v)}${units[k] ? ` ${units[k].unit}` : ""}`)
    .join(", ");
  const target = entry ? `${entry.target_text} (fail: ${entry.fail_text})` : "none";
  const notes = [
    `profile ${profile}, runs ${runs}`,
    profile === "node-small" ? "" : "not node-small: relative comparison only, never pass/fail",
    ...verdict.reasons,
    raw.notes ?? "",
  ].filter((s) => s !== "");
  return [
    `# ${raw.id} — ${entry?.metric ?? raw.scenario ?? raw.id} — ${date}`,
    `Hardware: ${profile} (${hw.cpu}, ${hw.cpus} vCPU, ${Math.round(hw.ram_mb / 1024)} GB RAM, ${hw.kernel}), git ${hw.git}, rustc ${shortVersion(hw.rustc)}, bun ${shortVersion(hw.bun)}, node ${shortVersion(hw.node)}, deno ${shortVersion(hw.deno)}`,
    `Scenario: ${raw.scenario ?? entry?.scenario ?? "n/a"}`,
    `Result: ${result}`,
    `Target: ${target} → ${verdict.status}`,
    `Notes: ${notes.join("; ")}`,
    `Raw: ${rawPath}`,
  ].join("\n");
}

if (import.meta.main) {
  const [rawPath, hwPath, targetsPath] = process.argv.slice(2);
  if (!rawPath || !hwPath || !targetsPath) {
    console.error("usage: report.ts <raw.json> <hw.json> <targets.json>");
    process.exit(2);
  }
  const raw = (await Bun.file(rawPath).json()) as RawResult;
  if (typeof raw.id !== "string" || typeof raw.summary !== "object" || raw.summary === null) {
    console.error(`report: ${rawPath} does not follow the scenario contract (id, samples, summary)`);
    process.exit(2);
  }
  const hw = (await Bun.file(hwPath).json()) as Hardware;
  const targets = (await Bun.file(targetsPath).json()) as Record<string, TargetEntry>;
  const date = rawPath.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? new Date().toISOString().slice(0, 10);
  console.log(
    render({
      raw,
      hw,
      entry: targets[raw.id],
      profile: process.env.BENCH_PROFILE ?? "dev-laptop",
      runs: process.env.BENCH_RUNS ?? "1",
      date,
      rawPath,
    }),
  );
}
