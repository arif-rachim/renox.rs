// #283: `renox authz explain` (docs/11-authorization.md): the decision and
// the deciding policies for one request, with the user's roles and the
// resource's declared attributes read from the dev tenant file.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { explain } from "../src/commands/authz.ts";
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
