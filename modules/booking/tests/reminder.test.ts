// The reminder job (#799): the payload is `ctx.job.payload`; the hook `booking.remind`
// runs first and a filler that sets `handled` stops the email; a customer with no auth
// email is skipped without error. The first block drives `core.remind` with a fake ctx;
// the second runs the job on the real worker with `t.job(name, { payload })`.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";
import * as core from "../lib/core.ts";

const MIG = (f: string) => readFileSync(join(import.meta.dir, "../migrations", f), "utf8");
const HOUR = 3_600_000;

function fixture() {
  const db = new Database(":memory:");
  for (const f of ["001_init.sql", "002_deposits_reminders_staff.sql", "003_hours_unique.sql"]) db.exec(MIG(f));
  db.exec(`create table auth__public_users_v1 (id text primary key, email text);
    insert into auth__public_users_v1 values ('u1', 'nour@example.com'), ('u2', null);
    insert into booking__services (id, name, minutes, buffer) values ('cut', 'Haircut', 30, 0);
    insert into booking__staff (id, name) values ('sara', 'Sara');`);
  const warns: string[] = [];
  const hookRuns: { name: string; args: Record<string, unknown> }[] = [];
  const sent: { to: string; subject: string; text: string }[] = [];
  let filler: ((args: Record<string, unknown>) => void) | null = null;
  const c: core.RemindCtx = {
    db: {
      async query<T>(sql: string, p: unknown[] = []) { return db.query(sql).all(...(p as never[])) as T[]; },
      async queryOne<T>(sql: string, p: unknown[] = []) { return (db.query(sql).get(...(p as never[])) ?? null) as T | null; },
      async execute(sql: string, p: unknown[] = []) { return { changes: db.query(sql).run(...(p as never[])).changes }; },
    },
    config: {},
    events: { emit: async () => {} },
    hooks: { run: async (name, args) => (hookRuns.push({ name, args: args as Record<string, unknown> }), filler?.(args as Record<string, unknown>), { halt: false }) },
    log: { warn: (m) => void warns.push(m) },
  };
  const start = Date.now() + 3 * 86_400_000;
  let seq = 0;
  const book = (id: string, customer: string, status = "confirmed") =>
    db.exec(`insert into booking__bookings (id, service_id, staff_id, customer, start_at, end_at, status, created_at) values ('${id}', 'cut', 'sara', '${customer}', ${start + ++seq}, ${start + HOUR * 2}, '${status}', 0)`);
  return { c, db, warns, hookRuns, sent, send: async (m: { to: string; subject: string; text: string }) => void sent.push(m), fill: (f: (a: Record<string, unknown>) => void) => (filler = f), book };
}

describe("core.remind", () => {
  test("a confirmed booking's 24 h and 2 h runs each send one mail, and a repeated run none", async () => {
    const f = fixture();
    f.book("b1", "u1");
    await core.remind(f.c, { booking_id: "b1", kind: "24h" }, f.send);
    await core.remind(f.c, { booking_id: "b1", kind: "2h" }, f.send);
    await core.remind(f.c, { booking_id: "b1", kind: "24h" }, f.send);
    expect(f.sent.map((m) => m.to)).toEqual(["nour@example.com", "nour@example.com"]);
    expect(f.hookRuns.map((h) => [h.name, h.args.kind, h.args.customer, h.args.service, h.args.handled])).toEqual([
      ["booking.remind", "24h", "u1", "Haircut", false],
      ["booking.remind", "2h", "u1", "Haircut", false],
    ]);
    expect(f.warns).toEqual([]);
  });

  test("a cancelled booking's run sends none and runs no hook", async () => {
    const f = fixture();
    f.book("b2", "u1", "cancelled");
    await core.remind(f.c, { booking_id: "b2", kind: "24h" }, f.send);
    await core.remind(f.c, { booking_id: "b2", kind: "2h" }, f.send);
    expect(f.sent).toEqual([]);
    expect(f.hookRuns).toEqual([]);
  });

  test("a run with no payload, or a malformed one, is a no-op with one warning each", async () => {
    const f = fixture();
    await core.remind(f.c, undefined, f.send);
    expect(f.warns).toHaveLength(1);
    await core.remind(f.c, { booking_id: "b1", kind: "1h" }, f.send);
    expect(f.warns).toHaveLength(2);
    expect(f.sent).toEqual([]);
    expect(f.hookRuns).toEqual([]);
  });

  test("a filler that sets handled stops the email", async () => {
    const f = fixture();
    f.book("b3", "u1");
    f.fill((a) => void (a.handled = true));
    await core.remind(f.c, { booking_id: "b3", kind: "24h" }, f.send);
    expect(f.hookRuns).toHaveLength(1);
    expect(f.sent).toEqual([]);
  });

  test("no filler: the email goes; a customer with no auth user or no address is skipped without error", async () => {
    const f = fixture();
    f.book("b4", "u1");
    f.book("b5", "wa:971500000000");
    f.book("b6", "u2");
    for (const id of ["b4", "b5", "b6"]) await core.remind(f.c, { booking_id: id, kind: "24h" }, f.send);
    expect(f.sent.map((m) => m.to)).toEqual(["nour@example.com"]);
    expect(f.sent[0]?.subject).toContain("Haircut");
    expect(f.hookRuns).toHaveLength(3);
  });
});

const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: join(import.meta.dir, "..") }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";

describe.skipIf(!worker)("the reminder job on the worker", () => {
  const mails = (to: string) => t.db.query<{ subject: string }>("select subject from email__messages where to_address = ? and subject like 'Reminder:%'", [to]).length;
  const reminders = () => t.db.query("select id from email__messages where subject like 'Reminder:%'").length;
  const filled = () => t.logs().filter((l) => l.message === "test filler delivered a reminder").length;
  // A 15-minute grid start three days ahead, two hours apart (a service is 30 minutes) so none collides.
  let n = 0;
  const startAt = () => Math.ceil((Date.now() + 3 * 86_400_000) / 900_000) * 900_000 + 2 * HOUR * ++n;

  async function book(customer: string, cancel = false): Promise<string> {
    const r = await t.as("adel").request("POST", `/api/book?customer=${encodeURIComponent(customer)}&start=${startAt()}${cancel ? "&cancel=1" : ""}`);
    expect(r.status).toBe(200);
    return r.json<{ id: string }>().id;
  }
  const run = (booking_id: string, kind: "24h" | "2h") => t.job("reminder", { module: "booking", payload: { booking_id, kind } });

  test("the queued runs read ctx.job.payload: one mail per kind to an auth user, none for a cancelled booking", async () => {
    const adel = t.as("adel");
    expect((await adel.action("/auth/register", "default", { email: "adel@example.com", password: PASSWORD, display_name: "adel" })).status).toBe(200);
    expect((await adel.action("/auth/login", "default", { email: "adel@example.com", password: PASSWORD })).status).toBe(303);
    expect((await adel.request("POST", "/api/grant?role=admin")).status).toBe(200);
    expect((await adel.request("POST", "/api/seed")).status).toBe(200);
    const uid = t.db.query<{ id: string }>("select id from auth__users where email = 'adel@example.com'")[0]?.id as string;

    const live = await book(uid);
    await run(live, "24h");
    expect(mails("adel@example.com")).toBe(1);
    await run(live, "2h");
    expect(mails("adel@example.com")).toBe(2);
    await run(live, "2h");
    expect(mails("adel@example.com")).toBe(2);

    const moved = await book(uid, true);
    await run(moved, "24h");
    await run(moved, "2h");
    expect(mails("adel@example.com")).toBe(2);
  });

  test("a filler that handles the reminder stops the email; a customer with no auth email is skipped without error", async () => {
    const before = reminders();
    const wa = await book("wa:971500000000");
    await run(wa, "24h");
    expect(filled()).toBe(1);
    const ghost = await book("draft-77");
    await run(ghost, "24h");
    expect(filled()).toBe(1);
    expect(reminders()).toBe(before);
  });

  test("a run with no payload is a no-op with one warning", async () => {
    const warns = () => t.logs().filter((l) => String(l.message).startsWith("booking reminder run without a payload")).length;
    const before = warns();
    await t.job("reminder", { module: "booking" });
    expect(warns()).toBe(before + 1);
  });
});
