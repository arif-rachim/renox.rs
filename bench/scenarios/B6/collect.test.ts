import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, medians } from "./collect.ts";

const dir = mkdtempSync(join(tmpdir(), "b6-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const meta = { page_100_bytes: 25_600, page_1000_bytes: 256_000, fragment_100_bytes: 24_576, page_100_fuel: 4780 };
const base = { page_100_us: [200], fragment_100_us: [190], fragment_captured_100_us: [380], page_1000_us: [2000] };

test("medians reads one sample per baseline", async () => {
  for (const [b, ns] of [["r1", 100_000], ["r2", 300_000], ["r3", 200_000]] as const) {
    const d = join(dir, "page", "100", b);
    mkdirSync(d, { recursive: true });
    await Bun.write(join(d, "estimates.json"), JSON.stringify({ median: { point_estimate: ns } }));
  }
  mkdirSync(join(dir, "report"), { recursive: true });
  expect(await medians(dir, ["r1", "r2", "r3"])).toEqual({ page_100_us: [100, 300, 200] });
});

test("render + marshal within 1 ms passes the derived check", () => {
  const r = build({ ...base, page_fuel_100_us: [220] }, meta, { summary: { marshal_us: 250 } }, "b9.json");
  expect(r.id).toBe("B6-first-cut");
  expect(r.summary.render_plus_marshal_us).toBe(450);
  expect(r.summary.fuel_overhead_pct).toBe(10);
  expect(r.summary.page_100_kb).toBe(25);
  expect(r.notes).toContain("→ PASS");
});

test("render + marshal over 1 ms fails the derived check", () => {
  const r = build({ ...base, page_fuel_100_us: [200] }, meta, { summary: { marshal_us: 900 } }, "b9.json");
  expect(r.notes).toContain("= 1100 µs vs ≤ 1000 µs → FAIL");
});

test("a B9 result without marshal_us is an error", () => {
  expect(() => build({ ...base, page_fuel_100_us: [200] }, meta, { summary: {} }, "b9.json")).toThrow("marshal_us");
});
