// Reports (F7-127): the `reports` module's sales page for the owner and the
// accountant, and the app's own reports under /reports/*: jobs per technician,
// maintenance contracts that end in the period, and the open invoices by age,
// each exported as CSV (through the module's `csv` service) or .xlsx. Runs on
// the local worker with the seed's users (password below). The seed has
// INV-000001 (357.00, 150.00 paid, issued five days ago), four finished visits
// (Dubai: Bilal twice, Ali once; Sharjah: Hamad once) and the two contracts.
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { app, snapshot } from "@renoxium/sdk/test";

import { addDays } from "../lib/contract-dates";

setDefaultTimeout(60_000);
const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string, next = "/reports") {
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
const today = (): string => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
const steady = (html: string) => html.replace(/\d{4}-\d{2}-\d{2}/gu, "<day>");
const BOM = "﻿";

const owner = await signIn("owner", "owner@fixit.example");
const accountant = await signIn("accountant", "accountant.dubai@fixit.example");
const dispatcher = await signIn("dispatcher", "dispatcher.dubai@fixit.example");
const manager = await signIn("manager", "manager.dubai@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example", "/me");

/** The export form of a report page, as the page posts it. */
const exportOf = (who: typeof owner, path: string, fields: Record<string, string>) => who.action(path, "export", fields);
const lines = (csv: string): string[] => csv.split("\r\n").filter((l) => l !== "");
const name = (user: string): string => String(rows("select display_name from auth__users where id = ?", [user])[0]?.display_name);

describe("the module's sales page", () => {
  test("normal case: the owner sees the seeded invoice's totals for the period", async () => {
    const res = await owner.page(`/reports?from=${addDays(today(), -30)}&to=${addDays(today(), 2)}`);
    expect(res.status).toBe(200);
    // INV-000001: 340.00 before VAT, 17.00 VAT, 357.00 in all.
    expect(res.html).toContain('<td dir="auto">1</td><td dir="auto">340.00</td><td dir="auto">17.00</td><td dir="auto">357.00</td>');
    expect(res.html).toContain('id="reports-sales"');
  });

  test("the accountant sees it too; a dispatcher, a manager and a technician get 403", async () => {
    expect((await accountant.page("/reports")).status).toBe(200);
    for (const who of [dispatcher, manager, ali]) expect((await who.page("/reports")).status).toBe(403);
  });
});

describe("jobs per technician", () => {
  test("normal case: the owner sees the Dubai technicians' finished visits, not Sharjah's", async () => {
    const res = await owner.page("/reports/technicians");
    expect(res.status).toBe(200);
    expect(res.html).toContain(name("u_dxb_bilal"));
    expect(res.html).toContain(name("u_dxb_ali"));
    expect(res.html).not.toContain(name("u_shj_hamad"));
    expect(res.html).toContain('id="report-technicians"');
    snapshot(steady(res.html), { role: "technicians, owner, en" });
    // ?lang=ar is remembered for the user, so English is asked for again after it.
    const ar = await owner.page("/reports/technicians?lang=ar");
    expect(ar.html).toContain('<html lang="ar" dir="rtl"');
    snapshot(steady(ar.html), { role: "technicians, owner, ar" });
    expect((await owner.page("/reports/technicians?lang=en")).html).toContain('<html lang="en" dir="ltr"');
  });

  test("normal case: the CSV has the documented header and one line per technician", async () => {
    const res = await exportOf(owner, "/reports/technicians", { from: addDays(today(), -29), to: today(), format: "csv" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain(`technicians-${addDays(today(), -29)}_${today()}.csv`);
    // Bilal: J-000011 (50 minutes) and J-000013 (73 minutes 20 seconds) = 2.06 hours, parts 45.00 + 180.00. Ali: J-000012, 0.91 hours, two filter sets.
    expect(lines(res.html)).toEqual(["technician,jobs_done,hours,parts_fils", `${name("u_dxb_ali")},1,0.91,5000`, `${name("u_dxb_bilal")},2,2.06,22500`].sort((a, b) => (a.startsWith("technician") ? -1 : b.startsWith("technician") ? 1 : a.localeCompare(b))));
  });

  test("the .xlsx has the same header and numbers as numbers", async () => {
    const res = await exportOf(accountant, "/reports/technicians", { from: addDays(today(), -29), to: today(), format: "xlsx" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.html.startsWith("PK")).toBe(true);
    for (const h of ["technician", "jobs_done", "hours", "parts_fils"]) expect(res.html).toContain(`<t xml:space="preserve">${h}</t>`);
    expect(res.html).toContain("<v>22500</v>");
    expect(res.html).toContain(name("u_dxb_bilal"));
  });

  test("edge case: an empty period says there is no data, and the export is only the header", async () => {
    const res = await owner.page("/reports/technicians?from=2020-01-01&to=2020-01-31");
    expect(res.status).toBe(200);
    expect(res.html).toContain('id="no-data"');
    expect(res.html).toContain("No data for this period.");
    const csv = await exportOf(owner, "/reports/technicians", { from: "2020-01-01", to: "2020-01-31", format: "csv" });
    expect(csv.html).toBe("technician,jobs_done,hours,parts_fils\r\n");
    const xl = await exportOf(owner, "/reports/technicians", { from: "2020-01-01", to: "2020-01-31", format: "xlsx" });
    expect(xl.html.startsWith("PK")).toBe(true);
    expect(xl.html).not.toContain(name("u_dxb_bilal"));
    // A period that is not a date falls back to the last thirty days.
    expect((await owner.page("/reports/technicians?from=nope&to=2020-13-45")).html).toContain(name("u_dxb_bilal"));
  });

  test("a visit that began before the period is not counted", async () => {
    const res = await owner.page(`/reports/technicians?from=${addDays(today(), 1)}&to=${addDays(today(), 5)}`);
    expect(res.html).toContain('id="no-data"');
  });
});

describe("contract renewals", () => {
  test("normal case: the Dubai contract ends within 90 days and is due; Sharjah's is not shown", async () => {
    const res = await owner.page("/reports/amc");
    expect(res.status).toBe(200);
    expect(res.html).toContain("AMC-000001");
    expect(res.html).toContain("Marina Heights Property Management");
    expect(res.html).toContain("Due");
    expect(res.html).not.toContain("AMC-000002");
    snapshot(steady(res.html), { role: "amc, owner, en" });
    expect((await owner.page(`/reports/amc?from=${today()}&to=${addDays(today(), 500)}`)).html).not.toContain("AMC-000002");
  });

  test("the CSV has the documented columns, and the state follows the reminder and the renewal", async () => {
    const ends = String(rows("select ends_on from app__contracts where id = 'ct_seed_01'")[0]?.ends_on);
    const fields = { from: today(), to: addDays(today(), 90), format: "csv" };
    expect(lines((await exportOf(owner, "/reports/amc", fields)).html)).toEqual(["contract,customer,ends_on,price_fils,status,renewal,renewed_by", `AMC-000001,Marina Heights Property Management,${ends},480000,active,due,`]);
    rw((db) => db.run("update app__contracts set renewal_notified_on = ? where id = 'ct_seed_01'", [today()]));
    expect(lines((await exportOf(owner, "/reports/amc", fields)).html)[1]).toBe(`AMC-000001,Marina Heights Property Management,${ends},480000,active,reminded,`);
    // Renewing makes a draft (not in the report) and the original `renewed`.
    expect((await dispatcher.action("/contracts/ct_seed_01", "renew", {})).status).toBe(303);
    const renewed = await exportOf(owner, "/reports/amc", fields);
    expect(lines(renewed.html)).toEqual(["contract,customer,ends_on,price_fils,status,renewal,renewed_by", `AMC-000001,Marina Heights Property Management,${ends},480000,active,renewed,AMC-000003`]);
    expect((await owner.page("/reports/amc")).html).toContain("Renewed");
  });

  test("edge case: no contract ends in the period", async () => {
    const res = await owner.page("/reports/amc?from=2020-01-01&to=2020-02-01");
    expect(res.html).toContain('id="no-data"');
    expect((await exportOf(owner, "/reports/amc", { from: "2020-01-01", to: "2020-02-01", format: "csv" })).html).toBe("contract,customer,ends_on,price_fils,status,renewal,renewed_by\r\n");
  });
});

describe("outstanding invoices", () => {
  const HEADER = "customer,days_0_30_fils,days_31_60_fils,days_over_60_fils,balance_fils";

  test("normal case: INV-000001's balance is in the first bucket", async () => {
    const res = await owner.page("/reports/outstanding");
    expect(res.status).toBe(200);
    expect(res.html).toContain("Layla Haddad");
    expect(res.html).toContain("207.00");
    snapshot(steady(res.html), { role: "outstanding, owner, en" });
    const csv = await exportOf(accountant, "/reports/outstanding", { format: "csv" });
    expect(lines(csv.html)).toEqual([HEADER, "Layla Haddad,20700,0,0,20700"]);
  });

  test("the ages split the balance; paid invoices and another branch's are left out", async () => {
    const day = 86400;
    const at = Math.floor(Date.now() / 1000);
    rw((db) => {
      const invoice = db.prepare("insert into app__job_invoices (job_id, contract_id, branch_id, customer_id, invoice_id, total_fils, due_at, created_by, created_at) values (null, null, ?, ?, ?, ?, ?, 'seed', ?)");
      invoice.run("br_dubai", "cu_dxb_02", "INV-000090", 10000, at, at - 45 * day);
      invoice.run("br_dubai", "cu_dxb_02", "INV-000091", 5000, at, at - 90 * day);
      invoice.run("br_dubai", "cu_dxb_03", "INV-000092", 3000, at, at - 10 * day);
      invoice.run("br_sharjah", "cu_shj_01", "INV-000093", 9000, at, at - 10 * day);
      db.run("insert into app__payments (branch_id, invoice_id, method, amount_fils, received_at, reference, recorded_by, created_at) values ('br_dubai', 'INV-000092', 'cash', 3000, ?, '', 'seed', ?)", [at, at]);
      db.run("insert into app__payments (branch_id, invoice_id, method, amount_fils, received_at, reference, recorded_by, created_at) values ('br_dubai', 'INV-000091', 'cash', 1000, ?, '', 'seed', ?)", [at, at]);
    });
    const csv = await exportOf(owner, "/reports/outstanding", { format: "csv" });
    // Peter: 100.00 aged 45 days, 40.00 left of the 90-day one; the biggest balance (Layla, 207.00) first.
    expect(lines(csv.html)).toEqual([HEADER, "Layla Haddad,20700,0,0,20700", `${rows("select name from app__customers where id = 'cu_dxb_02'")[0]?.name},0,10000,4000,14000`]);
    expect((await owner.page("/reports/outstanding")).html).not.toContain(String(rows("select name from app__customers where id = 'cu_shj_01'")[0]?.name));
  });

  test("edge case: with nothing open the page says so and the export is only the header", async () => {
    rw((db) => db.run("insert into app__payments (branch_id, invoice_id, method, amount_fils, received_at, reference, recorded_by, created_at) values ('br_dubai', 'INV-000001', 'cash', 20700, 1, '', 'seed', 1), ('br_dubai', 'INV-000090', 'cash', 10000, 1, '', 'seed', 1), ('br_dubai', 'INV-000091', 'cash', 4000, 1, '', 'seed', 1)"));
    const res = await owner.page("/reports/outstanding");
    expect(res.html).toContain('id="no-data"');
    expect((await exportOf(owner, "/reports/outstanding", { format: "csv" })).html).toBe(`${HEADER}\r\n`);
  });
});

describe("in Arabic", () => {
  test("the three reports render right to left for the owner", async () => {
    for (const path of ["/reports/technicians", "/reports/amc", "/reports/outstanding"]) {
      const res = await owner.page(`${path}?lang=ar`);
      expect(res.status).toBe(200);
      expect(res.html).toContain('<html lang="ar" dir="rtl"');
      expect(res.html).toContain('id="report-nav"');
    }
    expect((await owner.page("/reports/amc?lang=en")).html).toContain('<html lang="en" dir="ltr"');
  });
});

describe("who may", () => {
  test("error case: a dispatcher, a manager and a technician get 403 on every report and every export", async () => {
    for (const who of [dispatcher, manager, ali]) {
      for (const path of ["/reports/technicians", "/reports/amc", "/reports/outstanding"]) {
        expect((await who.page(path)).status).toBe(403);
        expect((await exportOf(who, path, { format: "csv" })).status).toBe(403);
      }
    }
  });

  test("a signed-out visitor is sent to sign in", async () => {
    const res = await t.request("GET", "/reports/technicians");
    expect(res.status).toBe(403);
  });

  test("every export is an audit row naming the report, the format and who exported", () => {
    const trail = rows("select actor_id, resource_id, details from audit__events where action = 'report.export' order by at, id");
    expect(trail.length).toBeGreaterThanOrEqual(8);
    expect(trail[0]).toMatchObject({ actor_id: "u_owner", resource_id: "technicians" });
    expect(JSON.parse(String(trail[0]?.details))).toMatchObject({ format: "csv", rows: 2 });
    expect(trail.some((r) => r.actor_id === "u_dxb_accountant")).toBe(true);
    expect(rows("select count(*) as n from audit__events where action = 'report.export' and actor_id in ('u_dxb_dispatcher', 'u_dxb_manager', 'u_dxb_ali')")[0]?.n).toBe(0);
  });
});

describe("the nightly summary", () => {
  test("goes to the accounts email of the settings", async () => {
    expect(rows("select value from app__settings where key = 'accounts_email'")[0]?.value).toBe("accounts@fixit.example");
    const day = new Date().toISOString().slice(0, 10);
    const sent = (await t.service("reports").nightly?.(Date.now() + 86_400_000)) as { day: string; sent_to: string | null };
    expect(sent).toEqual({ day, sent_to: "accounts@fixit.example" });
    expect(rows("select subject from email__messages where to_address = 'accounts@fixit.example'")).toEqual([{ subject: `Daily report ${day}` }]);
    expect(rows("select day, sent_to from reports__snapshots")).toEqual([{ day, sent_to: "accounts@fixit.example" }]);
  });
});
