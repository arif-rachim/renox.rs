// `renox check` lints: SQL interpolation (docs/24-threat-model.md, SQL
// injection row; docs/12-developer-experience.md "renox check") and
// undeclared fetch hosts.
import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lintBody, lintFetch, lintGlobalState, lintRedirect, lintSql } from "../src/lib/lint.ts";

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

/**
 * docs/24-threat-model.md, "Open redirect via `next`/`return_to`" (#111):
 * a redirect to a target taken from the request, directly or through a
 * variable, is an error. Every line marked `// FLAG` is one finding.
 */
test("no-unsafe-redirect: redirects to request input are errors with file and line", () => {
  const file = "functions/api/redirect.ts";
  const src = readFileSync(join(import.meta.dir, "fixtures/lint-redirect/flagged.ts"), "utf8");
  const expected = src.split("\n").flatMap((l, i) => (l.includes("// FLAG") ? [i + 1] : []));
  const f = lintRedirect(src, file);
  expect(f.map((x) => x.line)).toEqual(expected);
  expect(new Set(f.map((x) => `${x.file} ${x.rule} ${x.severity}`))).toEqual(new Set([`${file} no-unsafe-redirect error`]));
});

test("no-unsafe-redirect: redirect.safe, safeRedirectTarget, constants, strings, and comments are not flagged", () => {
  const src = readFileSync(join(import.meta.dir, "fixtures/lint-redirect/clean.ts"), "utf8");
  expect(lintRedirect(src, "clean.ts")).toEqual([]);
});

// docs/24-threat-model.md A, "Input validation" (#275 item 6): a body read
// with req.json() or req.formData() and used without validate() or a schema
// parse is a warning (not an error in this phase).
test("unvalidated-body: req.json() and req.formData() used without validation are warnings", () => {
  const file = "functions/api/notes.ts";
  const src = readFileSync(join(import.meta.dir, "fixtures/lint-body/flagged.ts"), "utf8");
  const expected = src.split("\n").flatMap((l, i) => (l.includes("// FLAG") ? [i + 1] : []));
  const f = lintBody(src, file);
  expect(f.map((x) => x.line)).toEqual(expected);
  expect(new Set(f.map((x) => `${x.file} ${x.rule} ${x.severity}`))).toEqual(new Set([`${file} unvalidated-body warning`]));
  expect(f[0]?.message).toContain("validate(schema, value)");
});

test("unvalidated-body: validate(schema, req), a validated name, a body inside validate(), and other .json() calls are not flagged", () => {
  const src = readFileSync(join(import.meta.dir, "fixtures/lint-body/clean.ts"), "utf8");
  expect(lintBody(src, "clean.ts")).toEqual([]);
});

test("unvalidated-body: a body assigned to a name declared earlier and then validated is not flagged", () => {
  const src = `export async function POST({ req }) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("bad", { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  return Response.json(parsed);
}
export async function PUT({ req }) {
  let raw: unknown;
  raw = await req.json();
  return Response.json(raw);
}`;
  const f = lintBody(src, "functions/api/cart.ts");
  expect(f.map((x) => x.line)).toEqual([13]);
});

// #336: catalog completeness (renox check's i18n-missing-key).
import { mkdirSync as mkdirP, mkdtempSync as tempDir, readdirSync as dirList, writeFileSync as writeText } from "node:fs";
import { tmpdir as osTmp } from "node:os";
import { join as pathJoin } from "node:path";

import { lintCatalogs } from "../src/lib/lint.ts";

describe("i18n-missing-key (#336)", () => {
  test("a key in one locale and not another, and a template key no locale has, are errors; _meta is not text", () => {
    const d = tempDir(pathJoin(osTmp(), "catalogs-"));
    mkdirP(pathJoin(d, "i18n"));
    mkdirP(pathJoin(d, "pages"));
    writeText(pathJoin(d, "i18n/en.json"), JSON.stringify({ shop: { title: "Shop", cart: { empty: "Empty" } } }));
    writeText(pathJoin(d, "i18n/ar.json"), JSON.stringify({ _meta: { status: "reviewed" }, shop: { title: "المتجر" } }));
    writeText(pathJoin(d, "pages/index.html"), '<h1><r-t key="shop.title" /></h1>\n<p><r-t key="shop.missing" /></p>\n');
    const f = lintCatalogs(d, "app");
    expect(f.map((x) => [x.file, x.line, x.message])).toEqual([
      ["app/i18n/ar.json", 1, "\"shop.cart.empty\" is in another locale's catalog but not in ar"],
      ["app/pages/index.html", 2, '<r-t key="shop.missing"> has no ar translation'],
      ["app/pages/index.html", 2, '<r-t key="shop.missing"> has no en translation'],
    ]);
    expect(f.every((x) => x.rule === "i18n-missing-key" && x.severity === "error")).toBe(true);
  });

  test("a tree without catalogs declares no locale", () => {
    expect(lintCatalogs(tempDir(pathJoin(osTmp(), "no-catalogs-")))).toEqual([]);
  });

  test("the repository: every module, the examples and the dashboard are complete in en and ar", () => {
    const root = pathJoin(import.meta.dir, "../..");
    const trees = [...dirList(pathJoin(root, "modules")).map((m) => `modules/${m}`), "examples/shop", "examples/chat", "control/dashboard", "www"];
    const findings = trees.flatMap((t) => lintCatalogs(pathJoin(root, t), t));
    expect(findings.map((f) => `${f.file}:${f.line} ${f.message}`)).toEqual([]);
  });
});
