// Result files of the chaos harness in the benchmark format
// (docs/14-benchmarks.md, "Recording results"): one Markdown file per
// scenario run and the raw JSON next to the other raw results.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { REPO } from "./stack.ts";

export type Verdict = "PASS" | "FAIL" | "SKIPPED";

/** One assertion of a scenario: what the failure-modes table says, and what happened. */
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Outcome {
  scenario: string;
  title: string;
  /** The `docs/23-failure-modes.md` row(s) the scenario exercises. */
  failureModes: string[];
  description: string;
  verdict: Verdict;
  /** Why the scenario was skipped (SKIPPED only). */
  skipped?: string;
  result: string;
  target: string;
  /** The ops/observability rules the scenario should trigger, and what was observed of them. */
  alerts: { rule: string; observed: string }[];
  checks: Check[];
  metrics: Record<string, number | string>;
  notes: string[];
}

export function verdictOf(checks: Check[]): Verdict {
  return checks.every((c) => c.ok) ? "PASS" : "FAIL";
}

function hardware(): string {
  const run = (cmd: string, args: string[]): string => spawnSync(cmd, args, { encoding: "utf8" }).stdout?.trim() ?? "";
  const cpu = run("sh", ["-c", "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2"]).trim() || "unknown CPU";
  const kernel = run("uname", ["-r"]) || "unknown kernel";
  const sha = run("git", ["-C", REPO, "rev-parse", "--short", "HEAD"]) || "unknown";
  const profile = process.env.BENCH_PROFILE ?? "dev-laptop";
  return `${profile} (${cpu}, kernel ${kernel}), renox-worker ${sha}, bun ${Bun.version}`;
}

/** Writes `<outDir>/<date>-CHAOS-<scenario>.md` and `<outDir>/raw/<date>-CHAOS-<scenario>.json`; returns the Markdown path. */
export function writeResult(outDir: string, o: Outcome, date = new Date().toISOString().slice(0, 10)): string {
  const base = `${date}-CHAOS-${o.scenario}`;
  mkdirSync(join(outDir, "raw"), { recursive: true });
  const raw = join(outDir, "raw", `${base}.json`);
  writeFileSync(raw, `${JSON.stringify({ id: `CHAOS-${o.scenario}`, ...o }, null, 2)}\n`);
  const lines = [
    `# CHAOS ${o.scenario} — ${o.title} — ${date}`,
    `Hardware: ${hardware()}`,
    `Scenario: ${o.description}`,
    `Failure modes: ${o.failureModes.map((f) => `"${f}"`).join(", ")} (docs/23-failure-modes.md)`,
    `Result: ${o.verdict === "SKIPPED" ? `skipped: ${o.skipped ?? ""}` : o.result}`,
    `Target: ${o.target} → ${o.verdict}`,
    `Alerts: ${o.alerts.length === 0 ? "none" : o.alerts.map((a) => `${a.rule} (${a.observed})`).join("; ")}`,
    "Checks:",
    ...o.checks.map((c) => `- [${c.ok ? "x" : " "}] ${c.name}: ${c.detail}`),
    `Notes: ${o.notes.length === 0 ? "none" : o.notes.join(" ")}`,
    `Raw: ${raw.startsWith(REPO) ? raw.slice(REPO.length + 1) : raw}`,
    "",
  ];
  const md = join(outDir, `${base}.md`);
  writeFileSync(md, lines.join("\n"));
  return md;
}
