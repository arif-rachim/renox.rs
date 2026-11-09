// #283: `renox check` and authorization (docs/11-authorization.md): an
// invalid policy fails with its file and line (RENOX_POLICY_INVALID, V24),
// `missing-guard` (a route that checks an action a policy names but has no
// guard), `unscoped-owned-table` (an owned table outside `db.scoped()`:
// error in module code, warning in app code), and `r-can` actions outside
// the merged action set.

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { check } from "../src/commands/check.ts";
import { lintMissingGuard, lintUnscoped, policyActions } from "../src/lib/lint.ts";
import { unknownEventHandlers } from "../src/check/app-slots.ts";
import { app, BASE, POLICY, TOML } from "./authz-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
if (worker) process.env.RENOX_WORKER_PATH = worker;

const OWNED = new Set(["app__docs"]);

test("unscoped-owned-table: module code is an error, app code a warning, a scoped Db is not flagged", () => {
  const src = `export async function list(ctx) {
  const a = await ctx.db.query("select * from app__docs where id = ?", [1]);
  const b = await ctx.db.scoped({ user_id: ctx.principal.id }).query("select * from app__docs");
  const s = ctx.db.scoped({ user_id: "u" });
  await s.execute("delete from app__docs where id = ?", [2]);
  await ctx.db.query("select * from app__docs_archive");
  return [a, b];
}`;
  const mod = lintUnscoped(src, "modules/notes/services.ts", OWNED);
  expect(mod).toHaveLength(1);
  expect(mod[0]).toMatchObject({ rule: "unscoped-owned-table", severity: "error", line: 2 });
  expect(mod[0]?.message).toContain("RENOX_DB_SCOPE");
  const appCode = lintUnscoped(src, "functions/docs.ts", OWNED);
  expect(appCode.map((f) => f.severity)).toEqual(["warning"]);
  expect(lintUnscoped(src, "functions/docs.ts", new Set())).toEqual([]);
});

test("missing-guard: a route checking an action a policy names needs a guard", () => {
  const named = policyActions(POLICY);
  expect([...named].sort()).toEqual(["doc.edit", "doc.read"]);
  const unguarded = `export async function POST(ctx) {\n  await ctx.authz.require("doc.edit", { type: "Doc", id: ctx.params.id });\n  return new Response("ok");\n}`;
  const f = lintMissingGuard(unguarded, "functions/docs/[id].ts", named);
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ rule: "missing-guard", severity: "error", line: 2 });
  // With a guard, outside pages/ and functions/, or an action no policy names: nothing.
  expect(lintMissingGuard(`export const guard = { action: "doc.edit" };\n${unguarded}`, "functions/docs/[id].ts", named)).toEqual([]);
  expect(lintMissingGuard(unguarded, "lib/docs.ts", named)).toEqual([]);
  expect(lintMissingGuard(unguarded.replace("doc.edit", "doc.export"), "functions/docs/[id].ts", named)).toEqual([]);
});

test("missing-guard: a tool's action is its guard", () => {
  const named = policyActions(`permit (principal, action == Renox::Action::"job.read", resource);`);
  const code = `export const action = "job.read";\nexport async function run(ctx) {\n  await ctx.authz.can("job.read", { type: "Job", id: "1" });\n}`;
  expect(lintMissingGuard(code, "functions/tools/t.ts", named)).toEqual([]);
  expect(lintMissingGuard(code, "functions/api/x.ts", named)).toHaveLength(1);
});

test.skipIf(!worker)("renox check: an invalid policy fails with its file and line", async () => {
  const dir = app({ ...BASE, "policies/app/docs.cedar": `${POLICY}\npermit (principal, action == Renox::Action::"doc.purge", resource);\n` });
  try {
    const { errors } = await check(dir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toMatch(/^RENOX_POLICY_INVALID: .*doc\.purge/u);
    expect(errors[0]).toMatchObject({ file: "policies/app/docs.cedar", line: 6 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!worker)("renox check: missing-guard and unscoped-owned-table on a project, and r-can actions", async () => {
  const dir = app({
    ...BASE,
    "functions/docs/edit.ts": `export async function POST(ctx) {\n  await ctx.authz.require("doc.edit");\n  await ctx.db.execute("update app__docs set title = ?", ["x"]);\n  return new Response("ok");\n}\n`,
    "pages/index.html": `<a r-can="doc.edit" href="/edit">Edit</a>\n<b r-can="doc.purge">Purge</b>\n`,
  });
  try {
    const { errors, findings } = await check(dir);
    expect(errors).toEqual([]);
    const rules = findings.map((f) => `${f.rule}:${f.severity}:${f.file}:${f.line}`).sort();
    expect(rules).toContain("missing-guard:error:functions/docs/edit.ts:2");
    expect(rules).toContain("unscoped-owned-table:warning:functions/docs/edit.ts:3");
    expect(rules).toContain("undeclared-action:error:pages/index.html:2");
    // The guarded, scoped route of BASE is clean.
    expect(findings.filter((f) => f.file === "functions/docs/[id].ts")).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #630 (artifact 1.8): the app's [[slots]], [events] and hooks.ts.
const SLOT_FILES = {
  "pages/_layouts/main.html": `<!doctype html><html><body><header><r-slot name="app.header" /></header><slot /></body></html>\n`,
  "pages/index.html": `<r-layout use="main"><h1>Docs</h1></r-layout>\n`,
  "partials/promo.html": `<aside>Promo</aside>\n`,
};
const withToml = (extra: string, files: Record<string, string> = {}) => app({ ...BASE, ...SLOT_FILES, ...files, "renox.toml": `${TOML}\n${extra}` });

test.skipIf(!worker)("renox check: a correct [[slots]], [events] and hooks.ts project has no finding about them", async () => {
  const dir = withToml(
    `[[slots]]\nname = "app.header"\ntemplate = "partials/promo.html"\nrequires = "doc.read"\n\n[events."app.doc_shared"]\npayload = { type = "object" }\n`,
    { "hooks.ts": `export const on = { "app.doc_shared": async () => {} };\n` },
  );
  try {
    const { errors, findings } = await check(dir, { types: "skip" });
    expect(errors).toEqual([]);
    expect(findings.filter((f) => f.file === "renox.toml" || f.file === "hooks.ts")).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!worker)("renox check: a filler whose template is missing, and a requires outside [authz] actions, are errors", async () => {
  const missing = withToml(`[[slots]]\nname = "app.header"\ntemplate = "partials/nope.html"\n`);
  const requires = withToml(`[[slots]]\nname = "app.header"\ntemplate = "partials/promo.html"\nrequires = "doc.purge"\n`);
  try {
    const a = await check(missing, { types: "skip" });
    expect(a.errors.map((e) => e.message).join("\n")).toContain("partials/nope.html does not exist");
    const b = await check(requires, { types: "skip" });
    expect(b.errors.map((e) => e.message).join("\n")).toContain('requires "doc.purge" is not in [authz] actions');
  } finally {
    for (const d of [missing, requires]) rmSync(d, { recursive: true, force: true });
  }
});

test.skipIf(!worker)("renox check: a slot nobody renders is a warning only", async () => {
  const dir = withToml(`[[slots]]\nname = "app.sidebar"\ntemplate = "partials/promo.html"\n`);
  try {
    const { errors, findings } = await check(dir, { types: "skip" });
    expect(errors).toEqual([]);
    const f = findings.filter((x) => x.rule === "unrendered-slot");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "warning", file: "renox.toml" });
    expect(f[0]?.message).toContain("no installed module renders slot app.sidebar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!worker)("renox check: an event key without app. is an error", async () => {
  const dir = withToml(`[events."job.done"]\npayload = { type = "object" }\n`);
  try {
    const { errors } = await check(dir, { types: "skip" });
    expect(errors.map((e) => e.message).join("\n")).toContain('events."job.done"');
    expect(errors[0]).toMatchObject({ file: "renox.toml" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hooks.ts: handled events of a module that is not installed are warnings; app.* are fine", () => {
  const src = `export const on = {\n  "app.x": async () => {},\n  "billing.paid": async () => {},\n  "auth.user_registered": async () => {},\n};\n// "ghost.event": nope\n`;
  const f = unknownEventHandlers("hooks.ts", src, new Set(["auth"]));
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ rule: "app-hooks", severity: "warning", file: "hooks.ts", line: 3 });
  expect(f[0]?.message).toContain("module billing is not installed");
});
