// Spreadsheet imports (F7-200): /admin/import. The owner uploads one .xlsx per
// kind (customers, sites, services, contracts) as the page's script does: the
// action signs, the browser PUTs, the form posts the stored key. The check
// writes nothing but its report; the commit (second factor) writes the whole
// file in one transaction, and only a file with no errors. Runs on the local
// worker with the seed's users (password below); the files are made with the
// `reports` module's `xlsx` service. The check and the commit are background
// jobs (#733): a test waits for the import to leave `checking` / `committing`.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { totp } from "@renoxium/sdk";
import { Database } from "bun:sqlite";
import { app, snapshot, type TestApp } from "@renoxium/sdk/test";

setDefaultTimeout(120_000);
const t = await app();
const PASSWORD = "correct horse battery";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function signIn(jar: string, email: string, next = "/admin") {
  const u = t.as(jar);
  const res = await u.action("/auth/login", "default", { email, password: PASSWORD, next });
  expect(res.status).toBe(303);
  return u;
}

const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);
const count = (table: string): number => Number(rows(`select count(*) as n from ${table}`)[0]?.n);

/** Enrols a TOTP factor for `email` on one session, then signs in on another that passed it (as admin.test.ts does). */
async function withSecondFactor(jar: string, email: string, next: string) {
  const plain = await signIn(`${jar}-plain`, email, next);
  const enrolling = await signIn(`${jar}-enrol`, email, next);
  const enrol = await enrolling.page("/2fa/enroll/totp");
  const secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(enrol.html)?.[1] ?? "").replace(/ /gu, "");
  expect((await enrolling.action("/2fa/enroll/totp", "confirm", { code: await totp(secret) })).status).toBe(200);
  const halted = await t.as(jar).action("/auth/login", "default", { email, password: PASSWORD, next });
  expect(halted.headers.get("location")).toBe(`/2fa/verify?next=${encodeURIComponent(next)}`);
  expect((await t.as(jar).action("/2fa/verify", "totp", { code: await totp(secret, Date.now() / 1000 + 30), next })).status).toBe(303);
  return { plain, verified: t.as(jar) };
}

const dispatcher = await signIn("dispatcher", "dispatcher.dubai@fixit.example");
const { plain: ownerNoFactor, verified: owner } = await withSecondFactor("owner", "owner@fixit.example", "/admin");

// The browser's PUT sends bytes; the test client sends a string, which this header turns back into bytes.
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

type Cells = (string | number | null)[][];

/** An .xlsx made by the `reports` module (the service answers the bytes as an object of numbers). */
async function workbook(sheet: string, cells: Cells): Promise<Uint8Array> {
  const out = (await t.service("reports").xlsx?.(sheet, cells)) as Record<string, number>;
  return Uint8Array.from(Object.values(out));
}

/**
 * An .xlsx of text cells written directly (a deflated zip with inline strings): the module's writer
 * runs out of CPU time on a file of 10,000 rows, and the check has to be tried on one. A real file is
 * deflated too, so its bytes (which cross to the module as numbers) stay few.
 */
function plainWorkbook(cells: string[][], lastRow?: number): Uint8Array {
  const esc = (v: string) => v.replace(/&/gu, "&amp;").replace(/</gu, "&lt;");
  const col = (i: number) => String.fromCharCode(65 + i);
  const head = '<?xml version="1.0" encoding="UTF-8"?>';
  const sheet = `${head}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells
    .map((r, y) => `<row r="${lastRow !== undefined && y === cells.length - 1 ? lastRow : y + 1}">${r.map((v, x) => `<c r="${col(x)}${lastRow !== undefined && y === cells.length - 1 ? lastRow : y + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join("")}</row>`)
    .join("")}</sheetData></worksheet>`;
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const files: [string, string][] = [
    ["[Content_Types].xml", `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`],
    ["_rels/.rels", `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${rel}"><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", sheet],
  ];
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 255, (n >> 8) & 255];
  const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  for (const [name, text] of files) {
    const n = enc.encode(name);
    const raw = enc.encode(text);
    const d = Bun.deflateSync(raw);
    // version needed, flags, method (deflate), time, date, crc32, sizes, name length, extra length.
    const shared = [...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0x21), ...u32(Bun.hash.crc32(raw)), ...u32(d.length), ...u32(raw.length), ...u16(n.length), ...u16(0)];
    parts.push(Uint8Array.from([0x50, 0x4b, 3, 4, ...shared]), n, d);
    central.push(Uint8Array.from([0x50, 0x4b, 1, 2, ...u16(20), ...shared, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), n);
    offset += 30 + n.length + d.length;
  }
  const size = central.reduce((a, c) => a + c.length, 0);
  const end = Uint8Array.from([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(size), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Step one and the PUT, as `public/upload.js` does them; answers the stored key. */
async function upload(u: TestApp, name: string, bytes: Uint8Array): Promise<string> {
  const signed = await u.action("/admin/import", "upload_url", { name, type: XLSX, size: String(bytes.length) });
  if (signed.status !== 200) console.log("UPLOAD_URL", signed.status, signed.html.slice(0, 600), JSON.stringify(t.logs().slice(-3)).slice(0, 1500));
  expect(signed.status).toBe(200);
  const target = signed.json<{ url: string; max_bytes: number }>();
  expect(target.max_bytes).toBe(10 * 1024 * 1024);
  expect(target.url).toStartWith("/_files/app/imports/");
  const put = await u.request("PUT", target.url, { body: latin1(bytes), headers: { "content-type": XLSX, "x-test-binary": "1" } });
  expect(put.status).toBe(201);
  return put.json<{ key: string }>().key;
}

/**
 * Waits for the background job of an import: until its row is no longer `checking` or `committing`
 * (a job that fails once is retried 10 s later, so the wait is long), then answers the status.
 */
async function settled(id: string, timeoutMs = 60_000): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const status = String(rows("select status from app__imports where id = ?", [id])[0]?.status);
    if (status !== "checking" && status !== "committing") return status;
    if (Date.now() > until) throw new Error(`import ${id} is still ${status} after ${timeoutMs} ms`);
    await Bun.sleep(100);
  }
}

/** Posts the check of a stored file; answers the response and the import's id (the job has not run yet). */
async function startCheck(kind: string, key: string, u: TestApp = owner): Promise<{ res: Awaited<ReturnType<TestApp["action"]>>; id: string }> {
  const res = await u.action("/admin/import", "check", { kind, file_key: key });
  expect(res.status).toBe(303);
  const id = /^\/admin\/import\/(im_[a-f0-9]{16})$/u.exec(res.headers.get("location") ?? "")?.[1];
  expect(id).toBeDefined();
  return { res, id: id as string };
}

/** Uploads `cells` as one file of `kind` and checks it (the job has run when this answers); answers the import's id. */
async function checked(kind: string, cells: Cells, u: TestApp = owner): Promise<string> {
  const key = await upload(u, `${kind}.xlsx`, await workbook(kind, cells));
  const { id } = await startCheck(kind, key, u);
  await settled(id);
  return id;
}

/** Posts the commit and, when it was accepted, waits for its job. */
async function commit(id: string, u: TestApp = owner) {
  const res = await u.action(`/admin/import/${id}`, "commit", {});
  if (res.status === 303) await settled(id);
  return res;
}
const strip = (s: string | undefined): string => (s ?? "").replace(/<[^>]*>/gu, "").replace(/\s+/gu, " ").trim();
/** The report's error table as [row, column, message]. */
const errorRows = (html: string): string[][] =>
  [...(/<table id="import-errors"[\s\S]*?<\/table>/u.exec(html)?.[0] ?? "").matchAll(/<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gu)].map((m) => [strip(m[1]), strip(m[2]), strip(m[3])]);
const total = (html: string, name: string): number => Number(strip(new RegExp(`id="total-${name}"[^>]*>([\\s\\S]*?)</dd>`, "u").exec(html)?.[1]));
const importRow = (id: string) => rows("select status, rows, ok, skipped, errors, kind from app__imports where id = ?", [id])[0] as { status: string; rows: number; ok: number; skipped: number; errors: number; kind: string };

const HEADER = ["branch", "kind", "name", "phone", "email", "trn", "language"];
const THREE: Cells = [
  HEADER,
  ["Dubai", "company", "Import Co One", "050 111 2233", "one@import.example", null, "en"],
  ["sharjah", "household", "Import Household Two", "+971 55 222 3344", null, null, "ar"],
  // A phone typed as a number (Excel drops the leading zero) and a branch named in Arabic.
  ["دبي", "household", "Import Household Three", 521112299, null, null, null],
];

describe("/admin/import", () => {
  test("normal case: a valid customers file of 3 rows is checked, writes nothing, and the commit adds 3 with normalised phones", async () => {
    const before = count("app__customers");
    const id = await checked("customers", THREE);
    expect(importRow(id)).toMatchObject({ status: "checked", rows: 3, ok: 3, skipped: 0, errors: 0, kind: "customers" });
    const report = await owner.page(`/admin/import/${id}`);
    expect(report.status).toBe(200);
    expect([total(report.html, "rows"), total(report.html, "insert"), total(report.html, "exists"), total(report.html, "errors")]).toEqual([3, 3, 0, 0]);
    expect(report.html).toContain('id="commit-form"');
    expect(count("app__customers")).toBe(before);
    expect(rows("select count(*) as n from app__imports")[0]?.n).toBe(1);

    expect((await commit(id)).status).toBe(303);
    expect(count("app__customers")).toBe(before + 3);
    expect(rows("select phone, branch_id, language from app__customers where name like 'Import %' order by name").map((r) => [r.phone, r.branch_id, r.language])).toEqual([
      ["+971501112233", "br_dubai", "en"],
      ["+971521112299", "br_dubai", "en"],
      ["+971552223344", "br_sharjah", "ar"],
    ]);
    expect(importRow(id)).toMatchObject({ status: "committed", ok: 3 });
    const done = await owner.page(`/admin/import/${id}`);
    expect(done.html).toContain('id="committed"');
    expect(done.html).toContain('href="/customers"');
    expect(done.html).not.toContain('id="commit-form"');
    const audit = rows("select count(*) as n from audit__events where action = 'import.committed'")[0];
    expect(audit?.n).toBe(1);
    // The new customer is on /customers (the owner works in Dubai).
    expect((await owner.page("/customers?q=Import")).html).toContain("Import Co One");
  });

  test("normal case: checking and committing the same valid file again inserts nothing (3 exists)", async () => {
    const before = count("app__customers");
    const id = await checked("customers", THREE);
    expect(importRow(id)).toMatchObject({ status: "checked", rows: 3, ok: 0, skipped: 3, errors: 0 });
    const report = await owner.page(`/admin/import/${id}`);
    expect([total(report.html, "insert"), total(report.html, "exists")]).toEqual([0, 3]);
    expect((await commit(id)).status).toBe(303);
    expect(count("app__customers")).toBe(before);
  });

  test("error case: a bad phone on row 3 and an unknown branch on row 5 are the two errors; no commit button; a posted commit is a 409", async () => {
    const before = count("app__customers");
    const id = await checked("customers", [
      HEADER,
      ["Dubai", "household", "Fine One", "050 999 0001", null, null, "en"],
      ["Dubai", "household", "Bad Phone", "12345", null, null, "en"],
      ["Dubai", "household", "Fine Two", "050 999 0002", null, null, "en"],
      ["Atlantis", "household", "No Branch", "050 999 0003", null, null, "en"],
    ]);
    expect(importRow(id)).toMatchObject({ status: "checked", errors: 2 });
    const report = await owner.page(`/admin/import/${id}`);
    expect(errorRows(report.html)).toEqual([
      ["3", "phone", "Not a UAE phone number, for example +971 50 123 4567."],
      ["5", "branch", "No branch has this name (see Branches)."],
    ]);
    expect(report.html).not.toContain('id="commit-form"');
    expect(report.html).toContain('id="fix-file"');
    expect((await commit(id)).status).toBe(409);
    expect(count("app__customers")).toBe(before);
    expect(importRow(id).status).toBe("checked");
    // Discarding is allowed and writes nothing.
    expect((await owner.action(`/admin/import/${id}`, "discard", {})).status).toBe(303);
    expect(importRow(id).status).toBe("discarded");
    expect((await commit(id)).status).toBe(409);
  });

  test("normal case: sites find their customer by phone; an unknown phone is unknown_customer; a repeat is exists", async () => {
    const header = ["customer_phone", "label", "emirate", "area", "address", "makani", "access_notes"];
    const id = await checked("sites", [
      header,
      ["050 111 2233", "Head office", "AE-DU", "Business Bay", "Tower 2, floor 14", null, "Ask at reception"],
      ["+971 55 222 3344", "Villa", "Sharjah", "Al Nahda", "Villa 12", null, null],
      ["050 111 2233", "Head office", "AE-DU", "Business Bay", "Same label again", null, null],
      ["050 777 0000", "Nowhere", "AE-DU", "Business Bay", "No such customer", null, null],
      ["050 111 2233", "Bad emirate", "AE-XX", "Business Bay", "Tower 2", null, null],
    ]);
    const report = await owner.page(`/admin/import/${id}`);
    expect(errorRows(report.html).map((r) => r.slice(0, 2))).toEqual([
      ["5", "customer_phone"],
      ["6", "emirate"],
    ]);
    expect(importRow(id).errors).toBe(2);
    // Without the two bad rows the file is good: 2 to add, 1 already there.
    const good = await checked("sites", [
      header,
      ["050 111 2233", "Head office", "AE-DU", "Business Bay", "Tower 2, floor 14", null, "Ask at reception"],
      ["+971 55 222 3344", "Villa", "Sharjah", "Al Nahda", "Villa 12", null, null],
      ["050 111 2233", "Head office", "AE-DU", "Business Bay", "Same label again", null, null],
    ]);
    expect(importRow(good)).toMatchObject({ ok: 2, skipped: 1, errors: 0 });
    const before = count("app__sites");
    expect((await commit(good)).status).toBe(303);
    expect(count("app__sites")).toBe(before + 2);
    expect(rows("select s.label, s.emirate, s.branch_id from app__sites s join app__customers c on c.id = s.customer_id where c.phone = '+971552223344'").map((r) => [r.label, r.emirate, r.branch_id])).toEqual([["Villa", "AE-SH", "br_sharjah"]]);
  });

  test("normal case: services: an existing code is updated, a new one inserted, 12.5 is stored as 1250", async () => {
    const header = ["code", "name_en", "name_ar", "unit", "price_aed", "vat_rate", "branch"];
    const before = count("app__services");
    const id = await checked("services", [
      header,
      ["ac-service", "AC service (new price)", "صيانة المكيف", "unit", 160, null, null],
      ["wash-12", "Car wash", "غسيل السيارة", "visit", 12.5, 0, "Sharjah"],
    ]);
    expect(importRow(id)).toMatchObject({ ok: 2, skipped: 0, errors: 0 });
    const report = await owner.page(`/admin/import/${id}`);
    expect([total(report.html, "insert"), total(report.html, "update")]).toEqual([1, 1]);
    expect((await commit(id)).status).toBe(303);
    expect(count("app__services")).toBe(before + 1);
    expect(rows("select name_en, price_fils, vat_rate, branch_id, active from app__services where code = 'AC-SERVICE'")[0]).toMatchObject({ name_en: "AC service (new price)", price_fils: 16000, vat_rate: 5, branch_id: null, active: 1 });
    expect(rows("select price_fils, vat_rate, branch_id, unit from app__services where code = 'WASH-12'")[0]).toMatchObject({ price_fils: 1250, vat_rate: 0, branch_id: "br_sharjah", unit: "visit" });
    // The rules of the columns.
    const bad = await checked("services", [
      header,
      ["bad code!", "x", "x", "visit", 10, null, null],
      ["OK-1", "x", "x", "week", 10, null, null],
      ["OK-2", "x", "x", "visit", 10.123, null, null],
      ["OK-3", "x", "x", "visit", -1, null, null],
      ["OK-4", "x", "x", "visit", 10, 7, null],
    ]);
    const codes = errorRows((await owner.page(`/admin/import/${bad}`)).html).map((r) => r.slice(0, 2).join(" "));
    expect(codes).toEqual(["2 code", "3 unit", "4 price_aed", "5 price_aed", "6 vat_rate"]);
  });

  test("normal case: contracts: two rows with one number are one draft contract with two items; an unknown site is an error", async () => {
    const header = ["number", "customer_phone", "starts_on", "ends_on", "price_aed", "site_label", "service_code", "visits_per_year", "next_visit_on", "notes"];
    const good: Cells = [
      header,
      ["OLD-2026-001", "+971501110001", "2026-01-01", "2026-12-31", 1800, "Apartment", "AC-SERVICE", 4, null, "Quarterly"],
      // An Excel serial number is a date (46023 is 2026-01-01); the second row repeats the contract's terms.
      ["OLD-2026-001", "050 111 0001", 46023, "2026-12-31", "1800.00", "apartment", "PEST", 2, "2026-03-01", null],
    ];
    const bad = await checked("contracts", [header, good[1] as (string | number | null)[], ["OLD-2026-002", "+971501110001", "2026-01-01", "2026-12-31", 900, "Garage", "PEST", 2, null, null]]);
    const badReport = await owner.page(`/admin/import/${bad}`);
    expect(errorRows(badReport.html).map((r) => r.slice(0, 2))).toEqual([["3", "site_label"]]);
    const before = count("app__contracts");
    expect((await commit(bad)).status).toBe(409);
    expect(count("app__contracts")).toBe(before);
    const beforeItems = count("app__contract_items");
    const id = await checked("contracts", good);
    expect(importRow(id)).toMatchObject({ ok: 2, skipped: 0, errors: 0 });
    expect(count("app__contracts")).toBe(before);
    expect((await commit(id)).status).toBe(303);
    expect(count("app__contracts")).toBe(before + 1);
    expect(count("app__contract_items")).toBe(beforeItems + 2);
    const contract = rows("select id, status, price_fils, starts_on, ends_on, customer_id, branch_id, notes, invoice_id from app__contracts where number = 'OLD-2026-001'")[0];
    expect(contract).toMatchObject({ status: "draft", price_fils: 180000, starts_on: "2026-01-01", ends_on: "2026-12-31", customer_id: "cu_dxb_01", branch_id: "br_dubai", notes: "Quarterly", invoice_id: null });
    expect(rows("select visits_per_year, next_visit_on from app__contract_items where contract_id = ? order by id", [contract?.id as string]).map((r) => [r.visits_per_year, r.next_visit_on])).toEqual([
      [4, "2026-01-01"],
      [2, "2026-03-01"],
    ]);
    // Again: the number is there already.
    const again = await checked("contracts", good);
    expect(importRow(again)).toMatchObject({ ok: 0, skipped: 2, errors: 0 });
    // Rows of one number that disagree.
    const split = await checked("contracts", [header, good[1] as (string | number | null)[], ["OLD-2026-009", "+971501110001", "2026-01-01", "2026-12-31", 100, "Apartment", "PEST", 2, null, null], ["OLD-2026-009", "+971501110001", "2026-01-01", "2026-11-30", 100, "Apartment", "PEST", 2, null, null]]);
    expect(errorRows((await owner.page(`/admin/import/${split}`)).html).map((r) => r.slice(0, 2))).toEqual([["4", "ends_on"]]);
  });

  test("error case: a dispatcher gets 403 on the page, the report and the template; the owner without a second factor cannot commit", async () => {
    expect((await dispatcher.page("/admin/import")).status).toBe(403);
    expect((await dispatcher.request("GET", "/admin/import/template/customers")).status).toBe(403);
    expect((await dispatcher.action("/admin/import", "check", { kind: "customers", file_key: "app/imports/abcdefgh12345678.xlsx" })).status).toBe(403);
    const id = await checked("customers", [HEADER, ["Dubai", "household", "Needs Factor", "050 999 1111", null, null, "en"]]);
    const before = count("app__customers");
    expect((await commit(id, ownerNoFactor)).status).toBe(403);
    expect(count("app__customers")).toBe(before);
    expect(importRow(id).status).toBe("checked");
    expect((await commit(id)).status).toBe(303);
    expect(count("app__customers")).toBe(before + 1);
  });

  test("error case: 10,001 data rows are too_many_rows; a .txt renamed .xlsx is refused by the store and a broken zip is not_xlsx; a missing column is named", async () => {
    // One column: on the free tier a request has 50 ms of CPU, and the cells cross from the module to the app.
    const big: Cells = [["branch"], ["Dubai"]];
    const key10k = await upload(owner, "big.xlsx", plainWorkbook(big as string[][], 10_002));
    const many = (await startCheck("customers", key10k)).id;
    expect(await settled(many)).toBe("checked");
    expect(importRow(many)).toMatchObject({ status: "checked", errors: 1 });
    expect(errorRows((await owner.page(`/admin/import/${many}`)).html)).toEqual([["—", "", "The file has too many rows: 10,000 at most."]]);

    // Plain text under an .xlsx name never reaches the check: the store sniffs the bytes and refuses the PUT.
    const text = await owner.action("/admin/import", "upload_url", { name: "notes.xlsx", type: XLSX, size: "34" });
    const refused = await owner.request("PUT", text.json<{ url: string }>().url, { body: "this is plain text, not a workbook", headers: { "content-type": XLSX, "x-test-binary": "1" } });
    expect(refused.status).toBe(415);
    // A zip that is no workbook (here a cut-off one) is the check's not_xlsx.
    const key = await upload(owner, "notes.xlsx", plainWorkbook([["branch"], ["Dubai"]]).slice(0, 80));
    const broken = (await startCheck("customers", key)).id;
    // The job catches the failed module service and ends the import as failed in the same attempt (#734's savepoints); it stays in the history.
    expect(await settled(broken)).toBe("failed");
    expect(rows("select error from app__imports where id = ?", [broken])[0]?.error).toBe("import.err.not_xlsx");
    expect(strip(/<p class="problem"[^>]*id="import-failed"[^>]*>([\s\S]*?)<\/p>/u.exec((await owner.page(`/admin/import/${broken}`)).html)?.[1])).toContain("This is not an Excel .xlsx file.");

    const missing = await checked("customers", [["branch", "kind", "name"], ["Dubai", "household", "No phone column"]]);
    expect(errorRows((await owner.page(`/admin/import/${missing}`)).html)).toEqual([["1", "phone", "The first row has no column with this name."]]);

    // The upload step refuses what is no .xlsx, and what is too big.
    expect((await owner.action("/admin/import", "upload_url", { name: "a.csv", type: "text/csv", size: "10" })).status).toBe(422);
    expect((await owner.action("/admin/import", "upload_url", { name: "a.xlsx", type: XLSX, size: String(10 * 1024 * 1024 + 1) })).status).toBe(413);
    // A key that this feature did not make is refused.
    expect((await owner.action("/admin/import", "check", { kind: "customers", file_key: "app/brand/logo.png" })).status).toBe(422);
    expect((await owner.action("/admin/import", "check", { kind: "orders", file_key: key })).status).toBe(422);
  });

  test("the template of each kind downloads as an .xlsx; an unknown kind is a 404", async () => {
    for (const kind of ["customers", "sites", "services", "contracts"]) {
      const res = await owner.request("GET", `/admin/import/template/${kind}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(XLSX);
      expect(res.headers.get("content-disposition")).toContain(`import-${kind}-template.xlsx`);
    }
    expect((await owner.request("GET", "/admin/import/template/orders")).status).toBe(404);
    const page = await owner.page("/admin/import");
    expect(page.html).toContain('href="/admin/import/template/customers"');
  });

  test("the page and the report render in Arabic, right to left", async () => {
    const id = await checked("customers", [HEADER, ["Dubai", "household", "Arabic Report", "12345", null, null, "en"]]);
    const steady = (html: string) =>
      /<main\b[^>]*>[\s\S]*<\/main>/u
        .exec(html)?.[0]
        .replace(/<table id="imports">[\s\S]*?<\/table>/u, "<table id=\"imports\">(the latest imports)</table>")
        .replace(/im_[a-f0-9]{16}/gu, "im_ID")
        .replace(/\d{4}-\d{2}-\d{2}/gu, "DATE") ?? "";
    const page = await owner.page("/admin/import?lang=ar");
    expect(page.status).toBe(200);
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain("الاستيراد من إكسل");
    expect(page.html).toContain("افحص الملف");
    snapshot(steady(page.html), { role: "import page, owner, ar" });
    const report = await owner.page(`/admin/import/${id}?lang=ar`);
    expect(report.status).toBe(200);
    expect(report.html).toContain('dir="rtl"');
    expect(report.html).toContain("تقرير الفحص");
    expect(report.html).toContain("ليس رقم هاتف إماراتياً");
    expect(report.html).toContain("أصلح الملف ثم افحصه من جديد.");
    snapshot(steady(report.html), { role: "import report, owner, ar" });
    expect((await owner.page("/admin/import?lang=en")).html).toContain('dir="ltr"');
  });
});

/** A writable connection to the tenant file, for what a test cannot do through the app: put an import row in a given state. */
function writable(): Database {
  const db = new Database(t.dbFile);
  db.run("pragma busy_timeout = 5000");
  return db;
}

const plainRows = (n: number, phoneBase: number): string[][] => [
  HEADER,
  ...Array.from({ length: n }, (_, i) => ["Dubai", "household", `Bulk Customer ${i}`, `+9715${String(phoneBase + i).padStart(8, "0")}`, `bulk${i}@import.example`, "", "en"]),
];

describe("/admin/import in the background (#733)", () => {
  test("normal case: a valid file goes checking, checked, committing, committed; the page says what is going on and refreshes while it waits", async () => {
    const key = await upload(owner, "customers.xlsx", await workbook("customers", [HEADER, ["Dubai", "household", "Background One", "050 333 0001", null, null, "en"], ["Sharjah", "company", "Background Two LLC", "050 333 0002", null, null, "ar"]]));
    const before = count("app__customers");
    const { res, id } = await startCheck("customers", key);
    expect(res.headers.get("location")).toBe(`/admin/import/${id}`);
    // The request wrote the row and nothing else; the job fills it in.
    expect(["checking", "checked"]).toContain(importRow(id).status);
    expect(await settled(id)).toBe("checked");
    expect(importRow(id)).toMatchObject({ status: "checked", rows: 2, ok: 2, skipped: 0, errors: 0 });
    expect(Number(rows("select checked_at from app__imports where id = ?", [id])[0]?.checked_at)).toBeGreaterThan(0);
    expect(count("app__customers")).toBe(before);
    const report = await owner.page(`/admin/import/${id}?lang=en`);
    expect(report.html).not.toContain('http-equiv="refresh"');
    expect(report.html).toContain('id="commit-form"');

    const done = await commit(id);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(`/admin/import/${id}`);
    expect(importRow(id)).toMatchObject({ status: "committed", ok: 2 });
    expect(count("app__customers")).toBe(before + 2);
    expect(rows("select count(*) as n from audit__events where action = 'import.committed' and resource_id = ?", [id])[0]?.n).toBe(1);
    // The history shows the status with its label.
    expect(strip(new RegExp(`<tr id="import-${id}"[\\s\\S]*?</tr>`, "u").exec((await owner.page("/admin/import?lang=en")).html)?.[0])).toContain("Imported");
  });

  test("normal case: a row that is checking shows 'Checking the file…' and refreshes by itself, in both languages; committing shows 'Importing…'", async () => {
    const key = await upload(owner, "customers.xlsx", await workbook("customers", [HEADER, ["Dubai", "household", "Waiting", "050 333 0003", null, null, "en"]]));
    const db = writable();
    const at = Math.floor(Date.now() / 1000);
    db.run(
      "insert into app__imports (id, kind, file_key, file_name, status, report, created_by, created_at) values ('im_aaaaaaaaaaaaaaaa', 'customers', ?, 'customers.xlsx', 'checking', '{\"errors\":[],\"insert\":0,\"update\":0,\"exists\":0}', 'u', ?), ('im_bbbbbbbbbbbbbbbb', 'customers', ?, 'customers.xlsx', 'committing', '{\"errors\":[],\"insert\":1,\"update\":0,\"exists\":0}', 'u', ?)",
      [key, at, key, at],
    );
    db.close();
    const checking = await owner.page("/admin/import/im_aaaaaaaaaaaaaaaa?lang=en");
    expect(checking.status).toBe(200);
    expect(checking.html).toContain('<meta http-equiv="refresh" content="3">');
    expect(strip(/<p[^>]*id="import-working"[^>]*>([\s\S]*?)<\/p>/u.exec(checking.html)?.[1])).toBe("Checking the file…");
    expect(checking.html).not.toContain('id="commit-form"');
    const committing = await owner.page("/admin/import/im_bbbbbbbbbbbbbbbb?lang=en");
    expect(committing.html).toContain('<meta http-equiv="refresh" content="3">');
    expect(strip(/<p[^>]*id="import-working"[^>]*>([\s\S]*?)<\/p>/u.exec(committing.html)?.[1])).toBe("Importing…");
    const ar = await owner.page("/admin/import/im_aaaaaaaaaaaaaaaa?lang=ar");
    expect(ar.html).toContain('dir="rtl"');
    expect(strip(/<p[^>]*id="import-working"[^>]*>([\s\S]*?)<\/p>/u.exec(ar.html)?.[1])).toBe("جارٍ فحص الملف…");
    expect(strip((await owner.page("/admin/import?lang=en")).html)).toContain("Checking");
    // A row that is checked or failed does not refresh.
    const id = await checked("customers", [HEADER, ["Dubai", "household", "Not Waiting", "050 333 0004", null, null, "en"]]);
    expect((await owner.page(`/admin/import/${id}?lang=en`)).html).not.toContain("http-equiv");
  });

  test("error case: a zip that is no workbook ends failed with not_xlsx and stays in the history, with an Upload again link", async () => {
    const garbage = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 200 }, (_, i) => (i * 37 + 11) & 255)]);
    const key = await upload(owner, "corrupt.xlsx", garbage);
    const { id } = await startCheck("customers", key);
    expect(await settled(id)).toBe("failed");
    expect(importRow(id)).toMatchObject({ status: "failed", rows: 0, errors: 0 });
    expect(rows("select error from app__imports where id = ?", [id])[0]?.error).toBe("import.err.not_xlsx");
    const page = await owner.page(`/admin/import/${id}?lang=en`);
    expect(page.status).toBe(200);
    expect(page.html).not.toContain("http-equiv");
    expect(strip(/<p[^>]*id="import-failed"[^>]*>([\s\S]*?)<\/p>/u.exec(page.html)?.[1])).toBe("This is not an Excel .xlsx file. Upload again");
    expect(page.html).toContain('href="/admin/import" id="import-again"');
    expect((await owner.page("/admin/import?lang=en")).html).toContain(`id="import-${id}"`);
    expect(strip(new RegExp(`<tr id="import-${id}"[\\s\\S]*?</tr>`, "u").exec((await owner.page("/admin/import?lang=en")).html)?.[0])).toContain("Failed");
    // The import cannot be committed.
    expect((await commit(id)).status).toBe(409);
    const ar = await owner.page(`/admin/import/${id}?lang=ar`);
    expect(strip(/<p[^>]*id="import-failed"[^>]*>([\s\S]*?)<\/p>/u.exec(ar.html)?.[1])).toContain("هذا ليس ملف إكسل");
  });

  test("error case (#759): a corrupt file is written as failed with not_xlsx by the first attempt of the check, never by a retry, and is in the import history", async () => {
    const garbage = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 300 }, (_, i) => (i * 53 + 7) & 255)]);
    const key = await upload(owner, "broken-again.xlsx", garbage);
    const { id } = await startCheck("customers", key);
    // An attempt that throws leaves its outbox row with attempts > 0 for the retry, 10 s later; polled every 50 ms, that is seen.
    const until = Date.now() + 30_000;
    let retried = 0;
    for (;;) {
      const run = rows("select attempts from renox__outbox where name = 'job:import-check' and payload like ?", [`%${id}%`]);
      for (const r of run) retried = Math.max(retried, Number(r.attempts));
      const status = String(rows("select status from app__imports where id = ?", [id])[0]?.status);
      if (status !== "checking" && run.length === 0) break;
      if (Date.now() > until) throw new Error(`import ${id} is still ${status}`);
      await Bun.sleep(50);
    }
    expect(retried).toBe(0);
    expect(importRow(id)).toMatchObject({ status: "failed", rows: 0, errors: 0 });
    expect(rows("select error from app__imports where id = ?", [id])[0]?.error).toBe("import.err.not_xlsx");
    const history = (await owner.page("/admin/import?lang=en")).html;
    expect(strip(new RegExp(`<tr id="import-${id}"[\\s\\S]*?</tr>`, "u").exec(history)?.[0])).toContain("Failed");
  });

  test("normal case: running the check job again for an import that is no longer checking changes nothing", async () => {
    const id = await checked("customers", THREE);
    const state = () => JSON.stringify(rows("select status, rows, ok, skipped, errors, report, checked_at from app__imports where id = ?", [id]));
    const before = state();
    expect(JSON.parse(before)[0]).toMatchObject({ status: "checked", rows: 3 });
    await t.job("import-check", { payload: { import_id: id } });
    await t.job("import-check", { payload: { import_id: id } });
    expect(state()).toBe(before);
    // A tick of the schedule has no payload and does nothing.
    await t.job("import-check");
    await t.job("import-commit");
    expect(state()).toBe(before);
    // The same for a commit that already happened.
    expect((await commit(id)).status).toBe(303);
    const committed = state();
    const customers = count("app__customers");
    await t.job("import-commit", { payload: { import_id: id, by: "someone" } });
    expect(state()).toBe(committed);
    expect(count("app__customers")).toBe(customers);
  });

  // #768: a job attempt has a CPU budget of its own (free 2,000 ms, paid 10,000 ms), so the check of the largest file
  // the import takes, 10,000 rows, fits one attempt on the free tier (it used to end failed with too_large). The
  // commit of all 10,000 rows fits it on the released renox-worker 0.10.0 but not on the debug build CI tests the
  // examples with, so here the commit is covered by the 2,000-row case below (#821).
  test("normal case (#768): a 10,000-row customers file is checked on the free tier in one job attempt and writes nothing", async () => {
    const key = await upload(owner, "bulk.xlsx", plainWorkbook(plainRows(10_000, 1_000_000)));
    const before = count("app__customers");
    const { id } = await startCheck("customers", key);
    expect(await settled(id, 90_000)).toBe("checked");
    expect(importRow(id)).toMatchObject({ status: "checked", rows: 10_000, ok: 10_000, errors: 0 });
    expect(count("app__customers")).toBe(before);
    const page = await owner.page(`/admin/import/${id}?lang=en`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('id="commit-form"');
    expect(page.html).not.toContain('id="import-failed"');
    expect((await owner.page("/admin/import?lang=en")).html).toContain(`id="import-${id}"`);
  });

  // The commit of a file the check passed, the row made `checked` directly: with the job budget (#768) the 2,000 rows
  // go in in one attempt and one transaction, with one audit row; the page no longer offers the commit.
  test("normal case (#768): the commit of a checked file of 2,000 rows writes them in one job attempt, with one audit row", async () => {
    const key = await upload(owner, "two-thousand.xlsx", plainWorkbook(plainRows(2_000, 2_000_000)));
    const before = count("app__customers");
    const id = "im_cccccccccccccccc";
    const db = writable();
    db.run(
      "insert into app__imports (id, kind, file_key, file_name, status, rows, ok, skipped, errors, report, created_by, created_at, checked_at) values (?, 'customers', ?, 'two-thousand.xlsx', 'checked', 2000, 2000, 0, 0, '{\"errors\":[],\"insert\":2000,\"update\":0,\"exists\":0}', 'u_owner', ?, ?)",
      [id, key, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)],
    );
    db.close();
    const done = await commit(id);
    expect(done.status).toBe(303);
    expect(importRow(id)).toMatchObject({ status: "committed", rows: 2000, ok: 2000, errors: 0 });
    expect(count("app__customers")).toBe(before + 2000);
    expect(rows("select count(*) as n from audit__events where action = 'import.committed' and resource_id = ?", [id])[0]?.n).toBe(1);
    const page = await owner.page(`/admin/import/${id}?lang=en`);
    expect(page.status).toBe(200);
    expect(page.html).not.toContain('id="commit-form"');
  });

});

// Parts and opening stock (#816): two more kinds, after `services`. `parts` updates an existing SKU and inserts a new
// one (through lib/parts.ts); `stock` writes one `in` move per row, reference `manual`, through lib/stock.ts, and is
// refused for a branch and part that already have any move, so an opening balance is imported once.
describe("/admin/import: parts and opening stock (#816)", () => {
  const PARTS_HEADER = ["sku", "name_en", "name_ar", "unit", "cost_aed", "sell_aed", "vat_rate", "min_stock"];
  const STOCK_HEADER = ["branch", "sku", "qty", "unit_cost_aed", "reason"];
  const part = (sku: string) => rows("select id, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active from app__parts where sku = ?", [sku])[0];
  const movesOf = (sku: string, branch: string) => rows("select kind, qty, unit_cost_fils, reason, ref_kind, ref_id, balance_after, created_by from app__stock_moves where branch_id = ? and part_id = (select id from app__parts where sku = ?) order by rowid", [branch, sku]);
  const found = async (id: string) => errorRows((await owner.page(`/admin/import/${id}`)).html);
  const where = (list: string[][]) => list.map((r) => r.slice(0, 2).join(" "));

  test("normal case: parts: an existing SKU is updated (id and active flag stay), a new one is inserted; money is stored in fils", async () => {
    const before = count("app__parts");
    const existing = part("FIL-AC-S");
    const id = await checked("parts", [
      PARTS_HEADER,
      ["fil-ac-s", "AC filter, split (renamed)", "فلتر مكيف سبليت جديد", "Piece", 13.5, 26, 5, 12],
      ["imp-hose", "Drain hose", "خرطوم تصريف", "metre", 2.25, 4, 0, "7.5"],
      // The optional columns may be empty: a part with a name and a unit only.
      ["IMP-BARE", "Bare part", "قطعة", "box", null, null, null, null],
    ]);
    expect(importRow(id)).toMatchObject({ status: "checked", rows: 3, ok: 3, skipped: 0, errors: 0, kind: "parts" });
    const report = await owner.page(`/admin/import/${id}`);
    expect([total(report.html, "insert"), total(report.html, "update")]).toEqual([2, 1]);
    expect(count("app__parts")).toBe(before);
    expect((await commit(id)).status).toBe(303);
    expect(count("app__parts")).toBe(before + 2);
    expect(part("FIL-AC-S")).toEqual({ ...existing, name_en: "AC filter, split (renamed)", name_ar: "فلتر مكيف سبليت جديد", cost_fils: 1350, sell_fils: 2600, vat_rate: 5, min_stock: 12 });
    expect(part("IMP-HOSE")).toMatchObject({ unit: "metre", cost_fils: 225, sell_fils: 400, vat_rate: 0, min_stock: 7.5, active: 1 });
    expect(part("IMP-BARE")).toMatchObject({ unit: "box", cost_fils: 0, sell_fils: 0, vat_rate: 5, min_stock: 0, active: 1 });
    expect((await commit(id)).status).not.toBe(303);
    // The result's link goes to the parts page.
    expect((await owner.page(`/admin/import/${id}`)).html).toContain('href="/admin/parts"');
    // A new part has no stock row: the import wrote none.
    expect(rows("select count(*) as n from app__stock where part_id = ?", [part("IMP-HOSE")?.id as string])[0]?.n).toBe(0);
  });

  test("error case: parts: the rules of the columns name the row and column with the code", async () => {
    const bad = await checked("parts", [
      PARTS_HEADER,
      ["bad sku!", "x", "x", "piece", 1, 1, 5, 0],
      ["OK-1", "x", "x", "yard", 1, 1, 5, 0],
      ["OK-2", "x", "x", "piece", 1.234, 1, 5, 0],
      ["OK-3", "x", "x", "piece", 1, -1, 5, 0],
      ["OK-4", "x", "x", "piece", 1, 1, 7, 0],
      ["OK-5", "x", "x", "piece", 1, 1, 5, 1.2345],
      ["", "x", "x", "piece", 1, 1, 5, 0],
    ]);
    expect(where(await found(bad))).toEqual(["2 sku", "3 unit", "4 cost_aed", "5 sell_aed", "6 vat_rate", "7 min_stock", "8 sku"]);
    expect(importRow(bad)).toMatchObject({ status: "checked", errors: 7 });
    expect((await owner.page(`/admin/import/${bad}`)).html).not.toContain('id="commit-form"');
    // A header without a required column is named.
    const missing = await checked("parts", [["sku", "name_en", "unit"], ["X-1", "x", "piece"]]);
    expect(where(await found(missing))).toEqual(["1 name_ar"]);
  });

  test("normal case: stock: opening balances are written once, as `in` moves with reference manual and the reason 'opening balance'", async () => {
    const file: Cells = [
      STOCK_HEADER,
      ["Dubai", "imp-hose", 40, 2.5, null],
      // No cost: the part's catalogue cost (2.25) is the cost; the branch may be named in Arabic; a given reason is kept.
      ["الشارقة", "IMP-HOSE", 10, null, "counted on 1 January"],
    ];
    const id = await checked("stock", file);
    expect(importRow(id)).toMatchObject({ status: "checked", rows: 2, ok: 2, skipped: 0, errors: 0, kind: "stock" });
    const movesBefore = count("app__stock_moves");
    expect((await commit(id)).status).toBe(303);
    expect(importRow(id)).toMatchObject({ status: "committed", ok: 2 });
    expect(count("app__stock_moves")).toBe(movesBefore + 2);
    expect(movesOf("IMP-HOSE", "br_dubai")).toEqual([{ kind: "in", qty: 40, unit_cost_fils: 250, reason: "opening balance", ref_kind: "manual", ref_id: null, balance_after: 40, created_by: "u_owner" }]);
    expect(movesOf("IMP-HOSE", "br_sharjah")).toEqual([{ kind: "in", qty: 10, unit_cost_fils: 225, reason: "counted on 1 January", ref_kind: "manual", ref_id: null, balance_after: 10, created_by: "u_owner" }]);
    expect(rows("select branch_id, qty, avg_cost_fils from app__stock where part_id = ? order by branch_id", [part("IMP-HOSE")?.id as string])).toEqual([
      { branch_id: "br_dubai", qty: 40, avg_cost_fils: 250 },
      { branch_id: "br_sharjah", qty: 10, avg_cost_fils: 225 },
    ]);
    expect((await owner.page(`/admin/import/${id}`)).html).toContain('href="/admin/stock"');
    expect((await owner.page("/admin/stock")).html).toContain("IMP-HOSE");

    // The same file again is refused, row by row: the branch and part already have moves. Nothing is written.
    const again = await checked("stock", file);
    expect(importRow(again)).toMatchObject({ status: "checked", errors: 2 });
    const refused = await found(again);
    expect(where(refused)).toEqual(["2 sku", "3 sku"]);
    expect(refused[0]?.[2]).toStartWith("This branch already has stock moves for this part");
    expect((await owner.page(`/admin/import/${again}`)).html).not.toContain('id="commit-form"');
    expect((await commit(again)).status).not.toBe(303);
    expect(count("app__stock_moves")).toBe(movesBefore + 2);
    // A part that has moves from anywhere (the demo's opening stock) is refused too; a branch that has none of the part is not.
    const other = await checked("stock", [STOCK_HEADER, ["Dubai", "FIL-AC-S", 5, null, null], ["Sharjah", "IMP-BARE", 3, null, null]]);
    expect(where(await found(other))).toEqual(["2 sku"]);
  });

  test("error case: stock: an unknown branch, an unknown SKU, a bad SKU, a bad quantity, a bad cost; a SKU twice in one file is refused the second time", async () => {
    const before = count("app__stock_moves");
    const bad = await checked("stock", [
      STOCK_HEADER,
      ["Nowhere", "IMP-BARE", 1, null, null],
      ["Dubai", "NO-SUCH-PART", 1, null, null],
      ["Dubai", "bad sku!", 1, null, null],
      ["Dubai", "IMP-BARE", 0, null, null],
      ["Dubai", "IMP-BARE", 1.2345, null, null],
      ["Dubai", "IMP-BARE", 1, 1.234, null],
      ["Dubai", "IMP-BARE", 2, null, null],
      ["Dubai", "IMP-BARE", 3, null, null],
    ]);
    expect(where(await found(bad))).toEqual(["2 branch", "3 sku", "4 sku", "5 qty", "6 qty", "7 unit_cost_aed", "9 sku"]);
    expect(count("app__stock_moves")).toBe(before);
    // A header without the quantity is named, and the file is not planned at all.
    const missing = await checked("stock", [["branch", "sku"], ["Dubai", "IMP-BARE"]]);
    expect(where(await found(missing))).toEqual(["1 qty"]);
  });

  test("the templates of the two kinds download as an .xlsx; the page lists them after the services, in Arabic too", async () => {
    for (const kind of ["parts", "stock"]) {
      const res = await owner.page(`/admin/import/template/${kind}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain(`import-${kind}-template.xlsx`);
      expect(res.html.startsWith("PK")).toBe(true);
    }
    const page = await owner.page("/admin/import?lang=en");
    expect(page.html).toContain('id="kind-parts"');
    expect(page.html).toContain('id="kind-stock"');
    expect(page.html.indexOf('id="kind-services"')).toBeLessThan(page.html.indexOf('id="kind-parts"'));
    expect(page.html.indexOf('id="kind-parts"')).toBeLessThan(page.html.indexOf('id="kind-stock"'));
    expect((await dispatcher.page("/admin/import/template/parts")).status).toBe(403);
    const ar = await owner.page("/admin/import?lang=ar");
    expect(ar.html).toContain("قطع الغيار");
    expect(ar.html).toContain("المخزون الافتتاحي");
  });
});
