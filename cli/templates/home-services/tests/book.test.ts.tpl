// Self-booking on /book (#775): the three steps in English and Arabic, the
// emirate with no branch, the free slots across the branch's technicians, the
// draft and its hold, the WhatsApp code (auth's real phone pages, through
// tests/outbox.ts phoneSignIn: a code is queued, then the test plants a known
// one in auth's store because the queued message is sealed), and the
// confirmation that makes the customer, the site and the job. Then the limits
// (5 drafts an hour per address, 3 live drafts per phone) and the hourly sweep
// of expired drafts (t.job). auth makes at most 3 accounts an hour per
// address: this file signs up two phones.
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { totp } from "@renoxium/sdk";
import { app, snapshot } from "@renoxium/sdk/test";

import { outboxOf, phoneSignIn } from "./outbox";

setDefaultTimeout(60_000);
const t = await app();
const PASSWORD = "correct horse battery";

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

/** The first day of the next six (Dubai) that is a full working day (Monday to Thursday or Saturday): never today, so every slot is ahead. */
const DAY = (() => {
  for (let i = 1; i < 7; i++) {
    const local = new Date(Date.now() + i * 86_400_000 + 4 * 3_600_000);
    if ([1, 2, 3, 4, 6].includes(local.getUTCDay())) return local.toISOString().slice(0, 10);
  }
  throw new Error("no working day ahead");
})();

const AC = String(rows("select id from app__services where code = 'AC-SERVICE'")[0]?.id);
const AREA = String(rows("select name_en from gcc__areas where emirate = 'AE-DU' and name_en = 'Dubai Marina'")[0]?.name_en ?? rows("select name_en from gcc__areas where emirate = 'AE-DU' order by name_en limit 1")[0]?.name_en);
const PLACE = { service: AC, emirate: "AE-DU", area: AREA, address: "Marina Gate 2, flat 3301", makani: "", notes: "The AC in the bedroom drips." };
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const STEP2 = `/book?${q({ ...PLACE, step: "2", day: DAY })}`;

/** The slot values step 2 offers for DAY, in order. */
async function slotsOf(who = t.as("anonymous")): Promise<string[]> {
  const res = await who.page(STEP2);
  expect(res.status).toBe(200);
  return [...res.html.matchAll(/name="slot" value="([^"]+)"/gu)].map((m) => m[1] as string);
}

/** Step 3's submit as `who`, for the first free slot of DAY. */
async function hold(who: ReturnType<typeof t.as>, phone: string, name = "Sara Visitor") {
  const slot = (await slotsOf(who))[0] as string;
  const form: Record<string, string> = { ...PLACE, day: DAY, slot, name, language: "en" };
  if (phone !== "") form.phone = phone;
  return { slot, res: await who.action("/book", "hold", form) };
}

const draftOf = (location: string): string => /\/book\/confirm\/(bd_[0-9a-f]{32})/u.exec(decodeURIComponent(location))?.[1] ?? "";

/** Steady text for a snapshot: the days, dates, times and slot values change with the day the test runs. */
const WEEKDAYS = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b|(الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت|الأحد)/gu;
const steady = (html: string): string =>
  html
    .replace(/<nav class="book-days"[^]*?<\/nav>/u, "<days />")
    .replace(/u_[a-z_]+(?:@|%40)\d{12,15}/gu, "<slot>")
    .replace(/bd_[0-9a-f]{32}/gu, "<draft>")
    .replace(/\d{4}-\d{2}-\d{2}/gu, "<day>")
    .replace(/\d{2}:\d{2}–\d{2}:\d{2}/gu, "<from>–<to>")
    .replace(WEEKDAYS, "<weekday>");

const P1 = "+971507770001";
const P2 = "+971507770002";

describe("the three steps, signed out", () => {
  test("step 1 lists the bookable services with their price, the emirates and the place fields, and sets no cookie of the app", async () => {
    const res = await t.as("fresh").page("/book?lang=en");
    expect(res.status).toBe(200);
    expect(res.html).toContain("AC service");
    expect(res.html).toContain('name="service"');
    expect(res.html).toMatch(/<option value="AE-DU"[^>]*>Dubai<\/option>/u);
    expect(res.html).toContain("Choose your emirate, then Show the areas.");
    // The only cookies are the platform's page session and CSRF pair, which every page route gets (#775 "Needs human"): no auth session, nothing of the app.
    const names = res.headers.getSetCookie().map((c) => c.split("=")[0]);
    expect(names.every((n) => n === "__Host-renox_sid" || n === "__Host-renox_csrf")).toBe(true);
    // A plain GET form, no inline script of the app, no CSRF field before step 3.
    expect(res.html).toContain('<form method="get" action="/book"');
    expect(res.html).not.toContain('name="_csrf"');
    expect(res.html).not.toMatch(/<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)[^>]*>/u);
    snapshot(res.html, { role: "book step 1, signed out, en" });
  });

  test("step 1 again with an emirate fills its areas; Arabic", async () => {
    const res = await t.as("fresh").page(`/book?${q({ service: AC, emirate: "AE-DU", step: "1", lang: "ar" })}`);
    expect(res.status).toBe(200);
    expect(res.html).toMatch(/<html lang="ar" dir="rtl"/u);
    expect(res.html).toContain('name="area"');
    expect(res.html).toContain(`value="${AREA}"`);
    snapshot(res.html, { role: "book step 1 with areas, signed out, ar" });
  });

  test("step 2 with a step 1 error shows step 1 again, the field marked", async () => {
    const res = await t.as("fresh").page(`/book?${q({ ...PLACE, address: "x", step: "2", lang: "en" })}`);
    expect(res.status).toBe(200);
    expect(res.html).toContain("Enter the address in 5 to 200 characters.");
    expect(res.html).toMatch(/name="address"[^>]*aria-invalid="true"/u);
    expect(res.html).not.toContain('name="slot"');
  });

  test("step 2 lists the next 7 days and at most 12 free slots of the day, earliest first, across the branch's technicians", async () => {
    const res = await t.as("fresh").page(`${STEP2}&lang=en`);
    expect(res.status).toBe(200);
    expect(res.html).toContain("Served by our Dubai branch.");
    expect([...res.html.matchAll(/<li><(?:a|strong)\b/gu)].length).toBe(7);
    const slots = [...res.html.matchAll(/name="slot" value="([^"@]+)@(\d+)"/gu)];
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(12);
    const starts = slots.map((m) => Number(m[2]));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(new Set(slots.map((m) => m[1]))).toEqual(new Set(["u_dxb_ali", "u_dxb_bilal"]));
    expect(res.html).not.toContain('name="_csrf"');
    snapshot(steady(res.html), { role: "book step 2, signed out, en" });
    const ar = await t.as("fresh").page(`${STEP2}&lang=ar`);
    snapshot(steady(ar.html), { role: "book step 2, signed out, ar" });
  });

  test("step 3 shows the summary and asks the name, the WhatsApp number and the language, in English and Arabic", async () => {
    const slot = (await slotsOf())[0] as string;
    const path = `/book?${q({ ...PLACE, day: DAY, slot, step: "3" })}`;
    const en = await t.as("fresh").page(`${path}&lang=en`);
    expect(en.status).toBe(200);
    expect(en.html).toContain("Your booking");
    expect(en.html).toContain('name="phone"');
    expect(en.html).toContain('action="?/hold"');
    snapshot(steady(en.html), { role: "book step 3, signed out, en" });
    const ar = await t.as("fresh").page(`${path}&lang=ar`);
    expect(ar.html).toContain("أرسل لي الرمز");
    snapshot(steady(ar.html), { role: "book step 3, signed out, ar" });
  });

  test("an emirate with no branch: the page says so with the company's phone, offers no time and books nothing", async () => {
    const before = rows("select count(*) as n from app__booking_drafts")[0]?.n;
    const res = await t.as("fresh").page(`/book?${q({ service: AC, emirate: "AE-FU", area: String(rows("select name_en from gcc__areas where emirate = 'AE-FU' order by name_en limit 1")[0]?.name_en), address: "Fujairah corniche 1", step: "2", lang: "en" })}`);
    expect(res.status).toBe(200);
    expect(res.html).toContain("We do not serve this emirate yet");
    expect(res.html).toContain('href="tel:+97140000001"');
    expect(res.html).not.toContain('name="slot"');
    expect(rows("select count(*) as n from app__booking_drafts")[0]?.n).toBe(before);
  });

  test("a service switched off for self-booking is not offered", async () => {
    write("update app__services set self_booking = 0 where code = 'PEST'");
    try {
      const res = await t.as("fresh").page("/book?lang=en");
      expect(res.html).not.toContain("Pest control");
      expect(res.html).toContain("AC service");
    } finally {
      write("update app__services set self_booking = 1 where code = 'PEST'");
    }
  });

  test("step 3 with a short name is a 422 that keeps the step", async () => {
    const slot = (await slotsOf())[0] as string;
    const res = await t.as("fresh").action("/book", "hold", { ...PLACE, day: DAY, slot, name: "x", phone: P1, language: "en" });
    expect(res.status).toBe(422);
    expect(res.html).toContain("Enter a name of 2 to 80 characters.");
    expect(res.html).toMatch(/name="name"[^>]*aria-invalid="true"/u);
    expect(res.html).toContain('action="?/hold"');
    expect(rows("select count(*) as n from app__booking_drafts")[0]?.n).toBe(0);
  });
});

describe("a new phone books, types the code and confirms", () => {
  const visitor = t.as("visitor");
  let draft = "";
  let slot = "";
  let number = "";

  test("step 3 holds the slot, stores the draft and sends the visitor to the phone sign-in with the number and the way back", async () => {
    const h = await hold(visitor, P1);
    slot = h.slot;
    expect(h.res.status).toBe(303);
    const to = located(h.res);
    expect(to.startsWith(`/auth/phone?phone=${encodeURIComponent(P1)}&next=`)).toBe(true);
    draft = draftOf(to);
    expect(draft).not.toBe("");
    const row = rows("select * from app__booking_drafts where id = ?", [draft])[0] as Record<string, unknown>;
    expect(row).toMatchObject({ phone: P1, name: "Sara Visitor", language: "en", emirate: "AE-DU", area: AREA, branch_id: "br_dubai", service_id: Number(AC) });
    expect(String(row.ip_hash)).toMatch(/^[0-9a-f]{64}$/u);
    const held = rows("select status, expires_at from booking__bookings where id = ?", [String(row.hold_id)])[0] as { status: string; expires_at: number };
    expect(held.status).toBe("held");
    // The draft lives as long as the hold (booking's hold_minutes = 10).
    expect(Number(row.expires_at)).toBe(Math.floor(held.expires_at / 1000));
    expect(Number(row.expires_at) - Number(row.created_at)).toBeGreaterThan(9 * 60);
  });

  test("a held slot is not offered any more", async () => {
    expect(await slotsOf()).not.toContain(slot);
  });

  test("the draft's page asks a signed-out visitor to sign in first", async () => {
    const res = await t.as("fresh").page(`/book/confirm/${draft}`);
    expect(res.status).toBe(303);
    expect(located(res)).toBe(`/auth/phone?next=${encodeURIComponent(`/book/confirm/${draft}`)}`);
  });

  test("the WhatsApp code signs the new phone up and lands on the draft, which shows the summary", async () => {
    const signed = await phoneSignIn(visitor, rows, write, P1, `/book/confirm/${draft}`);
    expect(signed.status).toBe(303);
    expect(located(signed)).toBe(`/book/confirm/${draft}`);
    const page = await visitor.page(`/book/confirm/${draft}?lang=en`);
    expect(page.status).toBe(200);
    expect(page.html).toContain("Confirm booking");
    expect(page.html).toContain("Marina Gate 2, flat 3301");
    expect(page.html).toContain(`<span dir="ltr">${P1}</span>`);
    snapshot(steady(page.html), { role: "book confirm, portal user, en" });
  });

  test("Confirm booking makes one customer, one site and one `new` job with source self_booking, releases the hold, tells the customer and the dispatcher", async () => {
    const holdId = String(rows("select hold_id from app__booking_drafts where id = ?", [draft])[0]?.hold_id);
    const res = await visitor.action(`/book/confirm/${draft}`, "confirm", {});
    expect(res.status).toBe(303);
    const to = located(res);
    expect(to).toMatch(/^\/my\?booked=J-\d{6}$/u);
    number = to.slice("/my?booked=".length);
    const userId = String(rows("select id from auth__users where phone = ?", [P1])[0]?.id);
    const customers = rows("select id, branch_id, kind, name, language, user_id from app__customers where phone = ?", [P1]);
    expect(customers).toEqual([{ id: expect.any(String), branch_id: "br_dubai", kind: "household", name: "Sara Visitor", language: "en", user_id: userId }]);
    const customer = String(customers[0]?.id);
    expect(rows("select label, emirate, area, address from app__sites where customer_id = ?", [customer])).toEqual([{ label: "Home", emirate: "AE-DU", area: AREA, address: "Marina Gate 2, flat 3301" }]);
    const at = Number(slot.slice(slot.indexOf("@") + 1));
    const job = rows("select * from app__jobs where number = ?", [number])[0] as Record<string, unknown>;
    expect(job).toMatchObject({ status: "new", source: "self_booking", customer_id: customer, branch_id: "br_dubai", service_id: Number(AC), technician_user_id: null, booking_id: null, created_by: userId, scheduled_start: Math.floor(at / 1000), description: "The AC in the bedroom drips." });
    expect(rows("select to_status from app__job_events where job_id = ?", [String(job.id)])).toEqual([{ to_status: "new" }]);
    expect(rows("select status from booking__bookings where id = ?", [holdId])[0]?.status).toBe("cancelled");
    expect(rows("select count(*) as n from app__booking_drafts where id = ?", [draft])[0]?.n).toBe(0);
    const sent = outboxOf(rows, P1).filter((m) => m.template === "booking_received");
    expect(sent.length).toBe(1);
    expect(sent[0]?.text).toContain(number);
    const told = await until(() => rows("select title, link from notifications__items where user_id = 'u_dxb_dispatcher' and title = ?", [`New self-booking ${number}`])[0], "the dispatcher's notification");
    expect(told).toEqual({ title: `New self-booking ${number}`, link: `/jobs/${String(job.id)}` });
  });

  test("/my says the booking was received and links to /book", async () => {
    const page = await visitor.page(`/my?booked=${number}&lang=en`);
    expect(page.status).toBe(200);
    expect(page.html).toContain(`We received your booking ${number}.`);
    expect(page.html).toContain('href="/book"');
    // Another number is not announced.
    expect((await visitor.page("/my?booked=J-000001")).html).not.toContain("We received your booking");
  });

  test("the same phone books again, signed in: no code, and the customer and the site are reused", async () => {
    const h = await hold(visitor, "");
    expect(h.res.status).toBe(303);
    const next = located(h.res);
    expect(next).toMatch(/^\/book\/confirm\/bd_[0-9a-f]{32}$/u);
    const done = await visitor.action(next, "confirm", {});
    expect(done.status).toBe(303);
    expect(rows("select count(*) as n from app__customers where phone = ?", [P1])[0]?.n).toBe(1);
    expect(rows("select count(*) as n from app__sites s join app__customers c on c.id = s.customer_id where c.phone = ?", [P1])[0]?.n).toBe(1);
    expect(rows("select count(*) as n from app__jobs j join app__customers c on c.id = j.customer_id where c.phone = ? and j.source = 'self_booking'", [P1])[0]?.n).toBe(2);
  });

  test("with auto-confirm on, the job is scheduled with the technician and the hold confirmed", async () => {
    write("insert or replace into app__settings (key, value) values ('portal_auto_confirm', '1')");
    try {
      const h = await hold(visitor, "");
      const tech = h.slot.slice(0, h.slot.indexOf("@"));
      const next = located(h.res);
      const holdId = String(rows("select hold_id from app__booking_drafts where id = ?", [draftOf(next)])[0]?.hold_id);
      const done = await visitor.action(next, "confirm", {});
      expect(done.status).toBe(303);
      const n = located(done).slice("/my?booked=".length);
      const job = rows("select * from app__jobs where number = ?", [n])[0] as Record<string, unknown>;
      expect(job).toMatchObject({ status: "scheduled", source: "self_booking", technician_user_id: tech, booking_id: holdId });
      expect(rows("select status from booking__bookings where id = ?", [holdId])[0]?.status).toBe("confirmed");
      expect(outboxOf(rows, P1).filter((m) => m.template === "visit_scheduled" && m.text.includes(n)).length).toBe(1);
    } finally {
      write("delete from app__settings where key = 'portal_auto_confirm'");
    }
  });

  test("an expired draft sends its owner back to step 2: that time was just taken", async () => {
    const h = await hold(visitor, "");
    const next = located(h.res);
    write("update app__booking_drafts set expires_at = ? where id = ?", [Math.floor(Date.now() / 1000) - 60, draftOf(next)]);
    const res = await visitor.page(next);
    expect(res.status).toBe(303);
    expect(located(res)).toContain("step=2");
    expect(located(res)).toContain("taken=1");
    const page = await visitor.page(`${located(res)}&lang=en`);
    expect(page.html).toContain("That time was just taken, please pick another.");
  });

  test("a draft opened by another phone's session is 404", async () => {
    const other = t.as("other");
    expect((await phoneSignIn(other, rows, write, P2, "/my")).status).toBe(303);
    const h = await hold(t.as("anon-p1"), P1);
    const next = draftOf(located(h.res));
    expect(next).not.toBe("");
    expect((await other.page(`/book/confirm/${next}`)).status).toBe(404);
    expect((await other.action(`/book/confirm/${next}`, "confirm", {})).status).toBe(404);
    expect((await other.page("/book/confirm/bd_00000000000000000000000000000000")).status).toBe(404);
  });
});

describe("abuse controls and the sweep", () => {
  const reset = () => {
    write("delete from app__booking_draft_log");
    write("delete from app__booking_drafts");
  };

  test("the sixth draft from one address in an hour is 429", async () => {
    reset();
    for (let i = 0; i < 5; i++) expect((await hold(t.as(`ip-${i}`), `+97150777010${i}`)).res.status).toBe(303);
    const sixth = (await hold(t.as("ip-6"), "+971507770106")).res;
    expect(sixth.status).toBe(429);
    expect(sixth.html).toContain("Too many booking requests");
    expect(rows("select count(*) as n from app__booking_drafts")[0]?.n).toBe(5);
  });

  test("a fourth live draft for one phone is 429", async () => {
    reset();
    const phone = "+971507770200";
    for (let i = 0; i < 3; i++) expect((await hold(t.as(`ph-${i}`), phone)).res.status).toBe(303);
    expect((await hold(t.as("ph-3"), phone)).res.status).toBe(429);
  });

  test("the hourly sweep releases an expired draft's hold and deletes it; a live one stays", async () => {
    reset();
    const old = draftOf(located((await hold(t.as("sweep-1"), "+971507770300")).res));
    const live = draftOf(located((await hold(t.as("sweep-2"), "+971507770301")).res));
    const holdId = String(rows("select hold_id from app__booking_drafts where id = ?", [old])[0]?.hold_id);
    const past = Math.floor(Date.now() / 1000) - 60;
    write("update app__booking_drafts set expires_at = ? where id = ?", [past, old]);
    write("update booking__bookings set expires_at = ? where id = ?", [past * 1000, holdId]);
    await t.job("booking-drafts");
    expect(rows("select id from app__booking_drafts order by id")).toEqual([{ id: live }]);
    expect(rows("select status from booking__bookings where id = ?", [holdId])[0]?.status).toBe("cancelled");
  });
});

describe("/services: the owner takes a service off /book", () => {
  test("Bookable online unchecked: /book no longer offers it", async () => {
    const email = "owner@fixit.example";
    const enrolling = t.as("owner-enrol");
    expect((await enrolling.action("/auth/login", "default", { email, password: PASSWORD, next: "/" })).status).toBe(303);
    const enrol = await enrolling.page("/2fa/enroll/totp");
    const secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(enrol.html)?.[1] ?? "").replace(/ /gu, "");
    expect((await enrolling.action("/2fa/enroll/totp", "confirm", { code: await totp(secret) })).status).toBe(200);
    const owner = t.as("owner");
    await owner.action("/auth/login", "default", { email, password: PASSWORD, next: "/services" });
    expect((await owner.action("/2fa/verify", "totp", { code: await totp(secret, Date.now() / 1000 + 30), next: "/services" })).status).toBe(303);
    const page = await owner.page("/services?lang=en");
    expect(page.html).toContain('name="self_booking"');
    expect(page.html).toContain("Bookable online");
    const id = String(rows("select id from app__services where code = 'HANDYMAN'")[0]?.id);
    expect((await owner.action("/services", "save", { service: id, price: "120.00", active: "1" })).status).toBe(200);
    expect(rows("select active, self_booking from app__services where id = ?", [id])[0]).toEqual({ active: 1, self_booking: 0 });
    expect((await t.as("fresh").page("/book?lang=en")).html).not.toContain("Handyman");
    expect((await owner.action("/services", "save", { service: id, price: "120.00", active: "1", self_booking: "1" })).status).toBe(200);
    expect((await t.as("fresh").page("/book?lang=en")).html).toContain("Handyman");
  });
});
