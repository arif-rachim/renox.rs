// Every CLI failure a tenant developer can cause gives one message (file,
// line, what to do) and the documented exit code (cli/README.md, "Exit
// codes"). docs/23-failure-modes.md section 3, rows "Syntax error, missing
// renox.toml, bad route file name". The messages are snapshotted
// (__snapshots__/messages.test.ts.snap).
//
// Fixtures are written at test time: two files that differ only in case
// cannot be committed (a macOS or Windows checkout would break).
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { EXIT } from "../../src/errors.ts";
import { app, HEALTH, renox, VALID_TOML } from "./helpers.ts";

const dirs: string[] = [];
const make = (files: Record<string, string>): string => {
  const d = app(files);
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Case {
  name: string;
  files: Record<string, string>;
  args: string[];
  exit: number;
  /** A fragment the message must contain (besides the snapshot). */
  says: string;
}

const base = { "renox.toml": VALID_TOML, "functions/api/health.ts": HEALTH };

const CASES: Case[] = [
  // renox.toml
  { name: "missing renox.toml", files: { "functions/api/health.ts": HEALTH }, args: ["build"], exit: EXIT.USER, says: "renox.toml: not found" },
  { name: "missing renox.toml (check)", files: { "functions/api/health.ts": HEALTH }, args: ["check"], exit: EXIT.USER, says: "renox new" },
  {
    name: "invalid TOML",
    files: { ...base, "renox.toml": '[app]\nname = "neg"\ntimezone = "Asia/Dubai"\n\n[permissions\nnetwork = []\n' },
    args: ["build"],
    exit: EXIT.VALIDATION,
    says: "renox.toml:5: invalid TOML",
  },
  {
    name: "unknown table",
    files: { ...base, "renox.toml": `${VALID_TOML}\n[limit]\ncpu_ms = 10\n` },
    args: ["build"],
    exit: EXIT.VALIDATION,
    says: "did you mean [limits]?",
  },
  {
    name: "unknown key",
    files: { ...base, "renox.toml": '[app]\nname = "neg"\ntimezone = "Asia/Dubai"\nregion = "me"\n\n[permissions]\nnetwrok = []\n' },
    args: ["build"],
    exit: EXIT.VALIDATION,
    says: 'renox.toml:4: unknown key "region" in [app]',
  },
  {
    name: "bad timezone",
    files: { ...base, "renox.toml": '[app]\nname = "neg"\ntimezone = "Asia/Atlantis"\n' },
    args: ["build"],
    exit: EXIT.VALIDATION,
    says: 'renox.toml:3: app.timezone: unknown time zone "Asia/Atlantis"',
  },
  {
    name: "schema error",
    files: { ...base, "renox.toml": '[app]\nname = "Neg App"\ntimezone = "UTC"\n\n[limits]\ncpu_ms = 9000\n' },
    args: ["check"],
    exit: EXIT.VALIDATION,
    says: "renox.toml:2",
  },
  // TypeScript syntax errors: file:line:col from the transpiler.
  {
    name: "syntax error in a route",
    files: { ...base, "functions/api/bad.ts": "export const GET = () => {\n  return Response.json({ a: 1 +  });\n};\n" },
    args: ["build"],
    exit: EXIT.VALIDATION,
    says: "functions/api/bad.ts:2:",
  },
  {
    name: "syntax error in an imported file",
    files: {
      ...base,
      "functions/api/uses.ts": 'import { f } from "../../lib/f.ts";\nexport const GET = () => Response.json(f());\n',
      "lib/f.ts": "export function f() {\n  return [1, 2;\n}\n",
    },
    args: ["build"],
    exit: EXIT.VALIDATION,
    says: "lib/f.ts:2:",
  },
  {
    name: "two syntax errors",
    files: { ...base, "functions/api/a.ts": "export const GET = () => (;\n", "functions/api/b.ts": "export const GET = ) => 1;\n" },
    args: ["check"],
    exit: EXIT.VALIDATION,
    says: "functions/api/b.ts:1:",
  },
  // Route file names.
  { name: "unclosed bracket", files: { ...base, "functions/api/[id.ts": HEALTH }, args: ["check"], exit: EXIT.VALIDATION, says: "functions/api/[id.ts" },
  { name: "space in a name", files: { ...base, "functions/api/my notes.ts": HEALTH }, args: ["check"], exit: EXIT.VALIDATION, says: "contains a space" },
  { name: "uppercase parameter", files: { ...base, "functions/api/[Id].ts": HEALTH }, args: ["check"], exit: EXIT.VALIDATION, says: "must be lowercase ([id])" },
  {
    name: "files differing only in case",
    files: { ...base, "functions/About.ts": HEALTH, "functions/about.ts": HEALTH },
    args: ["check"],
    exit: EXIT.VALIDATION,
    says: "functions/about.ts  error  differs only in case from functions/About.ts",
  },
  {
    name: "folders differing only in case",
    files: { ...base, "functions/Api/x.ts": HEALTH, "functions/api/y.ts": HEALTH },
    args: ["build"],
    exit: EXIT.VALIDATION,
    says: "functions/api: differs only in case from functions/Api",
  },
  {
    name: "two files for one route",
    files: { ...base, "functions/a.ts": HEALTH, "functions/a/index.ts": "export const POST = () => new Response(null);\n" },
    args: ["check"],
    exit: EXIT.VALIDATION,
    says: "functions/a/index.ts  error  maps to /a, as functions/a.ts does",
  },
  {
    name: "several route problems at once",
    files: { ...base, "functions/[x.ts": HEALTH, "functions/b c.ts": HEALTH },
    args: ["check"],
    exit: EXIT.VALIDATION,
    says: "2 route file problems",
  },
  // Usage.
  { name: "unknown command", files: base, args: ["deploy-now"], exit: EXIT.USER, says: 'unknown command "deploy-now"' },
  { name: "unknown build flag", files: base, args: ["build", "--fast"], exit: EXIT.USER, says: "usage: renox build" },
  { name: "build --out without a folder", files: base, args: ["build", "--out"], exit: EXIT.USER, says: "usage: renox build" },
  { name: "dev with a bad port", files: base, args: ["dev", "--port", "70000"], exit: EXIT.USER, says: "usage: renox dev" },
  { name: "new with a bad name", files: {}, args: ["new", "My App"], exit: EXIT.USER, says: "use lowercase letters" },
  { name: "new into a folder that is not empty", files: { "taken/x": "" }, args: ["new", "taken"], exit: EXIT.USER, says: "exists and is not empty" },
  { name: "new with an unknown template", files: {}, args: ["new", "x", "--template", "react"], exit: EXIT.USER, says: "--template blank" },
  // Environment.
  {
    name: "RENOX_WORKER_PATH that does not exist",
    files: base,
    args: ["dev", "--port", "1"],
    exit: EXIT.ENVIRONMENT,
    says: "RENOX_WORKER_PATH is /nonexistent/renox-worker, which does not exist",
  },
];

describe("messages and exit codes", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const dir = make(c.files);
      const env = c.name.startsWith("RENOX_WORKER_PATH") ? { RENOX_WORKER_PATH: "/nonexistent/renox-worker" } : {};
      const r = renox(dir, c.args, env);
      expect(r.stderr).toContain(c.says);
      expect(r.exitCode).toBe(c.exit);
      expect({ exit: r.exitCode, stderr: r.stderr.trim() }).toMatchSnapshot();
    });
  }

  test("a valid app checks and builds with exit 0", () => {
    const dir = make(base);
    expect(renox(dir, ["check"]).exitCode).toBe(EXIT.OK);
    expect(renox(dir, ["build"]).exitCode).toBe(EXIT.OK);
    expect(renox(dir, ["--help"])).toMatchObject({ exitCode: EXIT.OK });
  });

  test("check errors are exit 2; warnings alone are exit 0", () => {
    const sql = make({ ...base, "functions/api/q.ts": "export const GET = async ({ db, url }) => Response.json(await db.query(`select ${url.search}`));\n" });
    expect(renox(sql, ["check"]).exitCode).toBe(EXIT.VALIDATION);
    const warn = make({ ...base, "functions/api/f.ts": 'export const GET = () => fetch("https://undeclared.example/");\n' });
    const r = renox(warn, ["check"]);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stderr).toContain("1 warning(s)");
  });
});
