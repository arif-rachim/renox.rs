// The pure parts of `make lighthouse` (#725): median, thresholds, the table.
import { describe, expect, test } from "bun:test";

import { failures, markdown, median, medianOf, summarize, type LhrLike, type RunSummary, type TargetResult } from "./report.ts";
import { BUSY_SEED, parseArgs } from "./run.ts";

const run = (accessibility: number, performance: number, extra: Partial<RunSummary> = {}): RunSummary => ({
  accessibility,
  performance,
  lcpMs: 1500,
  tbtMs: 20,
  cls: 0,
  totalBytes: 75_000,
  ...extra,
});

const lhr: LhrLike = {
  categories: { accessibility: { score: 0.94 }, performance: { score: 0.876 } },
  audits: {
    "largest-contentful-paint": { numericValue: 1812.4 },
    "total-blocking-time": { numericValue: 120.2 },
    "cumulative-layout-shift": { numericValue: 0.04567 },
    "total-byte-weight": { numericValue: 80_000.4 },
  },
};

describe("median", () => {
  test("the middle of three, in any order", () => {
    expect(median([90, 100, 80])).toBe(90);
  });
  test("the mean of the two middle values for an even count", () => {
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
  test("no runs is an error", () => {
    expect(() => median([])).toThrow(/no runs/u);
    expect(() => medianOf([])).toThrow(/no runs/u);
  });
});

describe("summarize", () => {
  test("scores to 0-100 and the metrics rounded", () => {
    expect(summarize(lhr)).toEqual({ accessibility: 94, performance: 88, lcpMs: 1812, tbtMs: 120, cls: 0.046, totalBytes: 80_000 });
  });
  test("a category without a score is an error", () => {
    expect(() => summarize({ ...lhr, categories: { accessibility: { score: null } } })).toThrow(/accessibility/u);
  });
});

describe("failures", () => {
  const ok: TargetResult = { target: "/dispatch", role: "dispatcher", runs: [run(95, 90), run(92, 85), run(99, 99)] };
  test("medians at or over the thresholds pass", () => {
    expect(failures([ok, { target: "/x", role: "r", runs: [run(90, 80)] }])).toEqual([]);
  });
  test("names the target and the category; one bad run among three does not fail", () => {
    const bad: TargetResult = { target: "/me/visits/jb_seed_05?lang=ar", role: "technician", runs: [run(85, 70), run(86, 95), run(100, 60)] };
    const noisy: TargetResult = { target: "/dispatch?lang=ar", role: "dispatcher", runs: [run(95, 40), run(95, 90), run(95, 91)] };
    expect(failures([ok, noisy, bad])).toEqual([
      "/me/visits/jb_seed_05?lang=ar (technician): accessibility 86 is under 90",
      "/me/visits/jb_seed_05?lang=ar (technician): performance 70 is under 80",
    ]);
  });
});

describe("markdown", () => {
  test("a row per target with the median, the commit and the worker version", () => {
    const md = markdown([{ target: "/dispatch", role: "dispatcher", runs: [run(95, 90, { totalBytes: 2048 }), run(100, 100, { totalBytes: 2048 }), run(90, 80, { totalBytes: 2048 })] }], {
      date: "2026-11-10",
      commit: "abc1234",
      worker: "0.7.1",
      runs: 3,
    });
    expect(md).toContain("Commit abc1234; renox-worker 0.7.1");
    expect(md).toContain("| `/dispatch` | dispatcher | 95 | 90 | 1500 | 20 | 0 | 2.0 KiB |");
    expect(md).toContain("- `/dispatch`: 95/90, 100/100, 90/80");
  });
});

describe("parseArgs", () => {
  test("defaults and flags", () => {
    expect(parseArgs([]).runs).toBe(3);
    const o = parseArgs(["--assert", "--runs", "1", "--out", "/tmp/x"]);
    expect(o).toMatchObject({ assert: true, runs: 1, out: "/tmp/x" });
    expect(() => parseArgs(["--runs", "0"])).toThrow();
    expect(() => parseArgs(["--nope"])).toThrow(/unknown/u);
  });
  test("--busy adds the busy-day seed once, before and with other --seed files in order", () => {
    expect(parseArgs([]).busy).toBe(false);
    expect(parseArgs([]).extraSeeds).toEqual([]);
    expect(parseArgs(["--busy"])).toMatchObject({ busy: true, extraSeeds: [BUSY_SEED] });
    expect(parseArgs(["--busy", "--busy"]).extraSeeds).toEqual([BUSY_SEED]);
    expect(parseArgs(["--seed", "a.sql", "--busy", "--seed", "b.sql"]).extraSeeds).toEqual(["a.sql", BUSY_SEED, "b.sql"]);
    expect(BUSY_SEED.endsWith("bench/lighthouse/busy-day.sql")).toBe(true);
  });
});

describe("markdown seeds", () => {
  test("names the extra seed files in the header", () => {
    const md = markdown([{ target: "/dispatch", role: "dispatcher", runs: [run(100, 100)] }], { date: "2026-11-10", commit: "abc1234", worker: "0.7.1", runs: 1, extraSeeds: ["busy-day.sql"] });
    expect(md).toContain("with `seeds/001_demo.sql` and `busy-day.sql`;");
  });
});
