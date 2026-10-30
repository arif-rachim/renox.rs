// The booking module in an app, on the real worker (#334): a customer books
// through the page and sees only their own bookings; two customers racing
// for one slot get one booking (docs/23 "Booking: double booking"); the
// confirmation schedules both reminders (docs/23 "missed reminder"); the
// staff calendar needs booking.view_calendar and updates live over the
// change feed.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";

async function user(name: string, role?: string): Promise<TestApp> {
  const u = t.as(name);
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  if (role) expect((await u.request("POST", `/api/grant?role=${role}`)).status).toBe(200);
  return u;
}
const idOf = (name: string): string => t.db.query<{ id: string }>("select id from auth__users where email = ?", [`${name}@example.com`])[0]?.id as string;

/** The first free slot's start on a day three days ahead. */
async function firstSlot(u: TestApp): Promise<{ start: string; day: string }> {
  const day = new Date(Date.now() + 3 * 86_400_000 + 4 * 3_600_000).toISOString().slice(0, 10);
  const page = await u.page(`/booking?service=cut&day=${day}`);
  const start = /name="start" value="(\d+)"/u.exec(page.html)?.[1] as string;
  return { start, day };
}

describe.skipIf(!worker)("booking in an app", () => {
  test("seeded by an admin; a customer books through the page, sees it in their own list, and the reminders are scheduled", async () => {
    await user("sara", "staff");
    const admin = await user("adel", "admin");
    expect((await admin.request("POST", `/api/seed?staff_user=${idOf("sara")}`)).status).toBe(200);
    const nour = await user("nour");
    const { start } = await firstSlot(nour);
    expect(start).toMatch(/^\d+$/u);
    const held = await nour.action("/booking", "hold", { service: "cut", staff: "sara", start });
    expect(held.status).toBe(303);
    const mine = await nour.page("/booking/mine");
    expect(mine.html).toContain("Haircut");
    expect(mine.html).toContain("confirmed");
    const rami = await user("rami");
    expect((await rami.page("/booking/mine")).html).not.toContain("Haircut");
    const runs = t.db.query<{ name: string; next_at: number }>("select name, next_at from renox__outbox where name = 'job:reminder' order by next_at");
    expect(runs).toHaveLength(2);
    expect(Number(start) - (runs[0]?.next_at as number)).toBe(24 * 3_600_000);
    expect(Number(start) - (runs[1]?.next_at as number)).toBe(2 * 3_600_000);
  });

  test("two customers racing for the same slot: one booking", async () => {
    const a = await user("hala");
    const b = await user("ziad");
    const day = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const page = await a.page(`/booking?service=cut&day=${day}`);
    const start = /name="start" value="(\d+)"/u.exec(page.html)?.[1] as string;
    await b.page(`/booking?service=cut&day=${day}`);
    await Promise.all([a.action("/booking", "hold", { service: "cut", staff: "sara", start }), b.action("/booking", "hold", { service: "cut", staff: "sara", start })]);
    expect(t.db.query("select id from booking__bookings where start_at = ? and status != 'cancelled'", [Number(start)])).toHaveLength(1);
  });

  test("the calendar needs booking.view_calendar; the staff member's open stream gets the next booking", async () => {
    expect((await t.as("rami").page("/booking/calendar")).status).toBe(403);
    const sara = t.as("sara");
    const cal = await sara.page("/booking/calendar");
    expect(cal.status).toBe(200);
    const s = await sara.sse("/booking/sse/calendar");
    expect(s.status).toBe(200);
    const nour = t.as("nour");
    const day = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
    const start = /name="start" value="(\d+)"/u.exec((await nour.page(`/booking?service=cut&day=${day}`)).html)?.[1] as string;
    await nour.action("/booking", "hold", { service: "cut", staff: "sara", start });
    let e = await s.next(3000);
    while (e !== null && e.event !== null && e.event !== "change") e = await s.next(3000);
    expect(e?.data).toContain("booking__bookings");
  });
});
