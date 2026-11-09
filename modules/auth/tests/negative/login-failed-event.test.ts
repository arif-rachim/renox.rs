// #659, docs/24-threat-model.md "Security events not visible to operators":
// a failed password sign-in emits `auth.login_failed { reason, ip_hash }`,
// which the cell counts as renox_security_events_total{kind="login_failed"}
// (crates/renox-cell/tests/telemetry.rs `security_events_are_counted_per_kind`).
// The payload never carries the email, the password or a user id.
//
// `login` runs here on an in-memory database with the module's migrations
// and a context that records what it emits: under a worker the outbox
// delivers the event and deletes the row before a test could read it.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ACCOUNT_LIMIT, type AuthCtx, login } from "../../lib/core.ts";

const MIGRATIONS = join(import.meta.dir, "../../migrations");
const PASSWORD = "correct horse battery";

interface Emitted {
  name: string;
  payload: Record<string, unknown>;
}

function context(): { ctx: AuthCtx; emitted: Emitted[] } {
  const db = new Database(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  db.query("insert into auth__users (id, email, display_name, created_at, updated_at, password_hash) values (?, ?, ?, ?, ?, ?)").run("u_1", "lf@example.com", "lf", 0, 0, `hash:${PASSWORD}`);
  const emitted: Emitted[] = [];
  const ctx: AuthCtx = {
    db: {
      query: async (sql, params = []) => db.query(sql).all(...(params as never[])) as never,
      queryOne: async (sql, params = []) => (db.query(sql).get(...(params as never[])) ?? null) as never,
      execute: async (sql, params = []) => {
        const r = db.query(sql).run(...(params as never[]));
        return { changes: r.changes, last_insert_rowid: Number(r.lastInsertRowid) } as never;
      },
    },
    headers: new Headers({ "x-renox-client-ip": "203.0.113.7" }),
    config: {},
    password: { hash: async (p) => `hash:${p}`, verify: async (p, h) => h === `hash:${p}` },
    events: {
      emit: async (name, payload) => {
        emitted.push({ name, payload });
        return `ev_${emitted.length}`;
      },
    },
    hooks: { run: async () => ({ halt: false }) },
  };
  return { ctx, emitted };
}

const failed = (emitted: Emitted[]): Emitted[] => emitted.filter((e) => e.name === "auth.login_failed");

describe("auth.login_failed (#659)", () => {
  test("a wrong password and an unknown user emit it, with no email, password or user id in the payload", async () => {
    const { ctx, emitted } = context();
    expect((await login(ctx, { email: "lf@example.com", password: "wrong guess" })).ok).toBe(false);
    expect((await login(ctx, { email: "ghost-user@example.com", password: PASSWORD })).ok).toBe(false);
    const events = failed(emitted);
    expect(events.map((e) => e.payload.reason)).toEqual(["password", "unknown_user"]);
    for (const e of events) {
      expect(Object.keys(e.payload).sort()).toEqual(["ip_hash", "reason"]);
      expect(e.payload.ip_hash).toMatch(/^[0-9a-f]{16}$/u);
      const text = JSON.stringify(e.payload);
      for (const secret of ["example.com", "wrong guess", PASSWORD, "u_1", "203.0.113.7"]) expect(text).not.toContain(secret);
    }
  });

  test("a locked account reports reason locked, even with the right password", async () => {
    const { ctx, emitted } = context();
    for (let i = 0; i < ACCOUNT_LIMIT; i++) await login(ctx, { email: "lf@example.com", password: `wrong ${i}` });
    const before = failed(emitted).length;
    expect((await login(ctx, { email: "lf@example.com", password: PASSWORD })).ok).toBe(false);
    expect(failed(emitted).slice(before).map((e) => e.payload.reason)).toEqual(["locked"]);
  });

  test("a successful sign-in emits no auth.login_failed", async () => {
    const { ctx, emitted } = context();
    expect((await login(ctx, { email: "lf@example.com", password: PASSWORD })).ok).toBe(true);
    expect(failed(emitted)).toEqual([]);
  });
});
