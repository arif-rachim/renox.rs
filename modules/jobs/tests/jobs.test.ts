// The jobs module on the real worker (#297; ops.md 1.6.0 section 20): the
// page lists scheduled, queued, running and dead runs without payloads, an
// admin retries and cancels (audited), an operator only reads, a user
// without a role and the app's own broker calls are refused. Proves the
// docs/23-failure-modes.md row "Event handler fails repeatedly" for jobs:
// the dead-letter page shows the run and its redacted error.

import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";
import * as core from "../lib/core.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";
const DEAD = "01JDEAD0000000000000000000";

describe("core", () => {
  test("states and ids are checked before any op", () => {
    expect(core.state("dead")).toBe("dead");
    expect(() => core.state("sleeping")).toThrow("state is");
    expect(core.id(DEAD)).toBe(DEAD);
    expect(() => core.id("x' or 1=1")).toThrow("ULID");
  });

  test("a row is shown with UTC times and a short job label", () => {
    expect(core.shown({ id: DEAD, name: "prune", module: "audit", tick: null, next_at: null, run_at: 0, attempts: 2, started_at: null, finished_at: 1000, last_error: "threw" })).toEqual({
      id: DEAD,
      job: "audit.prune",
      next: "1970-01-01T00:00:00Z",
      last: "1970-01-01T00:00:01Z",
      started: null,
      attempts: 2,
      error: "threw",
    });
  });
});

async function user(name: string, role?: string): Promise<TestApp> {
  const u = t.as(name);
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  if (role) expect((await u.request("POST", `/api/grant?role=${role}`)).status).toBe(200);
  return u;
}

/** A dead run of `flaky`, as the outbox worker leaves one after its last attempt, with a payload the page must never show. */
function plantDead(): void {
  const db = new Database(t.dbFile);
  db.exec("pragma busy_timeout = 5000");
  db.query(
    "insert or replace into renox__outbox_dead (id, target, name, payload, module, created_at, attempts, next_at, last_error, dead_at) values (?, 'app', 'job:flaky', ?, 'app', 1, 8, 2, 'threw', 1793318400000)",
  ).run(DEAD, JSON.stringify({ card: "4242424242424242" }));
  db.close();
}

const section = (html: string, id: string): string => html.slice(html.indexOf(`<section id="${id}">`), html.indexOf("</section>", html.indexOf(`<section id="${id}">`)) + 10);

describe.skipIf(!worker)("jobs", () => {
  setDefaultTimeout(30_000);
  test("the page lists the scheduled jobs and the dead run, never its payload", async () => {
    const ada = await user("ada", "admin");
    plantDead();
    const page = await ada.page("/jobs");
    expect(page.status).toBe(200);
    expect(page.html).toContain("nightly");
    expect(page.html).toContain("flaky");
    expect(page.html).not.toContain("4242424242424242");
    expect(section(page.html, "jobs-dead").replace(/name="_csrf" value="[^"]+"/gu, 'name="_csrf" value="<csrf>"')).toMatchSnapshot();
  });

  test("an admin retries a dead run and cancels it once queued; both are audited", async () => {
    const ada = t.as("ada");
    plantDead();
    const retried = await ada.action("/jobs", "retry", { id: DEAD });
    if (retried.status !== 200) console.error(t.logs().slice(-5));
    expect(retried.status).toBe(200);
    expect(t.db.query("select id from renox__outbox_dead where id = ?", [DEAD])).toEqual([]);
    expect(t.db.query("select id from renox__outbox where id = ?", [DEAD])).toHaveLength(1);
    // It runs and fails again at once; its next attempt is ten seconds away, so it is queued.
    for (let i = 0; i < 100 && t.db.query<{ n: number }>("select count(*) as n from renox__outbox_meta where key = ?", [`job_running:${DEAD}`])[0]?.n; i++) await Bun.sleep(50);
    const cancel = await ada.action("/jobs", "cancel", { id: DEAD });
    expect(cancel.status).toBe(200);
    expect(t.db.query("select id from renox__outbox where id = ?", [DEAD])).toEqual([]);
    const audit = t.db.query<{ action: string }>("select action from renox__authz_audit where action in ('jobs.retry', 'jobs.cancel') and resource_id = ? order by id", [DEAD]);
    expect(audit.map((r) => r.action)).toEqual(["jobs.retry", "jobs.cancel"]);
  });

  test("an operator reads but cannot retry; a user without a role and the app itself are refused", async () => {
    const otto = await user("otto", "operator");
    plantDead();
    expect((await otto.page("/jobs")).status).toBe(200);
    expect((await otto.action("/jobs", "retry", { id: DEAD })).status).toBe(403);
    expect(t.db.query("select id from renox__outbox_dead where id = ?", [DEAD])).toHaveLength(1);
    const bob = await user("bob");
    expect((await bob.page("/jobs")).status).toBe(403);
    // The broker call runs as the app with no signed-in user: jobs.read is denied.
    await expect(t.service("jobs").list("dead")).rejects.toMatchObject({ code: expect.stringMatching(/RENOX_(FORBIDDEN|MODULE_SERVICE)/u) });
  });
});
