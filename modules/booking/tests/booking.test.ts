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
