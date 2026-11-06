// #283: `renox authz explain` (docs/11-authorization.md): the decision and
// the deciding policies for one request, with the user's roles and the
// resource's declared attributes read from the dev tenant file.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { attrsText, explain, parse } from "../src/commands/authz.ts";
import { devDb } from "../src/commands/migrate.ts";
import { app, BASE } from "./authz-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
if (worker) process.env.RENOX_WORKER_PATH = worker;

test.skipIf(!worker)("explain reads roles and resource attributes from the dev database", async () => {
  const dir = app(BASE);
  try {
    const file = devDb(dir);
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file);
    db.exec("create table app__docs (id text primary key, owner text not null, title text)");
    db.exec("insert into app__docs values ('d1', 'u_alice', 'Plan'), ('d2', 'u_bob', 'Notes')");
    db.exec("create table renox__role_assignments (user_id text, role text, scope_type text, scope_id text, granted_by text, at integer)");
    db.exec("insert into renox__role_assignments values ('u_carol', 'editor', 'global', null, 'u_root', 0)");
    db.close();

    const own = await explain(dir, { user: "u_alice", action: "doc.read", resource: { type: "Doc", id: "d1" }, roles: [] });
    expect(own.allow).toBe(true);
    expect(own.text).toStartWith("ALLOW");
    expect(own.text).toContain("resource.owner == principal.id");
    expect(own.policies).toHaveLength(1);

    const other = await explain(dir, { user: "u_alice", action: "doc.read", resource: { type: "Doc", id: "d2" }, roles: [] });
    expect(other.allow).toBe(false);
    expect(other.text).toContain("no policy permits this request");

    // u_carol's `editor` role comes from renox__role_assignments.
    const editor = await explain(dir, { user: "u_carol", action: "doc.edit", resource: { type: "Doc", id: "d2" }, roles: [] });
    expect(editor.allow).toBe(true);
    // --role adds a role for the question; an unknown resource has no attributes.
    const missing = await explain(dir, { user: "u_alice", action: "doc.read", resource: { type: "Doc", id: "nope" }, roles: [] });
    expect(missing.allow).toBe(false);
    expect(missing.reason).toBe("missing_attribute");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!worker)("renox authz explain prints the explanation; --json the decision", async () => {
  const dir = app(BASE);
  try {
    const main = join(import.meta.dir, "../src/main.ts");
    const run = (args: string[]) => Bun.spawnSync([process.execPath, main, "authz", ...args], { cwd: dir, env: { ...process.env, RENOX_WORKER_PATH: worker } });
    const text = run(["explain", "--user", "u_x", "--action", "doc.edit", "--role", "editor"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout.toString()).toStartWith("ALLOW");
    const json = run(["explain", "--user", "u_x", "--action", "doc.edit", "--json"]);
    expect(JSON.parse(json.stdout.toString())).toMatchObject({ allow: false, reason: "deny" });
    const bad = run(["explain", "--user", "u_x"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("usage: renox authz explain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #476: principal attributes a hook fills in the app (org's `principal.org`).
const BOARD: Record<string, string> = {
  "renox.toml": `[app]
name = "board"
timezone = "Asia/Dubai"

[authz]
actions = ["task.edit"]

[authz.entities]
Task = { table = "app__tasks", attrs = ["team_id"] }
`,
  "policies/app/board.cedar": `permit (principal is Renox::User, action == Renox::Action::"task.edit", resource is App::Task)
when { principal has org && resource.team_id == principal.org };
`,
  "migrations/001_tasks.sql": "create table app__tasks (id text primary key, team_id text not null);\n",
  "functions/health.ts": "export function GET(): Response {\n  return new Response(\"ok\");\n}\n",
};

test("--attr is repeatable; the value is JSON when it parses, else a string", () => {
  const a = parse(["explain", "--user", "u", "--action", "task.edit", "--attr", "org=o_acme", "--attr", "mfa_verified=true", "--attr", "level=3", "--attr", "note=a=b"]);
  expect(a?.attrs).toEqual({ org: "o_acme", mfa_verified: true, level: 3, note: "a=b" });
  expect(parse(["explain", "--user", "u", "--action", "a"])?.attrs).toBeUndefined();
  expect(parse(["explain", "--user", "u", "--action", "a", "--attr", "novalue"])).toBeNull();
  expect(parse(["explain", "--user", "u", "--action", "a", "--attr", "=x"])).toBeNull();
});

test("the output lists the principal attributes used", () => {
  expect(attrsText({ id: "u", roles: [], attrs: { org: "o_acme", mfa_verified: true } })).toBe('principal attributes: org="o_acme", mfa_verified=true\n');
  expect(attrsText({ id: "u", roles: [], attrs: {} })).toStartWith("principal attributes: none");
});

test.skipIf(!worker)("--attr org answers like the app for a member and a non-member", async () => {
  const dir = app(BOARD);
  try {
    const file = devDb(dir);
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file);
    db.exec("create table app__tasks (id text primary key, team_id text not null)");
    db.exec("insert into app__tasks values ('1', 'o_acme')");
    db.close();
    const req = { user: "u_omar", action: "task.edit", resource: { type: "Task", id: "1" }, roles: [] };

    const member = await explain(dir, { ...req, attrs: { org: "o_acme" } });
    expect(member.allow).toBe(true);
    expect(member.principal.attrs).toEqual({ org: "o_acme" });

    const outsider = await explain(dir, { ...req, attrs: { org: "o_other" } });
    expect(outsider.allow).toBe(false);

    const none = await explain(dir, req);
    expect(none.allow).toBe(false);
    expect(none.principal.attrs).toEqual({});

    const main = join(import.meta.dir, "../src/main.ts");
    const out = Bun.spawnSync([process.execPath, main, "authz", "explain", "--user", "u_omar", "--action", "task.edit", "--resource", "Task:1", "--attr", "org=o_acme"], { cwd: dir, env: { ...process.env, RENOX_WORKER_PATH: worker } });
    expect(out.stdout.toString()).toStartWith("ALLOW");
    expect(out.stdout.toString()).toContain('principal attributes: org="o_acme"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
