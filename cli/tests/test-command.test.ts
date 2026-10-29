// #238: `renox test` runs an app's tests/*.test.ts on the embedded worker
// with `renox/test`: a fixture module with one service, one page and two
// roles has unit, snapshot-per-role, install/upgrade and policy-case tests.

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addModule } from "../src/commands/add.ts";
import { runTests } from "../src/commands/test.ts";
import { treeHash } from "../src/lib/modules/resolve.ts";
import { write } from "./shop-auth-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
const repo = join(import.meta.dir, "../..");

const notesModule = (version: string, withList: boolean): Record<string, string> => ({
  "module.toml": `[module]
name = "notes"
version = "${version}"

[permissions]
tables = "notes__*"

[exports.services]
add = "Add a note"
${withList ? 'list = "All notes"\n' : ""}`,
  "services.ts": `export async function add(ctx, text) {
  await ctx.db.execute("insert into notes__notes (text) values (?)", [text]);
  return { added: text };
}
${withList ? `export async function list(ctx) {
  return ctx.db.query("select text from notes__notes order by rowid");
}
` : ""}`,
  "pages/index.ts": `export async function load(ctx) {
  const row = await ctx.db.queryOne("select role from notes__roles where session = ?", [ctx.session.id]);
  const notes = await ctx.db.query("select text from notes__notes order by rowid");
  return { role: row?.role ?? "viewer", notes };
}
export const actions = {
  async become({ db, form, session }) {
    await db.execute("insert or replace into notes__roles (session, role) values (?, ?)", [session.id, form.get("role")]);
    return {};
  },
};
`,
  "pages/index.html": `<main><h1>Notes</h1><p id="role">{{ role }}</p><p r-if="role == 'admin'" id="admin">Admin panel</p><ul><li r-for="n in notes">{{ n.text }}</li></ul></main>\n`,
  "migrations/001_init.sql": "create table notes__notes (text text not null);\ncreate table notes__roles (session text primary key, role text not null);\n",
});

const TEST_TS = `import { expect, test } from "bun:test";
import { app, installModule, policyCases, snapshot } from "renox/test";

const t = await app();

test("a service call goes through the broker", async () => {
  expect(await t.service("notes").add("hello")).toEqual({ added: "hello" });
  expect(await t.service("notes").list()).toEqual([{ text: "hello" }]);
  expect(t.db.query("select text from notes__notes")).toEqual([{ text: "hello" }]);
  expect(await t.request("GET", "/api/notes").then((r) => r.json())).toEqual([{ text: "hello" }]);
});

test("a page per role, snapshotted", async () => {
  const r = await t.as("bob").action("/notes", "become", { role: "admin" });
  expect(r.status).toBe(200);
  const viewer = await t.as("alice").page("/notes");
  expect(viewer.html).not.toContain("Admin panel");
  snapshot(viewer.html, { role: "viewer" });
  const admin = await t.as("bob").page("/notes");
  expect(admin.html).toContain("Admin panel");
  snapshot(admin.html, { role: "admin" });
});

test("install, then an upgrade that breaks the app's contract", async () => {
  const v1 = await installModule("notes", "path:fixtures/notes-v1");
  expect(v1.check.errors).toEqual([]);
  expect(v1.migrate?.modules.map((m) => [m.module, m.applied])).toEqual([["notes", ["001_init.sql"]], ["app", []]]);
  const v2 = await v1.upgrade("path:fixtures/notes-v2");
  expect(v2.check.errors.map((e) => e.message)).toContain("MF7: the app calls notes.list, which notes 2.0.0 does not export");
});

policyCases();
`;

async function fixtureApp(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "renox-test-cmd-"));
  write(dir, {
    "renox.toml": `[app]\nname = "notesapp"\ntimezone = "Asia/Dubai"\n`,
    "functions/api/notes.ts": `import { notes } from "renox:modules";\nexport async function GET() { return Response.json(await notes.list()); }\n`,
    "tests/notes.test.ts": TEST_TS,
    "policies/tests/notes.json": JSON.stringify([{ principal: { type: "User", id: "alice", roles: ["viewer"] }, action: "notes.delete", resource: { type: "Note" }, expected: "deny" }]),
  });
  write(join(dir, "modules/notes"), notesModule("1.0.0", true));
  write(join(dir, "fixtures/notes-v1"), notesModule("1.0.0", true));
  write(join(dir, "fixtures/notes-v2"), notesModule("2.0.0", false));
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(join(repo, "sdk"), join(dir, "node_modules/renox"));
  const log = console.log;
  console.log = () => {};
  try {
    expect(await addModule(dir, "notes", { source: "path:modules/notes", mount: "/notes", yes: true }, async () => true)).toBe(0);
  } finally {
    console.log = log;
  }
  return dir;
}

test.skipIf(!worker)(
  "renox test: unit, snapshot per role, install/upgrade, policy cases (pending)",
  async () => {
    const dir = await fixtureApp();
    const first = await runTests(dir, ["-u"], "pipe");
    expect(first.out).toContain("3 pass");
    expect(first.code).toBe(0);
    // Second run: the snapshots match, the policy case is still pending (F5).
    const second = await runTests(dir, [], "pipe");
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain("3 pass");
    expect(second.out).toContain("1 todo");
    expect(second.out).not.toContain("snapshots: +");
  },
  120_000,
);

test.skipIf(!worker)(
  "a failing test is exit code 2",
  async () => {
    const dir = await fixtureApp();
    write(dir, { "tests/fail.test.ts": `import { expect, test } from "bun:test";\ntest("fails", () => expect(1).toBe(2));\n` });
    const r = await runTests(dir, ["tests/fail.test.ts"], "pipe");
    expect(r.code).toBe(2);
  },
  120_000,
);

test.skipIf(!worker)(
  "in a module folder, renox test leaves the module tree as it was (its hash is in apps' locks, MF12)",
  async () => {
    const gcc = join(repo, "modules/gcc");
    const before = treeHash(gcc);
    const r = await runTests(gcc, ["tests/validators.test.ts"], "pipe");
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(gcc, ".renox"))).toBe(false);
    expect(treeHash(gcc)).toBe(before);
  },
  120_000,
);
