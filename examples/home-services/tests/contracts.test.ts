// Maintenance contracts (F7-126): a draft with items is activated (the upfront
// tax invoice is issued through tax_gcc and linked), the daily visits job makes
// the jobs due in the next 14 days once, the renewals job reminds the customer
// 30 days before the end and expires the contract the day after, and the
// contract has an EN and AR PDF. Runs on the local worker with the seed's users
// (password below); the jobs run through the worker's outbox (tests/run-job.ts).
// The seed has two active contracts: AMC-000001 (Dubai, Marina Heights) and
// AMC-000002 (Sharjah), every next visit more than 14 days away.
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { totp } from "@renoxium/sdk";
import { app, snapshot } from "@renoxium/sdk/test";

import { addDays, nextVisit, visitDays, yearEnd } from "../lib/contract-dates";
import { runJob } from "./run-job";

setDefaultTimeout(60_000);
const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string, next = "/contracts") {
  const u = t.as(jar);
  const res = await u.action("/auth/login", "default", { email, password: PASSWORD, next });
  expect(res.status).toBe(303);
  return u;
}

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
/** The Dubai day today, as the app's `today()` works it out. */
const today = (): string => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
/** The seed's dates move with the day the tests run. */
const steady = (html: string) => html.replace(/\d{4}-\d{2}-\d{2}/gu, "<day>");
const located = (res: { headers: Headers }) => res.headers.get("location") ?? "";
const serviceId = (code: string): string => String(rows("select id from app__services where code = ?", [code])[0]?.id);

const dispatcher = await signIn("dispatcher", "dispatcher.dubai@fixit.example");
const sharjah = await signIn("sharjah", "dispatcher.sharjah@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example", "/me");

// The owner enrols a TOTP factor on one session and works on another that passed it (as invoices.test.ts does for the accountant).
const noFactor = await signIn("owner-plain", "owner@fixit.example");
const enrolling = await signIn("owner", "owner@fixit.example");
const enrol = await enrolling.page("/2fa/enroll/totp");
const secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(enrol.html)?.[1] ?? "").replace(/ /gu, "");
expect((await enrolling.action("/2fa/enroll/totp", "confirm", { code: await totp(secret) })).status).toBe(200);
const halted = await t.as("owner-2").action("/auth/login", "default", { email: "owner@fixit.example", password: PASSWORD, next: "/contracts" });
expect(halted.headers.get("location")).toBe("/2fa/verify?next=%2Fcontracts");
expect((await t.as("owner-2").action("/2fa/verify", "totp", { code: await totp(secret, Date.now() / 1000 + 30), next: "/contracts" })).status).toBe(303);
const owner = t.as("owner-2");

const contractRow = (id: string) => rows("select * from app__contracts where id = ?", [id])[0] as Record<string, unknown>;
const itemRows = (id: string) => rows("select id, service_id, visits_per_year, next_visit_on from app__contract_items where contract_id = ? order by id", [id]);
const visitJobs = (id: string) => rows("select cj.item_id, cj.due_on, j.id, j.number, j.status, j.service_id, j.site_id, j.customer_id, j.branch_id from app__contract_jobs cj join app__jobs j on j.id = cj.job_id where cj.contract_id = ? order by cj.item_id, cj.due_on", [id]);

/** The form of a new contract for Al Barsha Facilities (Dubai, with a TRN) with the given items. */
const form = (extra: Record<string, string> = {}, items: { site: string; service: string; visits: string }[] = []) => ({
  customer_id: "cu_dxb_05",
  starts_on: addDays(today(), 3),
  price: "1200",
  notes: "Test contract",
  ...Object.fromEntries(items.flatMap((i, n) => [[`site_id_${n}`, i.site], [`service_${n}`, i.service], [`visits_${n}`, i.visits]])),
  ...extra,
});

async function create(who: typeof dispatcher, f: Record<string, string>): Promise<string> {
  const res = await who.action("/contracts/new", "create", f);
  expect(res.status).toBe(303);
  return located(res).replace("/contracts/", "");
}

describe("the day arithmetic", () => {
  test("a one-year term ends the day before the anniversary", () => {
    expect(yearEnd("2026-11-10")).toBe("2027-11-09");
    expect(yearEnd("2028-02-29")).toBe("2029-02-27");
    expect(yearEnd("2027-01-01")).toBe("2027-12-31");
  });

  test("the visits are 365 / n days apart, and a term holds exactly n of them", () => {
    expect(nextVisit("2026-11-10", "2026-11-10", 12)).toBe("2026-12-10");
    expect(nextVisit("2026-11-10", "2026-11-10", 4)).toBe("2027-02-09");
    for (const n of [1, 2, 4, 12, 26, 52]) expect(visitDays("2026-11-10", yearEnd("2026-11-10"), n)).toHaveLength(n);
    // Edge case: one visit a year is the one at the start, none later in the term.
    expect(visitDays("2026-11-10", "2027-11-09", 1)).toEqual(["2026-11-10"]);
    expect(nextVisit("2026-11-10", "2026-11-10", 1) > "2027-11-09").toBe(true);
  });
});

describe("the seed", () => {
  test("a Dubai dispatcher sees the Dubai contract and not the Sharjah one", async () => {
    const list = await dispatcher.page("/contracts");
    expect(list.status).toBe(200);
    expect(list.html).toContain("AMC-000001");
    expect(list.html).toContain("Marina Heights Property Management");
    expect(list.html).not.toContain("AMC-000002");
    expect((await sharjah.page("/contracts")).html).toContain("AMC-000002");
    snapshot(steady(list.html), { role: "contracts, dispatcher, en" });
  });

  test("the contract page: items, price with VAT, no visits yet", async () => {
    const res = await dispatcher.page("/contracts/ct_seed_01");
    expect(res.status).toBe(200);
    expect(res.html).toContain("AC service");
    expect(res.html).toContain("Pest control");
    expect(res.html).toContain("Tower A");
    expect(rows("select count(*) as n from app__contract_jobs")[0]?.n).toBe(0);
    snapshot(steady(res.html), { role: "contract, dispatcher, en" });
    const ar = await dispatcher.page("/contracts/ct_seed_01?lang=ar");
    expect(ar.html).toContain('<html lang="ar" dir="rtl"');
    snapshot(steady(ar.html), { role: "contract, dispatcher, ar" });
  });
});

describe("create and activate", () => {
  let id = "";

  test("normal case: a dispatcher makes a draft with an item, and adds a second one on its page", async () => {
    id = await create(dispatcher, form({}, [{ site: "st_dxb_05a", service: serviceId("AC-SERVICE"), visits: "12" }]));
    expect(contractRow(id)).toMatchObject({ number: "AMC-000003", status: "draft", branch_id: "br_dubai", customer_id: "cu_dxb_05", price_fils: 120000, billing: "upfront", created_by: "u_dxb_dispatcher" });
    expect(contractRow(id).ends_on).toBe(yearEnd(addDays(today(), 3)));
    expect((await dispatcher.action(`/contracts/${id}`, "item", { site_id: "st_dxb_05a", service: serviceId("PEST"), visits: "4" })).status).toBe(303);
    expect(itemRows(id).map((i) => i.visits_per_year)).toEqual([12, 4]);
    expect(itemRows(id).every((i) => i.next_visit_on === addDays(today(), 3))).toBe(true);
  });

  test("error case: a site of another customer, an unknown service and a bad form are refused", async () => {
    expect((await dispatcher.action(`/contracts/${id}`, "item", { site_id: "st_dxb_01a", service: serviceId("PEST"), visits: "4" })).status).toBe(422);
    expect((await dispatcher.action(`/contracts/${id}`, "item", { site_id: "st_dxb_05a", service: "99999", visits: "4" })).status).toBe(422);
    const bad = await dispatcher.action("/contracts/new", "create", form({ ends_on: addDays(today(), -5), price: "x" }));
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('id="err-ends_on"');
    expect(bad.html).toContain('id="err-price"');
    expect((await dispatcher.action(`/contracts/${id}`, "item", { site_id: "st_dxb_05a", service: serviceId("PEST"), visits: "0" })).status).toBe(422);
    expect(itemRows(id)).toHaveLength(2);
  });

  test("error case: activating a draft with no items is a 422 and the contract stays a draft", async () => {
    const empty = await create(dispatcher, form({ price: "0" }));
    const res = await dispatcher.action(`/contracts/${empty}`, "activate", {});
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-items"');
    expect((await owner.action(`/contracts/${empty}`, "activate", {})).status).toBe(422);
    expect(contractRow(empty).status).toBe("draft");
  });

  test("a priced contract issues a tax invoice, which is a sensitive action: a dispatcher, and an owner without the second factor, are refused (403)", async () => {
    expect((await dispatcher.action(`/contracts/${id}`, "activate", {})).status).toBe(403);
    expect((await noFactor.action(`/contracts/${id}`, "activate", {})).status).toBe(403);
    expect(contractRow(id).status).toBe("draft");
    expect(rows("select 1 from app__job_invoices where contract_id = ?", [id])).toEqual([]);
  });

  test("normal case: the owner activates it: the contract is active and the upfront invoice is issued and linked", async () => {
    const res = await owner.action(`/contracts/${id}`, "activate", {});
    expect(res.status).toBe(303);
    const c = contractRow(id);
    expect(c.status).toBe("active");
    expect(c.invoice_id).toBe("INV-000002");
    const inv = rows("select job_id, contract_id, branch_id, customer_id, total_fils from app__job_invoices where invoice_id = 'INV-000002'")[0];
    expect(inv).toMatchObject({ job_id: null, contract_id: id, branch_id: "br_dubai", customer_id: "cu_dxb_05", total_fils: 126000 });
    const doc = JSON.parse(String(rows("select body from tax_gcc__documents where number = 'INV-000002'")[0]?.body)) as { totals: { standard: number; vat: number; total: number }; buyer: { name: string; trn: string | null }; lines: { description: string }[] };
    expect(doc.totals).toMatchObject({ standard: 120000, vat: 6000, total: 126000 });
    expect(doc.buyer).toMatchObject({ name: "Al Barsha Facilities LLC", trn: "100123456700011" });
    expect(doc.lines[0]?.description).toContain("AMC-000003");
    // The invoice page, the list and the statement know it.
    const page = await owner.page("/invoices/INV-000002");
    expect(page.status).toBe(200);
    expect(page.html).toContain("AMC-000003");
    expect(page.html).toContain(`/contracts/${id}`);
    expect((await owner.page("/invoices?status=open")).html).toContain("INV-000002");
    const statement = (await owner.page("/customers/cu_dxb_05/statement.pdf?format=json&lang=en")).json<{ invoices: { number: string; balance: number }[] }>();
    expect(statement.invoices).toEqual([expect.objectContaining({ number: "INV-000002", balance: 1260 })]);
    // The customer was told, with a link; the audit trail has both rows.
    expect(rows("select channel from app__customer_messages where customer_id = 'cu_dxb_05' and kind = 'invoice_due'")).toHaveLength(1);
    expect(rows("select action from audit__events where resource_id = ? and action = 'contract.activate'", [id])).toHaveLength(1);
    expect(rows("select action from audit__events where resource_id = 'INV-000002' and action = 'invoice.issue'")).toHaveLength(1);
    // Activated twice: a 409, and no second invoice.
    expect((await owner.action(`/contracts/${id}`, "activate", {})).status).toBe(409);
    expect(rows("select count(*) as n from app__job_invoices where contract_id = ?", [id])[0]?.n).toBe(1);
  });

  test("an active contract takes no more items", async () => {
    expect((await dispatcher.action(`/contracts/${id}`, "item", { site_id: "st_dxb_05a", service: serviceId("PEST"), visits: "2" })).status).toBe(409);
    expect((await dispatcher.page(`/contracts/${id}`)).html).not.toContain('id="add-item"');
  });

  test("a contract with no price is activated by a dispatcher and issues no invoice", async () => {
    const free = await create(dispatcher, form({ price: "0" }, [{ site: "st_dxb_05a", service: serviceId("PEST"), visits: "2" }]));
    expect((await dispatcher.action(`/contracts/${free}`, "activate", {})).status).toBe(303);
    expect(contractRow(free)).toMatchObject({ status: "active", invoice_id: null });
    expect(rows("select 1 from app__job_invoices where contract_id = ?", [free])).toEqual([]);
    expect((await dispatcher.action(`/contracts/${free}`, "cancel", {})).status).toBe(303);
    expect(contractRow(free).status).toBe("cancelled");
  });

  test("the visits job: the two items (12 and 4 a year) make their jobs due in 14 days, once", async () => {
    // The contract started in three days, so both items are due now: two jobs.
    await runJob(t, "amc-visits");
    const jobs = visitJobs(id);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.due_on)).toEqual([addDays(today(), 3), addDays(today(), 3)]);
    expect(jobs.every((j) => j.status === "new" && j.branch_id === "br_dubai" && j.customer_id === "cu_dxb_05" && j.site_id === "st_dxb_05a")).toBe(true);
    expect(jobs.map((j) => String(j.service_id))).toEqual([serviceId("AC-SERVICE"), serviceId("PEST")]);
    // The next visits moved on: 30 days for 12 a year, 91 for 4 a year.
    expect(itemRows(id).map((i) => i.next_visit_on)).toEqual([addDays(today(), 33), addDays(today(), 94)]);
    // Each job has its timeline and its audit row, and shows on the work list.
    const first = String(jobs[0]?.id);
    expect(rows("select note from app__job_events where job_id = ?", [first])[0]?.note).toContain("AMC-000003");
    expect(rows("select action from audit__events where action = 'job.transition' and resource_id = ?", [first])).toHaveLength(1);
    expect((await dispatcher.page("/jobs")).html).toContain(String(jobs[0]?.number));
    expect((await dispatcher.page(`/contracts/${id}`)).html).toContain(String(jobs[1]?.number));
    // The seeded contracts have nothing due yet.
    expect(rows("select count(*) as n from app__contract_jobs where contract_id in ('ct_seed_01', 'ct_seed_02')")[0]?.n).toBe(0);
    const total = rows("select count(*) as n from app__jobs")[0]?.n;
    // Idempotent: a second run makes nothing.
    await runJob(t, "amc-visits");
    expect(visitJobs(id)).toHaveLength(2);
    expect(rows("select count(*) as n from app__jobs")[0]?.n).toBe(total);
  });

  test("a visit that is not due within 14 days waits; an overdue one becomes a single job", async () => {
    const [a, b] = itemRows(id);
    // The next visit of the 12-a-year item falls in 20 days: not yet.
    rw((db) => db.run("update app__contract_items set next_visit_on = ? where id = ?", [addDays(today(), 20), a?.id as number]));
    await runJob(t, "amc-visits");
    expect(visitJobs(id)).toHaveLength(2);
    // The job did not run for 40 days: one visit due today, then the grid goes on after today.
    rw((db) => db.run("update app__contract_items set next_visit_on = ? where id = ?", [addDays(today(), -40), b?.id as number]));
    await runJob(t, "amc-visits");
    const late = visitJobs(id).filter((j) => j.item_id === b?.id);
    expect(late.map((j) => j.due_on)).toEqual([today(), addDays(today(), 3)]);
    expect(String(itemRows(id)[1]?.next_visit_on) > today()).toBe(true);
  });
});

describe("one visit a year", () => {
  test("edge case: exactly one job in the whole year", async () => {
    const id = await create(dispatcher, form({ starts_on: today(), price: "0", customer_id: "cu_dxb_04" }, [{ site: "st_dxb_04a", service: serviceId("AMC-VISIT"), visits: "1" }]));
    expect((await dispatcher.action(`/contracts/${id}`, "activate", {})).status).toBe(303);
    await runJob(t, "amc-visits");
    expect(visitJobs(id)).toHaveLength(1);
    const end = String(contractRow(id).ends_on);
    expect(String(itemRows(id)[0]?.next_visit_on) > end).toBe(true);
    await runJob(t, "amc-visits");
    expect(visitJobs(id)).toHaveLength(1);
    // Even with the clock at the last day of the term, no second visit is due.
    expect(visitDays(today(), end, 1)).toEqual([today()]);
  });
});

describe("renewals", () => {
  const reminders = () => rows("select channel, template from app__customer_messages where customer_id = 'cu_dxb_04' and kind = 'amc_renewal' order by id");
  const staff = () => rows("select category, title, link from notifications__items where user_id = 'u_dxb_dispatcher' and title like 'Contract AMC-000001 ends%'");

  test("normal case: a contract that ends in 30 days is announced once", async () => {
    rw((db) => db.run("update app__contracts set ends_on = ? where id = 'ct_seed_01'", [addDays(today(), 30)]));
    await runJob(t, "amc-renewals");
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]?.template).toBe("amc_renewal");
    const mail = rows("select subject from email__messages where to_address = 'ops@marinaheights.example' and subject like '%AMC-000001%'");
    expect(mail).toHaveLength(1);
    expect(String(mail[0]?.subject)).toBe(`Your maintenance contract AMC-000001 ends on ${addDays(today(), 30)}`);
    const preview = rows("select body from app__outbox_preview where customer_id = 'cu_dxb_04' and template = 'amc_renewal'");
    expect(String(preview[0]?.body)).toContain("AMC-000001");
    expect(staff()).toEqual([{ category: "contracts", title: `Contract AMC-000001 ends on ${addDays(today(), 30)}`, link: "/contracts/ct_seed_01" }]);
    expect(contractRow("ct_seed_01").renewal_notified_on).toBe(today());
    // The same day again: nothing is repeated.
    await runJob(t, "amc-renewals");
    expect(reminders()).toHaveLength(1);
    expect(staff()).toHaveLength(1);
    // The next day the contract ends in 29 days: it does not repeat either.
    rw((db) => db.run("update app__contracts set ends_on = ? where id = 'ct_seed_01'", [addDays(today(), 29)]));
    await runJob(t, "amc-renewals");
    expect(reminders()).toHaveLength(1);
    expect(contractRow("ct_seed_01").status).toBe("active");
  });

  test("the Sharjah contract is not announced (it ends in a year), and a draft is never", async () => {
    expect(rows("select count(*) as n from app__customer_messages where kind = 'amc_renewal'")[0]?.n).toBe(1);
  });

  test("the day after the end the contract is expired, and an expired contract can be renewed once", async () => {
    rw((db) => db.run("update app__contracts set ends_on = ? where id = 'ct_seed_01'", [addDays(today(), -1)]));
    await runJob(t, "amc-renewals");
    expect(contractRow("ct_seed_01").status).toBe("expired");
    expect(rows("select action from audit__events where action = 'contract.expire' and resource_id = 'ct_seed_01'")).toHaveLength(1);
    // Renewing copies the contract for the next year as a draft that starts the day after.
    const res = await dispatcher.action("/contracts/ct_seed_01", "renew", {});
    expect(res.status).toBe(303);
    const next = located(res).replace("/contracts/", "");
    const c = contractRow(next);
    expect(c).toMatchObject({ status: "draft", renewed_from: "ct_seed_01", customer_id: "cu_dxb_04", price_fils: 480000, starts_on: today(), branch_id: "br_dubai" });
    expect(c.ends_on).toBe(yearEnd(today()));
    expect(itemRows(next).map((i) => [i.visits_per_year, i.next_visit_on])).toEqual([[12, today()], [4, today()]]);
    expect((await dispatcher.page("/contracts/ct_seed_01")).html).toContain('id="contract-renewal"');
    // A second renewal of the same contract is a 409.
    expect((await dispatcher.action("/contracts/ct_seed_01", "renew", {})).status).toBe(409);
    // A draft is not renewed.
    expect((await dispatcher.action(`/contracts/${next}`, "renew", {})).status).toBe(409);
  });
});

describe("the contract PDF", () => {
  test("renders in English and Arabic", async () => {
    for (const lang of ["en", "ar"]) {
      const pdf = await dispatcher.page(`/contracts/ct_seed_01/pdf?lang=${lang}`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get("content-type")).toBe("application/pdf");
      expect(pdf.html.startsWith("%PDF")).toBe(true);
    }
  });

  test("a technician is refused, and another branch's contract is not found", async () => {
    expect((await ali.page("/contracts/ct_seed_01/pdf")).status).toBe(403);
    expect((await dispatcher.page("/contracts/ct_seed_02/pdf")).status).toBe(404);
  });
});

describe("who may, and the branch fence", () => {
  test("error case: a technician creating a contract is a 403, and reads none", async () => {
    expect((await ali.page("/contracts")).status).toBe(403);
    expect((await ali.page("/contracts/new")).status).toBe(403);
    const before = rows("select count(*) as n from app__contracts")[0]?.n;
    expect((await ali.action("/contracts/new", "create", form({}, [{ site: "st_dxb_05a", service: serviceId("PEST"), visits: "4" }]))).status).toBe(403);
    expect(rows("select count(*) as n from app__contracts")[0]?.n).toBe(before);
    expect((await ali.action("/contracts/ct_seed_02", "cancel", {})).status).toBe(403);
  });

  test("a Dubai dispatcher neither sees nor changes a Sharjah contract", async () => {
    expect((await dispatcher.page("/contracts/ct_seed_02")).status).toBe(404);
    expect((await dispatcher.action("/contracts/ct_seed_02", "cancel", {})).status).toBe(404);
    expect((await dispatcher.action("/contracts/ct_seed_02", "renew", {})).status).toBe(404);
    expect(contractRow("ct_seed_02").status).toBe("active");
    // A customer of another branch is no customer here.
    const res = await dispatcher.action("/contracts/new", "create", { customer_id: "cu_shj_04", starts_on: today(), price: "0", site_id_0: "st_shj_04a", service_0: serviceId("PEST"), visits_0: "2" });
    expect(res.status).toBe(422);
  });

  test("every row of a contract repeats its branch", () => {
    expect(rows("select count(*) as n from app__contract_items i join app__contracts c on c.id = i.contract_id where i.branch_id != c.branch_id")[0]?.n).toBe(0);
    expect(rows("select count(*) as n from app__contract_jobs cj join app__jobs j on j.id = cj.job_id where cj.branch_id != j.branch_id")[0]?.n).toBe(0);
    expect(rows("select count(*) as n from app__contracts c join app__customers cu on cu.id = c.customer_id where c.branch_id != cu.branch_id")[0]?.n).toBe(0);
  });
});
