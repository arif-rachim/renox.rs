// Jobs and scheduling (F7-122): the state machine, `booking` slots inside the
// branch's hours and the technician's free time, one booking per scheduled
// visit, and a technician who sees only their own work. Runs on the local
// worker with the seed's users (password below); the seed has two technicians
// per branch (Ali and Bilal in Dubai) and twenty jobs.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { snapshot, app } from "@renoxium/sdk/test";

const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string, next = "/jobs") {
  const u = t.as(jar);
  const res = await u.action("/auth/login", "default", { email, password: PASSWORD, next });
  expect(res.status).toBe(303);
  return u;
}

const dubai = await signIn("dubai", "dispatcher.dubai@fixit.example");
const sharjah = await signIn("sharjah", "dispatcher.sharjah@fixit.example");
const accountant = await signIn("accountant", "accountant.dubai@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example");

const ALI = "u_dxb_ali";
const BILAL = "u_dxb_bilal";
const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);

/** The unix milliseconds of 09:00 (Dubai, UTC+4) on `day`, a Monday at least `after` days from now. */
function mondayAt(hour: number, after: number, minute = 0): { day: string; ms: number } {
  const d = new Date(Date.now() + 4 * 3_600_000 + after * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  const day = d.toISOString().slice(0, 10);
  return { day, ms: Date.parse(`${day}T00:00:00Z`) - 4 * 3_600_000 + (hour * 60 + minute) * 60_000 };
}

const slot = (tech: string, ms: number) => `${tech}@${ms}`;
const jobOf = (number: string) => rows("select * from app__jobs where number = ?", [number])[0] as Record<string, unknown>;
const located = (res: { headers: Headers }) => res.headers.get("location") ?? "";

describe("the seed", () => {
  test("twenty jobs across the states and both branches", () => {
    const by = rows("select status, count(*) as n from app__jobs group by status order by status");
    expect(Object.fromEntries(by.map((r) => [r.status, r.n]))).toEqual({ cancelled: 2, done: 3, en_route: 1, in_progress: 2, invoiced: 1, new: 6, scheduled: 5 });
    expect(rows("select count(*) as n from app__jobs")[0]?.n).toBe(20);
    expect(rows("select branch_id, count(*) as n from app__jobs group by branch_id order by branch_id")).toEqual([
      { branch_id: "br_dubai", n: 14 },
      { branch_id: "br_sharjah", n: 6 },
    ]);
    // The twelve jobs that were scheduled, and went on, have their confirmed booking.
    expect(rows("select count(*) as n from app__jobs j join booking__bookings b on b.id = j.booking_id where b.status = 'confirmed'")[0]?.n).toBe(12);
  });
});

describe("the job list is the branch's own", () => {
  test("a Dubai dispatcher sees the fourteen Dubai jobs and none of Sharjah's", async () => {
    const res = await dubai.page("/jobs");
    expect(res.status).toBe(200);
    for (let n = 1; n <= 14; n++) expect(res.html).toContain(`J-${String(n).padStart(6, "0")}`);
    expect(res.html).not.toContain("J-000015");
    expect(res.html).not.toContain("J-000019");
  });

  test("filters by status, technician and day", async () => {
    const fresh = await dubai.page("/jobs?status=new");
    for (const n of ["J-000001", "J-000002", "J-000003", "J-000004"]) expect(fresh.html).toContain(n);
    expect(fresh.html).not.toContain("J-000005");
    snapshot(fresh.html, { role: "jobs, new, dispatcher, en" });
    const bilal = await dubai.page(`/jobs?technician=${BILAL}`);
    expect(bilal.html).toContain("J-000007");
    expect(bilal.html).not.toContain("J-000006");
    const today = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
    const day = await dubai.page(`/jobs?day=${today}`);
    expect(day.html).toContain("J-000005");
    expect(day.html).not.toContain("J-000006");
  });

  test("the Sharjah dispatcher sees theirs, and cannot open a Dubai job", async () => {
    const res = await sharjah.page("/jobs");
    expect(res.html).toContain("J-000015");
    expect(res.html).not.toContain("J-000001");
    expect((await sharjah.page("/jobs/jb_seed_01")).status).toBe(404);
    expect((await sharjah.action("/jobs/jb_seed_01", "cancel", {})).status).toBe(404);
    expect(jobOf("J-000001").status).toBe("new");
  });

  test("the list in Arabic, right to left", async () => {
    const res = await dubai.page("/jobs?lang=ar");
    expect(res.html).toContain('<html lang="ar" dir="rtl"');
    expect(res.html).toContain("المهام");
  });
});

describe("a technician sees only their own jobs", () => {
  test("normal case: Ali's /jobs lists the four jobs assigned to Ali", async () => {
    const res = await ali.page("/jobs");
    expect(res.status).toBe(200);
    for (const n of ["J-000005", "J-000006", "J-000010", "J-000012"]) expect(res.html).toContain(n);
    for (const n of ["J-000001", "J-000007", "J-000009", "J-000013", "J-000017"]) expect(res.html).not.toContain(n);
    expect(res.html).not.toContain("/jobs/new");
  });

  test("error case: another technician's job is 403, their own is 200", async () => {
    expect((await ali.page("/jobs/jb_seed_07")).status).toBe(403);
    expect((await ali.page("/jobs/jb_seed_01")).status).toBe(403);
    const own = await ali.page("/jobs/jb_seed_06");
    expect(own.status).toBe(200);
    expect(own.html).not.toContain('id="schedule"');
  });

  test("an accountant reads every job of the branch", async () => {
    const res = await accountant.page("/jobs");
    expect(res.html).toContain("J-000007");
    expect(res.html).toContain("J-000001");
    expect((await accountant.page("/jobs/jb_seed_07")).status).toBe(200);
  });

  test("a technician cannot open the dispatch board or create a job", async () => {
    expect((await ali.page("/dispatch")).status).toBe(403);
    expect((await ali.page("/jobs/new")).status).toBe(403);
  });
});

describe("an approved quotation becomes a job, which is scheduled with a technician and a booking", () => {
  const first = mondayAt(9, 8);
  let id = "";
  let number = "";

  test("only an approved quotation is offered: the form fills in its site and service", async () => {
    const draft = await dubai.page("/jobs/new?quote=qt_seed_01");
    expect(draft.html).not.toContain('id="from-quote"');
    const res = await dubai.page("/jobs/new?quote=qt_seed_04");
    expect(res.status).toBe(200);
    expect(res.html).toContain('id="from-quote"');
    expect(res.html).toContain("Q-000004");
    expect(res.html).toContain('name="quote_id"');
    // The approved quotation's page links to it; a sent one's does not.
    expect((await dubai.page("/quotes/qt_seed_04")).html).toContain('href="/jobs/new?quote=qt_seed_04"');
    expect((await dubai.page("/quotes/qt_seed_02")).html).not.toContain("/jobs/new");
  });

  test("a quotation that is not approved is refused with 409", async () => {
    const res = await dubai.action("/jobs/new", "create", { site_id: "st_dxb_01a", quote_id: "qt_seed_01", service: String(rows("select id from app__services where code = 'AC-SERVICE'")[0]?.id) });
    expect(res.status).toBe(409);
    expect(res.html).toContain("approved");
  });

  test("normal case: approved quotation to a `new` job", async () => {
    const service = String(rows("select id from app__services where code = 'AC-REPAIR'")[0]?.id);
    const res = await dubai.action("/jobs/new", "create", { site_id: "st_dxb_03a", quote_id: "qt_seed_04", service, priority: "high", description: "Q-000004: AC repair" });
    expect(res.status).toBe(303);
    id = located(res).replace("/jobs/", "");
    const job = rows("select * from app__jobs where id = ?", [id])[0] as Record<string, unknown>;
    number = String(job.number);
    expect(number).toBe("J-000021");
    expect(job).toMatchObject({ status: "new", quote_id: "qt_seed_04", customer_id: "cu_dxb_03", branch_id: "br_dubai", priority: "high", technician_user_id: null, booking_id: null });
    expect(rows("select to_status, note from app__job_events where job_id = ?", [id])).toEqual([{ to_status: "new", note: "created from a quotation" }]);
  });

  test("the quotation has one live job: a second is refused", async () => {
    const service = String(rows("select id from app__services where code = 'AC-REPAIR'")[0]?.id);
    const res = await dubai.action("/jobs/new", "create", { site_id: "st_dxb_03a", quote_id: "qt_seed_04", service });
    expect(res.status).toBe(409);
    expect(res.html).toContain(number);
  });

  test("the slot picker offers starts inside the branch's hours and Ali's free time only", async () => {
    const res = await dubai.page(`/jobs/${id}?day=${first.day}&technician=${ALI}`);
    expect(res.status).toBe(200);
    expect(res.html).toContain(`value="${slot(ALI, first.ms)}"`);
    const starts = [...res.html.matchAll(new RegExp(`value="${ALI}@(\\d+)"`, "gu"))].map((m) => Number(m[1]));
    // 08:00 to 18:00 on a Monday, a 90 minute visit on a 30 minute grid: 08:00 to 16:30, eighteen starts.
    expect(starts.length).toBe(18);
    expect(starts[0]).toBe(first.ms - 3_600_000);
    expect(starts[starts.length - 1]).toBe(first.ms + 7.5 * 3_600_000);
    expect(res.html).not.toContain(`value="${BILAL}@`);
  });

  test("Friday opens at 14:00, Sunday is closed", async () => {
    const fri = new Date(`${first.day}T00:00:00Z`);
    fri.setUTCDate(fri.getUTCDate() + 4);
    const friday = await dubai.page(`/jobs/${id}?day=${fri.toISOString().slice(0, 10)}&technician=${ALI}`);
    const starts = [...friday.html.matchAll(new RegExp(`value="${ALI}@(\\d+)"`, "gu"))].map((m) => Number(m[1]));
    expect(starts[0]).toBe(first.ms + 4 * 86_400_000 + 5 * 3_600_000);
    const sun = new Date(`${first.day}T00:00:00Z`);
    sun.setUTCDate(sun.getUTCDate() - 1);
    const sunday = await dubai.page(`/jobs/${id}?day=${sun.toISOString().slice(0, 10)}&technician=${ALI}`);
    expect(sunday.html).not.toContain(`value="${ALI}@`);
    expect(sunday.html).toContain('id="no-slots"');
  });

  test("normal case: schedule at 09:00 with Ali: scheduled, and a confirmed booking exists", async () => {
    const res = await dubai.action(`/jobs/${id}`, "schedule", { slot: slot(ALI, first.ms), note: "Bring a ladder" });
    expect(res.status).toBe(303);
    const job = jobOf(number);
    expect(job).toMatchObject({ status: "scheduled", technician_user_id: ALI, scheduled_start: first.ms / 1000, scheduled_end: first.ms / 1000 + 90 * 60 });
    const booking = rows("select * from booking__bookings where id = ?", [job.booking_id as string])[0];
    expect(booking).toMatchObject({ status: "confirmed", staff_id: ALI, service_id: "ac-repair", customer: "cu_dxb_03", start_at: first.ms, end_at: first.ms + 90 * 60_000 });
    const page = await dubai.page(`/jobs/${id}`);
    expect(page.html).toContain("Bring a ladder");
    expect(page.html).toContain("Ali Hassan");
    // The timeline has the creation and the scheduling.
    expect(rows("select from_status, to_status from app__job_events where job_id = ? order by id", [id])).toEqual([
      { from_status: null, to_status: "new" },
      { from_status: "new", to_status: "scheduled" },
    ]);
  });

  test("each transition is audited", () => {
    const events = rows("select action, actor_id, resource_id, result from audit__events where action = 'job.transition' and resource_id = ?", [id]);
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ actor_id: "u_dxb_dispatcher", result: "ok" });
  });

  test("the booked start is no longer offered to anyone", async () => {
    const res = await dubai.page(`/jobs/${id}?day=${first.day}&technician=${ALI}`);
    expect(res.html).not.toContain(`value="${slot(ALI, first.ms)}"`);
    // 09:00 to 10:30 is taken: 08:00 would run into it, the next start is 10:30.
    expect(res.html).not.toContain(`value="${slot(ALI, first.ms - 1_800_000)}"`);
    expect(res.html).toContain(`value="${slot(ALI, first.ms + 5_400_000)}"`);
  });

  test("edge case: a slot already booked for Ali is refused, naming the next free slot", async () => {
    const other = await dubai.action("/jobs/new", "create", { site_id: "st_dxb_01a", service: String(rows("select id from app__services where code = 'AC-REPAIR'")[0]?.id) });
    const otherId = located(other).replace("/jobs/", "");
    const res = await dubai.action(`/jobs/${otherId}`, "schedule", { slot: slot(ALI, first.ms + 1_800_000) });
    expect(res.status).toBe(409);
    expect(res.html).toContain("Ali Hassan is not free at");
    expect(res.html).toContain(`${first.day} 10:30`);
    // Nothing changed: still new, no booking.
    expect(rows("select status, booking_id from app__jobs where id = ?", [otherId])[0]).toEqual({ status: "new", booking_id: null });
    expect(rows("select count(*) as n from booking__bookings where staff_id = ? and start_at = ?", [ALI, first.ms + 1_800_000])[0]?.n).toBe(0);
    // The suggestion works.
    const next = await dubai.action(`/jobs/${otherId}`, "schedule", { slot: slot(ALI, first.ms + 5_400_000) });
    expect(next.status).toBe(303);
  });

  test("a start outside the hours is refused too", async () => {
    const late = mondayAt(19, 8);
    const early = mondayAt(6, 8);
    for (const ms of [late.ms, early.ms, first.ms - 86_400_000]) {
      const res = await dubai.action(`/jobs/${id}`, "schedule", { slot: slot(BILAL, ms) });
      expect(res.status).toBe(409);
    }
    expect(jobOf(number)).toMatchObject({ technician_user_id: ALI, scheduled_start: first.ms / 1000 });
  });

  test("moving the job books the new slot and releases the old booking", async () => {
    const before = jobOf(number).booking_id as string;
    const later = mondayAt(13, 8);
    const res = await dubai.action(`/jobs/${id}`, "schedule", { slot: slot(ALI, later.ms) });
    expect(res.status).toBe(303);
    const job = jobOf(number);
    expect(job).toMatchObject({ status: "scheduled", scheduled_start: later.ms / 1000 });
    expect(job.booking_id).not.toBe(before);
    expect(rows("select status from booking__bookings where id = ?", [before])[0]?.status).toBe("cancelled");
    expect(rows("select status from booking__bookings where id = ?", [job.booking_id as string])[0]?.status).toBe("confirmed");
  });

  test("assigning a scheduled job to Bilal keeps its time; a taken time for Bilal is refused", async () => {
    const res = await dubai.action(`/jobs/${id}`, "assign", { technician: BILAL });
    expect(res.status).toBe(303);
    const job = jobOf(number);
    expect(job).toMatchObject({ technician_user_id: BILAL, status: "scheduled" });
    expect(rows("select staff_id, status from booking__bookings where id = ?", [job.booking_id as string])[0]).toEqual({ staff_id: BILAL, status: "confirmed" });
    // Ali is free at that time now: a third job takes it, and giving it to Bilal is refused.
    const service = String(rows("select id from app__services where code = 'AC-REPAIR'")[0]?.id);
    const third = located(await dubai.action("/jobs/new", "create", { site_id: "st_dxb_01a", service })).replace("/jobs/", "");
    const at = mondayAt(13, 8);
    expect((await dubai.action(`/jobs/${third}`, "schedule", { slot: slot(ALI, at.ms) })).status).toBe(303);
    const busy = await dubai.action(`/jobs/${third}`, "assign", { technician: BILAL });
    expect(busy.status).toBe(409);
    expect(busy.html).toContain("Bilal Raza is not free at");
    expect(rows("select technician_user_id from app__jobs where id = ?", [third])[0]?.technician_user_id).toBe(ALI);
  });

  test("error case: a technician scheduling a job is 403", async () => {
    const res = await ali.action("/jobs/jb_seed_06", "schedule", { slot: slot(ALI, mondayAt(15, 9).ms) });
    expect(res.status).toBe(403);
    expect((await ali.action("/jobs/jb_seed_06", "assign", { technician: BILAL })).status).toBe(403);
    expect((await ali.action("/jobs/jb_seed_06", "cancel", {})).status).toBe(403);
    expect((await ali.action("/jobs/jb_seed_06", "status", { to: "done" })).status).toBe(403);
    expect(jobOf("J-000006")).toMatchObject({ status: "scheduled", technician_user_id: ALI });
  });

  test("an invalid slot or technician is a 422 naming the field", async () => {
    const bad = await dubai.action(`/jobs/${id}`, "schedule", { slot: "nonsense" });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('id="err-slot"');
    const unknown = await dubai.action(`/jobs/${id}`, "schedule", { slot: slot("u_shj_hamad", mondayAt(9, 9).ms) });
    expect(unknown.status).toBe(422);
    expect(unknown.html).toContain("technician of this branch");
  });

  test("cancelling the job cancels its booking, and cancelling twice is a 409", async () => {
    const bookingId = jobOf(number).booking_id as string;
    const res = await dubai.action(`/jobs/${id}`, "cancel", { note: "Customer moved out" });
    expect(res.status).toBe(303);
    expect(jobOf(number).status).toBe("cancelled");
    expect(rows("select status from booking__bookings where id = ?", [bookingId])[0]?.status).toBe("cancelled");
    expect(rows("select note from app__job_events where job_id = ? order by id desc limit 1", [id])[0]?.note).toBe("Customer moved out");
    const again = await dubai.action(`/jobs/${id}`, "cancel", {});
    expect(again.status).toBe(409);
    // The quotation is free for a new job once its job is cancelled.
    const service = String(rows("select id from app__services where code = 'AC-REPAIR'")[0]?.id);
    expect((await dubai.action("/jobs/new", "create", { site_id: "st_dxb_03a", quote_id: "qt_seed_04", service })).status).toBe(303);
  });
});

describe("the state machine", () => {
  test("error case: a done job cannot go back to new (409), nor can a cancelled one be scheduled", async () => {
    const res = await dubai.action("/jobs/jb_seed_12", "status", { to: "new" });
    expect(res.status).toBe(409);
    expect(res.html).toContain("done job cannot become new");
    expect(jobOf("J-000012").status).toBe("done");
    expect((await dubai.action("/jobs/jb_seed_14", "schedule", { slot: slot(ALI, mondayAt(9, 12).ms) })).status).toBe(409);
    expect((await dubai.action("/jobs/jb_seed_01", "status", { to: "done" })).status).toBe(409);
    expect((await dubai.action("/jobs/jb_seed_01", "status", { to: "teleported" })).status).toBe(422);
  });

  test("normal case: a visit goes en route, in progress, done, invoiced; every step is an event", async () => {
    const id = "jb_seed_05";
    for (const to of ["en_route", "in_progress", "done", "invoiced"]) {
      const res = await dubai.action(`/jobs/${id}`, "status", { to, note: `to ${to}` });
      expect(res.status).toBe(303);
      expect(jobOf("J-000005").status).toBe(to);
    }
    const timeline = rows("select from_status, to_status, note from app__job_events where job_id = ? order by id", [id]);
    expect(timeline.slice(-4)).toEqual([
      { from_status: "scheduled", to_status: "en_route", note: "to en_route" },
      { from_status: "en_route", to_status: "in_progress", note: "to in_progress" },
      { from_status: "in_progress", to_status: "done", note: "to done" },
      { from_status: "done", to_status: "invoiced", note: "to invoiced" },
    ]);
    expect((await dubai.action(`/jobs/${id}`, "status", { to: "done" })).status).toBe(409);
  });

  test("back to new releases the booking and the schedule", async () => {
    const bookingId = jobOf("J-000008").booking_id as string;
    expect(bookingId).toBe("bk_seed_08");
    expect((await dubai.action("/jobs/jb_seed_08", "status", { to: "new" })).status).toBe(303);
    expect(jobOf("J-000008")).toMatchObject({ status: "new", booking_id: null, scheduled_start: null });
    expect(rows("select status from booking__bookings where id = ?", [bookingId])[0]?.status).toBe("cancelled");
  });
});

describe("booking is told about technicians the first time they are seen", () => {
  test("a technician added later is registered once, with the branch's hours", async () => {
    const db = new Database(t.dbFile);
    db.run("insert into auth__users (id, email, display_name, password_hash, email_verified_at, created_at, updated_at) select 'u_dxb_chandra', 'chandra.dubai@fixit.example', 'Chandra Iyer', password_hash, email_verified_at, created_at, updated_at from auth__users where id = 'u_dxb_dispatcher'");
    db.run("insert into org__members (org_id, user_id, role, created_at) values ('org_dubai', 'u_dxb_chandra', 'member', 1793000000)");
    db.run("insert into renox__role_assignments (user_id, role, scope_type, scope_id, granted_by, at) values ('u_dxb_chandra', 'technician', 'global', '', 'test', 1793000000000)");
    db.close();
    expect(rows("select count(*) as n from booking__staff where id = 'u_dxb_chandra'")[0]?.n).toBe(0);
    const day = mondayAt(9, 15);
    const res = await dubai.page(`/jobs/jb_seed_01?day=${day.day}&technician=u_dxb_chandra`);
    expect(res.html).toContain(`value="u_dxb_chandra@${day.ms}"`);
    expect(rows("select name, user_id from booking__staff where id = 'u_dxb_chandra'")).toEqual([{ name: "Chandra Iyer", user_id: "u_dxb_chandra" }]);
    expect(rows("select weekday, open_min, close_min from booking__hours where staff_id = 'u_dxb_chandra' order by weekday")).toEqual([
      { weekday: 1, open_min: 480, close_min: 1080 },
      { weekday: 2, open_min: 480, close_min: 1080 },
      { weekday: 3, open_min: 480, close_min: 1080 },
      { weekday: 4, open_min: 480, close_min: 1080 },
      { weekday: 5, open_min: 840, close_min: 1080 },
      { weekday: 6, open_min: 480, close_min: 1080 },
    ]);
    // A second visit adds nothing: booking inserts a row of hours at every setHours call.
    await dubai.page(`/jobs/jb_seed_01?day=${day.day}`);
    expect(rows("select count(*) as n from booking__hours where staff_id = 'u_dxb_chandra'")[0]?.n).toBe(6);
    expect(rows("select count(*) as n from booking__staff_services where staff_id = 'u_dxb_chandra'")[0]?.n).toBe(8);
  });

  test("the Sharjah dispatcher's slot picker never offers Dubai's technicians", async () => {
    const day = mondayAt(9, 15);
    const res = await sharjah.page(`/jobs/jb_seed_15?day=${day.day}`);
    expect(res.status).toBe(200);
    expect(res.html).toContain("u_shj_hamad@");
    expect(res.html).toContain("u_shj_imran@");
    expect(res.html).not.toContain("u_dxb_");
  });
});
