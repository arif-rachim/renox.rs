import { describe, expect, test } from "bun:test";
import { percentile, summarize } from "./stats.ts";

describe("stats", () => {
  test("nearest-rank percentiles on 1..100", () => {
    const samples = Array.from({ length: 100 }, (_, i) => 100 - i);
    const s = summarize(samples);
    expect(s).toEqual({ count: 100, p50: 50, p99: 99, mean: 50.5, min: 1, max: 100 });
  });

  test("single sample", () => {
    expect(summarize([7])).toEqual({ count: 1, p50: 7, p99: 7, mean: 7, min: 7, max: 7 });
  });

  test("rejects empty and non-finite input", () => {
    expect(() => summarize([])).toThrow("no samples");
    expect(() => summarize([1, Number.NaN])).toThrow("finite");
    expect(() => percentile([1], 0)).toThrow("out of range");
  });
});
