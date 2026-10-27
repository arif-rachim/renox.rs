import { expect, test } from "bun:test";
import { build, runTimes, workerAsset, type Job } from "./collect.ts";

function job(name: string, conclusion: string, start: string, end: string): Job {
  return { name, conclusion, startedAt: `2026-10-27T${start}:00Z`, completedAt: `2026-10-27T${end}:00Z` };
}

test("run wall time spans the jobs that ran; skipped jobs are ignored", () => {
  const t = runTimes([
    job("changes", "success", "10:00", "10:01"),
    job("rust", "success", "10:01", "10:13"),
    job("ts", "success", "10:01", "10:03"),
    job("docs", "skipped", "09:00", "09:00"),
  ]);
  expect(t).toEqual({ ci_min: 13, rust_job_min: 12 });
});

test("a run whose rust job was skipped is not CI time for B20", () => {
  expect(runTimes([job("changes", "success", "10:00", "10:01"), job("rust", "skipped", "10:01", "10:01")])).toBeNull();
});

test("worker asset is matched by target, not the checksum file", () => {
  const assets = [
    { name: "renox-worker-0.1.0-x86_64-unknown-linux-gnu.sha256", size: 100 },
    { name: "renox-worker-0.1.0-x86_64-unknown-linux-gnu", size: 52_428_800 },
  ];
  expect(workerAsset(assets, "x86_64-unknown-linux-gnu")?.size).toBe(52_428_800);
  expect(workerAsset(assets, "aarch64-unknown-linux-gnu")).toBeUndefined();
});

test("median of runs is judged; binary_mb only when a release exists", () => {
  const times = [
    { ci_min: 20, rust_job_min: 19, run: "1" },
    { ci_min: 9, rust_job_min: 8, run: "2" },
    { ci_min: 11, rust_job_min: 10, run: "3" },
  ];
  const without = build(times, undefined);
  expect(without.summary).toEqual({ ci_min: 11, rust_job_min: 10 });
  expect(without.notes).toContain("binary_mb not measured");
  const withRelease = build(times, { tag: "worker-v0.1.0", asset: { name: "renox-worker-0.1.0-x86_64-unknown-linux-gnu", size: 52_428_800 } });
  expect(withRelease.summary.binary_mb).toBe(50);
});

test("no CI run with the rust job is an error", () => {
  expect(() => build([], undefined)).toThrow("no successful CI run");
});
