// A visit's part line picks a stocked part and takes it out of the branch's stock (#814, wave D); free text stays.
// A stocked part of quantity 2 lowers the job's branch by 2 with an `out` move that references the visit and the
// price is the part's, whatever the form posted; removing the line puts it back with an `in` move at the current
// average; the same `action_id` twice moves once (and a queued replay is accepted even when stock goes negative);
// a free-text line moves nothing; a deactivated part is not offered and its posted id is a 422; stock under zero
// shows the note and tells the dispatcher once per part per day; the invoice names a stocked part in the
// customer's language with the part's VAT rate; the branch is the job's, never a form field; above 50 active parts
// the select gives way to a server-rendered search. Stock is written only by lib/stock.ts: the tests read it, and
// the opening balance comes through the stock page (receive).
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { totp } from "@renoxium/sdk";
import { app } from "@renoxium/sdk/test";

import en from "../i18n/en.json";

setDefaultTimeout(120_000);
const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string, next = "/me") {
  const u = t.as(jar);
  expect((await u.action("/auth/login", "default", { email, password: PASSWORD, next })).status).toBe(303);
  return u;
}

const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);
const count = (sql: string, params: (string | number | null)[] = []): number => Number(rows(sql, params)[0]?.n);
const rw = <T>(f: (db: Database) => T): T => {
  const db = new Database(t.dbFile);
  db.exec("pragma busy_timeout = 5000");
  try {
    return f(db);
  } finally {
    db.close();
  }
};
async function until<T>(f: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) {
    const v = f();
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

const DXB = "br_dubai";
const SHJ = "br_sharjah";
const FILTER = "pt_0000000000814a01";
const PIPE = "pt_0000000000814a02";
const OFF = "pt_0000000000814a03";
const GAS = "pt_0000000000814a04";
const part = (id: string, sku: string, en: string, ar: string, sell: number, vat: number, active: number) =>
  rw((db) => db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values (?, ?, ?, ?, 'piece', 500, ?, ?, 0, ?, 1700000000)", [id, sku, en, ar, sell, vat, active]));
part(FILTER, "AC-FILTER", "AC filter", "فلتر مكيف", 900, 5, 1);
part(PIPE, "PIPE-15", "Copper pipe 15 mm", "أنبوب نحاسي 15 مم", 1400, 5, 1);
part(OFF, "OLD-GAS", "Old gas", "غاز قديم", 0, 0, 0);
part(GAS, "GAS-ZERO", "Zero-rated gas", "غاز بنسبة صفر", 1000, 0, 1);

const ali = await signIn("ali", "ali.dubai@fixit.example");
const bilal = await signIn("bilal", "bilal.dubai@fixit.example");
const manager = await signIn("manager", "manager.dubai@fixit.example", "/");
type User = typeof ali;

const level = (branch: string, id: string) => rows("select qty, avg_cost_fils from app__stock where branch_id = ? and part_id = ?", [branch, id])[0];
const moves = (branch: string, id: string) => rows("select kind, qty, unit_cost_fils, reason, ref_kind, ref_id, balance_after, created_by from app__stock_moves where branch_id = ? and part_id = ? order by rowid", [branch, id]);
const receive = async (id: string, qty: string, cost: string) => expect((await manager.action("/admin/stock", "receive", { part: id, qty, unit_cost: cost, reason: "delivery from the supplier" })).status).toBe(303);

let serial = 0;
/** A scheduled job of Ali's in Dubai of its own, checked in, and the id of its visit. */
async function openJob(customer = "cu_dxb_05", site = "st_dxb_05a"): Promise<{ job: string; number: string; visit: string }> {
  serial += 1;
  const job = `jb_vp_${serial}`;
  const number = `J-8${String(serial).padStart(5, "0")}`;
  rw((db) =>
    db.run(
      "insert into app__jobs (id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, scheduled_start, scheduled_end, technician_user_id, booking_id, created_by, created_at, updated_at, source) select ?, branch_id, ?, ?, null, ?, 'scheduled', priority, service_id, description, scheduled_start, scheduled_end, 'u_dxb_ali', null, created_by, created_at, updated_at, source from app__jobs where id = 'jb_seed_10'",
      [job, customer, site, number],
    ),
  );
  expect((await ali.action(`/me/visits/${job}`, "checkin", {})).status).toBe(303);
  return { job, number, visit: String(rows("select id from app__visits where job_id = ?", [job])[0]?.id) };
}
const lines = (visit: string) => rows("select id, description, qty, unit_price_fils, part_id, stock_move_id, branch_id from app__visit_parts where visit_id = ? order by id", [visit]);

let nextId = 0;
const fresh = (): string => `vpart-${String(++nextId).padStart(4, "0")}-abcdefghij`;
async function post(u: User, job: string, action: string, form: Record<string, string>) {
  const res = await u.request("POST", `/me/visits/${job}?/${action}`, {
    headers: { "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": u.cookie("__Host-renox_csrf") ?? "", accept: "application/json", "x-hs-queued": "1" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, raw: res.html };
}

describe("a stocked part takes stock out, and removing it puts it back", () => {
  test("2 of a part lower the branch's stock by 2; the price is the part's whatever the form posted", async () => {
    await receive(FILTER, "10", "5.00");
    expect(level(DXB, FILTER)).toEqual({ qty: 10, avg_cost_fils: 500 });
    const v = await openJob();
    const res = await ali.action(`/me/visits/${v.job}`, "part", { part_id: FILTER, qty: "2", description: "Gold plated", price: "0.01" });
    expect(res.status).toBe(303);
    const line = lines(v.visit);
    expect(line).toEqual([{ id: line[0]?.id, description: "AC filter", qty: 2, unit_price_fils: 900, part_id: FILTER, stock_move_id: expect.any(String), branch_id: DXB }]);
    expect(level(DXB, FILTER)).toEqual({ qty: 8, avg_cost_fils: 500 });
    const list = moves(DXB, FILTER);
    expect(list.at(-1)).toEqual({ kind: "out", qty: 2, unit_cost_fils: 500, reason: v.number, ref_kind: "visit", ref_id: v.visit, balance_after: 8, created_by: "u_dxb_ali" });
    expect(rows("select id from app__stock_moves where kind = 'out' and ref_id = ?", [v.visit])[0]?.id).toBe(line[0]?.stock_move_id);
    // The page lists the line with its SKU and the total at the part's price.
    const page = await ali.page(`/me/visits/${v.job}`);
    expect(page.html).toContain("AC-FILTER · AC filter");
    expect(page.html).toContain('id="parts-total"');

    // Removing the line puts the 2 back with a second move at the current average, in the same visit.
    expect((await ali.action(`/me/visits/${v.job}`, "removePart", { part: String(line[0]?.id) })).status).toBe(303);
    expect(lines(v.visit)).toEqual([]);
    expect(level(DXB, FILTER)).toEqual({ qty: 10, avg_cost_fils: 500 });
    expect(moves(DXB, FILTER).at(-1)).toEqual({ kind: "in", qty: 2, unit_cost_fils: 500, reason: `removed from ${v.number}`, ref_kind: "visit", ref_id: v.visit, balance_after: 10, created_by: "u_dxb_ali" });
    expect(moves(DXB, FILTER).length).toBe(list.length + 1);
  });

  test("the same part action posted twice moves stock once, and so does the remove", async () => {
    const v = await openJob();
    const before = moves(DXB, FILTER).length;
    const was = level(DXB, FILTER)?.qty as number;
    const id = fresh();
    const first = await post(ali, v.job, "part", { part_id: FILTER, qty: "1", action_id: id });
    const second = await post(ali, v.job, "part", { part_id: FILTER, qty: "1", action_id: id });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.raw).toBe(first.raw);
    expect(lines(v.visit).length).toBe(1);
    expect(level(DXB, FILTER)?.qty).toBe(was - 1);
    expect(moves(DXB, FILTER).length).toBe(before + 1);
    const line = String(lines(v.visit)[0]?.id);
    const rid = fresh();
    expect((await post(ali, v.job, "removePart", { part: line, action_id: rid })).status).toBe(200);
    expect((await post(ali, v.job, "removePart", { part: line, action_id: rid })).status).toBe(200);
    expect(level(DXB, FILTER)?.qty).toBe(was);
    expect(moves(DXB, FILTER).length).toBe(before + 2);
  });

  test("a free-text part moves nothing and is as it was", async () => {
    const v = await openJob();
    const before = count("select count(*) as n from app__stock_moves");
    expect((await ali.action(`/me/visits/${v.job}`, "part", { description: "Copper joint", qty: "2", price: "12.50" })).status).toBe(303);
    expect(lines(v.visit)).toMatchObject([{ description: "Copper joint", qty: 2, unit_price_fils: 1250, part_id: null, stock_move_id: null }]);
    expect(count("select count(*) as n from app__stock_moves")).toBe(before);
    expect((await ali.action(`/me/visits/${v.job}`, "removePart", { part: String(lines(v.visit)[0]?.id) })).status).toBe(303);
    expect(count("select count(*) as n from app__stock_moves")).toBe(before);
    // "Other" with no name is still a 422 naming the description.
    const bad = await ali.action(`/me/visits/${v.job}`, "part", { part_id: "", description: "", qty: "1", price: "1" });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('id="err-description"');
  });
});

describe("which parts are offered", () => {
  test("the select lists the active parts with the quantity on hand in the branch; a deactivated part is not offered and its id is a 422", async () => {
    const v = await openJob();
    const page = await ali.page(`/me/visits/${v.job}`);
    expect(page.html).toContain('name="part_id"');
    expect(page.html).toContain(en.visits.parts.other);
    expect(page.html).toMatch(/AC-FILTER · AC filter \(10\)/u);
    expect(page.html).toMatch(/PIPE-15 · Copper pipe 15 mm \(0\)/u);
    expect(page.html).not.toContain("OLD-GAS");
    const before = count("select count(*) as n from app__stock_moves");
    for (const id of [OFF, "pt_ffffffffffffffff", "nope"]) {
      const res = await ali.action(`/me/visits/${v.job}`, "part", { part_id: id, qty: "1" });
      expect([id, res.status]).toEqual([id, 422]);
      expect(res.html).toContain('id="err-part_id"');
    }
    expect(count("select count(*) as n from app__stock_moves")).toBe(before);
    expect(lines(v.visit)).toEqual([]);
  });
});

describe("stock under zero", () => {
  test("a visit that takes more than is held is accepted (queued replay too), shows the note, and tells the dispatcher once per part per day", async () => {
    const a = await openJob();
    const b = await openJob();
    expect(level(DXB, PIPE)).toBeUndefined();
    const res = await post(ali, a.job, "part", { part_id: PIPE, qty: "3", action_id: fresh() });
    expect(res.status).toBe(200);
    expect(level(DXB, PIPE)).toEqual({ qty: -3, avg_cost_fils: 0 });
    expect(moves(DXB, PIPE).at(-1)).toMatchObject({ kind: "out", qty: 3, balance_after: -3 });
    const page = await ali.page(`/me/visits/${a.job}`);
    expect(page.html).toContain(en.visits.parts.negative.replace("{part}", "PIPE-15 Copper pipe 15 mm"));
    const told = () => rows("select title, link from notifications__items where user_id = 'u_dxb_dispatcher' and title like 'Stock of PIPE-15%'");
    await until(() => (told().length > 0 ? told() : undefined), "the dispatcher's notification");
    expect(told()[0]?.link).toBe(`/admin/stock/${PIPE}?branch=${DXB}`);
    // A second visit on the same part the same day adds none.
    expect((await ali.action(`/me/visits/${b.job}`, "part", { part_id: PIPE, qty: "1" })).status).toBe(303);
    expect(level(DXB, PIPE)?.qty).toBe(-4);
    await Bun.sleep(300);
    expect(told().length).toBe(1);
    // Another part under zero is another notice only for that part.
    expect((await ali.action(`/me/visits/${b.job}`, "part", { part_id: GAS, qty: "1" })).status).toBe(303);
    await until(() => (rows("select 1 from notifications__items where user_id = 'u_dxb_dispatcher' and title like 'Stock of GAS-ZERO%'").length > 0 ? true : undefined), "the second part's notification");
    expect(told().length).toBe(1);
  });
});

describe("the branch is the job's", () => {
  test("a branch in the form is ignored: the move is in the job's branch, and another branch's stock is untouched", async () => {
    const v = await openJob();
    const shjBefore = count("select count(*) as n from app__stock where branch_id = ?", [SHJ]);
    expect((await ali.action(`/me/visits/${v.job}`, "part", { part_id: FILTER, qty: "1", branch: SHJ, branch_id: SHJ })).status).toBe(303);
    expect(rows("select branch_id from app__stock_moves where ref_id = ?", [v.visit])).toEqual([{ branch_id: DXB }]);
    expect(lines(v.visit)[0]?.branch_id).toBe(DXB);
    expect(count("select count(*) as n from app__stock where branch_id = ?", [SHJ])).toBe(shjBefore);
  });

  test("another technician cannot add a part to the visit, and a Sharjah job is not reachable from Dubai", async () => {
    const v = await openJob();
    const before = count("select count(*) as n from app__stock_moves");
    expect((await bilal.action(`/me/visits/${v.job}`, "part", { part_id: FILTER, qty: "1" })).status).toBe(403);
    expect((await ali.action("/me/visits/jb_my_shj", "part", { part_id: FILTER, qty: "1" })).status).toBe(404);
    expect(count("select count(*) as n from app__stock_moves")).toBe(before);
    expect(lines(v.visit)).toEqual([]);
  });

  test("after the check-out a line cannot be removed and nothing moves", async () => {
    const v = await openJob();
    expect((await ali.action(`/me/visits/${v.job}`, "part", { part_id: FILTER, qty: "1" })).status).toBe(303);
    const line = String(lines(v.visit)[0]?.id);
    expect((await ali.action(`/me/visits/${v.job}`, "checkout", {})).status).toBe(303);
    const before = count("select count(*) as n from app__stock_moves");
    expect((await ali.action(`/me/visits/${v.job}`, "removePart", { part: line })).status).toBe(409);
    expect(count("select count(*) as n from app__stock_moves")).toBe(before);
    expect(lines(v.visit).length).toBe(1);
  });
});

describe("the invoice", () => {
  test("a stocked part is named in the customer's language with the part's VAT rate; a free-text line is as typed", async () => {
    // The accountant enrols a TOTP factor on one session and works on another that passed it (as invoices.test.ts does).
    const plain = await signIn("acc-plain", "accountant.dubai@fixit.example", "/invoices");
    expect(plain).toBeDefined();
    const enrolling = await signIn("acc-enrol", "accountant.dubai@fixit.example", "/invoices");
    const enrol = await enrolling.page("/2fa/enroll/totp");
    const secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(enrol.html)?.[1] ?? "").replace(/ /gu, "");
    expect((await enrolling.action("/2fa/enroll/totp", "confirm", { code: await totp(secret) })).status).toBe(200);
    const halted = await t.as("acc").action("/auth/login", "default", { email: "accountant.dubai@fixit.example", password: PASSWORD, next: "/invoices" });
    expect(halted.headers.get("location")).toBe("/2fa/verify?next=%2Finvoices");
    expect((await t.as("acc").action("/2fa/verify", "totp", { code: await totp(secret, Date.now() / 1000 + 30), next: "/invoices" })).status).toBe(303);
    const accountant = t.as("acc");

    // cu_dxb_01 reads Arabic.
    const v = await openJob("cu_dxb_01", "st_dxb_01a");
    expect((await ali.action(`/me/visits/${v.job}`, "part", { part_id: FILTER, qty: "2" })).status).toBe(303);
    expect((await ali.action(`/me/visits/${v.job}`, "part", { part_id: GAS, qty: "1" })).status).toBe(303);
    expect((await ali.action(`/me/visits/${v.job}`, "part", { description: "Sealant", qty: "1", price: "20" })).status).toBe(303);
    expect((await ali.action(`/me/visits/${v.job}`, "checkout", {})).status).toBe(303);
    const issued = await accountant.action(`/jobs/${v.job}/invoice`, "default", {});
    expect(issued.status).toBe(303);
    const number = (issued.headers.get("location") ?? "").replace("/invoices/", "");
    const doc = JSON.parse(String(rows("select body from tax_gcc__documents where number = ?", [number])[0]?.body)) as { lines: { description: string; quantity: number; unit_fils: number; net_fils: number; vat_fils: number }[] };
    const by = (text: string) => doc.lines.find((l) => l.description === text);
    expect(by("فلتر مكيف")).toMatchObject({ quantity: 2, unit_fils: 900, net_fils: 1800, vat_fils: 90 });
    expect(by("غاز بنسبة صفر")).toMatchObject({ quantity: 1, unit_fils: 1000, net_fils: 1000, vat_fils: 0 });
    expect(by("Sealant")).toMatchObject({ unit_fils: 2000, vat_fils: 100 });
    expect(doc.lines.some((l) => l.description === "AC filter")).toBe(false);
    // The visit report lists the SKU and the name in the report's language.
    const report = await ali.page(`/me/visits/${v.job}`);
    expect(report.html).toContain("AC-FILTER · AC filter");
  });
});

describe("many parts: a search instead of the select", () => {
  test("above 50 active parts the page has a search field and lists only what ?part_q= finds, no script", async () => {
    rw((db) => {
      for (let i = 0; i < 52; i++) db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values (?, ?, ?, ?, 'piece', 0, 100, 5, 0, 1, 1700000000)", [`pt_00000000814b${String(i).padStart(4, "0")}`, `BULK-${String(i).padStart(3, "0")}`, `Bulk part ${i}`, `قطعة ${i}`]);
    });
    const v = await openJob();
    const bare = await ali.page(`/me/visits/${v.job}`);
    expect(bare.html).toContain('name="part_q"');
    expect(bare.html).toContain(en.visits.parts.search_more);
    expect(bare.html).not.toContain("BULK-007");
    const found = await ali.page(`/me/visits/${v.job}?part_q=BULK-007`);
    expect(found.html).toContain("BULK-007 · Bulk part 7 (0)");
    expect(found.html).not.toContain("BULK-008");
    expect((await ali.page(`/me/visits/${v.job}?part_q=nothing-like-it`)).html).toContain(en.visits.parts.search_none);
    // A result is posted like any chosen part.
    expect((await ali.action(`/me/visits/${v.job}`, "part", { part_id: "pt_00000000814b0007", qty: "1" })).status).toBe(303);
    expect(lines(v.visit)).toMatchObject([{ description: "Bulk part 7", unit_price_fils: 100 }]);
  });
});
