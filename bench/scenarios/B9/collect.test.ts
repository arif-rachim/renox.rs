import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "./collect.ts";

const dir = mkdtempSync(join(tmpdir(), "b9-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function estimate(path: string, items: number, baseline: string, ns: number) {
  const d = join(dir, path, String(items), baseline);
  mkdirSync(d, { recursive: true });
  await Bun.write(join(d, "estimates.json"), JSON.stringify({ median: { point_estimate: ns } }));
}

test("median of runs per path, best 100-item path judged as marshal_us", async () => {
  for (const [b, k] of [["r1", 1], ["r2", 3], ["r3", 2]] as const) {
    await estimate("struct", 100, b, 400_000 * k);
    await estimate("walker", 100, b, 300_000 * k);
    await estimate("walker", 10, b, 30_000 * k);
  }
  mkdirSync(join(dir, "report"), { recursive: true });
  const r = await collect(dir, ["r1", "r2", "r3"]);
  expect(r.samples.walker_100_us).toEqual([300, 900, 600]);
  expect(r.summary.struct_100_us).toBe(800);
  expect(r.summary.walker_100_us).toBe(600);
  expect(r.summary.marshal_us).toBe(600);
  expect(r.summary.walker_10_us).toBe(60);
  expect(r.notes).toBe("best path at 100 items: walker");
});

test("a missing baseline is an error", async () => {
  await expect(collect(dir, ["r1", "nope"])).rejects.toThrow("missing");
});
