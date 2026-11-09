// Invoicing (F7-125): the accountant issues the tax invoice of a done job
// through the tax_gcc module (a sequential number, 5 % VAT, the buyer's TRN),
// records cash, transfer and cheque payments, and credits an invoice. Issuing
// and paying are sensitive actions: the accountant needs a recent second factor
// (twofa), a dispatcher is refused outright. Runs on the local worker with the
// seed's users (password below). The seed has INV-000001, part-paid, on the
// invoiced job J-000013.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { totp } from "@renoxium/sdk";
import { snapshot, app } from "@renoxium/sdk/test";

import { lineTotal } from "../lib/money";

const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string, next = "/invoices") {
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
/** Dates and the invoice dates of the seed move with the day the tests run. */
const steady = (html: string) => html.replace(/\d{4}-\d{2}-\d{2}/gu, "<day>");

const dispatcher = await signIn("dispatcher", "dispatcher.dubai@fixit.example", "/jobs");
const manager = await signIn("manager", "manager.dubai@fixit.example");
const customer = t.as("customer"); // never signs in

// The accountant enrols a TOTP factor on one session, and works on another that passed it (as the shop's refund and the services price edit do).
// (Enrolling counts as a verification of the session that enrols, so a session that never passed the factor signs in first.)
const noFactor = await signIn("accountant-plain", "accountant.dubai@fixit.example");
const enrolling = await signIn("accountant", "accountant.dubai@fixit.example");
const enrol = await enrolling.page("/2fa/enroll/totp");
const secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(enrol.html)?.[1] ?? "").replace(/ /gu, "");
expect((await enrolling.action("/2fa/enroll/totp", "confirm", { code: await totp(secret) })).status).toBe(200);
const halted = await t.as("accountant-2").action("/auth/login", "default", { email: "accountant.dubai@fixit.example", password: PASSWORD, next: "/invoices" });
expect(halted.headers.get("location")).toBe("/2fa/verify?next=%2Finvoices");
expect((await t.as("accountant-2").action("/2fa/verify", "totp", { code: await totp(secret, Date.now() / 1000 + 30), next: "/invoices" })).status).toBe(303);
const accountant = t.as("accountant-2");

const located = (res: { headers: Headers }) => res.headers.get("location") ?? "";
const invoiceRow = (id: string) => rows("select * from app__invoice_status where invoice_id = ?", [id])[0] as Record<string, unknown>;
const doc = (number: string) => JSON.parse(String(rows("select body from tax_gcc__documents where number = ?", [number])[0]?.body)) as { totals: { total: number; vat: number; standard: number }; buyer: { name: string; trn: string | null }; lines: { description: string; net_fils: number; vat_fils: number }[]; number: string; against?: string };
const jobOf = (id: string) => rows("select status from app__jobs where id = ?", [id])[0]?.status;

describe("the seed", () => {
  test("INV-000001 is part-paid by a cheque, and the next number is INV-000002", () => {
    expect(invoiceRow("INV-000001")).toMatchObject({ job_id: "jb_seed_13", total_fils: 35700, paid_fils: 15000, status: "part-paid" });
    expect(rows("select next from tax_gcc__sequences where prefix = 'INV'")).toEqual([{ next: 2 }]);
  });

  test("the accountant's list shows it as open, with its balance", async () => {
    const res = await accountant.page("/invoices");
    expect(res.status).toBe(200);
    expect(res.html).toContain("INV-000001");
    expect(res.html).toContain("Part paid");
    const open = await accountant.page("/invoices?status=open");
    expect(open.html).toContain("INV-000001");
    expect((await accountant.page("/invoices?status=paid")).html).not.toContain("INV-000001");
    snapshot(steady(res.html), { role: "invoices, accountant, en" });
  });

  test("an invoice past its due date is overdue", async () => {
    rw((db) => db.run("update app__job_invoices set due_at = due_at - 40 * 86400 where invoice_id = 'INV-000001'"));
    const res = await accountant.page("/invoices?status=overdue");
    expect(res.html).toContain("INV-000001");
    expect(res.html).toContain("Overdue");
    rw((db) => db.run("update app__job_invoices set due_at = due_at + 40 * 86400 where invoice_id = 'INV-000001'"));
    expect((await accountant.page("/invoices?status=overdue")).html).not.toContain("INV-000001");
  });

  test("the invoice page: the module's document, the cheque, the payment form", async () => {
    const res = await accountant.page("/invoices/INV-000001");
    expect(res.status).toBe(200);
    expect(res.html).toContain("Kitchen mixer tap");
    expect(res.html).toContain("000123");
    expect(res.html).toContain('id="pay"');
    snapshot(steady(res.html), { role: "invoice, accountant, en" });
    const ar = await accountant.page("/invoices/INV-000001?lang=ar");
    expect(ar.html).toContain('<html lang="ar" dir="rtl"');
    snapshot(steady(ar.html), { role: "invoice, accountant, ar" });
  });
});

describe("who may issue", () => {
  test("error case: a dispatcher calling POST /jobs/<id>/invoice is a 403 and nothing is issued", async () => {
    expect((await dispatcher.action("/jobs/jb_seed_12/invoice", "default", {})).status).toBe(403);
    expect(jobOf("jb_seed_12")).toBe("done");
    expect(rows("select 1 from app__job_invoices where job_id = 'jb_seed_12'")).toEqual([]);
  });

  test("an accountant without the second factor is refused (403), and the form is not offered", async () => {
    expect((await noFactor.action("/jobs/jb_seed_12/invoice", "default", {})).status).toBe(403);
    expect((await noFactor.page("/jobs/jb_seed_12")).html).not.toContain('id="invoice-issue"');
    expect(jobOf("jb_seed_12")).toBe("done");
  });

  test("a dispatcher cannot read the invoices; a branch manager reads them but cannot issue", async () => {
    expect((await dispatcher.page("/invoices")).status).toBe(403);
    expect((await dispatcher.page("/invoices/INV-000001")).status).toBe(403);
    expect((await manager.page("/invoices")).status).toBe(200);
    expect((await manager.action("/jobs/jb_seed_12/invoice", "default", {})).status).toBe(403);
  });

  test("the audit table has the decisions on the sensitive action", () => {
    const r = rows("select result from renox__authz_audit_v1 where action = 'invoice.issue' order by id").map((x) => x.result);
    expect(r).toContain("deny");
  });
});

describe("issuing from a done job, paying, and the statement", () => {
  let number = "";
  let link = "";
  const JOB = "jb_seed_12"; // Fatima Al Suwaidi (Arabic), AC service; the seed's visit used two filter sets

  test("normal case: the invoice has a sequential number, 5 % VAT and the customer's TRN; the job is invoiced", async () => {
    rw((db) => db.run("update app__customers set trn = '100123456700003' where id = 'cu_dxb_03'"));
    const res = await accountant.action(`/jobs/${JOB}/invoice`, "default", {});
    expect(res.status).toBe(303);
    number = located(res).replace("/invoices/", "");
    expect(number).toBe("INV-000002");
    const d = doc(number);
    expect(d.buyer).toMatchObject({ name: "Fatima Al Suwaidi", trn: "100123456700003" });
    // The service line (the catalogue's price, once, in Arabic for this customer) and the two filter sets.
    expect(d.lines.map((l) => l.description)).toContain("Filter set");
    const net = d.lines.reduce((n, l) => n + l.net_fils, 0);
    expect(d.totals.standard).toBe(net);
    expect(d.totals.vat).toBe(d.lines.reduce((n, l) => n + lineTotal(1, l.net_fils, 5).vat_fils, 0));
    expect(d.totals.total).toBe(net + d.totals.vat);
    expect(d.lines.some((l) => l.description === "صيانة المكيف")).toBe(true);
    expect(jobOf(JOB)).toBe("invoiced");
    expect(invoiceRow(number)).toMatchObject({ job_id: JOB, branch_id: "br_dubai", customer_id: "cu_dxb_03", total_fils: d.totals.total, paid_fils: 0, status: "issued" });
    const event = rows("select from_status, to_status, note from app__job_events where job_id = ? order by id desc limit 1", [JOB])[0];
    expect(event).toMatchObject({ from_status: "done", to_status: "invoiced", note: `invoice ${number}` });
    expect(rows("select count(*) as n from renox__authz_audit_v1 where action = 'invoice.issue' and result = 'allow'")[0]?.n).toBe(1);
  });

  test("the customer's link shows the invoice and the PDF starts with %PDF (Arabic and English)", async () => {
    const msg = rows("select body from app__outbox_preview where customer_id = 'cu_dxb_03' and template = 'invoice_due'")[0];
    link = /(\/l\/invoice\/[A-Za-z0-9_-]{43})/u.exec(String(msg?.body))?.[1] ?? "";
    expect(link).not.toBe("");
    expect(String(msg?.body)).toContain(number);
    const page = await customer.page(link);
    expect(page.status).toBe(200);
    expect(page.html).toContain(number);
    for (const lang of ["ar", "en"]) {
      const pdf = await customer.page(`${link}/pdf?lang=${lang}`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get("content-type")).toBe("application/pdf");
      expect(pdf.html.startsWith("%PDF")).toBe(true);
    }
    expect((await customer.page(`${link}/pdf`)).status).toBe(200);
    expect((await customer.page(`/l/invoice/${"A".repeat(43)}`)).status).toBe(404);
    expect((await customer.page(`${link.slice(0, -3)}/pdf`)).status).toBe(404);
    expect(rows("select kind from app__customer_messages where customer_id = 'cu_dxb_03' and kind = 'invoice_due'")).toHaveLength(1);
  });

  test("error case: issuing twice is a 409, and so is a job that is not done", async () => {
    const again = await accountant.action(`/jobs/${JOB}/invoice`, "default", {});
    expect(again.status).toBe(409);
    expect(again.html).toContain(number);
    expect((await accountant.action("/jobs/jb_seed_01/invoice", "default", {})).status).toBe(409);
    expect(rows("select count(*) as n from app__job_invoices")[0]?.n).toBe(2);
    expect(rows("select next from tax_gcc__sequences where prefix = 'INV'")).toEqual([{ next: 3 }]);
  });

  test("error case: a dispatcher and an accountant without the factor cannot record a payment", async () => {
    expect((await dispatcher.action(`/invoices/${number}`, "pay", { method: "cash", amount: "10" })).status).toBe(403);
    expect((await noFactor.action(`/invoices/${number}`, "pay", { method: "cash", amount: "10" })).status).toBe(403);
    expect(rows("select 1 from app__payments where invoice_id = ?", [number])).toEqual([]);
  });

  test("normal case: a cheque with its number and date, then a transfer for the rest: paid, and both are audited", async () => {
    const total = doc(number).totals.total;
    const first = 10000;
    const cheque = await accountant.action(`/invoices/${number}`, "pay", { method: "cheque", amount: String(first / 100), cheque_number: "778899", cheque_date: "2026-12-01", reference: "Bank Muscat" });
    expect(cheque.status).toBe(303);
    expect(invoiceRow(number)).toMatchObject({ paid_fils: first, status: "part-paid" });
    expect((await accountant.page(`/invoices/${number}`)).html).toContain("778899");
    const rest = ((total - first) / 100).toFixed(2);
    const transfer = await accountant.action(`/invoices/${number}`, "pay", { method: "transfer", amount: rest, reference: "WIRE-1" });
    expect(transfer.status).toBe(303);
    expect(invoiceRow(number)).toMatchObject({ paid_fils: total, status: "paid" });
    const payments = rows("select method, amount_fils, cheque_number, cheque_date, recorded_by, branch_id from app__payments where invoice_id = ? order by id", [number]);
    expect(payments).toEqual([
      { method: "cheque", amount_fils: first, cheque_number: "778899", cheque_date: "2026-12-01", recorded_by: "u_dxb_accountant", branch_id: "br_dubai" },
      { method: "transfer", amount_fils: total - first, cheque_number: null, cheque_date: null, recorded_by: "u_dxb_accountant", branch_id: "br_dubai" },
    ]);
    const trail = rows("select actor_id, details from audit__events where action = 'invoice.payment' and resource_id = ? order by at, id", [number]);
    expect(trail.map((r) => r.actor_id)).toEqual(["u_dxb_accountant", "u_dxb_accountant"]);
    expect(trail.map((r) => JSON.parse(String(r.details)).method)).toEqual(["cheque", "transfer"]);
    expect(JSON.parse(String(trail[0]?.details)).amount_fils).toBe(first);
    // A paid invoice takes no form and no more money.
    expect((await accountant.page(`/invoices/${number}`)).html).not.toContain('id="pay"');
    expect((await accountant.action(`/invoices/${number}`, "pay", { method: "cash", amount: "1" })).status).toBe(422);
  });

  test("error case: an over-payment is a 422 naming the amount, and a cheque without its number too; nothing is recorded", async () => {
    const before = rows("select count(*) as n from app__payments")[0]?.n;
    const over = await accountant.action("/invoices/INV-000001", "pay", { method: "cash", amount: "207.01" });
    expect(over.status).toBe(422);
    expect(over.html).toContain('id="err-amount"');
    const noNumber = await accountant.action("/invoices/INV-000001", "pay", { method: "cheque", amount: "10", cheque_date: "2026-12-01" });
    expect(noNumber.status).toBe(422);
    expect(noNumber.html).toContain('id="err-cheque_number"');
    expect((await accountant.action("/invoices/INV-000001", "pay", { method: "gold", amount: "10" })).status).toBe(422);
    expect((await accountant.action("/invoices/INV-000001", "pay", { method: "cash", amount: "0" })).status).toBe(422);
    expect(rows("select count(*) as n from app__payments")[0]?.n).toBe(before);
    // The exact balance (207.00) closes it.
    expect((await accountant.action("/invoices/INV-000001", "pay", { method: "cash", amount: "207.00" })).status).toBe(303);
    expect(invoiceRow("INV-000001")).toMatchObject({ paid_fils: 35700, status: "paid" });
  });

  test("the statement lists the customer's invoice and its payments, as a PDF in both languages", async () => {
    const data = (await accountant.page("/customers/cu_dxb_03/statement.pdf?format=json")).json<{ invoices: { number: string; status: string; balance: number }[]; payments: { invoice: string; method: string }[]; totals: { balance: number } }>();
    expect(data.invoices.map((i) => i.number)).toEqual([number]);
    expect(data.invoices[0]).toMatchObject({ status: "مدفوعة", balance: 0 });
    expect(data.payments.map((p) => p.invoice)).toEqual([number, number]);
    expect(data.totals.balance).toBe(0);
    for (const lang of ["en", "ar"]) {
      const pdf = await accountant.page(`/customers/cu_dxb_03/statement.pdf?lang=${lang}`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get("content-type")).toBe("application/pdf");
      expect(pdf.html.startsWith("%PDF")).toBe(true);
    }
    const peter = (await accountant.page("/customers/cu_dxb_01/statement.pdf?format=json&lang=en")).json<{ invoices: { number: string; status: string; balance: number }[]; totals: { balance: number } }>();
    expect(peter.invoices).toEqual([expect.objectContaining({ number: "INV-000001", status: "Paid", balance: 0 })]);
  });

  test("the statement and the invoice PDF need invoice.read", async () => {
    expect((await dispatcher.page("/customers/cu_dxb_03/statement.pdf")).status).toBe(403);
    expect((await dispatcher.page(`/invoices/${number}/pdf`)).status).toBe(403);
    for (const lang of ["en", "ar"]) {
      const pdf = await accountant.page(`/invoices/${number}/pdf?lang=${lang}`);
      expect(pdf.status).toBe(200);
      expect(pdf.html.startsWith("%PDF")).toBe(true);
    }
  });
});

describe("a credit note", () => {
  const JOB = "jb_seed_11"; // Peter Nowak (English)
  let number = "";

  test("edge case: crediting an invoiced job cancels it and the invoice is credited, with the module's credit note", async () => {
    const issued = await accountant.action(`/jobs/${JOB}/invoice`, "default", {});
    expect(issued.status).toBe(303);
    number = located(issued).replace("/invoices/", "");
    expect(jobOf(JOB)).toBe("invoiced");
    // Too short a reason is a 422; nothing changes.
    expect((await accountant.action(`/invoices/${number}`, "credit", { reason: "x" })).status).toBe(422);
    expect(invoiceRow(number)).toMatchObject({ status: "issued", credit_note_id: null });
    expect((await dispatcher.action(`/invoices/${number}`, "credit", { reason: "Customer cancelled" })).status).toBe(403);
    expect((await accountant.action(`/invoices/${number}`, "credit", { reason: "Customer cancelled the job" })).status).toBe(303);
    expect(invoiceRow(number)).toMatchObject({ status: "credited", credit_note_id: "CN-000001" });
    expect(jobOf(JOB)).toBe("cancelled");
    const cn = doc("CN-000001");
    expect(cn.against).toBe(number);
    expect(cn.totals.total).toBe(-doc(number).totals.total);
    const event = rows("select from_status, to_status, note from app__job_events where job_id = ? order by id desc limit 1", [JOB])[0];
    expect(event).toMatchObject({ from_status: "invoiced", to_status: "cancelled" });
    expect(String(event?.note)).toContain("CN-000001");
    const page = await accountant.page(`/invoices/${number}`);
    expect(page.html).toContain("CN-000001");
    expect(page.html).not.toContain('id="pay"');
    expect((await accountant.page("/invoices?status=credited")).html).toContain(number);
  });

  test("error case: a credited invoice takes no payment (409) and no second credit note (409)", async () => {
    expect((await accountant.action(`/invoices/${number}`, "pay", { method: "cash", amount: "1" })).status).toBe(409);
    expect((await accountant.action(`/invoices/${number}`, "credit", { reason: "Again" })).status).toBe(409);
    expect(rows("select count(*) as n from tax_gcc__documents where kind = 'credit_note'")[0]?.n).toBe(1);
  });
});

describe("the branch fence", () => {
  test("a Sharjah invoice is not found, listed or paid by a Dubai accountant; every row repeats its branch", async () => {
    rw((db) => {
      db.run("insert into app__job_invoices (job_id, branch_id, customer_id, invoice_id, total_fils, due_at, created_by, created_at) values ('jb_seed_19', 'br_sharjah', 'cu_shj_03', 'INV-000099', 10000, 1900000000, 'u_shj_dispatcher', 1790000000)");
    });
    expect((await accountant.page("/invoices/INV-000099")).status).toBe(404);
    expect((await accountant.page("/invoices")).html).not.toContain("INV-000099");
    expect((await accountant.action("/invoices/INV-000099", "pay", { method: "cash", amount: "10" })).status).toBe(404);
    expect((await accountant.page("/customers/cu_shj_03/statement.pdf")).status).toBe(404);
    expect(rows("select count(*) as n from app__payments p join app__job_invoices i on i.invoice_id = p.invoice_id where p.branch_id != i.branch_id")[0]?.n).toBe(0);
    expect(rows("select count(*) as n from app__job_invoices i join app__customers c on c.id = i.customer_id where i.branch_id != c.branch_id")[0]?.n).toBe(0);
  });
});
