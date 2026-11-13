// The customer's documents on `/my` (#777): the tax invoices (a list, one
// invoice with "Download PDF" and the company's payment instructions while it
// is open, the PDF) and the report of a done visit (the summary, the parts with
// their quantities, the photos, who signed, the PDF). Every route reads through
// `customerDb`: another customer's invoice, visit or photo is a 404, as is a
// number tax_gcc never issued (the app keeps no draft invoice) or a visit not
// checked out. The PDFs are the link versions' bytes, in the language of the
// customer record. Peter Nowak (cu_dxb_02, English) and Layla Haddad
// (cu_dxb_01, Arabic, the seed's INV-000001 and the done job J-000013) are the
// customers. The phone sign-in goes through auth's real pages
// (tests/outbox.ts phoneSignIn). auth makes at most 3 accounts an hour per
// address: this file signs up two.
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { totp } from "@renoxium/sdk";
import { app, snapshot } from "@renoxium/sdk/test";

import ar from "../i18n/ar.json";
import en from "../i18n/en.json";
import { tokenHash } from "../lib/links";
import { base64Of, solidPng } from "../lib/placeholder-png";
import { instructionsIn, isOpen } from "../lib/portal-view";
import { PAYMENT_INSTRUCTIONS_MAX, paymentInstructionsOf } from "../lib/settings";
import { phoneSignIn } from "./outbox";

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

const PETER = "+971521110002";
const LAYLA = "+971501110001";
const NOW = Math.floor(Date.now() / 1000);
const DAY_S = 86_400;
const service = (code: string) => Number(rows("select id from app__services where code = ?", [code])[0]?.id);

/** A tax_gcc document written the way the module writes it (as the seed does for INV-000001). */
function taxDocument(db: Database, number: string, buyer: string, lines: { description: string; net: number }[], issuedAt: number) {
  const standard = lines.reduce((n, l) => n + l.net, 0);
  const vat = Math.round(standard * 0.05);
  const fils = (n: number) => (n / 100).toFixed(2);
  const body = {
    kind: "invoice",
    title: { en: "Tax Invoice", ar: "فاتورة ضريبية" },
    number,
    issued_at: issuedAt * 1000,
    seller: { name: "FixIt Services LLC", trn: "100000000000003", address: "Dubai" },
    buyer: { name: buyer, trn: null, address: "Villa, Al Barsha, Street 14, villa 22" },
    lines: lines.map((l) => ({ description: l.description, quantity: 1, unit_fils: l.net, rate: "standard", net_fils: l.net, vat_fils: Math.round(l.net * 0.05) })),
    totals: { standard, zero: 0, exempt: 0, vat, total: standard + vat, vat_rate: 5, currency: "AED", display: { standard: fils(standard), zero: "0.00", exempt: "0.00", vat: fils(vat), total: fils(standard + vat) } },
  };
  db.run("insert into tax_gcc__documents (number, kind, against, body, standard, zero, exempt, vat, issued_at) values (?, 'invoice', null, ?, ?, 0, 0, ?, ?)", [number, JSON.stringify(body), standard, vat, issuedAt * 1000]);
  return standard + vat;
}

// What the seed does not hold for Peter: the invoice of his done job J-000011 (paid two days ago), the upfront
// invoice of an active contract (open), nine older credited invoices (for the paging), a draft contract (no
// invoice), and the customers' report and invoice links, for the bytes the link versions serve. Below, Ali
// makes Peter's scheduled visit J-000006 a done one through the real flow, with two photos the storage
// module holds (the seed's photo files are never stored in a test).
const PAID_AT = NOW - 2 * DAY_S;
const INVOICE_TOKEN = `inv${"d".repeat(40)}`;
const REPORT_TOKEN = `rep${"e".repeat(40)}`;
const hashes = { invoice: await tokenHash(INVOICE_TOKEN), report: await tokenHash(REPORT_TOKEN) };
rw((db) => {
  const paid = taxDocument(db, "INV-000901", "Peter Nowak", [{ description: "Handyman", net: 45000 }], NOW - 10 * DAY_S);
  db.run("insert into app__job_invoices (job_id, branch_id, customer_id, invoice_id, total_fils, due_at, credit_note_id, created_by, created_at) values ('jb_seed_11', 'br_dubai', 'cu_dxb_02', 'INV-000901', ?, ?, null, 'u_dxb_accountant', ?)", [paid, NOW + 20 * DAY_S, NOW - 10 * DAY_S]);
  db.run("insert into app__payments (branch_id, invoice_id, method, amount_fils, received_at, reference, cheque_number, cheque_date, recorded_by, created_at) values ('br_dubai', 'INV-000901', 'transfer', ?, ?, 'WIRE-901', null, null, 'u_dxb_accountant', ?)", [paid, PAID_AT, PAID_AT]);
  db.run(
    "insert into app__contracts (id, branch_id, customer_id, number, status, starts_on, ends_on, price_fils, vat_rate, billing, notes, invoice_id, renewed_from, renewal_notified_on, created_by, created_at, activated_at) values ('ct_md_01', 'br_dubai', 'cu_dxb_02', 'AMC-000911', 'active', '2026-11-01', '2027-10-31', 120000, 5, 'upfront', '', 'INV-000902', null, null, 'u_dxb_dispatcher', ?, ?)",
    [NOW - DAY_S, NOW - DAY_S],
  );
  const amc = taxDocument(db, "INV-000902", "Peter Nowak", [{ description: "Maintenance contract AMC-000911", net: 120000 }], NOW - DAY_S);
  db.run("insert into app__job_invoices (job_id, contract_id, branch_id, customer_id, invoice_id, total_fils, due_at, credit_note_id, created_by, created_at) values (null, 'ct_md_01', 'br_dubai', 'cu_dxb_02', 'INV-000902', ?, ?, null, 'u_dxb_accountant', ?)", [amc, NOW + 29 * DAY_S, NOW - DAY_S]);
  db.run(
    "insert into app__contracts (id, branch_id, customer_id, number, status, starts_on, ends_on, price_fils, vat_rate, billing, notes, invoice_id, renewed_from, renewal_notified_on, created_by, created_at, activated_at) values ('ct_md_02', 'br_dubai', 'cu_dxb_02', 'AMC-000912', 'draft', '2026-12-01', '2027-11-30', 90000, 5, 'upfront', '', null, null, null, 'u_dxb_dispatcher', ?, null)",
    [NOW],
  );
  for (let i = 0; i < 9; i++) {
    const at = NOW - (30 + i) * DAY_S;
    db.run(
      "insert into app__jobs (id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, scheduled_start, scheduled_end, technician_user_id, booking_id, created_by, created_at, updated_at, source) values (?, 'br_dubai', 'cu_dxb_02', 'st_dxb_02a', null, ?, 'invoiced', 'normal', ?, '', ?, ?, 'u_dxb_bilal', null, 'u_dxb_dispatcher', ?, ?, 'staff')",
      [`jb_md_${i}`, `J-00095${i}`, service("PLUMBING"), at, at + 3600, at, at],
    );
    db.run("insert into app__job_invoices (job_id, branch_id, customer_id, invoice_id, total_fils, due_at, credit_note_id, created_by, created_at) values (?, 'br_dubai', 'cu_dxb_02', ?, 10500, ?, ?, 'u_dxb_accountant', ?)", [`jb_md_${i}`, `INV-00091${i}`, at + 30 * DAY_S, `CN-00091${i}`, at]);
  }
  db.run("insert into app__links (token_hash, kind, ref_id, expires_at, used_at) values (?, 'invoice', 'INV-000001', ?, null)", [hashes.invoice, NOW + DAY_S]);
  db.run("insert into app__links (token_hash, kind, ref_id, expires_at, used_at) values (?, 'report', 'vs_seed_13', ?, null)", [hashes.report, NOW + DAY_S]);
});

const peter = t.as("peter");
expect((await phoneSignIn(peter, rows, write, PETER, "/my")).status).toBe(303);
const layla = t.as("layla");
expect((await phoneSignIn(layla, rows, write, LAYLA, "/my")).status).toBe(303);
const nobody = t.as("nobody");

// The browser's PUT of binary bytes, as tests/visits.test.ts sends it: a latin-1 string with `x-test-binary`.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const headers = init?.headers as Record<string, string> | undefined;
  if (headers?.["x-test-binary"] !== undefined && typeof init?.body === "string") {
    const { "x-test-binary": _binary, ...rest } = headers;
    return realFetch(input, { ...init, headers: rest, body: Uint8Array.from(init.body, (c) => c.charCodeAt(0)) });
  }
  return realFetch(input, init);
}) as typeof fetch;
const latin1 = (bytes: Uint8Array): string => Array.from(bytes, (b) => String.fromCharCode(b)).join("");

/** Peter's J-000006 done by Ali: check in, a photo before and one after (signed upload, PUT, key), a part, the signature, check out. */
const ali = t.as("ali");
expect((await ali.action("/auth/login", "default", { email: "ali.dubai@fixit.example", password: PASSWORD, next: "/me" })).status).toBe(303);
const DONE = "jb_seed_06";
expect((await ali.action(`/me/visits/${DONE}`, "checkin", {})).status).toBe(303);
for (const [phase, name, rgb] of [["before", "dirty.png", [0x8a, 0x5c, 0x3c]], ["after", "clean.png", [0x1f, 0x6f, 0x5c]]] as const) {
  const png = solidPng([rgb[0], rgb[1], rgb[2]], 16).bytes;
  const signed = await ali.action(`/me/visits/${DONE}`, "photo_url", { name, type: "image/png", size: String(png.length) });
  expect(signed.status).toBe(200);
  const put = await ali.request("PUT", signed.json<{ url: string }>().url, { body: latin1(png), headers: { "content-type": "image/png", "x-test-binary": "1" } });
  expect(put.status).toBe(201);
  expect((await ali.action(`/me/visits/${DONE}`, "photo", { phase, caption: `The ${phase} photo`, key: put.json<{ key: string }>().key })).status).toBe(303);
}
expect((await ali.action(`/me/visits/${DONE}`, "part", { description: "Bait station", qty: "3", price: "12.50" })).status).toBe(303);
expect((await ali.action(`/me/visits/${DONE}`, "signature", { signed_by: "Peter Nowak", signature: `data:image/png;base64,${base64Of(solidPng([0, 0, 0], 12).bytes)}` })).status).toBe(303);
expect((await ali.action(`/me/visits/${DONE}`, "checkout", {})).status).toBe(303);
const DONE_VISIT = String(rows("select id from app__visits where job_id = ?", [DONE])[0]?.id);

const ids = (html: string) => [...html.matchAll(/<tr id="invoice-(INV-\d+)"/gu)].map((m) => m[1]);
const rowOf = (html: string, id: string) => new RegExp(`<tr id="invoice-${id}">[^]*?</tr>`, "u").exec(html)?.[0] ?? "";
const WEEKDAYS = new RegExp([...Object.values(en.backoffice.hours.day), ...Object.values(ar.backoffice.hours.day)].join("|"), "gu");
const steady = (html: string): string =>
  html
    .replace(/(exp=)\d+(&amp;sig=)[0-9a-f]+/gu, "$1<exp>$2<sig>")
    .replace(/\d{4}-\d{2}-\d{2}/gu, "<day>")
    .replace(/\d{2}:\d{2}/gu, "<time>")
    .replace(WEEKDAYS, "<weekday>");

describe("the helpers", () => {
  test("open is issued or part-paid; the payment instructions in the page's language, as lines, the other language when empty", () => {
    expect(["issued", "part-paid", "paid", "credited"].map(isOpen)).toEqual([true, true, false, false]);
    expect(instructionsIn({ en: " Bank transfer\r\n\r\n IBAN AE07 0331 \n", ar: "" }, "en")).toEqual(["Bank transfer", "IBAN AE07 0331"]);
    expect(instructionsIn({ en: "Bank transfer", ar: "تحويل بنكي" }, "ar")).toEqual(["تحويل بنكي"]);
    expect(instructionsIn({ en: "Bank transfer", ar: " " }, "ar")).toEqual(["Bank transfer"]);
    expect(instructionsIn({ en: "", ar: "" }, "en")).toEqual([]);
  });

  test("the settings form: trimmed, plain line ends, at most 500 characters each", () => {
    const form = (en: string, ar?: string) => {
      const f = new FormData();
      f.set("payment_instructions_en", en);
      if (ar !== undefined) f.set("payment_instructions_ar", ar);
      return f;
    };
    expect(paymentInstructionsOf(form(" a\r\nb ", ""))).toEqual({ value: { payment_instructions_en: "a\nb", payment_instructions_ar: "" } });
    expect(paymentInstructionsOf(form("a"))).toEqual({ value: { payment_instructions_en: "a" } });
    expect(paymentInstructionsOf(form("x".repeat(PAYMENT_INSTRUCTIONS_MAX)))).toEqual({ value: { payment_instructions_en: "x".repeat(500) } });
    expect(paymentInstructionsOf(form("x".repeat(501), "y"))).toEqual({ errors: { payment_instructions_en: "backoffice.err.payment_instructions" } });
    expect([en.backoffice.err.payment_instructions, ar.backoffice.err.payment_instructions].every((s) => s.includes("500"))).toBe(true);
  });
});

describe("/my/invoices", () => {
  test("only this customer's issued invoices, newest first, 10 a page: number, day, what for, total with VAT, state", async () => {
    const one = await peter.page("/my/invoices?lang=en");
    expect(one.status).toBe(200);
    const first = ids(one.html);
    expect(first).toEqual(["INV-000902", "INV-000901", ...Array.from({ length: 8 }, (_, i) => `INV-00091${i}`)]);
    expect(one.html).toContain('href="/my/invoices?page=2"');
    const two = await peter.page("/my/invoices?page=2&lang=en");
    expect(ids(two.html)).toEqual(["INV-000918"]);
    expect(two.html).toContain('href="/my/invoices?page=1"');
    // Layla's invoice and the draft contract are not there.
    for (const html of [one.html, two.html]) {
      expect(html).not.toContain("INV-000001");
      expect(html).not.toContain("AMC-000912");
      expect(html).not.toContain("Layla");
    }
    const amc = rowOf(one.html, "INV-000902");
    expect(amc).toContain('<a href="/my/invoices/INV-000902" dir="auto">INV-000902</a>');
    expect(amc).toContain('Contract <span dir="ltr">AMC-000911</span>');
    expect(amc).toContain("1,260.00");
    expect(amc).toContain("Open, due");
    const job = rowOf(one.html, "INV-000901");
    expect(job).toContain("Handyman");
    expect(job).toContain("472.50");
    expect(job).toContain(`Paid on</span> <span dir="ltr">${new Date((PAID_AT + 4 * 3600) * 1000).toISOString().slice(0, 10)}</span>`);
    expect(rowOf(one.html, "INV-000910")).toContain("Credited");
  });

  test("on top: what is left to pay on the open invoices, and how many", async () => {
    const res = await peter.page("/my/invoices?lang=en");
    const top = /<p[^>]*id="open-sum"[^]*?<\/p>/u.exec(res.html)?.[0] ?? "";
    expect(top).toContain("To pay on your open invoices:");
    expect(top).toContain("1,260.00");
    expect(top).toContain('<span dir="ltr">1</span> open');
    // Layla's part-paid INV-000001: 357.00 less the 150.00 cheque.
    expect((await layla.page("/my/invoices?lang=en")).html).toContain("207.00");
  });

  test("the /my tile: how many are open and their sum, linking to the list", async () => {
    const res = await peter.page("/my?lang=en");
    const tile = /<a class="tile" href="\/my\/invoices" id="tile-invoices">[^]*?<\/a>/u.exec(res.html)?.[0] ?? "";
    expect(tile).toContain('Invoices <strong dir="ltr">1</strong> open');
    expect(tile).toContain("1,260.00");
  });

  test("the empty state", async () => {
    write("update app__job_invoices set customer_id = 'cu_dxb_05' where customer_id = 'cu_dxb_02'");
    try {
      const res = await peter.page("/my/invoices?lang=en");
      expect(res.status).toBe(200);
      expect(res.html).toContain('id="invoices-empty"');
      expect(res.html).toContain("You have no invoices yet.");
      expect(res.html).not.toContain('id="open-sum"');
      expect((await peter.page("/my?lang=en")).html).toContain('Invoices <strong dir="ltr">0</strong> open</a>');
    } finally {
      write("update app__job_invoices set customer_id = 'cu_dxb_02' where invoice_id like 'INV-0009%'");
    }
  });
});

describe("/my/invoices/<number>", () => {
  test("the invoice as the customer's link shows it, with Download PDF; no payment instructions while none are set", async () => {
    const res = await peter.page("/my/invoices/INV-000902?lang=en");
    expect(res.status).toBe(200);
    expect(res.html).toContain('<span dir="ltr">INV-000902</span>');
    expect(res.html).toContain("Maintenance contract AMC-000911");
    expect(res.html).toContain("1,260.00");
    expect(res.html).toContain('id="invoice-due"');
    expect(res.html).toContain('<a href="/my/invoices/INV-000902/pdf" class="btn-brand">Download PDF</a>');
    expect(res.html).not.toContain('id="payment-instructions"');
  });

  test("another customer's invoice, a number never issued (no draft is kept) and a malformed number are 404, on the page and on the PDF", async () => {
    for (const id of ["INV-000001", "INV-999999", "INV-1", "x'or'1", "AMC-000912"]) {
      const page = await peter.page(`/my/invoices/${encodeURIComponent(id)}`);
      expect([id, page.status]).toEqual([id, 404]);
      expect(page.html).not.toContain("Layla");
      const pdf = await peter.page(`/my/invoices/${encodeURIComponent(id)}/pdf`);
      expect([id, pdf.status]).toEqual([id, 404]);
      expect(pdf.headers.get("content-type")).not.toContain("pdf");
    }
    // An invoice row the module never issued a document for is no invoice either.
    write("insert into app__job_invoices (job_id, branch_id, customer_id, invoice_id, total_fils, due_at, credit_note_id, created_by, created_at) values ('jb_seed_14', 'br_dubai', 'cu_dxb_02', 'INV-000990', 100, ?, null, 'u_dxb_accountant', ?)", [NOW + DAY_S, NOW - 400 * DAY_S]);
    try {
      expect((await peter.page("/my/invoices/INV-000990")).status).toBe(404);
      expect((await peter.page("/my/invoices/INV-000990/pdf")).status).toBe(404);
    } finally {
      write("delete from app__job_invoices where invoice_id = 'INV-000990'");
    }
  });

  test("the PDF: application/pdf, private, no-store, named after the number, the link version's bytes", async () => {
    const res = await peter.page("/my/invoices/INV-000901/pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="INV-000901.pdf"');
    expect(res.html.length).toBeGreaterThan(1000);
    expect(res.html.startsWith("%PDF")).toBe(true);
  });

  test("the Arabic customer gets the Arabic template, whatever the page's language: the link version's Arabic bytes", async () => {
    await layla.page("/my?lang=en");
    const mine = await layla.page("/my/invoices/INV-000001/pdf");
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("private, no-store");
    const linkAr = await nobody.page(`/l/invoice/${INVOICE_TOKEN}/pdf?lang=ar`);
    const linkEn = await nobody.page(`/l/invoice/${INVOICE_TOKEN}/pdf?lang=en`);
    expect(linkAr.status).toBe(200);
    expect(mine.html).toBe(linkAr.html);
    expect(mine.html).not.toBe(linkEn.html);
  });
});

describe("the visit report on /my/visits/<id>", () => {
  const section = (html: string) => /<section[^>]*id="visit-report"[^]*?<\/section>/u.exec(html)?.[0] ?? "";

  test("a done visit: what was done, the parts with quantities and no prices, who signed, the PDF link", async () => {
    const res = await peter.page("/my/visits/jb_seed_11?lang=en");
    expect(res.status).toBe(200);
    const report = section(res.html);
    expect(report).toContain("What was done");
    expect(report).toContain("The TV was mounted on the living-room wall and the curtain rail was fixed.");
    expect(report).toContain('Wall bracket × <span dir="ltr">1</span>');
    expect(report).not.toContain("45.00");
    // The technician's notes are not the summary.
    expect(report).not.toContain("Customer asked for a cable cover");
    // The seed's photos have no stored file (no size): a link to the ownership-checked route, no thumbnail.
    expect(report).toContain('<a href="/my/visits/jb_seed_11/photo/1">Open the photo</a>');
    expect(report).toContain('<a href="/my/visits/jb_seed_11/photo/2">Open the photo</a>');
    expect(report).toContain('Signed by Customer · <span dir="ltr">');
    expect(report).toContain('<a href="/my/visits/jb_seed_11/report" class="btn-brand" id="report-pdf">Download report (PDF)</a>');
  });

  test("stored photos: before and after through <x-image>, lazy, each linking to the ownership-checked photo route", async () => {
    const res = await peter.page(`/my/visits/${DONE}?lang=en`);
    expect(res.status).toBe(200);
    const report = section(res.html);
    const before = /<ul class="photos" id="photos-before">[^]*?<\/ul>/u.exec(report)?.[0] ?? "";
    const after = /<ul class="photos" id="photos-after">[^]*?<\/ul>/u.exec(report)?.[0] ?? "";
    expect(before).toMatch(new RegExp(`<a href="/my/visits/${DONE}/photo/1"><img src="/_img/storage/${DONE_VISIT}/[^"]*\\?w=160&amp;exp=\\d+&amp;sig=[0-9a-f]+"[^>]* alt="The before photo"[^>]* loading="lazy"`, "u"));
    expect(after).toContain(`<a href="/my/visits/${DONE}/photo/2"><img`);
    expect(report).toContain('Bait station × <span dir="ltr">3</span>');
    expect(report).not.toContain("12.50");
    expect(report).toContain('Signed by Peter Nowak · <span dir="ltr">');
  });

  test("their own photo: a short signed link of this origin, private; a number past the last is 404", async () => {
    const res = await peter.page(`/my/visits/${DONE}/photo/1`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(new RegExp(`^/_files/storage/${DONE_VISIT}/[^?]+-dirty\\.png\\?`, "u"));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    for (const n of ["3", "0", "x"]) expect([n, (await peter.page(`/my/visits/${DONE}/photo/${n}`)).status]).toEqual([n, 404]);
    // A seed photo with no stored file is 404 too, not an error.
    expect((await peter.page("/my/visits/jb_seed_11/photo/1")).status).toBe(404);
  });

  test("a visit not done shows no report and has no PDF", async () => {
    const res = await peter.page("/my/visits/jb_seed_02?lang=en");
    expect(res.status).toBe(200);
    expect(res.html).not.toContain('id="visit-report"');
    expect((await peter.page("/my/visits/jb_seed_02/report")).status).toBe(404);
  });

  test("the report PDF: application/pdf, private, no-store, named after the job, starting with %PDF", async () => {
    const res = await peter.page("/my/visits/jb_seed_11/report");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="visit-report-J-000011.pdf"');
    expect(res.html.length).toBeGreaterThan(1000);
    expect(res.html.startsWith("%PDF")).toBe(true);
  });

  test("the Arabic customer's report is the Arabic template, as the link renders it", async () => {
    await layla.page("/my?lang=en");
    const mine = await layla.page("/my/visits/jb_seed_13/report");
    expect(mine.status).toBe(200);
    expect(mine.headers.get("content-disposition")).toBe('attachment; filename="visit-report-J-000013.pdf"');
    // The renderer stores the customer's own language as the visit's report.
    expect(rows("select report_key from app__visits where id = 'vs_seed_13'")[0]?.report_key).toBe("app/visits/vs_seed_13/report-ar.pdf");
    const link = await nobody.page(`/l/report/${REPORT_TOKEN}/pdf`);
    expect(link.status).toBe(200);
    expect(mine.html).toBe(link.html);
    expect(mine.html).not.toBe((await nobody.page(`/l/report/${REPORT_TOKEN}/pdf?lang=en`)).html);
  });

  test("another customer's visit: its report and its photos are 404", async () => {
    for (const path of ["/my/visits/jb_seed_13/report", "/my/visits/jb_seed_13/photo/1", "/my/visits/jb_seed_13/photo/2", "/my/visits/jb_seed_19/photo/1", "/my/visits/jb_nope/photo/1"]) {
      const res = await peter.page(path);
      expect([path, res.status]).toEqual([path, 404]);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
    for (const path of [`/my/visits/${DONE}/photo/1`, `/my/visits/${DONE}/photo/2`, `/my/visits/${DONE}/report`, "/my/visits/jb_seed_11/report"]) {
      expect([path, (await layla.page(path)).status]).toEqual([path, 404]);
    }
  });
});

describe("signed out", () => {
  test("every route is a redirect to the phone sign-in, and back", async () => {
    for (const path of ["/my/invoices", "/my/invoices/INV-000901", "/my/invoices/INV-000901/pdf", "/my/visits/jb_seed_11/report", "/my/visits/jb_seed_11/photo/1"]) {
      const res = await nobody.page(path);
      expect([path, res.status]).toEqual([path, 303]);
      expect([path, res.headers.get("location")]).toEqual([path, `/auth/phone?next=${encodeURIComponent(path)}`]);
    }
  });

  test("the customer's links keep working without a session, and point to the account", async () => {
    const invoice = await nobody.page(`/l/invoice/${INVOICE_TOKEN}?lang=en`);
    expect(invoice.status).toBe(200);
    expect(invoice.html).toContain('<p id="see-all-invoices"><a href="/my/invoices">See all your invoices in your account</a></p>');
    const report = await nobody.page(`/l/report/${REPORT_TOKEN}?lang=ar`);
    expect(report.status).toBe(200);
    expect(report.html).toContain(`<a href="/my/invoices">${ar.my.invoices.see_all}</a>`);
  });
});

describe("Arabic", () => {
  test("the list: right to left, numbers and amounts left to right", async () => {
    const res = await layla.page("/my/invoices?lang=ar");
    expect(res.html).toMatch(/<html lang="ar" dir="rtl"/u);
    expect(res.html).toContain(ar.my.invoices.title);
    expect(res.html).toContain('<td dir="ltr"><a href="/my/invoices/INV-000001" dir="auto">INV-000001</a></td>');
    snapshot(steady(res.html), { role: "my invoices, portal customer, ar" });
  });

  test("one invoice", async () => {
    const res = await layla.page("/my/invoices/INV-000001?lang=ar");
    expect(res.status).toBe(200);
    expect(res.html).toContain('<span dir="ltr">INV-000001</span>');
    expect(res.html).toContain(ar.my.invoice.pdf);
    snapshot(steady(res.html), { role: "my invoice, portal customer, ar" });
  });

  test("the visit report", async () => {
    const res = await layla.page("/my/visits/jb_seed_13?lang=ar");
    expect(res.status).toBe(200);
    expect(res.html).toContain("تم استبدال صنبور المطبخ بخلاط جديد.");
    expect(res.html).toContain(ar.my.report.pdf);
    snapshot(steady(res.html), { role: "my visit report, portal customer, ar" });
  });

  test("English snapshots of the list and the report", async () => {
    snapshot(steady((await peter.page("/my/invoices?lang=en")).html), { role: "my invoices, portal customer, en" });
    snapshot(steady((await peter.page("/my/visits/jb_seed_11?lang=en")).html), { role: "my visit report, portal customer, en" });
  });
});

describe("the payment instructions (/admin/settings)", () => {
  async function ownerWithSecondFactor() {
    const email = "owner@fixit.example";
    const enrolling = t.as("owner-enrol");
    expect((await enrolling.action("/auth/login", "default", { email, password: PASSWORD, next: "/admin" })).status).toBe(303);
    const enrol = await enrolling.page("/2fa/enroll/totp");
    const secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(enrol.html)?.[1] ?? "").replace(/ /gu, "");
    expect((await enrolling.action("/2fa/enroll/totp", "confirm", { code: await totp(secret) })).status).toBe(200);
    await t.as("owner").action("/auth/login", "default", { email, password: PASSWORD, next: "/admin" });
    expect((await t.as("owner").action("/2fa/verify", "totp", { code: await totp(secret, Date.now() / 1000 + 30), next: "/admin" })).status).toBe(303);
    return t.as("owner");
  }
  const form = (extra: Record<string, string>) => ({
    brand_name: "FixIt Services",
    brand_name_ar: "",
    brand_color: "#1f6f5c",
    brand_footer_en: "FixIt Services LLC, Dubai",
    brand_footer_ar: "فيكس إت للخدمات ذ.م.م، دبي",
    sender_name: "",
    accounts_email: "accounts@fixit.example",
    ...extra,
  });
  const EN = "Pay by bank transfer to FixIt Services LLC.\nIBAN AE07 0331 2345 6789 0123 456\nPlease quote the invoice number.";
  const AR = "ادفع بالتحويل البنكي إلى فيكس إت للخدمات.\nيرجى ذكر رقم الفاتورة.";

  test("over 500 characters is a 422 naming the field, with the text kept; nothing is saved", async () => {
    const owner = await ownerWithSecondFactor();
    const page = await owner.page("/admin/settings?lang=en");
    expect(page.status).toBe(200);
    expect(page.html).toContain('<textarea name="payment_instructions_en" maxlength="500"');
    const res = await owner.action("/admin/settings", "save", form({ payment_instructions_en: "x".repeat(501), payment_instructions_ar: AR }));
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-payment_instructions_en"');
    expect(res.html).toContain('aria-invalid="true" aria-describedby="err-payment_instructions_en"');
    expect(res.html).toContain(AR.split("\n")[0] as string);
    expect(rows("select value from app__settings where key like 'payment_instructions_%'")).toEqual([]);
  });

  test("saved with an audit row, shown on the form, and on an open invoice only, in the page's language", async () => {
    const owner = t.as("owner");
    const before = Number(rows("select count(*) as n from audit__events where action = 'settings.update'")[0]?.n);
    const res = await owner.action("/admin/settings", "save", form({ payment_instructions_en: EN, payment_instructions_ar: AR }));
    expect(res.status).toBe(303);
    expect(rows("select key, value from app__settings where key like 'payment_instructions_%' order by key")).toEqual([
      { key: "payment_instructions_ar", value: AR },
      { key: "payment_instructions_en", value: EN },
    ]);
    const audit = rows("select details from audit__events where action = 'settings.update' order by at");
    expect(audit.length).toBe(before + 1);
    expect(JSON.parse(String(audit.at(-1)?.details)).keys).toEqual(expect.arrayContaining(["payment_instructions_en", "payment_instructions_ar"]));
    expect((await owner.page("/admin/settings?lang=en")).html).toContain(`>${EN}</textarea>`);

    const open = await peter.page("/my/invoices/INV-000902?lang=en");
    const block = /<section[^>]*id="payment-instructions"[^]*?<\/section>/u.exec(open.html)?.[0] ?? "";
    expect(block).toContain("How to pay");
    expect(block).toContain('<p dir="auto">IBAN AE07 0331 2345 6789 0123 456</p>');
    expect((await peter.page("/my/invoices/INV-000902?lang=ar")).html).toContain('<p dir="auto">يرجى ذكر رقم الفاتورة.</p>');
    // A paid invoice asks for nothing.
    expect((await peter.page("/my/invoices/INV-000901?lang=en")).html).not.toContain('id="payment-instructions"');
    await peter.page("/my?lang=en");
  });

  test("emptied, the block is hidden again", async () => {
    expect((await t.as("owner").action("/admin/settings", "save", form({ payment_instructions_en: "", payment_instructions_ar: "" }))).status).toBe(303);
    expect((await peter.page("/my/invoices/INV-000902?lang=en")).html).not.toContain('id="payment-instructions"');
  });
});
