// `renox check` lints: SQL interpolation (docs/24-threat-model.md, SQL
// injection row; docs/12-developer-experience.md "renox check") and
// undeclared fetch hosts.
import { expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lintFetch, lintGlobalState, lintSql } from "../src/lib/lint.ts";

test("template interpolation and concatenation in SQL are errors", () => {
  const src = [
    "await db.query(`select ${x}`);",
    'await ctx.db.queryOne("select * from t where a = " + a);',
    "await tx.execute(`update t set a = 1 where id = ${id}`, []);",
    'await db.query("select 1".concat(x));',
  ].join("\n");
  const f = lintSql(src, "f.ts");
  expect(f.map((x) => [x.line, x.rule, x.severity])).toEqual([
    [1, "sql-interpolation", "error"],
    [2, "sql-interpolation", "error"],
    [3, "sql-interpolation", "error"],
    [4, "sql-interpolation", "error"],
  ]);
});

test("parameterised SQL, plain templates, comments, and strings are not flagged", () => {
  const src = [
    'await db.query("select * from t where a = ?", [a + 1]);',
    "await db.query(`select * from t where a = ?`, [`x${y}`]);",
    "// db.query(`select ${x}`)",
    'const s = "db.query(`select ${x}`)";',
    "await other.query(`select ${x}`);",
    "await db.query(SQL, [x]);",
    'await db.query("select a " + "from t " + `where b = ?`, [b]);',
  ].join("\n");
  expect(lintSql(src, "f.ts")).toEqual([]);
});

test("literal fetch URLs to undeclared hosts are warnings", () => {
  const src = [
    'await fetch("https://api.example.com/x");',
    'await fetch("https://a.cdn.example.net/x");',
    'await fetch("https://evil.test/x");',
    'await fetch("http://api.example.com/x");',
    "await fetch(`https://${host}/x`);",
    'await ctx.fetch("https://other.test/");',
  ].join("\n");
  const f = lintFetch(src, "f.ts", ["api.example.com", "*.cdn.example.net"]);
  expect(f.map((x) => [x.line, x.severity])).toEqual([
    [3, "warning"],
    [4, "warning"],
    [6, "warning"],
  ]);
});

/**
 * docs/23-failure-modes.md, "Handler writes to global scope" (`renox check`
 * lint, lint fixture); docs/16-risks.md, "Global state leaking between
 * requests". Every line marked `// FLAG` in the fixture is one finding.
 */
test("global-state: globalThis writes and module-level let/var writes inside functions are errors", () => {
  const file = "tests/fixtures/lint-global/flagged.ts";
  const src = readFileSync(join(import.meta.dir, "fixtures/lint-global/flagged.ts"), "utf8");
  const expected = src
    .split("\n")
    .flatMap((l, i) => (l.includes("// FLAG") ? [i + 1] : []));
  const f = lintGlobalState(src, file);
  expect(f.map((x) => x.line)).toEqual(expected);
  expect(new Set(f.map((x) => `${x.rule} ${x.severity}`))).toEqual(new Set(["global-state error"]));
  expect(f.map((x) => x.message.split(":")[0])).toMatchSnapshot();
});

test("global-state: reads, shadowing, parameters, top-level init, strings, comments, and renox-allow-global are not flagged", () => {
  const src = readFileSync(join(import.meta.dir, "fixtures/lint-global/clean.ts"), "utf8");
  expect(lintGlobalState(src, "clean.ts")).toEqual([]);
});
