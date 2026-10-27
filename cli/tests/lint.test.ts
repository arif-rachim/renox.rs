// `renox check` lints: SQL interpolation (docs/24-threat-model.md, SQL
// injection row; docs/12-developer-experience.md "renox check") and
// undeclared fetch hosts.
import { expect, test } from "bun:test";

import { lintFetch, lintSql } from "../src/lib/lint.ts";

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
