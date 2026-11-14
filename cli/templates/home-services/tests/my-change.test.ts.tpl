// Cancel and reschedule on /my (#778): lib/portal-change.ts canChange (each
// reason, a table), then the pages and actions of /my/visits/<id> for Peter
// Nowak (cu_dxb_02, seed), signed in by phone through auth's real pages
// (tests/outbox.ts phoneSignIn). A scheduled visit with a real `booking` is
// made the way a customer makes one: /book with the setting
// portal_auto_confirm on. The harness has no clock to move: the visits that
// test the cut-off are written with a start 13 and 11 hours from the real now
// (the default cut-off is 12 hours). The WhatsApp messages are read from the
// sandbox outbox, the dispatcher's and technicians' notifications from the
// notifications module's table, and the reminders `booking` queued are run
// as its job. auth makes at most 3 accounts an hour per address: this file
// signs up one.
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { app, snapshot } from "@renoxium/sdk/test";

import ar from "../i18n/ar.json";
import en from "../i18n/en.json";
import { canChange, cancelReasonOf, type ChangeReason, reasonKey } from "../lib/portal-change";
import { PORTAL_CUTOFF_HOURS, PORTAL_MAX_RESCHEDULES, portalCutoffHours, portalMaxReschedules } from "../lib/settings";
import { outboxOf, phoneSignIn } from "./outbox";

setDefaultTimeout(60_000);
const t = await app();

const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);
const rw = <T>(f: (db: Database) => T): T => {
  const db = new Database(t.dbFile);
  db.exec("pragma busy_timeout = 5000");
  try {
    return f(db);
  } finally {
    db.close();
  }
};
const write = (sql: string, params: (string | number | null)[] = []) => rw((db) => db.run(sql, params));
const located = (res: { headers: Headers }) => res.headers.get("location") ?? "";

async function until<T>(f: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) {
    const v = f();
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

const PETER = "+971521110002";
const DUBAI_PHONE = "+97140000001";
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const service = (code: string) => Number(rows("select id from app__services where code = ?", [code])[0]?.id);
const job = (id: string) => rows("select * from app__jobs where id = ?", [id])[0] as Record<string, unknown>;

/** The first day of the next six (Dubai) that is a full working day: never today, so every slot is ahead and past any cut-off. */
const DAY = (() => {
  for (let i = 2; i < 8; i++) {
    const local = new Date(Date.now() + i * 86_400_000 + 4 * 3_600_000);
    if ([1, 2, 3, 4, 6].includes(local.getUTCDay())) return local.toISOString().slice(0, 10);
  }
  throw new Error("no working day ahead");
})();
/** A working day (Dubai) after DAY, for tests that must not meet the slots the other tests hold. */
const DAYS_AFTER = (() => {
  const out: string[] = [];
  for (let i = 2; i < 8; i++) {
    const key = new Date(Date.now() + i * 86_400_000 + 4 * 3_600_000).toISOString().slice(0, 10);
    const wd = new Date(`${key}T00:00:00Z`).getUTCDay();
    if ([1, 2, 3, 4, 6].includes(wd) && key !== DAY) out.push(key);
  }
  return out;
})();
const AC = String(service("AC-SERVICE"));
const AREA = String(rows("select name_en from gcc__areas where emirate = 'AE-DU' order by name_en limit 1")[0]?.name_en);
const PLACE = { service: AC, emirate: "AE-DU", area: AREA, address: "Marina Gate 2, flat 3301", makani: "", notes: "" };
const STEP2 = `/book?${new URLSearchParams({ ...PLACE, step: "2", day: DAY }).toString()}`;
const slotsIn = (html: string): string[] => [...html.matchAll(/name="slot" value="([^"]+)"/gu)].map((m) => m[1] as string);
const startOf = (slot: string): number => Number(slot.slice(slot.indexOf("@") + 1));

/** A visitor's hold of `slot` on /book step 3 (it holds the slot in `booking`): another customer taking a time. */
async function holdAsVisitor(jar: string, slot: string, phone: string, day = DAY) {
  return t.as(jar).action("/book", "hold", { ...PLACE, day, slot, name: "Other Visitor", phone, language: "en" });
}

// Visits of Peter's the seed does not hold: staff visits 13 and 11 hours ahead, a contract visit in 5 days, two
// `new` self-bookings (one an hour ahead, one in 3 days), all without a `booking` of their own.
rw((db) => {
  const ins = db.prepare(
    "insert into app__jobs (id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, scheduled_start, scheduled_end, technician_user_id, booking_id, created_by, created_at, updated_at, source) values (?, 'br_dubai', 'cu_dxb_02', 'st_dxb_02a', null, ?, ?, 'normal', ?, '', ?, ?, ?, null, 'u_dxb_dispatcher', ?, ?, ?)",
  );
  const handyman = service("HANDYMAN");
  ins.run("jb_chg_13h", "J-000971", "scheduled", handyman, NOW + 13 * HOUR, NOW + 14 * HOUR, "u_dxb_ali", NOW, NOW, "staff");
  ins.run("jb_chg_11h", "J-000972", "scheduled", handyman, NOW + 11 * HOUR, NOW + 12 * HOUR, "u_dxb_ali", NOW, NOW, "staff");
  ins.run("jb_chg_amc", "J-000973", "scheduled", service("AC-SERVICE"), NOW + 5 * 24 * HOUR, NOW + 5 * 24 * HOUR + HOUR, "u_dxb_bilal", NOW, NOW, "contract");
  ins.run("jb_chg_new1h", "J-000974", "new", handyman, NOW + HOUR, NOW + 2 * HOUR, null, NOW, NOW, "self_booking");
  ins.run("jb_chg_new3d", "J-000975", "new", service("AC-SERVICE"), NOW + 3 * 24 * HOUR, NOW + 3 * 24 * HOUR + HOUR, null, NOW, NOW, "self_booking");
});

const peter = t.as("peter");
expect((await phoneSignIn(peter, rows, write, PETER, "/my")).status).toBe(303);
expect((await peter.page("/my")).status).toBe(200);

describe("canChange (lib/portal-change.ts)", () => {
  const rules = { cutoff_hours: 12, max_reschedules: 2 };
  const at = (hours: number | null) => (hours === null ? null : NOW + hours * HOUR);
  const cases: { what: string; status: string; start: number | null; source?: string; moves?: number; want: { cancel: boolean; reschedule: boolean; reason: ChangeReason } }[] = [
    { what: "scheduled, 13 h ahead", status: "scheduled", start: 13, want: { cancel: true, reschedule: true, reason: "ok" } },
    { what: "scheduled, 11 h ahead", status: "scheduled", start: 11, want: { cancel: false, reschedule: false, reason: "too_late" } },
    { what: "scheduled, exactly at the cut-off", status: "scheduled", start: 12, want: { cancel: true, reschedule: true, reason: "ok" } },
    { what: "new, an hour ahead: cancel any time before confirmation", status: "new", start: 1, want: { cancel: true, reschedule: false, reason: "too_late" } },
    { what: "new, no time yet", status: "new", start: null, want: { cancel: true, reschedule: true, reason: "ok" } },
    { what: "on the way", status: "en_route", start: 20, want: { cancel: false, reschedule: false, reason: "in_progress" } },
    { what: "work started", status: "in_progress", start: 20, want: { cancel: false, reschedule: false, reason: "in_progress" } },
    { what: "done", status: "done", start: -20, want: { cancel: false, reschedule: false, reason: "not_scheduled" } },
    { what: "invoiced", status: "invoiced", start: -20, want: { cancel: false, reschedule: false, reason: "not_scheduled" } },
    { what: "cancelled", status: "cancelled", start: 20, want: { cancel: false, reschedule: false, reason: "not_scheduled" } },
    { what: "moved twice already", status: "scheduled", start: 48, moves: 2, want: { cancel: true, reschedule: false, reason: "limit" } },
    { what: "moved once", status: "scheduled", start: 48, moves: 1, want: { cancel: true, reschedule: true, reason: "ok" } },
    { what: "a contract visit", status: "scheduled", start: 48, source: "contract", want: { cancel: false, reschedule: true, reason: "contract_visit" } },
    { what: "a contract visit inside the cut-off", status: "scheduled", start: 2, source: "contract", want: { cancel: false, reschedule: false, reason: "too_late" } },
  ];
  for (const c of cases) {
    test(c.what, () => {
      expect(canChange({ status: c.status, scheduled_start: at(c.start), source: c.source ?? "staff", reschedules: c.moves ?? 0 }, NOW, rules)).toEqual(c.want);
    });
  }

  test("a cut-off of 0 and a limit of 0", () => {
    expect(canChange({ status: "scheduled", scheduled_start: NOW + 60, source: "staff", reschedules: 0 }, NOW, { cutoff_hours: 0, max_reschedules: 0 })).toEqual({ cancel: true, reschedule: false, reason: "limit" });
  });

  test("the settings: whole numbers in range, else the defaults 12 and 2", () => {
    expect([portalCutoffHours({}), portalMaxReschedules({})]).toEqual([12, 2]);
    expect([portalCutoffHours({ portal_cutoff_hours: "24" }), portalMaxReschedules({ portal_max_reschedules: "0" })]).toEqual([24, 0]);
    expect([portalCutoffHours({ portal_cutoff_hours: "169" }), portalCutoffHours({ portal_cutoff_hours: "-1" }), portalCutoffHours({ portal_cutoff_hours: "1.5" })]).toEqual([12, 12, 12]);
    expect([portalMaxReschedules({ portal_max_reschedules: "6" }), portalMaxReschedules({ portal_max_reschedules: "x" })]).toEqual([2, 2]);
    expect([PORTAL_CUTOFF_HOURS.key, PORTAL_MAX_RESCHEDULES.key]).toEqual(["portal_cutoff_hours", "portal_max_reschedules"]);
  });

  test("the cancel reason: optional, one of three, Other with up to 200 characters", () => {
    const f = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    expect(cancelReasonOf(f({}))).toEqual({ value: { reason: "", text: "" } });
    expect(cancelReasonOf(f({ reason: "no_longer_needed", reason_other: "ignored" }))).toEqual({ value: { reason: "no_longer_needed", text: "" } });
    expect(cancelReasonOf(f({ reason: "other", reason_other: " Moving house " }))).toEqual({ value: { reason: "other", text: "Moving house" } });
    expect(cancelReasonOf(f({ reason: "other", reason_other: "x".repeat(201) }))).toEqual({ errors: { reason_other: "my.change.err.other" } });
    expect(cancelReasonOf(f({ reason: "because" }))).toEqual({ errors: { reason: "my.change.err.reason" } });
  });

  test("every reason's sentence is in both catalogues", () => {
    const get = (cat: unknown, key: string) => key.split(".").reduce<unknown>((n, p) => (n as Record<string, unknown>)?.[p], cat);
    for (const r of ["too_late", "not_scheduled", "in_progress", "limit", "contract_visit"] as const) {
      expect([r, typeof get(en, reasonKey(r)), typeof get(ar, reasonKey(r))]).toEqual([r, "string", "string"]);
    }
  });
});

/** Steady text for a snapshot: the days, dates, times and slot values change with the day the test runs. */
const WEEKDAYS = new RegExp([...Object.values(en.backoffice.hours.day), ...Object.values(ar.backoffice.hours.day)].join("|"), "gu");
const steady = (html: string): string =>
  html
    .replace(/<nav class="book-days"[^]*?<\/nav>/u, "<days />")
    .replace(/u_[a-z_]+(?:@|%40)\d{12,15}/gu, "<slot>")
    .replace(/jb_[0-9a-f]{16}/gu, "<job>")
    .replace(/J-\d{6}/gu, "<number>")
    .replace(/\d{4}-\d{2}-\d{2}/gu, "<day>")
    .replace(/\d{2}:\d{2}/gu, "<time>")
    .replace(WEEKDAYS, "<weekday>");

describe("reschedule a confirmed visit", () => {
  let id = "";
  let number = "";
  let firstBooking = "";
  let firstSlot = "";
  let movedTo = "";

  test("setup: Peter books on /book and, with auto-confirm on, the visit is scheduled with a booking", async () => {
    write("insert or replace into app__settings (key, value) values ('portal_auto_confirm', '1')");
    try {
      const page = await peter.page(STEP2);
      firstSlot = slotsIn(page.html)[0] as string;
      const held = await peter.action("/book", "hold", { ...PLACE, day: DAY, slot: firstSlot, name: "Peter Nowak", language: "en" });
      expect(held.status).toBe(303);
      const done = await peter.action(located(held), "confirm", {});
      expect(done.status).toBe(303);
      number = located(done).slice("/my?booked=".length);
    } finally {
      write("delete from app__settings where key = 'portal_auto_confirm'");
    }
    const row = rows("select * from app__jobs where number = ?", [number])[0] as Record<string, unknown>;
    expect(row).toMatchObject({ status: "scheduled", customer_id: "cu_dxb_02" });
    id = String(row.id);
    firstBooking = String(row.booking_id);
    expect(rows("select status from booking__bookings where id = ?", [firstBooking])[0]?.status).toBe("confirmed");
  });

  test("the visit page offers both links", async () => {
    const res = await peter.page(`/my/visits/${id}?lang=en`);
    expect(res.status).toBe(200);
    expect(res.html).toContain(`href="/my/visits/${id}?change=1"`);
    expect(res.html).toContain(`href="/my/visits/${id}?cancel=1"`);
    expect(res.html).toContain("Change the time");
    expect(res.html).toContain("Cancel this visit");
    expect(res.html).not.toContain('id="change-why"');
  });

  test("?change=1 shows the day row and the free slots of the job's branch and service, without its current slot; EN and AR", async () => {
    const res = await peter.page(`/my/visits/${id}?change=1&day=${DAY}&lang=en`);
    expect(res.status).toBe(200);
    expect(res.html).toContain("Choose a new time");
    expect([...res.html.matchAll(/<li><(?:a|strong)\b/gu)].length).toBe(7);
    expect(res.html).toContain('action="?/reschedule"');
    const offered = slotsIn(res.html);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain(firstSlot);
    expect(offered.every((s) => startOf(s) !== startOf(firstSlot))).toBe(true);
    snapshot(steady(res.html), { role: "my visit change, portal customer, en" });
    const arPage = await peter.page(`/my/visits/${id}?change=1&day=${DAY}&lang=ar`);
    expect(arPage.html).toContain("اختر موعداً جديداً");
    snapshot(steady(arPage.html), { role: "my visit change, portal customer, ar" });
    // The language sticks to the session: back to English for the next tests.
    expect((await peter.page("/my?lang=en")).status).toBe(200);
  });

  test("a move: the job keeps `scheduled` with the new time and the slot's technician, the old booking is released, the event and the messages are written", async () => {
    const page = await peter.page(`/my/visits/${id}?change=1&day=${DAY}`);
    movedTo = slotsIn(page.html).at(-1) as string;
    const res = await peter.action(`/my/visits/${id}`, "reschedule", { slot: movedTo, day: DAY });
    expect(res.status).toBe(303);
    expect(located(res)).toBe(`/my/visits/${id}?changed=moved`);
    const after = job(id);
    expect(after).toMatchObject({ status: "scheduled", scheduled_start: Math.floor(startOf(movedTo) / 1000), technician_user_id: movedTo.slice(0, movedTo.indexOf("@")) });
    expect(after.booking_id).not.toBe(firstBooking);
    expect(rows("select status from booking__bookings where id = ?", [firstBooking])[0]?.status).toBe("cancelled");
    expect(rows("select status, start_at from booking__bookings where id = ?", [String(after.booking_id)])[0]).toEqual({ status: "confirmed", start_at: startOf(movedTo) });
    const events = rows("select from_status, to_status, note, by_user_id from app__job_events where job_id = ? and note like 'customer_rescheduled%'", [id]);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ from_status: "scheduled", to_status: "scheduled" });
    expect(String(events[0]?.note)).toContain(" to ");
    const moved = outboxOf(rows, PETER).filter((m) => m.template === "visit_moved");
    expect(moved.length).toBe(1);
    expect(moved[0]?.text).toContain(number);
    await until(() => rows("select title, link from notifications__items where user_id = 'u_dxb_dispatcher' and title like ?", [`Visit ${number} moved by the customer%`])[0], "the dispatcher's notification");
    const page2 = await peter.page(`/my/visits/${id}?changed=moved&lang=en`);
    expect(page2.html).toContain("Your visit is moved.");
    expect(page2.html).toContain("You moved the visit");
  });

  test("the old slot is free again: another customer can book it", async () => {
    expect(slotsIn((await t.as("anyone").page(STEP2)).html)).toContain(firstSlot);
    const res = await holdAsVisitor("other-1", firstSlot, "+971507780001");
    expect(res.status).toBe(303);
    expect(located(res)).toContain("/auth/phone");
  });

  test("no reminder for the old time remains: the old booking's runs point to a cancelled booking, the new one's are queued for the new time", async () => {
    // booking queues its 24 h and 2 h reminders per booking at confirm(), and a run sends only while its
    // booking is still confirmed (modules/booking/lib/core.ts reminderDue). A move is a new booking, so the
    // reminders follow it; the old booking's queued runs find it cancelled.
    const queued = rows("select payload, next_at from renox__outbox where name = 'job:reminder' and target = 'booking'").map((r) => ({ ...(JSON.parse(String(r.payload)) as { booking_id: string; kind: string }), next_at: Number(r.next_at) }));
    const newBooking = String(job(id).booking_id);
    const live = rows("select id from booking__bookings where status = 'confirmed'").map((r) => String(r.id));
    // Every queued reminder of this visit is the new booking's, at the new time; none of the old one's would send.
    for (const r of queued.filter((q) => q.booking_id === firstBooking)) expect(live).not.toContain(r.booking_id);
    const mine = queued.filter((q) => q.booking_id === newBooking);
    expect(mine.length).toBeGreaterThan(0);
    for (const r of mine) expect(r.next_at).toBe(startOf(movedTo) - (r.kind === "24h" ? 24 : 2) * 3_600_000);
    expect(rows("select status from booking__bookings where id = ?", [firstBooking])[0]?.status).toBe("cancelled");
  });

  test("the race: the slot is taken between the form and the post: 409, the reason and the links again, nothing changed", async () => {
    const page = await peter.page(`/my/visits/${id}?change=1&day=${DAY}`);
    const target = slotsIn(page.html)[0] as string;
    expect((await holdAsVisitor("other-2", target, "+971507780002")).status).toBe(303);
    const before = job(id);
    const res = await peter.action(`/my/visits/${id}`, "reschedule", { slot: target, day: DAY });
    expect(res.status).toBe(409);
    expect(res.html).toContain("That time was just taken. Please pick another.");
    expect(res.html).toContain(`href="/my/visits/${id}?change=1"`);
    expect(job(id)).toEqual(before);
    expect(rows("select status from booking__bookings where id = ?", [String(before.booking_id)])[0]?.status).toBe("confirmed");
    expect(rows("select count(*) as n from app__job_events where job_id = ? and note like 'customer_rescheduled%'", [id])[0]?.n).toBe(1);
  });

  test("a slot that is not offered (the current one, or a made-up one) is refused the same way", async () => {
    const current = `${String(job(id).technician_user_id)}@${Number(job(id).scheduled_start) * 1000}`;
    expect((await peter.action(`/my/visits/${id}`, "reschedule", { slot: current })).status).toBe(409);
    expect((await peter.action(`/my/visits/${id}`, "reschedule", { slot: "u_dxb_ali@1000000000000" })).status).toBe(409);
  });

  test("the second move counts, and the third is refused with `limit`", async () => {
    const page = await peter.page(`/my/visits/${id}?change=1&day=${DAY}`);
    const second = slotsIn(page.html)[0] as string;
    expect((await peter.action(`/my/visits/${id}`, "reschedule", { slot: second })).status).toBe(303);
    expect(rows("select count(*) as n from app__job_events where job_id = ? and note like 'customer_rescheduled%'", [id])[0]?.n).toBe(2);
    const visit = await peter.page(`/my/visits/${id}?lang=en`);
    expect(visit.html).not.toContain(`href="/my/visits/${id}?change=1"`);
    expect(visit.html).toContain(`href="/my/visits/${id}?cancel=1"`);
    expect(visit.html).toContain("You have already moved this visit");
    // ?change=1 offers nothing any more, and a post is refused.
    expect((await peter.page(`/my/visits/${id}?change=1&day=${DAY}`)).html).not.toContain('name="slot"');
    const third = slotsIn((await t.as("anyone").page(STEP2)).html)[0] as string;
    const before = job(id);
    const res = await peter.action(`/my/visits/${id}`, "reschedule", { slot: third });
    expect(res.status).toBe(409);
    expect(res.html).toContain("You have already moved this visit");
    expect(job(id)).toEqual(before);
  });
});

describe("a requested time moves on a `new` self-booking", () => {
  test("the job stays `new`, with the new requested time and no technician or booking", async () => {
    const page = await peter.page(`/my/visits/jb_chg_new3d?change=1&day=${DAY}&lang=en`);
    expect(page.html).toContain("The new time is a request: we will confirm it.");
    const slot = slotsIn(page.html)[0] as string;
    const res = await peter.action("/my/visits/jb_chg_new3d", "reschedule", { slot });
    expect(res.status).toBe(303);
    expect(job("jb_chg_new3d")).toMatchObject({ status: "new", scheduled_start: Math.floor(startOf(slot) / 1000), technician_user_id: null, booking_id: null });
    expect(rows("select from_status, to_status from app__job_events where job_id = 'jb_chg_new3d'")).toEqual([{ from_status: "new", to_status: "new" }]);
    expect(outboxOf(rows, PETER).filter((m) => m.template === "visit_moved" && m.text.includes("J-000975")).length).toBe(1);
  });

  test("the technician the page showed is taken meanwhile but another is free at that time: the move goes through silently (#802)", async () => {
    const day = DAYS_AFTER[0] as string;
    // Its own `new` visit: the limit of two moves belongs to the job, and the tests below move jb_chg_new3d.
    write(
      "insert into app__jobs (id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, scheduled_start, scheduled_end, technician_user_id, booking_id, created_by, created_at, updated_at, source) values ('jb_chg_new_race', 'br_dubai', 'cu_dxb_02', 'st_dxb_02a', null, 'J-000976', 'new', 'normal', ?, '', ?, ?, null, null, 'u_dxb_dispatcher', ?, ?, 'self_booking')",
      [service("AC-SERVICE"), NOW + 3 * 24 * HOUR, NOW + 3 * 24 * HOUR + HOUR, NOW, NOW],
    );
    const page = await peter.page(`/my/visits/jb_chg_new_race?change=1&day=${day}&lang=en`);
    const radios = slotsIn(page.html);
    expect(radios.length).toBe(12);
    expect(new Set(radios.map(startOf)).size).toBe(12);
    const slot = radios[0] as string;
    // The technician of the radio is taken by someone else between the page and the post; the other one is free.
    expect((await holdAsVisitor("other-3", slot, "+971507780003", day)).status).toBe(303);
    const res = await peter.action("/my/visits/jb_chg_new_race", "reschedule", { slot, day });
    expect(res.status).toBe(303);
    expect(located(res)).toBe("/my/visits/jb_chg_new_race?changed=moved");
    expect(job("jb_chg_new_race")).toMatchObject({ status: "new", scheduled_start: Math.floor(startOf(slot) / 1000) });
  });

  test("an empty slot is a 422 that keeps the change step", async () => {
    const res = await peter.action("/my/visits/jb_chg_new3d", "reschedule", { slot: "", day: DAY });
    expect(res.status).toBe(422);
    expect(res.html).toContain("Choose a time.");
    expect(res.html).toContain('action="?/reschedule"');
  });
});

describe("cancel within the cut-off", () => {
  test("?cancel=1 asks for confirmation with an optional reason; EN and AR", async () => {
    const res = await peter.page("/my/visits/jb_chg_13h?cancel=1&lang=en");
    expect(res.status).toBe(200);
    expect(res.html).toContain("Cancel this visit?");
    expect(res.html).toContain('action="?/cancel"');
    expect(res.html).toContain('<option value="found_other_time"');
    expect(res.html).toMatch(/<textarea name="reason_other" maxlength="200"/u);
    snapshot(steady(res.html), { role: "my visit cancel, portal customer, en" });
    snapshot(steady((await peter.page("/my/visits/jb_chg_13h?cancel=1&lang=ar")).html), { role: "my visit cancel, portal customer, ar" });
    expect((await peter.page("/my?lang=en")).status).toBe(200);
  });

  test("an unknown reason is a 422 and changes nothing", async () => {
    const res = await peter.action("/my/visits/jb_chg_13h", "cancel", { reason: "because" });
    expect(res.status).toBe(422);
    expect(res.html).toContain("Choose one of the reasons.");
    expect(job("jb_chg_13h").status).toBe("scheduled");
  });

  test("13 hours before: cancelled, with the reason on the timeline, a WhatsApp message, the dispatcher and the technician told", async () => {
    const res = await peter.action("/my/visits/jb_chg_13h", "cancel", { reason: "other", reason_other: "Moving house" });
    expect(res.status).toBe(303);
    expect(located(res)).toBe("/my/visits/jb_chg_13h?changed=cancelled");
    expect(job("jb_chg_13h").status).toBe("cancelled");
    expect(rows("select from_status, to_status, note from app__job_events where job_id = 'jb_chg_13h'")).toEqual([{ from_status: "scheduled", to_status: "cancelled", note: "customer_cancelled: other: Moving house" }]);
    const sent = outboxOf(rows, PETER).filter((m) => m.template === "visit_cancelled");
    expect(sent.length).toBe(1);
    expect(sent[0]?.text).toContain("J-000971");
    await until(() => rows("select 1 from notifications__items where user_id = 'u_dxb_dispatcher' and title = 'Visit J-000971 cancelled by the customer'")[0], "the dispatcher's notification");
    await until(() => rows("select 1 from notifications__items where user_id = 'u_dxb_ali' and title = 'Visit J-000971 cancelled by the customer'")[0], "the technician's notification");
    const page = await peter.page("/my/visits/jb_chg_13h?changed=cancelled&lang=en");
    expect(page.html).toContain("Your visit is cancelled.");
    expect(page.html).toContain("You cancelled the visit");
    expect(page.html).not.toContain("?cancel=1");
  });

  test("11 hours before: no links, the reason and the branch's phone; a posted cancel is 409 with `too_late` and changes nothing", async () => {
    const page = await peter.page("/my/visits/jb_chg_11h?lang=en");
    expect(page.html).not.toContain("?cancel=1");
    expect(page.html).not.toContain("?change=1");
    expect(page.html).toContain("Less than 12 hours to go.");
    expect(page.html).toContain(`Please call <a href="tel:${DUBAI_PHONE}" dir="ltr">${DUBAI_PHONE}</a>.`);
    const res = await peter.action("/my/visits/jb_chg_11h", "cancel", {});
    expect(res.status).toBe(409);
    expect(res.html).toContain("Less than 12 hours to go.");
    expect(job("jb_chg_11h").status).toBe("scheduled");
    expect(rows("select count(*) as n from app__job_events where job_id = 'jb_chg_11h'")[0]?.n).toBe(0);
  });

  test("the cut-off is the company's: with 10 hours the same visit can be cancelled", async () => {
    write("insert or replace into app__settings (key, value) values ('portal_cutoff_hours', '10')");
    try {
      expect((await peter.page("/my/visits/jb_chg_11h")).html).toContain("?cancel=1");
    } finally {
      write("delete from app__settings where key = 'portal_cutoff_hours'");
    }
  });

  test("a contract visit shows no cancel link, and a posted cancel is refused; it can be moved", async () => {
    const page = await peter.page("/my/visits/jb_chg_amc?lang=en");
    expect(page.html).toContain("?change=1");
    expect(page.html).not.toContain("?cancel=1");
    expect(page.html).toContain("This visit is part of your maintenance contract");
    expect((await peter.page("/my/visits/jb_chg_amc?cancel=1")).html).not.toContain('action="?/cancel"');
    const res = await peter.action("/my/visits/jb_chg_amc", "cancel", {});
    expect(res.status).toBe(409);
    expect(job("jb_chg_amc").status).toBe("scheduled");
  });

  test("a `new` self-booking can be cancelled at any time before confirmation, even an hour ahead", async () => {
    const page = await peter.page("/my/visits/jb_chg_new1h?lang=en");
    expect(page.html).toContain("?cancel=1");
    expect(page.html).not.toContain("?change=1");
    const res = await peter.action("/my/visits/jb_chg_new1h", "cancel", { reason: "no_longer_needed" });
    expect(res.status).toBe(303);
    expect(job("jb_chg_new1h").status).toBe("cancelled");
    expect(rows("select note from app__job_events where job_id = 'jb_chg_new1h'")).toEqual([{ note: "customer_cancelled: no longer needed" }]);
  });

  test("a cancelled visit cannot be cancelled again", async () => {
    expect((await peter.action("/my/visits/jb_chg_new1h", "cancel", {})).status).toBe(409);
  });
});

describe("another customer's visit", () => {
  test("is 404 for both actions and both steps, and nothing changes", async () => {
    const before = job("jb_seed_05");
    expect((await peter.page("/my/visits/jb_seed_05?change=1")).status).toBe(404);
    expect((await peter.page("/my/visits/jb_seed_05?cancel=1")).status).toBe(404);
    expect((await peter.action("/my/visits/jb_seed_05", "cancel", {})).status).toBe(404);
    const slot = slotsIn((await t.as("anyone").page(STEP2)).html)[0] as string;
    expect((await peter.action("/my/visits/jb_seed_05", "reschedule", { slot })).status).toBe(404);
    expect((await peter.action("/my/visits/no-such-job", "cancel", {})).status).toBe(404);
    expect(job("jb_seed_05")).toEqual(before);
  });

  test("a signed-out post goes to the phone sign-in, and changes nothing", async () => {
    const res = await t.as("signed-out").action("/my/visits/jb_chg_amc", "cancel", {});
    expect(res.status).toBe(303);
    expect(located(res)).toContain("/auth/phone");
    expect(job("jb_chg_amc").status).toBe("scheduled");
  });
});
