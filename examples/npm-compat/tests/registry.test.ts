import { expect, test } from "bun:test";
import pkg from "../package.json";
import { checks } from "../checks/_registry.ts";
import { runOne } from "../checks/_run.ts";
import { GET } from "../functions/api/check.ts";

test("versions are exact pins and match the registry", () => {
  const deps: Record<string, string> = pkg.dependencies;
  for (const [name, version] of Object.entries(deps)) {
    expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
  }
  for (const entry of checks.filter((c) => c.kind === "official")) {
    const names = entry.package.split("+");
    const versions = entry.version.split("+");
    names.forEach((name, i) => expect(deps[name], name).toBe(versions[i]));
  }
});

test("a failing check is reported, not thrown", async () => {
  const r = await runOne({ package: "x", version: "0", kind: "built-in", run: async () => { throw new Error("boom"); } });
  expect(r).toMatchObject({ ok: false, error: "Error: boom" });
});

test("a hanging check times out", async () => {
  const r = await runOne({ package: "x", version: "0", kind: "built-in", run: () => new Promise(() => {}) }, 50);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("timed out after 50 ms");
});

test("GET /api/check returns one passing result per package", async () => {
  const res = await GET({ req: new Request("http://localhost/api/check") });
  const body = (await res.json()) as { results: { package: string; ok: boolean; error?: string; ms: number }[] };
  expect(body.results.map((r) => r.package)).toEqual(checks.map((c) => c.package));
  for (const r of body.results) {
    expect(r.ok, `${r.package}: ${r.error}`).toBe(true);
    expect(r.ms).toBeLessThan(2000);
  }
});
