// SQL lint for control/api (#275 item 5; docs/24-threat-model.md E, "SQL
// injection in the control plane"): every statement under src/ is a string
// literal with $n parameters. A call to `query`, `queryOne`, `exec`,
// `execute`, or `sql` whose SQL argument is a template literal with `${…}`
// or a `+` concatenation is a finding, unless sql-lint-allow.json lists it
// (file and a substring of the SQL argument) with the reason it is safe
// (constant fragments only).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

interface Finding {
  file: string;
  line: number;
  /** The SQL argument, whitespace collapsed. */
  sql: string;
}

const CALL = /(?:\.|\b)(query|queryOne|exec|execute|sql)\s*(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\s*\(/gu;

/** The first argument of the call whose `(` is at `open`: up to the first `,` or `)` at depth 0. */
function firstArgument(src: string, open: number): string {
  let depth = 0;
  let i = open + 1;
  const start = i;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === '"' || ch === "'") {
      i = skipString(src, i, ch);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) break;
    i++;
  }
  return src.slice(start, i);
}

function skipString(src: string, i: number, quote: string): number {
  i++;
  while (i < src.length && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
  return i + 1;
}

function skipTemplate(src: string, i: number): number {
  i++;
  while (i < src.length && src[i] !== "`") {
    if (src[i] === "\\") i += 2;
    else if (src[i] === "$" && src[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        const ch = src[i] as string;
        if (ch === "`") i = skipTemplate(src, i);
        else if (ch === '"' || ch === "'") i = skipString(src, i, ch);
        else {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          i++;
        }
      }
    } else i++;
  }
  return i + 1;
}

/** True when `arg` builds a string: a template literal with a substitution, or a top-level `+`. */
function builtString(arg: string): boolean {
  let i = 0;
  let depth = 0;
  while (i < arg.length) {
    const ch = arg[i] as string;
    if (ch === '"' || ch === "'") {
      i = skipString(arg, i, ch);
      continue;
    }
    if (ch === "`") {
      const end = skipTemplate(arg, i);
      if (/\$\{/u.test(arg.slice(i, end))) return true;
      i = end;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "+" && depth === 0 && arg[i + 1] !== "+" && arg[i - 1] !== "+") return true;
    i++;
  }
  return false;
}

/** The findings of one source text. */
export function lintSql(file: string, src: string): Finding[] {
  const out: Finding[] = [];
  for (const m of src.matchAll(CALL)) {
    const open = (m.index as number) + m[0].length - 1;
    const arg = firstArgument(src, open);
    if (!builtString(arg)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ file, line, sql: arg.replace(/\s+/gu, " ").trim() });
  }
  return out;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

interface Allow {
  file: string;
  contains: string;
  reason: string;
}

const allow = (JSON.parse(readFileSync(join(ROOT, "sql-lint-allow.json"), "utf8")) as { allow: Allow[] }).allow;
const allowed = (f: Finding): Allow | undefined => allow.find((a) => a.file === f.file && f.sql.includes(a.contains));

describe("control/api SQL lint", () => {
  test("no string-built SQL in src/ outside the reviewed allowlist", () => {
    const findings: Finding[] = [];
    for (const path of sources(join(ROOT, "src"))) findings.push(...lintSql(relative(ROOT, path), readFileSync(path, "utf8")));
    const unreviewed = findings.filter((f) => allowed(f) === undefined).map((f) => `${f.file}:${f.line}: ${f.sql}`);
    expect(unreviewed).toEqual([]);
    // Every allowlist entry still matches a call and says why it is safe: no stale exceptions.
    for (const a of allow) {
      expect([a.file, a.contains, findings.some((f) => allowed(f) === a)]).toEqual([a.file, a.contains, true]);
      expect(a.reason.length).toBeGreaterThan(10);
    }
  });

  test("a fixture with interpolation or concatenation fails; parameters and constant strings pass", () => {
    const flagged = [
      "await db.query(`select * from apps where name = '${name}'`, []);",
      "await deps.db.query<{ id: string }>(`delete from tokens where id = ${id}`);",
      'await tx.exec("drop table " + table);',
      "await db.queryOne(\n  `select ${col}\n   from users`,\n  [],\n);",
      "const r = sql(`select ${x}`);",
    ];
    for (const src of flagged) expect([src, lintSql("fixture.ts", src).length]).toEqual([src, 1]);
    const clean = [
      'await db.query("select * from apps where name = $1", [name]);',
      "await db.query(`select * from apps\n where name = $1`, [name]);",
      'await db.query("update secret_sets set version = version + 1 where id = $1", [id]);',
      "await db.exec(file.sql);",
      "const m = /^x$/u.exec(text + suffix);".replace("text + suffix", "text"),
      "await db.query(sql, params);",
      "await db.query(\"select 1\", [a + b]);",
    ];
    for (const src of clean) expect([src, lintSql("fixture.ts", src)]).toEqual([src, []]);
  });
});
