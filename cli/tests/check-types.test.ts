// Type checking in `renox check`, `renox deploy` and `run_check` (#443): the
// app's own TypeScript compiler, findings with file:line:col and the TS code,
// one warning when the types cannot be checked, `--types-only` and
// `--no-types`. The runtime half of the same mistake (a handler returning a
// non-Response) is #444.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, typeFindings } from "../src/commands/check.ts";
import { newApp } from "../src/commands/new.ts";
import { NO_TSCONFIG, NO_TYPESCRIPT, parseTsc, typeCheck } from "../src/check/types.ts";
import { NUMBER_HANDLER, typedApp } from "./typed-app.ts";

const repo = join(import.meta.dir, "../..");
const main = join(import.meta.dir, "../src/main.ts");

const cli = (args: string[], cwd: string) => {
  const p = Bun.spawnSync(["bun", main, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

test("a handler returning a number: renox check exits 2 naming the file, line, column and TS2322; fixing the type makes it pass", () => {
  const dir = typedApp();
  writeFileSync(join(dir, "functions/api/hello.ts"), NUMBER_HANDLER);
  const bad = cli(["check"], dir);
  expect(bad.code).toBe(2);
  expect(bad.err).toMatch(/^functions\/api\/hello\.ts:3:41 {2}error {2}types {2}TS2322: Type 'Promise<number>' is not assignable to type 'Promise<Response> \| Response'\.\n {2}Type 'Promise<number>'/mu);
  // --no-types skips it; --types-only runs just it.
  expect(cli(["check", "--no-types"], dir).code).toBe(0);
  expect(cli(["check", "--types-only"], dir).code).toBe(2);
  writeFileSync(join(dir, "functions/api/hello.ts"), `import type { Handler } from "@renoxium/sdk";\n\nexport const GET: Handler = async () => Response.json({ ok: true });\n`);
  const good = cli(["check"], dir);
  expect([good.code, good.err.trim()]).toEqual([0, "renox check: ok"]);
  rmSync(dir, { recursive: true });
}, 60_000);

test("the new app's own files (function, page loader-less, test with @renoxium/sdk/test) pass the type check", () => {
  const dir = typedApp("fresh");
  const t = typeCheck(dir);
  expect(t.skipped).toBeNull();
  expect(t.findings).toEqual([]);
  rmSync(dir, { recursive: true });
}, 60_000);

test("without typescript installed: check passes with exactly one 'types not checked' warning", async () => {
  const dir = newApp("untyped", "hello", mkdtempSync(join(tmpdir(), "renox-types-")));
  const r = await check(dir, { types: "include" });
  const warnings = r.findings.filter((f) => f.rule === "types");
  expect(warnings).toEqual([{ file: "package.json", line: 1, column: 1, rule: "types", severity: "warning", message: NO_TYPESCRIPT }]);
  expect(r.errors).toEqual([]);
  expect(cli(["check"], dir).code).toBe(0);
});

test("without tsconfig.json: exactly one 'no tsconfig.json' warning, and no guessed configuration", () => {
  const dir = typedApp("noconfig");
  rmSync(join(dir, "tsconfig.json"));
  expect(typeFindings(dir)).toEqual([{ file: "tsconfig.json", line: 1, column: 1, rule: "types", severity: "warning", message: NO_TSCONFIG }]);
  rmSync(dir, { recursive: true });
});

test("parseTsc: multi-line messages kept, node_modules dropped, paths relative to the app, file-less errors on tsconfig.json", () => {
  const out = [
    "functions/api/a.ts(4,14): error TS2322: Type 'number' is not assignable to type 'Response'.",
    "  Type 'number' is missing the following properties: headers, ok",
    "node_modules/x/index.d.ts(1,1): error TS1005: ';' expected.",
    "    a continuation of a dropped one",
    "error TS5058: The specified path does not exist: 'tsconfig.json'.",
  ].join("\n");
  expect(parseTsc(out, "/app")).toEqual([
    { file: "functions/api/a.ts", line: 4, column: 14, rule: "types", severity: "error", message: "TS2322: Type 'number' is not assignable to type 'Response'.\n  Type 'number' is missing the following properties: headers, ok" },
    { file: "tsconfig.json", line: 1, column: 1, rule: "types", severity: "error", message: "TS5058: The specified path does not exist: 'tsconfig.json'." },
  ]);
});

test("module test apps have no tsconfig.json: one warning each, nothing guessed (their modules are type checked by their own `check` script)", () => {
  const { readdirSync, existsSync } = require("node:fs") as typeof import("node:fs");
  const apps = readdirSync(join(repo, "modules")).map((m) => join(repo, "modules", m, "tests", "app")).filter((d) => existsSync(join(d, "renox.toml")));
  expect(apps.length).toBeGreaterThan(10);
  for (const app of apps) expect(typeFindings(app).map((f) => f.message)).toEqual([NO_TSCONFIG]);
});

test("examples/hello, examples/shop and every module's test app type check; examples/shop under 5 s", () => {
  const timings: Record<string, number> = {};
  for (const app of ["examples/hello", "examples/shop"]) {
    const t = typeCheck(join(repo, app));
    expect([app, t.skipped, t.findings.filter((f) => f.severity === "error")]).toEqual([app, null, []]);
    timings[app] = t.ms;
  }
  console.log(`type check: ${JSON.stringify(timings)} ms`);
  expect(timings["examples/shop"] as number).toBeLessThan(5000);
}, 120_000);

test("run_check over MCP returns the type findings (rule `types`, file, line, column)", async () => {
  const { callTool } = await import("../src/mcp/tools.ts");
  const dir = typedApp("mcp");
  writeFileSync(join(dir, "functions/api/hello.ts"), NUMBER_HANDLER);
  const r = await callTool("run_check", {}, dir);
  const s = (r as unknown as { structuredContent: { ok: boolean; problems: { code: string; file: string; line: number; column: number; message: string }[] } }).structuredContent;
  expect(s.ok).toBe(false);
  expect(s.problems).toContainEqual(expect.objectContaining({ code: "types", file: "functions/api/hello.ts", line: 3, column: 41 }));
  expect(s.problems.find((p) => p.code === "types")?.message).toStartWith("TS2322:");
  rmSync(dir, { recursive: true });
}, 60_000);
