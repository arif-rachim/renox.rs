import { describe, expect, test } from "bun:test";
import { judge, render, type Hardware, type TargetEntry } from "./report.ts";
import targetsJson from "../targets.json";

const targets = targetsJson as unknown as Record<string, TargetEntry>;
const b6 = targets.B6 as TargetEntry;

describe("targets.json", () => {
  test("has B1..B20 with at least one metric each", () => {
    for (let i = 1; i <= 20; i++) {
      const entry = targets[`B${i}`];
      expect(entry, `B${i}`).toBeDefined();
      expect(Object.keys(entry?.metrics ?? {}).length).toBeGreaterThan(0);
    }
  });

  test("numbers match docs/14-benchmarks.md for the F0 benchmarks", () => {
    expect(targets.B1?.metrics.rss_delta_mb).toMatchObject({ target: 10, fail: 20 });
    expect(targets.B4?.metrics.p99_ms).toMatchObject({ target: 100, fail: 100 });
    expect(targets.B6?.metrics.p99_ms).toMatchObject({ target: 15, fail: 30 });
    expect(targets.B9?.metrics.marshal_us).toMatchObject({ target: 300, fail: 1000 });
    expect(targets.B17?.metrics.failed_packages).toMatchObject({ target: 0, fail: 0 });
  });
});

describe("judge", () => {
  test("PASS when every target is met", () => {
    expect(judge(b6, { p50_ms: 2.4, p99_ms: 11.8 }).status).toBe("PASS");
  });

  test("FAIL when a target is missed but the fail threshold is not crossed", () => {
    const v = judge(b6, { p50_ms: 2.4, p99_ms: 20 });
    expect(v.status).toBe("FAIL");
    expect(v.reasons[0]).toContain("misses the target");
  });

  test("FAIL with the threshold named when the fail threshold is crossed", () => {
    expect(judge(b6, { p50_ms: 2.4, p99_ms: 31 }).reasons[0]).toContain("fail threshold");
  });

  test("FAIL when a judged metric is missing", () => {
    expect(judge(b6, { p50_ms: 2.4 }).status).toBe("FAIL");
  });

  test("higher-is-better metrics", () => {
    const b11 = targets.B11 as TargetEntry;
    expect(judge(b11, { req_per_s: 41000 }).status).toBe("PASS");
    expect(judge(b11, { req_per_s: 14000 }).reasons[0]).toContain("fail threshold");
  });

  test("INFO without a target or without numbers", () => {
    expect(judge(undefined, {}).status).toBe("INFO");
    expect(judge(targets.B8, { path_a_p50_ms: 1, path_b_p50_ms: 2 }).status).toBe("INFO");
  });
});

test("render follows the Recording results format", () => {
  const hw: Hardware = {
    cpu: "AMD EPYC 7B13",
    cpus: 4,
    ram_mb: 8192,
    kernel: "Linux 6.8.0",
    rustc: "rustc 1.99.1 (58cf8f9c3 2026-10-13)",
    bun: "1.4.4",
    node: null,
    deno: null,
    git: "abc1234",
  };
  const out = render({
    raw: { id: "B6", samples: {}, summary: { p50_ms: 2.4, p99_ms: 11.8 } },
    hw,
    entry: b6,
    profile: "node-small",
    runs: "3",
    date: "2026-11-15",
    rawPath: "bench/results/raw/2026-11-15-B6.json",
  });
  const lines = out.split("\n");
  expect(lines[0]).toBe("# B6 — SSR medium page — 2026-11-15");
  expect(lines.map((l) => l.split(":")[0])).toEqual([
    "# B6 — SSR medium page — 2026-11-15",
    "Hardware",
    "Scenario",
    "Result",
    "Target",
    "Notes",
    "Raw",
  ]);
  expect(lines[1]).toContain("node-small (AMD EPYC 7B13");
  expect(lines[4]).toEndWith("→ PASS");
});
