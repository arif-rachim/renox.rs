// The booking module (#334): slots from weekly and Ramadan hours, buffers,
// holds that expire, confirmation, no double booking.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as core from "../lib/core.ts";

function ctx() {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(import.meta.dir, "../migrations/001_init.sql"), "utf8"));
  db.exec(`insert into booking__services values ('cut', 'Haircut', 30, 15);
    insert into booking__staff values ('sara', 'Sara'), ('omar', 'Omar');
    insert into booking__staff_services values ('sara', 'cut'), ('omar', 'cut');
    insert into booking__hours (staff_id, weekday, open_min, close_min) values ('sara', 4, 540, 660), ('omar', 4, 600, 660);
    insert into booking__hours (staff_id, day, open_min, close_min) values ('sara', '2026-11-12', 1200, 1290), ('omar', '2026-11-12', 0, 0);`);
  // #334 F67-B: deposits, the window, staff users, reminders, the live-booking index (after the seed's positional inserts).
  db.exec(readFileSync(join(import.meta.dir, "../migrations/002_deposits_reminders_staff.sql"), "utf8"));
  const emitted: unknown[] = [];
  const c: core.BookingCtx = {
    db: {
      async query<T>(sql: string, p: unknown[] = []) { return db.query(sql).all(...(p as never[])) as T[]; },
      async queryOne<T>(sql: string, p: unknown[] = []) { return (db.query(sql).get(...(p as never[])) ?? null) as T | null; },
      async execute(sql: string, p: unknown[] = []) { return { changes: db.query(sql).run(...(p as never[])).changes }; },
    },
    config: { slot_minutes: 30, hold_minutes: 10 },
    events: { emit: async (_n, p) => void emitted.push(p) },
    utcOffsetMinutes: 240,
  };
  return { c, emitted };
}

const local = (day: string, hh: number, mm = 0) => core.midnight(day, 240) + (hh * 60 + mm) * 60_000;
const hm = (ms: number) => new Date(ms + 240 * 60_000).toISOString().slice(11, 16);

test("the pure slot grid respects windows, length, buffer and busy intervals", () => {
  const w = [{ open: 0, close: 120 * 60_000 }];
  expect(core.freeSlots(w, [], 30, 0, 30).length).toBe(4);
  expect(core.freeSlots(w, [{ start: 30 * 60_000, end: 60 * 60_000 }], 30, 15, 30).map((s) => s.start / 60_000)).toEqual([90]);
});

test("a Thursday: Sara 09:00-11:00, Omar 10:00-11:00, 30 min + 15 min buffer on a 30 min grid", async () => {
  const { c } = ctx();
  const now = local("2026-11-05", 0);
  const s = await core.slots(c, "cut", "2026-11-05", {}, now);
  expect(s.map((x) => `${hm(x.start)} ${x.staff}`)).toEqual(["09:00 sara", "09:30 sara", "10:00 omar", "10:00 sara", "10:30 omar", "10:30 sara"]);
  // A Ramadan evening for Sara, Omar off.
  const r = await core.slots(c, "cut", "2026-11-12", {}, now);
  expect(r.map((x) => `${hm(x.start)} ${x.staff}`)).toEqual(["20:00 sara", "20:30 sara", "21:00 sara"]);
});

test("hold, confirm, no double booking, an expired hold frees the slot", async () => {
  const { c, emitted } = ctx();
  const now = local("2026-11-05", 0);
  const start = local("2026-11-05", 9);
  const h = await core.hold(c, "cut", "sara", start, "cust_1", now);
  await expect(core.hold(c, "cut", "sara", start, "cust_2", now)).rejects.toMatchObject({ code: "TAKEN" });
  // The buffer blocks 09:30 too.
  expect((await core.slots(c, "cut", "2026-11-05", { staff: "sara" }, now)).map((x) => hm(x.start))).toEqual(["10:00", "10:30"]);
  // After the hold expires the slot is free again.
  expect((await core.slots(c, "cut", "2026-11-05", { staff: "sara" }, h.expires_at + 1)).map((x) => hm(x.start))[0]).toBe("09:00");
  const b = (await core.confirm(c, h.id, now + 60_000)) as { status: string };
  expect(b.status).toBe("confirmed");
  expect(emitted).toEqual([{ booking_id: h.id }]);
  await expect(core.hold(c, "cut", "sara", start, "cust_2", h.expires_at + 1)).rejects.toMatchObject({ code: "TAKEN" });
  expect(await core.cancel(c, h.id)).toBe(true);
  await expect(core.hold(c, "cut", "sara", start, "cust_2", now)).resolves.toMatchObject({ id: expect.any(String) });
});

// #334 F67-B: one live booking per staff and start, deposits, reminders, the cancellation window.
test("one live booking per staff member and start: a second write of the same start is refused by the index", async () => {
  const { c } = ctx();
  const start = local("2026-11-05", 9);
  await core.hold(c, "cut", "sara", start, "u1", start - 86_400_000);
  // A writer that skipped the slot search (the race): the unique index refuses it.
  await expect(c.db.execute("insert into booking__bookings (id, service_id, staff_id, customer, start_at, end_at, status, created_at) values ('x', 'cut', 'sara', 'u2', ?, ?, 'held', 0)", [start, start + 1])).rejects.toThrow();
  await expect(core.hold(c, "cut", "sara", start, "u2", start - 86_400_000)).rejects.toMatchObject({ code: "TAKEN" });
  // Once the first hold expires, the start is free again.
  expect(await core.hold(c, "cut", "sara", start, "u2", start - 86_400_000 + 11 * 60_000)).toMatchObject({ pay_url: null });
});

test("a deposit: the hold answers the checkout; paying it confirms and schedules the 24 h and 2 h reminders, each sent once", async () => {
  const { c, emitted } = ctx();
  await c.db.execute("update booking__services set deposit_fils = 5000 where id = 'cut'");
  const orders: unknown[] = [];
  c.deposit = async (o) => (orders.push(o), { url: "https://checkout.stripe.com/c/cs_1" });
  const queued: unknown[] = [];
  c.jobs = { enqueue: async (name, payload, o) => (queued.push([name, payload, o?.runAt]), "job_1") };
  const start = local("2026-11-05", 10);
  const now = start - 3 * 86_400_000;
  const h = await core.hold(c, "cut", "sara", start, "u1", now);
  expect(h.pay_url).toBe("https://checkout.stripe.com/c/cs_1");
  expect(orders).toEqual([{ order_id: `booking:${h.id}`, customer_id: "u1", amount: 5000, description: "Deposit: Haircut" }]);
  const hooks = await import("../hooks.ts");
  await hooks.on["billing.checkout_completed"](c, { payload: { order_id: `booking:${h.id}` } });
  expect((await c.db.queryOne<{ status: string }>("select status from booking__bookings where id = ?", [h.id]))?.status).toBe("confirmed");
  expect(emitted).toEqual([{ booking_id: h.id }]);
  expect(queued).toEqual([
    ["reminder", { booking_id: h.id, kind: "24h" }, start - 24 * 3_600_000],
    ["reminder", { booking_id: h.id, kind: "2h" }, start - 2 * 3_600_000],
  ]);
  expect(await core.reminderDue(c, h.id, "24h", start - 24 * 3_600_000)).toMatchObject({ customer: "u1", service: "Haircut" });
  expect(await core.reminderDue(c, h.id, "24h", start - 24 * 3_600_000)).toBeNull();
  // Another order's completion is not a booking's.
  await hooks.on["billing.checkout_completed"](c, { payload: { order_id: "order-9" } });
});

test("cancelling: only the customer's own; inside the window a paid deposit is retained, outside it is not; a missed reminder after a cancel is not sent; no-show after the start", async () => {
  const { c, emitted } = ctx();
  await c.db.execute("update booking__services set deposit_fils = 5000, cancel_hours = 24 where id = 'cut'");
  c.deposit = async () => ({ url: "https://pay" });
  const start = local("2026-11-05", 9, 30);
  const early = await core.hold(c, "cut", "sara", start, "u1", start - 5 * 86_400_000);
  await core.confirm(c, early.id, start - 5 * 86_400_000);
  await expect(core.cancel(c, early.id, { customer: "u2" }, start - 4 * 86_400_000)).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await core.cancel(c, early.id, { customer: "u1" }, start - 4 * 86_400_000)).toBe(true);
  expect(await core.reminderDue(c, early.id, "2h", start - 2 * 3_600_000)).toBeNull();
  const late = await core.hold(c, "cut", "sara", start, "u1", start - 4 * 86_400_000);
  await core.confirm(c, late.id, start - 4 * 86_400_000);
  expect(await core.cancel(c, late.id, {}, start - 3_600_000)).toBe(true);
  expect(emitted.filter((e) => typeof (e as { deposit_retained?: boolean }).deposit_retained === "boolean")).toEqual([
    { booking_id: early.id, deposit_retained: false },
    { booking_id: late.id, deposit_retained: true },
  ]);
  const third = await core.hold(c, "cut", "sara", start, "u3", start - 3_600_000);
  await core.confirm(c, third.id, start - 3_600_000);
  expect(await core.noShow(c, third.id, start - 60_000)).toBe(false);
  expect(await core.noShow(c, third.id, start + 60_000)).toBe(true);
});
