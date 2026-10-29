// The chaos harness's result files (#104): the benchmark format of
// docs/14-benchmarks.md, one Markdown file and one raw JSON per scenario run.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Outcome, verdictOf, writeResult } from "./result.ts";
import { sample } from "./stack.ts";

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  scenario: "corrupt-file",
  title: "Tenant file corrupted",
  failureModes: ["SQLite file corrupted, WAL unreadable"],
  description: "overwrite",
  verdict: "PASS",
  result: "restored in 0.1 s",
  target: "503 then 200",
  alerts: [{ rule: "RenoxTenantFileRestoring", observed: "pending #295" }],
  checks: [{ name: "503 first", ok: true, detail: "503" }],
  metrics: { restore_s: 0.1 },
  notes: [],
  ...over,
});

test("a result file has the benchmark format's lines and a raw JSON beside it", () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-result-"));
  const md = writeResult(dir, outcome(), "2026-10-29");
  expect(md).toBe(join(dir, "2026-10-29-CHAOS-corrupt-file.md"));
  const text = readFileSync(md, "utf8");
  expect(text.split("\n")[0]).toBe("# CHAOS corrupt-file — Tenant file corrupted — 2026-10-29");
  for (const prefix of ["Hardware: ", "Scenario: ", "Result: ", "Target: 503 then 200 → PASS", "Alerts: RenoxTenantFileRestoring (pending #295)", "- [x] 503 first: 503", "Raw: "]) {
    expect(text).toContain(prefix);
  }
  const raw = JSON.parse(readFileSync(join(dir, "raw", "2026-10-29-CHAOS-corrupt-file.json"), "utf8")) as { id: string; verdict: string };
  expect(raw).toMatchObject({ id: "CHAOS-corrupt-file", verdict: "PASS" });
});

test("a skipped scenario says why; a failed check fails the verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-result-"));
  const text = readFileSync(writeResult(dir, outcome({ verdict: "SKIPPED", skipped: "needs root" }), "2026-10-29"), "utf8");
  expect(text).toContain("Result: skipped: needs root");
  expect(text).toContain("→ SKIPPED");
  expect(verdictOf([{ name: "a", ok: true, detail: "" }, { name: "b", ok: false, detail: "" }])).toBe("FAIL");
  expect(verdictOf([{ name: "a", ok: true, detail: "" }])).toBe("PASS");
});

test("samples are found by name and label prefix", () => {
  const m = new Map([
    ['renox_cp_node_healthy{node_id="node-chaos-1",region="me-central-1"}', 0],
    ["renox_cp_replication_lag_max_seconds", 12.5],
  ]);
  expect(sample(m, 'renox_cp_node_healthy{node_id="node-chaos-1"')).toBe(0);
  expect(sample(m, "renox_cp_replication_lag_max_seconds")).toBe(12.5);
  expect(sample(m, 'renox_cp_node_healthy{node_id="node-chaos-2"')).toBeNull();
  expect(sample(null, "x")).toBeNull();
});
