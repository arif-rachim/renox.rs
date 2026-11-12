// #238: `renox test` runs an app's tests/*.test.ts on the embedded worker
// with `@renoxium/sdk/test`: a fixture module with one service, one page and two
// roles has unit, snapshot-per-role, install/upgrade and policy-case tests.

import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

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
import { app, installModule, policyCases, snapshot } from "@renoxium/sdk/test";

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
  mkdirSync(join(dir, "node_modules/@renoxium"), { recursive: true });
  symlinkSync(join(repo, "sdk"), join(dir, "node_modules/@renoxium/sdk"));
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
  "renox test: unit, snapshot per role, install/upgrade, policy cases",
  async () => {
    const dir = await fixtureApp();
    const first = await runTests(dir, ["-u"], "pipe");
    expect(first.out).toContain("4 pass");
    expect(first.code).toBe(0);
    // Second run: the snapshots match; the policy case is evaluated (#283),
    // by `renox test` itself and as a test of the file that calls policyCases().
    const second = await runTests(dir, [], "pipe");
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain("4 pass");
    expect(second.out).toContain("(pass) policy policies/tests/notes.json");
    expect(second.out).not.toContain("snapshots: +");
  },
  120_000,
);

// #593: `t.job` and `t.tool`. The fixture gains two jobs (one writes a row,
// one throws), a `confirm` tool, the auth module (the agent tokens) and a
// policy that lets a user whose email is verified call the tool.
const HELPERS_TS = `import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { app } from "@renoxium/sdk/test";

const t = await app();
const PASSWORD = "correct horse battery";

async function user(name) {
  const u = t.as(name);
  expect((await u.action("/auth/register", "default", { email: name + "@example.com", password: PASSWORD, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: name + "@example.com", password: PASSWORD })).status).toBe(303);
  return u;
}

/** A connection of the test's own on the tenant file, waiting on the worker's lock as the harness's does. */
function own() {
  const db = new Database(t.dbFile);
  db.exec("pragma busy_timeout = 5000");
  return db;
}

test("t.job runs the job once and resolves after its commit", async () => {
  await t.job("ping");
  expect(t.db.query("select count(*) as n from app__pings")).toEqual([{ n: 1 }]);
  expect(t.db.query("select count(*) as n from renox__outbox where name = 'job:ping'")).toEqual([{ n: 0 }]);
  // The test writes through its own connection while the outbox drains the second run.
  const db = own();
  const writes = (async () => {
    for (let i = 0; i < 40; i++) {
      db.query("insert into app__marks (n) values (?)").run(i);
      await Bun.sleep(2);
    }
  })();
  try {
    await Promise.all([t.job("ping"), writes]);
  } finally {
    db.close();
  }
  expect(t.db.query("select count(*) as n from app__pings")).toEqual([{ n: 2 }]);
  expect(t.db.query("select count(*) as n from app__marks")).toEqual([{ n: 40 }]);
  // A job that throws: t.job rejects with its error text.
  await expect(t.job("boom")).rejects.toThrow("boom: the job failed");
  await expect(t.job("nope")).rejects.toThrow("no scheduled job nope in the app");
});

test("t.job with a payload is a queued run: the job sees the payload, once per call", async () => {
  await t.job("queued", { payload: { n: 7 } });
  await t.job("queued", { payload: { n: 8 } });
  await t.job("queued", { payload: { n: 7 } });
  expect(t.db.query("select n, raw from app__queued order by rowid")).toEqual([{ n: 7, raw: '{"n":7}' }, { n: 8, raw: '{"n":8}' }, { n: 7, raw: '{"n":7}' }]);
  expect(t.db.query("select count(*) as n from renox__outbox where name = 'job:queued'")).toEqual([{ n: 0 }]);
  // A scheduled tick of the same job still has a null payload.
  await t.job("queued");
  expect(t.db.query("select count(*) as n from app__queued where n is null")).toEqual([{ n: 1 }]);
});

test("t.tool: preview then confirmed call; a token of another user is scoped", async () => {
  const alice = await user("alice");
  const bob = await user("bob");
  // The policy lets a verified user call echo: alice is, bob is not.
  const db = own();
  try {
    db.query("update auth__users set email_verified_at = ? where email = 'alice@example.com'").run(Date.now());
  } finally {
    db.close();
  }
  const preview = await t.tool("echo", { x: 1 }, { as: alice });
  expect(preview.ok).toBe(true);
  expect(preview.preview).toEqual({ echo: { x: 1 }, preview: true });
  expect(typeof preview.confirmation?.token).toBe("string");
  expect(preview.confirmation?.expires_at).toBeGreaterThan(Date.now());
  // The preview is rolled back.
  expect(t.db.query("select count(*) as n from app__echoes")).toEqual([{ n: 0 }]);

  const done = await t.tool("echo", { x: 1 }, { as: alice, confirm: true });
  expect(done).toEqual({ ok: true, result: { echo: { x: 1 }, preview: false } });
  expect(t.db.query("select u.email from app__echoes e join auth__users u on u.id = e.user_id")).toEqual([{ email: "alice@example.com" }]);

  // Bob's token is his: the action is refused for him, nothing is written.
  const denied = await bob.tool("echo", { x: 2 }, { confirm: true });
  expect(denied.ok).toBe(false);
  expect(denied.error?.code).toBe("RENOX_FORBIDDEN");
  // A token narrowed to another tool.
  const narrow = await t.tool("echo", { x: 3 }, { as: alice, scope: "tools:other" });
  expect(narrow).toMatchObject({ ok: false, error: { code: "RENOX_TOOL_SCOPE" } });
  expect(t.db.query("select count(*) as n from app__echoes")).toEqual([{ n: 1 }]);
});
`;

const ECHO_TS = `import { tool } from "@renoxium/sdk";

const json = { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false };
const input = {
  "~standard": {
    version: 1,
    vendor: "fixture",
    validate: (v) => (typeof v === "object" && v !== null && Number.isInteger(v.x) ? { value: { x: v.x } } : { issues: [{ message: "x is an integer", path: ["x"] }] }),
    jsonSchema: { input: () => json },
  },
};

export default tool({
  name: "echo",
  description: "Echo the input back, and record who called",
  input,
  action: "echo.call",
  confirm: true,
  async run(ctx) {
    await ctx.db.execute("insert into app__echoes (user_id, x) values (?, ?)", [ctx.principal.id, ctx.tool.input.x]);
    return { echo: ctx.tool.input, preview: ctx.tool.preview };
  },
});
`;

/** The fixture app with what `t.job` and `t.tool` need (#593). */
async function helpersApp(): Promise<string> {
  const dir = await fixtureApp();
  const log = console.log;
  console.log = () => {};
  try {
    for (const m of ["i18n", "auth"]) {
      const source = `path:${relative(dir, join(repo, "modules", m))}`;
      expect(await addModule(dir, m, { source, yes: true, ...(m === "auth" ? { mount: "/auth" } : {}) }, async () => true)).toBe(0);
    }
  } finally {
    console.log = log;
  }
  write(dir, {
    "renox.toml": `${readFileSync(join(dir, "renox.toml"), "utf8")}\n[authz]\nactions = ["echo.call"]\n`,
    "migrations/001_app.sql": "create table app__pings (at integer not null);\ncreate table app__marks (n integer not null);\ncreate table app__echoes (user_id text not null, x integer not null);\ncreate table app__queued (n integer, raw text);\n",
    "jobs/ping.ts": `export const schedule = "0 0 1 1 *";\nexport async function run(ctx) {\n  await ctx.db.execute("insert into app__pings (at) values (?)", [Date.now()]);\n}\n`,
    "jobs/queued.ts": `export const schedule = "0 0 1 1 *";\nexport async function run(ctx) {\n  await ctx.db.execute("insert into app__queued (n, raw) values (?, ?)", [ctx.job.payload === null ? null : ctx.job.payload.n, JSON.stringify(ctx.job.payload)]);\n}\n`,
    "jobs/boom.ts": `export const schedule = "0 0 1 1 *";\nexport async function run() {\n  throw new Error("boom: the job failed");\n}\n`,
    "functions/tools/echo.ts": ECHO_TS,
    "policies/app/echo.cedar": `permit (principal, action == Renox::Action::"echo.call", resource)\nwhen { principal has email_verified && principal.email_verified };\n`,
    "tests/helpers.test.ts": HELPERS_TS,
  });
  return dir;
}

test.skipIf(!worker)(
  "renox test: t.job runs a scheduled job now, t.tool calls an App MCP tool as a user's agent (#593)",
  async () => {
    const dir = await helpersApp();
    const r = await runTests(dir, ["tests/helpers.test.ts"], "pipe");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("3 pass");
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

test.skipIf(!worker)(
  "renox test runs against a pages-only app",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-test-pages-only-"));
    try {
      cpSync(join(import.meta.dir, "fixtures/pages-only"), dir, { recursive: true });
      mkdirSync(join(dir, "node_modules/@renoxium"), { recursive: true });
      symlinkSync(join(repo, "sdk"), join(dir, "node_modules/@renoxium/sdk"));
      const r = await runTests(dir, [], "pipe");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("1 pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);
