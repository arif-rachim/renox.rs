// renox jobs (#297): list, run and retry on a dev tenant file with the
// platform's outbox tables, and the scheduler lines `renox dev --jobs` shows.
// The SQL the cell uses is in crates/renox-runtime/src/ops/jobs.rs; these
// tests check the CLI writes rows the cell reads the same way (one row per
// job, the coalescing key, attempts reset on retry, no payload listed).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT } from "../src/errors.ts";
import { format, list, retry, run, runNow, ulid } from "../src/commands/jobs.ts";
import { jobTick } from "../src/commands/dev.ts";

const SCHEMA = readFileSync(join(import.meta.dir, "../../crates/renox-data/migrations/0001_outbox.sql"), "utf8");

function devDb(): string {
  const file = join(mkdtempSync(join(tmpdir(), "renox-jobs-")), "app.db");
  const db = new Database(file);
  db.exec(SCHEMA);
  db.close();
  return file;
}

const rows = (file: string, sql: string, ...p: (string | number)[]) => {
  const db = new Database(file);
  try {
    return db.query(sql).all(...p) as Record<string, unknown>[];
  } finally {
    db.close();
  }
};

describe("renox jobs", () => {
  test("run writes one row per job and coalesces a second run into the waiting row", () => {
    const f = devDb();
    const a = runNow(f, "app", "report", 1_000);
    const b = runNow(f, "app", "report", 2_000);
    expect(b).toBe(a);
    expect(rows(f, "select id, target, name, payload from renox__outbox")).toEqual([{ id: a, target: "app", name: "job:report", payload: "null" }]);
    expect(rows(f, "select value from renox__outbox_meta where key = 'job_tick:app:report'")).toEqual([{ value: 2_000 }]);
    const queued = list(f, "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ id: a, module: "app", name: "report", tick: 2_000, attempts: 0 });
  });

  test("list never shows a payload; running and scheduled come from the meta rows", () => {
    const f = devDb();
    const db = new Database(f);
    db.query("insert into renox__outbox (id, target, name, payload, module, created_at, attempts, next_at) values ('01J0000000000000000000000A', 'audit', 'job:prune', '{\"secret\":\"s3\"}', 'audit', 1, 0, 5)").run();
    db.query("insert into renox__outbox_meta (key, value) values ('job_running:01J0000000000000000000000A', 7), ('job_next:app:report', 9), ('job_last:app:report', 3)").run();
    db.close();
    expect(list(f, "queued")).toEqual([]);
    const running = list(f, "running");
    expect(running[0]).toMatchObject({ module: "audit", name: "prune", started_at: 7 });
    expect(JSON.stringify(running)).not.toContain("s3");
    expect(list(f, "scheduled")).toEqual([{ id: null, module: "app", name: "report", tick: null, next_at: 9, attempts: 0, started_at: null, finished_at: 3, last_error: null }]);
    expect(format("scheduled", list(f, "scheduled"))).toContain("report  next 1970-01-01T00:00:00.009Z");
  });

  test("retry puts a dead run back with its attempts reset and refuses a live one", () => {
    const f = devDb();
    const id = ulid(1);
    const db = new Database(f);
    db.query("insert into renox__outbox_dead (id, target, name, payload, module, created_at, attempts, next_at, last_error, dead_at) values (?, 'app', 'job:report', '{}', 'app', 1, 8, 2, 'threw', 3)").run(id);
    db.close();
    expect(list(f, "dead")[0]).toMatchObject({ id, attempts: 8, last_error: "threw", finished_at: 3 });
    retry(f, id, 10);
    expect(rows(f, "select attempts, next_at from renox__outbox where id = ?", id)).toEqual([{ attempts: 0, next_at: 10 }]);
    expect(list(f, "dead")).toEqual([]);
    expect(() => retry(f, id)).toThrow("not dead");
    expect(() => retry(f, ulid(2))).toThrow("no dead job run");
  });

  test("usage errors and a missing dev database", () => {
    expect(run(["list", "--state", "sleeping"])).toBe(EXIT.USER);
    expect(run(["run", "Bad Name"])).toBe(EXIT.USER);
    expect(run(["retry", "nope"])).toBe(EXIT.USER);
    expect(() => list(join(tmpdir(), "renox-no-such", "app.db"), "queued")).toThrow("no dev database");
  });

  test("a ULID is 26 Crockford characters that sort by time", () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(a < b).toBe(true);
  });
});

describe("renox dev --jobs", () => {
  test("scheduler lines become short terminal lines; other lines are ignored", () => {
    expect(jobTick(JSON.stringify({ level: "INFO", fields: { message: "job tick", module: "app", job: "report", tick: 0 } }))).toBe("jobs: report tick 1970-01-01T00:00:00.000Z");
    expect(jobTick(JSON.stringify({ level: "INFO", message: "missed job ticks coalesced into one run", module: "audit", job: "prune", tick: 0 }))).toBe("jobs: audit.prune missed ticks, one run for 1970-01-01T00:00:00.000Z");
    expect(jobTick(JSON.stringify({ level: "INFO", message: "cell ready" }))).toBeNull();
    expect(jobTick("not json")).toBeNull();
  });
});
