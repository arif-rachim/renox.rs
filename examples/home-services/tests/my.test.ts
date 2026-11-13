// The customer portal's lists and visit page (#776): a signed-in customer sees
// their upcoming visits (a `new` self-booking with its requested time,
// "waiting for confirmation"), their past visits (10 a page) and their active
// maintenance contracts on `/my`, and one visit on `/my/visits/<id>`: the
// timeline in plain words, the address, their notes, the technician's first
// name and the branch's phone. Another customer's visit is a 404; internal
// notes, costs and the technician's last name are never in the page. Peter
// Nowak (cu_dxb_02, seed) is the customer, and here he is a customer of
// Sharjah too. The phone sign-in goes through auth's real pages
// (tests/outbox.ts phoneSignIn). auth makes at most 3 accounts an hour per
// address: this file signs up one.
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { app, snapshot } from "@renoxium/sdk/test";

import ar from "../i18n/ar.json";
import en from "../i18n/en.json";
import { firstName } from "../lib/customer-db";
import { clockOf, dayOf, eventKey, isLive, pageOf, statusKey } from "../lib/portal-view";
import { phoneSignIn } from "./outbox";

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

const PETER = "+971521110002";
const NOW = Math.floor(Date.now() / 1000);
const DAY_S = 86_400;
/** The start of today in Dubai (unix seconds), and a Dubai day `n` days from today. */
const TODAY = Math.floor((NOW + 4 * 3600) / DAY_S) * DAY_S - 4 * 3600;
const dayIn = (n: number) => dayOf(TODAY + n * DAY_S + 12 * 3600);
const service = (code: string) => Number(rows("select id from app__services where code = ?", [code])[0]?.id);

// What the seed does not hold for Peter: a self-booking waiting for confirmation, an internal note on his
// scheduled job, an active contract that ends in 20 days, eleven more past visits (for the paging), and a
// customer row of Sharjah with his phone, with a site and a confirmed visit there.
const SELF_START = TODAY + 3 * DAY_S + 10 * 3600;
const INTERNAL = "INTERNAL-776 gate code 4471, customer is difficult";
rw((db) => {
  const job = db.prepare(
    "insert into app__jobs (id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, scheduled_start, scheduled_end, technician_user_id, booking_id, created_by, created_at, updated_at, source) values (?, ?, ?, ?, null, ?, ?, 'normal', ?, ?, ?, ?, ?, null, ?, ?, ?, ?)",
  );
  const event = db.prepare("insert into app__job_events (job_id, branch_id, at, by_user_id, from_status, to_status, note) values (?, ?, ?, ?, ?, ?, ?)");
  job.run("jb_my_self", "br_dubai", "cu_dxb_02", "st_dxb_02a", "J-000901", "new", service("AC-REPAIR"), "Please ring twice, the bell is weak.", SELF_START, SELF_START + 3600, null, "u_peter", NOW - 600, NOW - 600, "self_booking");
  event.run("jb_my_self", "br_dubai", NOW - 600, null, null, "new", "self-booked: requested, waiting for the dispatcher");
  // On his scheduled visit J-000006 (Ali, tomorrow): a note of the dispatcher's, with no status change, and one with.
  event.run("jb_seed_06", "br_dubai", NOW - 300, "u_dxb_dispatcher", null, null, INTERNAL);
  event.run("jb_seed_06", "br_dubai", NOW - 200, "u_dxb_dispatcher", "scheduled", "scheduled", `${INTERNAL} (rescheduled)`);
  for (let i = 0; i < 11; i++) {
    const start = TODAY - (40 + i) * DAY_S + 9 * 3600;
    job.run(`jb_my_past_${i}`, "br_dubai", "cu_dxb_02", "st_dxb_02a", `J-0009${30 + i}`, "done", service("HANDYMAN"), "Staff description, not for the customer.", start, start + 3600, "u_dxb_bilal", "u_dxb_dispatcher", start - DAY_S, start, "staff");
  }
  db.run(
    "insert into app__contracts (id, branch_id, customer_id, number, status, starts_on, ends_on, price_fils, vat_rate, billing, notes, invoice_id, renewed_from, renewal_notified_on, created_by, created_at, activated_at) values ('ct_my_01', 'br_dubai', 'cu_dxb_02', 'AMC-000901', 'active', ?, ?, 120000, 5, 'upfront', 'Internal: discount agreed by Omar.', null, null, null, 'u_dxb_dispatcher', ?, ?)",
    [dayIn(-345), dayIn(20), NOW - 345 * DAY_S, NOW - 345 * DAY_S],
  );
  db.run("insert into app__contract_items (contract_id, branch_id, site_id, service_id, visits_per_year, next_visit_on) values ('ct_my_01', 'br_dubai', 'st_dxb_02a', ?, 4, ?)", [service("AC-SERVICE"), dayIn(12)]);
  db.run("insert into app__contracts (id, branch_id, customer_id, number, status, starts_on, ends_on, price_fils, vat_rate, billing, notes, invoice_id, renewed_from, renewal_notified_on, created_by, created_at, activated_at) values ('ct_my_02', 'br_dubai', 'cu_dxb_02', 'AMC-000902', 'draft', ?, ?, 90000, 5, 'upfront', '', null, null, null, 'u_dxb_dispatcher', ?, null)", [dayIn(1), dayIn(365), NOW]);
  db.run("insert into app__customers (id, branch_id, kind, name, trn, phone, email, language, created_at) values ('cu_shj_peter', 'br_sharjah', 'household', 'Peter Nowak', null, ?, null, 'en', ?)", [PETER, NOW - DAY_S]);
  db.run("insert into app__sites (id, customer_id, branch_id, label, emirate, area, address, makani, lat, lng, access_notes) values ('st_shj_peter', 'cu_shj_peter', 'br_sharjah', 'Holiday flat', 'AE-SH', 'Al Majaz', 'Majaz Tower, flat 804', null, null, null, 'Key with the concierge.')");
  const shjStart = TODAY + 2 * DAY_S + 14 * 3600;
  job.run("jb_my_shj", "br_sharjah", "cu_shj_peter", "st_shj_peter", "J-000920", "scheduled", service("PEST"), "", shjStart, shjStart + 5400, "u_shj_hamad", "u_shj_dispatcher", NOW - DAY_S, NOW - DAY_S, "staff");
  event.run("jb_my_shj", "br_sharjah", NOW - DAY_S, "u_shj_dispatcher", null, "new", "created");
  event.run("jb_my_shj", "br_sharjah", NOW - DAY_S + 60, "u_shj_dispatcher", "new", "scheduled", "");
});

const peter = t.as("peter");
expect((await phoneSignIn(peter, rows, write, PETER, "/my")).status).toBe(303);

const ids = (html: string, prefix: string) => [...html.matchAll(new RegExp(`<li id="${prefix}-([A-Za-z0-9_]+)"`, "gu"))].map((m) => m[1]);
/** The upcoming item of a job on /my, as HTML. */
const itemOf = (html: string, id: string) => /<li id="upcoming-([^"]+)">[^]*?<\/li>/gu.exec(html.slice(html.indexOf(`<li id="upcoming-${id}"`)))?.[0] ?? "";
const WEEKDAYS = new RegExp([...Object.values(en.backoffice.hours.day), ...Object.values(ar.backoffice.hours.day)].join("|"), "gu");
const steady = (html: string): string =>
  html
    .replace(/\d{4}-\d{2}-\d{2}/gu, "<day>")
    .replace(/\d{2}:\d{2}/gu, "<time>")
    .replace(WEEKDAYS, "<weekday>");

describe("the customer-facing words (lib/portal-view.ts)", () => {
  test("statuses: a plain word for each, an invoiced job is Done", () => {
    expect(["new", "scheduled", "en_route", "in_progress", "done", "invoiced", "cancelled"].map((s) => statusKey(s))).toEqual([
      "my.status.new",
      "my.status.scheduled",
      "my.status.en_route",
      "my.status.in_progress",
      "my.status.done",
      "my.status.done",
      "my.status.cancelled",
    ]);
    expect([en.my.status.scheduled, en.my.status.en_route, en.my.status.in_progress]).toEqual(["Confirmed", "On the way", "Work in progress"]);
  });

  test("timeline events: requested, confirmed, on the way, started, finished, cancelled; a note or the invoicing is not shown", () => {
    expect(["new", "scheduled", "en_route", "in_progress", "done", "cancelled"].map((s) => eventKey(s))).toEqual([
      "my.event.requested",
      "my.event.confirmed",
      "my.event.en_route",
      "my.event.started",
      "my.event.finished",
      "my.event.cancelled",
    ]);
    expect(eventKey(null)).toBeNull();
    expect(eventKey("invoiced")).toBeNull();
  });

  test("every key the mapping names is in both catalogues", () => {
    const keys = [...["new", "scheduled", "en_route", "in_progress", "done", "cancelled", "other"].map(statusKey), ...["new", "scheduled", "en_route", "in_progress", "done", "cancelled"].map((s) => eventKey(s) as string)];
    for (const cat of [en, ar] as Record<string, unknown>[]) {
      for (const k of keys) expect([k, typeof k.split(".").reduce<unknown>((n, p) => (n as Record<string, unknown>)?.[p], cat)]).toEqual([k, "string"]);
    }
  });

  test("Dubai times, the live reload, the page number, the first name", () => {
    expect([dayOf(1793400000), clockOf(1793400000)]).toEqual(["2026-10-31", "02:40"]);
    expect(isLive(["new", "scheduled"])).toBe(false);
    expect(isLive(["scheduled", "en_route"])).toBe(true);
    expect(isLive(["in_progress"])).toBe(true);
    expect([pageOf(null), pageOf("2"), pageOf("0"), pageOf("-1"), pageOf("x"), pageOf("1e3")]).toEqual([1, 2, 1, 1, 1, 1]);
    expect([firstName("Ali Hassan"), firstName("  Bilal  Raza "), firstName("Hamad"), firstName("")]).toEqual(["Ali", "Bilal", "Hamad", ""]);
  });
});

describe("/my", () => {
  test("upcoming: soonest first, at most 10, with the time in Dubai, the technician's first name and the status in plain words", async () => {
    const res = await peter.page("/my?lang=en");
    expect(res.status).toBe(200);
    const upcoming = ids(res.html, "upcoming");
    // J-000006 (tomorrow, Ali), the Sharjah visit (in 2 days), the self-booking (in 3 days), then J-000002 (new, no time).
    expect(upcoming).toEqual(["jb_seed_06", "jb_my_shj", "jb_my_self", "jb_seed_02"]);
    const j6 = itemOf(res.html, "jb_seed_06");
    expect(j6).toContain("Pest control");
    expect(j6).toContain("Villa");
    expect(j6).toContain("Al Barsha");
    expect(j6).toContain("Confirmed");
    expect(j6).toContain("Technician: Ali");
    const start = Number(rows("select scheduled_start from app__jobs where id = 'jb_seed_06'")[0]?.scheduled_start);
    expect(j6).toContain(`<span dir="ltr">${dayOf(start)}</span> <span dir="ltr">${clockOf(start)}–${clockOf(start + 5400)}</span>`);
    expect(j6).toContain('href="/my/visits/jb_seed_06"');
    expect(j6).toContain('<span dir="ltr">J-000006</span>');
    expect(res.html).not.toContain("Hassan");
  });

  test("a `new` self-booking shows its requested time, waiting for confirmation, and no technician", async () => {
    const res = await peter.page("/my?lang=en");
    const self = itemOf(res.html, "jb_my_self");
    expect(self).toContain(`Requested for ${en.backoffice.hours.day[String(new Date((SELF_START + 4 * 3600) * 1000).getUTCDay()) as "1"]} <span dir="ltr">${dayOf(SELF_START)}</span> <span dir="ltr">${clockOf(SELF_START)}–${clockOf(SELF_START + 3600)}</span>, waiting for confirmation`);
    expect(self).toContain("Waiting for confirmation");
    expect(self).not.toContain("Technician");
    const j2 = itemOf(res.html, "jb_seed_02");
    expect(j2).toContain("We will call you to agree a time.");
  });

  test("past visits: done and cancelled, newest first, 10 a page with ?page=", async () => {
    const one = await peter.page("/my?lang=en");
    const first = ids(one.html, "past");
    expect(first.length).toBe(10);
    expect(one.html).toContain('href="/my?page=2#past"');
    expect(one.html).not.toContain('rel="prev"');
    const two = await peter.page("/my?page=2&lang=en");
    const second = ids(two.html, "past");
    expect(second.length).toBe(3);
    expect(two.html).toContain('href="/my?page=1#past"');
    expect(new Set([...first, ...second])).toEqual(new Set(["jb_seed_11", "jb_seed_14", ...Array.from({ length: 11 }, (_, i) => `jb_my_past_${i}`)]));
    // Newest first: the done visit of the seed (today) leads, the oldest added one closes.
    expect(first[0]).toBe("jb_seed_11");
    expect(second.at(-1)).toBe("jb_my_past_10");
    expect(one.html).toContain("Cancelled");
    // A page past the end shows the last one.
    expect(ids((await peter.page("/my?page=9&lang=en")).html, "past")).toEqual(second);
  });

  test("contracts: the active one with its period, what it covers, the next planned visit and the renewal note; a draft is not listed", async () => {
    const res = await peter.page("/my?lang=en");
    expect(ids(res.html, "contract")).toEqual(["ct_my_01"]);
    const c = /<li id="contract-ct_my_01">[^]*?<\/ul>[^]*?<\/li>/u.exec(res.html)?.[0] ?? "";
    expect(c).toContain('<strong dir="ltr">AMC-000901</strong>');
    expect(c).toContain(`<span dir="ltr">${dayIn(-345)} – ${dayIn(20)}</span>`);
    expect(c).toContain('AC service · Villa · <span dir="ltr">4</span> visits a year');
    expect(c).toContain(`Next planned visit: <span dir="ltr">${dayIn(12)}</span>`);
    expect(c).toContain(`Ends on <span dir="ltr">${dayIn(20)}</span>. We will contact you about renewal.`);
    expect(res.html).not.toContain("AMC-000902");
    expect(res.html).not.toContain("discount agreed");
  });

  test("a customer of two branches sees both branches' items, each marked with the branch", async () => {
    const res = await peter.page("/my?lang=en");
    expect(itemOf(res.html, "jb_my_shj")).toContain("Branch: Sharjah");
    expect(itemOf(res.html, "jb_my_shj")).toContain("Holiday flat");
    expect(itemOf(res.html, "jb_seed_06")).toContain("Branch: Dubai");
  });

  test("staff-only data is not in the page: internal notes, staff descriptions, costs, other customers", async () => {
    const res = await peter.page("/my?lang=en");
    for (const hidden of [INTERNAL, "Staff description", "Ants in the kitchen.", "Customer found someone else.", "Gate code at the guard post.", "Layla", "Marina Heights", "120000", "1,200"]) expect([hidden, res.html.includes(hidden)]).toEqual([hidden, false]);
  });

  test("the page reloads itself every minute only while a visit is on its way or in progress", async () => {
    expect((await peter.page("/my?lang=en")).html).not.toContain('http-equiv="refresh"');
    write("update app__jobs set status = 'en_route' where id = 'jb_seed_06'");
    try {
      const res = await peter.page("/my?lang=en");
      expect(res.html).toContain('<meta http-equiv="refresh" content="60">');
      expect(itemOf(res.html, "jb_seed_06")).toContain("On the way");
    } finally {
      write("update app__jobs set status = 'scheduled' where id = 'jb_seed_06'");
    }
  });

  test("empty states in plain words", async () => {
    write("update app__customers set phone = '+971500000000' where id in ('cu_dxb_02', 'cu_shj_peter')");
    write("update app__customers set user_id = null where id in ('cu_dxb_02', 'cu_shj_peter')");
    try {
      const res = await peter.page("/my?lang=en");
      expect(res.status).toBe(200);
      expect(res.html).toContain("You have no upcoming visits.");
      expect(res.html).toContain("No past visits yet.");
      expect(res.html).toContain("You have no active maintenance contract.");
      expect(res.html).not.toContain("<li id=\"past-");
    } finally {
      write("update app__customers set phone = ? where id in ('cu_dxb_02', 'cu_shj_peter')", [PETER]);
    }
    expect(ids((await peter.page("/my?lang=en")).html, "upcoming").length).toBe(4);
  });

  test("Arabic: right to left, the words in Arabic, numbers and times left to right", async () => {
    const res = await peter.page("/my?lang=ar");
    expect(res.html).toMatch(/<html lang="ar" dir="rtl"/u);
    expect(res.html).toContain("الزيارات القادمة");
    expect(res.html).toContain("بانتظار التأكيد");
    expect(res.html).toContain('<span dir="ltr">J-000006</span>');
    snapshot(steady(res.html), { role: "my, portal customer, ar" });
    await peter.page("/my?lang=en");
  });
});

describe("/my/visits/<id>", () => {
  test("one visit: the timeline in plain words with times, the address, the technician's first name, the branch's phone", async () => {
    const res = await peter.page("/my/visits/jb_seed_06?lang=en");
    expect(res.status).toBe(200);
    expect(res.html).toContain('<span dir="ltr">J-000006</span>');
    expect(res.html).toContain("Confirmed");
    expect(res.html).toContain("Street 14, villa 22, Al Barsha");
    expect(res.html).toContain('id="visit-technician" dir="auto">Ali</dd>');
    expect(res.html).toContain('<a href="tel:+97140000001" dir="ltr" id="branch-phone">+97140000001</a>');
    const timeline = /<ol class="my-timeline"[^]*?<\/ol>/u.exec(res.html)?.[0] ?? "";
    // Created (new), scheduled, and the reschedule (scheduled again); the note without a status change is not an event.
    expect([...timeline.matchAll(/<li[^>]*>([^·<]+) ·/gu)].map((m) => m[1]?.trim())).toEqual(["Requested", "Confirmed", "Confirmed"]);
    expect(timeline).toContain(`<span dir="ltr">${dayOf(1793400000)} ${clockOf(1793400000)}</span>`);
    for (const hidden of [INTERNAL, "Hassan", "Ants in the kitchen.", "Gate code at the guard post.", "u_dxb_dispatcher", "Dina"]) expect([hidden, res.html.includes(hidden)]).toEqual([hidden, false]);
  });

  test("a self-booking shows the customer's notes and the requested time, waiting for confirmation", async () => {
    const res = await peter.page("/my/visits/jb_my_self?lang=en");
    expect(res.status).toBe(200);
    expect(res.html).toContain('<dd dir="auto" id="visit-notes">Please ring twice, the bell is weak.</dd>');
    expect(res.html).toContain("waiting for confirmation");
    expect(res.html).not.toContain('id="visit-technician"');
    expect(res.html).not.toContain("self-booked: requested");
  });

  test("a done visit: Finished, and neither the technician's notes nor the parts' prices", async () => {
    const res = await peter.page("/my/visits/jb_seed_11?lang=en");
    expect(res.status).toBe(200);
    expect(res.html).toContain("Finished");
    expect(res.html).toContain('id="visit-technician" dir="auto">Bilal</dd>');
    for (const hidden of ["Customer asked for a cable cover", "45.00", "Raza", "Mount a TV"]) expect([hidden, res.html.includes(hidden)]).toEqual([hidden, false]);
    // The visit report (#777, tests/my-documents.test.ts) names the parts used with their quantities, never their prices.
    expect(res.html).toContain('href="/my/visits/jb_seed_11/report"');
  });

  test("the Sharjah visit names the Sharjah branch and its phone", async () => {
    const res = await peter.page("/my/visits/jb_my_shj?lang=en");
    expect(res.status).toBe(200);
    expect(res.html).toContain("Sharjah");
    expect(res.html).toContain('href="tel:+97160000002"');
  });

  test("another customer's job, an unknown id and a malformed id are 404, never 403", async () => {
    for (const id of ["jb_seed_01", "jb_seed_15", "jb_nope", "x'or'1"]) {
      const res = await peter.page(`/my/visits/${encodeURIComponent(id)}`);
      expect([id, res.status]).toEqual([id, 404]);
      expect(res.html).not.toContain("Layla");
      expect(res.html).not.toContain("Khalid");
    }
  });

  test("signed out: to the phone sign-in, and back here", async () => {
    const res = await t.as("nobody").page("/my/visits/jb_seed_06");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/auth/phone?next=%2Fmy%2Fvisits%2Fjb_seed_06");
  });

  test("Arabic: right to left, the timeline in Arabic", async () => {
    // J-000006 is tomorrow at 09:00: whether it is inside the change cut-off (#778, 12 hours) depends on the
    // hour the test runs, so the snapshot is taken with a cut-off of 0 (both links shown, at any hour).
    write("insert or replace into app__settings (key, value) values ('portal_cutoff_hours', '0')");
    const res = await peter.page("/my/visits/jb_seed_06?lang=ar");
    write("delete from app__settings where key = 'portal_cutoff_hours'");
    expect(res.html).toMatch(/<html lang="ar" dir="rtl"/u);
    expect(res.html).toContain("تم الطلب");
    snapshot(steady(res.html), { role: "my visit, portal customer, ar" });
    await peter.page("/my?lang=en");
  });
});
