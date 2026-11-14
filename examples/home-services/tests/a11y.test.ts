// Accessibility of every page (F7-201, #727), asserted from the HTML the app
// serves, in English and in Arabic, signed in with the role that uses the page:
// one h1, html[lang] and html[dir], the skip link first, a main landmark to
// skip to, a name for every control, alt on every image, no positive tabindex,
// a scope on every table header and a caption on every table, no id used twice,
// and every in-page link and aria-describedby pointing at an element that is
// there. The board has its live region; an invalid form (422) marks its
// controls and links its summary to them; the brand colour's text and lines
// meet WCAG 2.2 AA. Lighthouse (`make lighthouse`) measures the real thing.
// Runs on the local worker with the seed's users (password below). Arabic runs
// after English: a page asked for with ?lang=ar keeps that language for the user.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { totp } from "@renoxium/sdk";
import { app, snapshot } from "@renoxium/sdk/test";

import { inkOn, lineOn, PAPER, ratio } from "../lib/contrast";
import { tokenHash } from "../lib/links";
import { attention, attentionHtml, fill } from "../public/offline-queue-core.js";
import { phoneSignIn } from "./outbox";

const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string, next = "/") {
  const u = t.as(jar);
  const res = await u.action("/auth/login", "default", { email, password: PASSWORD, next });
  expect(res.status).toBe(303);
  return u;
}

const rw = <T>(f: (db: Database) => T): T => {
  const db = new Database(t.dbFile);
  db.exec("pragma busy_timeout = 5000");
  try {
    return f(db);
  } finally {
    db.close();
  }
};

type Who = ReturnType<typeof t.as>;
const anonymous = t.as("anonymous");
const dispatcher = await signIn("dispatcher", "dispatcher.dubai@fixit.example");

/** The owner, with a second factor: the back office and the company's pages ask for it (as import.test.ts does). */
async function ownerWithSecondFactor(): Promise<Who> {
  const email = "owner@fixit.example";
  const enrolling = await signIn("owner-enrol", email, "/admin");
  const enrol = await enrolling.page("/2fa/enroll/totp");
  const secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(enrol.html)?.[1] ?? "").replace(/ /gu, "");
  expect((await enrolling.action("/2fa/enroll/totp", "confirm", { code: await totp(secret) })).status).toBe(200);
  const halted = await t.as("owner").action("/auth/login", "default", { email, password: PASSWORD, next: "/admin" });
  expect(halted.headers.get("location")).toBe("/2fa/verify?next=%2Fadmin");
  expect((await t.as("owner").action("/2fa/verify", "totp", { code: await totp(secret, Date.now() / 1000 + 30), next: "/admin" })).status).toBe(303);
  return t.as("owner");
}
const owner = await ownerWithSecondFactor();
const accountant = await signIn("accountant", "accountant.dubai@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example", "/me");
const manager = await signIn("manager", "manager.dubai@fixit.example", "/customers");
// A portal customer (#774): Peter Nowak (cu_dxb_02) signs up with his phone, through auth's phone pages.
const customer = t.as("customer");
expect((await phoneSignIn(customer, (sql, params) => t.db.query(sql, params), (sql, params) => rw((db) => db.run(sql, params)), "+971521110002", "/my")).status).toBe(303);

// The booking page (#775): its three steps for a working day ahead (the first slot step 2 offers), a step 1
// with an error, an emirate with no branch, and a draft of Peter's to confirm.
const BOOK_DAY = (() => {
  for (let i = 1; i < 7; i++) {
    const local = new Date(Date.now() + i * 86_400_000 + 4 * 3_600_000);
    if ([1, 2, 3, 4, 6].includes(local.getUTCDay())) return local.toISOString().slice(0, 10);
  }
  return "";
})();
const BOOK_SERVICE = String(t.db.query<{ id: number }>("select id from app__services where code = 'AC-SERVICE'")[0]?.id);
const BOOK_PLACE = new URLSearchParams({ service: BOOK_SERVICE, emirate: "AE-DU", area: "Dubai Marina", address: "Marina Gate 2, flat 3301", day: BOOK_DAY }).toString();
const BOOK_SLOT = /name="slot" value="([^"]+)"/u.exec((await anonymous.page(`/book?${BOOK_PLACE}&step=2`)).html)?.[1] ?? "";
const BOOK_FU_AREA = encodeURIComponent(String(t.db.query<{ name_en: string }>("select name_en from gcc__areas where emirate = 'AE-FU' order by name_en limit 1")[0]?.name_en));
const BOOK_DRAFT = `bd_${"a".repeat(32)}`;
rw((db) =>
  db.run(
    "insert into app__booking_drafts (id, service_id, emirate, area, address, makani, slot_start, slot_end, technician_user_id, branch_id, hold_id, name, phone, language, notes, ip_hash, created_at, expires_at) values (?, ?, 'AE-DU', 'Dubai Marina', 'Marina Gate 2, flat 3301', null, ?, ?, 'u_dxb_ali', 'br_dubai', null, 'Peter Nowak', '+971521110002', 'en', '', '', ?, ?)",
    [BOOK_DRAFT, Number(BOOK_SERVICE), Math.floor(Number(BOOK_SLOT.split("@")[1]) / 1000), Math.floor(Number(BOOK_SLOT.split("@")[1]) / 1000) + 3600, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 86_400],
  ),
);

// What the seed does not hold: the customer's invoice and report links (only a hash is stored), and two
// spreadsheet imports (a file with errors and a clean one), written the way the app writes them.
const INVOICE_TOKEN = `inv${"a".repeat(40)}`;
const REPORT_TOKEN = `rep${"b".repeat(40)}`;
const now = Math.floor(Date.now() / 1000);
const hashes = { invoice: await tokenHash(INVOICE_TOKEN), report: await tokenHash(REPORT_TOKEN) };
rw((db) => {
  db.run("insert into app__links (token_hash, kind, ref_id, expires_at, used_at) values (?, 'invoice', 'INV-000001', ?, null)", [hashes.invoice, now + 86_400]);
  db.run("insert into app__links (token_hash, kind, ref_id, expires_at, used_at) values (?, 'report', 'vs_seed_12', ?, null)", [hashes.report, now + 86_400]);
  const bad = JSON.stringify({ errors: [{ row: 2, column: "phone", code: "bad_phone" }, { row: 0, column: "", code: "required" }], insert: 1, update: 0, exists: 0 });
  const ok = JSON.stringify({ errors: [], insert: 2, update: 0, exists: 1 });
  db.run("insert into app__imports (id, kind, file_key, file_name, status, rows, ok, skipped, errors, report, created_by, created_at) values ('im_00000000000a11b0', 'customers', 'k1', 'bad.xlsx', 'checked', 3, 1, 0, 2, ?, 'u_owner', ?)", [bad, now]);
  db.run("insert into app__imports (id, kind, file_key, file_name, status, rows, ok, skipped, errors, report, created_by, created_at) values ('im_00000000000a11c0', 'customers', 'k2', 'ok.xlsx', 'checked', 3, 2, 1, 0, ?, 'u_owner', ?)", [ok, now]);
  // Parts and suppliers (#812): one active and one deactivated of each.
  db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values ('pt_00000000000a11a1', 'A11Y-PIPE', 'Copper pipe 15 mm', 'أنبوب نحاسي 15 مم', 'metre', 850, 1400, 5, 20, 1, ?)", [now]);
  db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values ('pt_00000000000a11a2', 'A11Y-GAS', 'R32 refrigerant', 'غاز التبريد R32', 'kg', 4500, 0, 0, 3.5, 0, ?)", [now]);
  db.run("insert into app__suppliers (id, name, trn, phone, email, address, notes, active, created_at) values ('su_00000000000a11a1', 'Al Noor Trading', '100123456700003', '+97144110088', 'orders@alnoor.example', 'Dubai', 'Net 30', 1, ?)", [now]);
  db.run("insert into app__suppliers (id, name, trn, phone, email, address, notes, active, created_at) values ('su_00000000000a11a2', 'Old Pipes LLC', null, '', '', '', '', 0, ?)", [now]);
  // Purchase orders (#815): a draft with a line, a sent one with a line, and a partly received one (its lines need no stock rows: receiving is tested by purchasing.test.ts).
  db.run("insert into app__purchase_orders (id, branch_id, supplier_id, number, status, language, expected_on, notes, created_by, created_at, sent_at) values ('po_00000000000a11a1', 'br_dubai', 'su_00000000000a11a1', 'PO-A11Y01', 'draft', 'en', '2026-12-31', 'Call before delivery', 'u_dxb_manager', ?, null)", [now]);
  db.run("insert into app__purchase_orders (id, branch_id, supplier_id, number, status, language, expected_on, notes, created_by, created_at, sent_at) values ('po_00000000000a11a2', 'br_dubai', 'su_00000000000a11a1', 'PO-A11Y02', 'sent', 'ar', null, '', 'u_dxb_manager', ?, ?)", [now, now]);
  db.run("insert into app__purchase_orders (id, branch_id, supplier_id, number, status, language, expected_on, notes, created_by, created_at, sent_at) values ('po_00000000000a11a3', 'br_dubai', 'su_00000000000a11a1', 'PO-A11Y03', 'partly_received', 'en', null, '', 'u_dxb_manager', ?, ?)", [now, now]);
  for (const po of ["po_00000000000a11a1", "po_00000000000a11a2", "po_00000000000a11a3"]) db.run("insert into app__purchase_order_lines (po_id, branch_id, part_id, qty, unit_cost_fils, received_qty) values (?, 'br_dubai', 'pt_00000000000a11a1', 12.5, 850, ?)", [po, po.endsWith("3") ? 5 : 0]);
  // The background states of #733: a file being checked (its page reloads itself) and one that failed.
  const empty = JSON.stringify({ errors: [], insert: 0, update: 0, exists: 0 });
  db.run("insert into app__imports (id, kind, file_key, file_name, status, report, created_by, created_at) values ('im_00000000000a11d0', 'customers', 'k3', 'waiting.xlsx', 'checking', ?, 'u_owner', ?)", [empty, now]);
  db.run("insert into app__imports (id, kind, file_key, file_name, status, report, created_by, created_at, error) values ('im_00000000000a11e0', 'customers', 'k4', 'broken.xlsx', 'failed', ?, 'u_owner', ?, 'import.err.not_xlsx')", [empty, now]);
  // An open tax invoice of Peter's (#777), with its tax_gcc document as the module writes it (no job: a page of /my/invoices).
  const body = JSON.stringify({
    kind: "invoice",
    title: { en: "Tax Invoice", ar: "فاتورة ضريبية" },
    number: "INV-000950",
    issued_at: now * 1000,
    seller: { name: "FixIt Services LLC", trn: "100000000000003", address: "Dubai" },
    buyer: { name: "Peter Nowak", trn: null, address: "Villa, Al Barsha" },
    lines: [{ description: "Handyman", quantity: 1, unit_fils: 12000, rate: "standard", net_fils: 12000, vat_fils: 600 }],
    totals: { standard: 12000, zero: 0, exempt: 0, vat: 600, total: 12600, vat_rate: 5, currency: "AED", display: { standard: "120.00", zero: "0.00", exempt: "0.00", vat: "6.00", total: "126.00" } },
  });
  db.run("insert into tax_gcc__documents (number, kind, against, body, standard, zero, exempt, vat, issued_at) values ('INV-000950', 'invoice', null, ?, 12000, 0, 0, 600, ?)", [body, now * 1000]);
  db.run("insert into app__job_invoices (job_id, branch_id, customer_id, invoice_id, total_fils, due_at, credit_note_id, created_by, created_at) values (null, 'br_dubai', 'cu_dxb_02', 'INV-000950', 12600, ?, null, 'u_dxb_accountant', ?)", [now + 30 * 86_400, now]);
});
// Stock (#813): Dubai receives some of the active part through the page, as the owner would (the tables are written by
// lib/stock.ts only), so /admin/stock and its history have a row and a move; the part is under its minimum.
expect((await owner.action("/admin/stock", "receive", { branch: "br_dubai", part: "pt_00000000000a11a1", qty: "8", unit_cost: "8.50", reason: "delivery for the audit" })).status).toBe(303);

// Two self-bookings of Peter's waiting for the dispatcher (#779): one at a time the technicians are free (the
// confirm form) and one on a Sunday, when the branch is closed (no technician free: Confirm disabled).
const ONLINE_AT = Math.floor(Date.parse(`${BOOK_DAY}T00:00:00Z`) / 1000) - 4 * 3600 + 16 * 3600;
const ONLINE_SUNDAY = (() => {
  for (let i = 1; i < 8; i++) {
    const local = new Date(Date.now() + i * 86_400_000 + 4 * 3_600_000);
    if (local.getUTCDay() === 0) return Math.floor(Date.parse(`${local.toISOString().slice(0, 10)}T00:00:00Z`) / 1000) - 4 * 3600 + 10 * 3600;
  }
  return 0;
})();
rw((db) => {
  const handyman = Number((db.query("select id from app__services where code = 'HANDYMAN'").get() as { id: number }).id);
  for (const [id, number, at] of [["jb_a11y_online", "J-000991", ONLINE_AT], ["jb_a11y_online_none", "J-000992", ONLINE_SUNDAY]] as [string, string, number][]) {
    db.run(
      "insert into app__jobs (id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, scheduled_start, scheduled_end, technician_user_id, booking_id, created_by, created_at, updated_at, source) values (?, 'br_dubai', 'cu_dxb_02', 'st_dxb_02a', null, ?, 'new', 'normal', ?, '', ?, ?, null, null, 'u_dxb_dispatcher', ?, ?, 'self_booking')",
      [id, number, handyman, at, at + 3600, now, now],
    );
  }
});

// Ali checks in to his job J-000006 and records a part: its visit page then holds every form (J-000010 is still before check-in).
expect((await ali.action("/me/visits/jb_seed_06", "checkin", {})).status).toBe(303);
expect((await ali.action("/me/visits/jb_seed_06", "part", { description: "Hose", qty: "1", price: "10" })).status).toBe(303);

// -- the audit ------------------------------------------------------------------------------------------------------

interface Tag {
  name: string;
  attrs: Record<string, string>;
  close: boolean;
  at: number;
  end: number;
}

/** The tags of a page in order; script and style contents and comments are not markup. */
function tagsOf(html: string): Tag[] {
  const clean = html.replace(/<!--[^]*?-->/gu, (m) => " ".repeat(m.length)).replace(/<(script|style)\b[^>]*>[^]*?<\/\1>/giu, (m) => " ".repeat(m.length));
  const out: Tag[] = [];
  for (const m of clean.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gu)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? "").matchAll(/([^\s=/>]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu)) attrs[(a[1] as string).toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    out.push({ name: (m[2] as string).toLowerCase(), attrs, close: m[1] === "/", at: m.index as number, end: (m.index as number) + m[0].length });
  }
  return out;
}

const textOf = (html: string): string =>
  html
    .replace(/<(select|textarea|script|style)\b[^>]*>[^]*?<\/\1>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;|\s+/gu, " ")
    .trim();

const TEXT_INPUTS_SKIPPED = new Set(["hidden", "submit", "button", "reset", "image"]);

/** What is wrong with the page: an empty list when nothing is. */
function audit(html: string, lang: "en" | "ar"): string[] {
  const bad: string[] = [];
  const tags = tagsOf(html);
  const open = (name: string) => tags.filter((x) => x.name === name && !x.close);

  const h1 = open("h1").length;
  if (h1 !== 1) bad.push(`${h1} h1 elements`);
  const root = open("html")[0];
  if (root?.attrs.lang !== lang || root?.attrs.dir !== (lang === "ar" ? "rtl" : "ltr")) bad.push(`html lang/dir are ${root?.attrs.lang}/${root?.attrs.dir}`);
  const firstA = open("a")[0];
  if (firstA === undefined || firstA.attrs.href !== "#main" || !(firstA.attrs.class ?? "").split(" ").includes("skip")) bad.push("the skip link is not the first link");
  const mains = open("main");
  if (mains.length !== 1 || mains[0]?.attrs.id !== "main" || mains[0]?.attrs.tabindex !== "-1") bad.push("there is not exactly one <main id=main tabindex=-1>");

  // Names: a label that wraps the control (with text) or points at it, or aria-label(ledby).
  const labels: { from: number; to: number; text: string }[] = [];
  const closes = tags.filter((x) => x.name === "label" && x.close);
  for (const l of open("label")) {
    const c = closes.find((x) => x.at > l.at);
    if (c) labels.push({ from: l.at, to: c.end, text: textOf(html.slice(l.end, c.at)) });
  }
  const forIds = new Set(open("label").filter((l) => l.attrs.for !== undefined && labels.some((x) => x.from === l.at && x.text !== "")).map((l) => l.attrs.for));
  for (const c of tags.filter((x) => !x.close && (x.name === "select" || x.name === "textarea" || (x.name === "input" && !TEXT_INPUTS_SKIPPED.has((x.attrs.type ?? "text").toLowerCase()))))) {
    const named = (c.attrs["aria-label"] ?? "").trim() !== "" || (c.attrs["aria-labelledby"] ?? "") !== "" || (c.attrs.id !== undefined && forIds.has(c.attrs.id)) || labels.some((l) => l.from < c.at && c.at < l.to && l.text !== "");
    if (!named) bad.push(`<${c.name} name=${c.attrs.name ?? ""}> has no name`);
  }
  for (const b of open("button")) {
    const close = tags.find((x) => x.name === "button" && x.close && x.at > b.at);
    const label = (b.attrs["aria-label"] ?? "") !== "" || textOf(html.slice(b.end, close?.at ?? b.end)) !== "";
    if (!label) bad.push("a button has no name");
  }
  for (const i of open("img")) if (i.attrs.alt === undefined) bad.push(`<img src=${i.attrs.src}> has no alt`);
  for (const x of tags.filter((x) => !x.close && x.attrs.tabindex !== undefined && Number(x.attrs.tabindex) > 0)) bad.push(`<${x.name}> has tabindex ${x.attrs.tabindex}`);
  for (const th of open("th")) if (th.attrs.scope === undefined) bad.push("a <th> has no scope");
  const tables = open("table");
  const captions = open("caption");
  if (captions.length < tables.length) bad.push(`${tables.length} tables, ${captions.length} captions`);

  // References.
  const ids = tags.flatMap((x) => (x.attrs.id === undefined ? [] : [x.attrs.id]));
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) bad.push(`id ${id} is used twice`);
    seen.add(id);
  }
  for (const x of tags.filter((x) => !x.close && (x.attrs["aria-describedby"] ?? "") !== "")) {
    for (const id of (x.attrs["aria-describedby"] as string).split(/\s+/u)) if (!seen.has(id)) bad.push(`aria-describedby points at ${id}`);
  }
  for (const x of open("a")) if (x.attrs.href?.startsWith("#") && x.attrs.href.length > 1 && !seen.has(x.attrs.href.slice(1))) bad.push(`the link ${x.attrs.href} points nowhere`);
  for (const x of tags.filter((x) => !x.close && x.attrs["aria-invalid"] === "true")) if ((x.attrs["aria-describedby"] ?? "") === "") bad.push(`an invalid <${x.name}> is not described`);
  return bad;
}

describe("the audit itself", () => {
  const GOOD = '<html lang="en" dir="ltr"><body><a class="skip" href="#main">Skip</a><main id="main" tabindex="-1"><h1>T</h1>';
  const END = "</main></body></html>";

  test("a clean page has nothing to report", () => {
    const form = '<label>Name <input name="n"></label><label for="q">Q</label><input id="q" name="q"><input type="hidden" name="h"><img src="a" alt=""><button>Go</button>';
    const table = '<table><caption>C</caption><thead><tr><th scope="col">A</th></tr></thead></table>';
    expect(audit(GOOD + form + table + END, "en")).toEqual([]);
  });

  test("it finds a control with no name, a nameless image, a header with no scope, a table with no caption, a positive tabindex, a reused id and a link to nowhere", () => {
    const html = `${GOOD}<input name="a"><label><select name="s"><option>x</option></select></label><img src="a"><table><tr><th>A</th></tr></table><div tabindex="2" id="d"></div><p id="d"></p><a href="#gone">x</a><button></button>${END}`;
    const found = audit(html, "en").join("|");
    expect(found).toContain("<input name=a> has no name");
    expect(found).toContain("<select name=s> has no name");
    expect(found).toContain("<img src=a> has no alt");
    expect(found).toContain("a <th> has no scope");
    expect(found).toContain("1 tables, 0 captions");
    expect(found).toContain("<div> has tabindex 2");
    expect(found).toContain("id d is used twice");
    expect(found).toContain("the link #gone points nowhere");
    expect(found).toContain("a button has no name");
  });

  test("it finds a missing skip link, a second h1 and the wrong language", () => {
    const found = audit('<html lang="en" dir="ltr"><body><a href="/">Home</a><main><h1>a</h1><h1>b</h1></main></body></html>', "ar").join("|");
    expect(found).toContain("2 h1 elements");
    expect(found).toContain("html lang/dir are en/ltr");
    expect(found).toContain("the skip link is not the first link");
    expect(found).toContain("there is not exactly one <main id=main tabindex=-1>");
  });
});

// -- the pages --------------------------------------------------------------------------------------------------------

/** Every page under pages/, with the user who uses it (a page's ?lang is added by the test). */
const PAGES: { path: string; as: () => Who; note?: string }[] = [
  { path: "/", as: () => anonymous },
  { path: "/", as: () => dispatcher, note: "signed in" },
  { path: "/nothing-here", as: () => anonymous, note: "404" },
  { path: "/l/approve/demo-q000002-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", as: () => anonymous, note: "open quotation" },
  { path: "/l/approve/demo-q000004-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", as: () => anonymous, note: "approved quotation" },
  { path: `/l/invoice/${INVOICE_TOKEN}`, as: () => anonymous },
  { path: `/l/report/${REPORT_TOKEN}`, as: () => anonymous },
  { path: "/customers", as: () => dispatcher },
  { path: "/customers/new", as: () => dispatcher },
  { path: "/customers/cu_dxb_04", as: () => dispatcher },
  { path: "/quotes", as: () => dispatcher },
  { path: "/quotes/new", as: () => dispatcher },
  { path: "/quotes/qt_seed_02", as: () => dispatcher },
  { path: "/jobs", as: () => dispatcher },
  { path: "/jobs/new", as: () => dispatcher },
  { path: "/jobs/jb_seed_05", as: () => dispatcher, note: "scheduled" },
  { path: "/jobs/jb_seed_10", as: () => dispatcher, note: "in progress, with a visit" },
  { path: "/jobs/jb_seed_12", as: () => dispatcher, note: "done, with a report" },
  { path: "/jobs/jb_a11y_online", as: () => dispatcher, note: "a self-booking to confirm (#779)" },
  { path: "/jobs/jb_a11y_online_none", as: () => dispatcher, note: "a self-booking with no technician free (#779)" },
  { path: "/jobs?source=self_booking", as: () => dispatcher, note: "booked online (#779)" },
  { path: "/dispatch", as: () => dispatcher },
  { path: "/services", as: () => owner },
  { path: "/contracts", as: () => owner },
  { path: "/contracts/new", as: () => owner },
  { path: "/contracts/ct_seed_01", as: () => owner },
  { path: "/invoices", as: () => accountant },
  { path: "/invoices/INV-000001", as: () => accountant },
  { path: "/reports/technicians", as: () => owner },
  { path: "/reports/amc", as: () => owner },
  { path: "/reports/outstanding", as: () => accountant },
  { path: "/admin/tile", as: () => owner },
  { path: "/admin/settings", as: () => owner },
  { path: "/admin/branches", as: () => owner },
  { path: "/admin/whatsapp", as: () => owner },
  { path: "/admin/whatsapp?status=failed", as: () => owner, note: "a filter" },
  { path: "/admin/people", as: () => owner },
  { path: "/admin/import", as: () => owner },
  { path: "/admin/parts", as: () => owner },
  { path: "/admin/parts?edit=pt_00000000000a11a1", as: () => owner, note: "editing a part (#812)" },
  { path: "/admin/parts?q=pipe", as: () => owner, note: "a search" },
  { path: "/admin/parts", as: () => dispatcher, note: "read-only, no form" },
  { path: "/admin/stock", as: () => owner, note: "stock per branch, with the three forms (#813)" },
  { path: "/admin/stock?branch=br_sharjah&low=1", as: () => owner, note: "another branch, low stock only" },
  { path: "/admin/stock?q=pipe", as: () => owner, note: "a search" },
  { path: "/admin/stock", as: () => dispatcher, note: "read-only, no form" },
  { path: "/admin/stock/pt_00000000000a11a1", as: () => owner, note: "the moves of a part" },
  { path: "/admin/stock/pt_00000000000a11a1", as: () => dispatcher, note: "the moves of a part, read-only" },
  { path: "/admin/suppliers", as: () => owner },
  { path: "/admin/suppliers?edit=su_00000000000a11a1", as: () => owner, note: "editing a supplier (#812)" },
  { path: "/admin/suppliers", as: () => accountant, note: "read-only, no form" },
  { path: "/admin/purchasing", as: () => owner, note: "purchase orders, with the new-order form (#815)" },
  { path: "/admin/purchasing?status=sent&supplier=su_00000000000a11a1", as: () => owner, note: "a filter" },
  { path: "/admin/purchasing", as: () => accountant, note: "read-only, no form" },
  { path: "/admin/purchasing/po_00000000000a11a1", as: () => owner, note: "a draft: add a line, send, cancel" },
  { path: "/admin/purchasing/po_00000000000a11a2", as: () => owner, note: "sent: the receive form" },
  { path: "/admin/purchasing/po_00000000000a11a3", as: () => owner, note: "partly received" },
  { path: "/admin/purchasing/po_00000000000a11a2", as: () => accountant, note: "read-only, no form" },
  { path: "/admin/import/im_00000000000a11b0", as: () => owner, note: "a file with errors" },
  { path: "/admin/import/im_00000000000a11c0", as: () => owner, note: "a clean file" },
  { path: "/admin/import/im_00000000000a11d0", as: () => owner, note: "being checked" },
  { path: "/admin/import/im_00000000000a11e0", as: () => owner, note: "failed" },
  { path: "/jobs?outside_hours=1", as: () => owner, note: "outside the branch's hours" },
  { path: "/me", as: () => ali },
  { path: "/me/visits/jb_seed_10", as: () => ali, note: "before check-in" },
  { path: "/me/visits/jb_seed_06", as: () => ali, note: "visit open" },
  { path: "/me/visits/jb_seed_12", as: () => ali, note: "visit closed" },
  { path: "/me/signout", as: () => ali, note: "the sign-out warning (#810)" },
  { path: "/my", as: () => customer, note: "the customer portal" },
  { path: "/my/visits/jb_seed_06", as: () => customer, note: "a visit in progress" },
  { path: "/my/visits/jb_seed_02", as: () => customer, note: "a visit waiting for confirmation" },
  { path: "/my/visits/jb_seed_11", as: () => customer, note: "a visit done" },
  { path: "/my/visits/jb_seed_02?change=1", as: () => customer, note: "change the time (#778)" },
  { path: "/my/visits/jb_seed_02?cancel=1", as: () => customer, note: "cancel the visit (#778)" },
  { path: "/my/invoices", as: () => customer, note: "the customer's invoices" },
  { path: "/my/invoices/INV-000950", as: () => customer, note: "an open invoice" },
  { path: "/book", as: () => anonymous, note: "step 1, signed out" },
  { path: `/book?${BOOK_PLACE}&address=x&step=2`, as: () => anonymous, note: "step 1 with an error" },
  { path: `/book?service=${BOOK_SERVICE}&emirate=AE-FU&area=${BOOK_FU_AREA}&address=Fujairah+corniche&step=2`, as: () => anonymous, note: "an emirate with no branch" },
  { path: `/book?${BOOK_PLACE}&step=2`, as: () => anonymous, note: "step 2" },
  { path: `/book?${BOOK_PLACE}&slot=${encodeURIComponent(BOOK_SLOT)}&step=3`, as: () => anonymous, note: "step 3" },
  { path: `/book?${BOOK_PLACE}&slot=${encodeURIComponent(BOOK_SLOT)}&step=3`, as: () => customer, note: "step 3, signed in" },
  { path: `/book/confirm/${BOOK_DRAFT}`, as: () => customer, note: "the confirmation" },
];

const withLang = (path: string, lang: string) => `${path}${path.includes("?") ? "&" : "?"}lang=${lang}`;

for (const lang of ["en", "ar"] as const) {
  describe(`every page, ${lang === "en" ? "English" : "Arabic"}`, () => {
    for (const p of PAGES) {
      test(`${p.path}${p.note ? ` (${p.note})` : ""}`, async () => {
        const res = await p.as().page(withLang(p.path, lang));
        expect(res.status).toBe(p.note === "404" ? 404 : 200);
        expect(audit(res.html, lang)).toEqual([]);
      });
    }
  });
}

// -- the error pages ----------------------------------------------------------------------------------------------------

describe("the error pages, translated", () => {
  const TITLES = { en: { 404: "Page not found", 500: "Something went wrong (500)" }, ar: { 404: "الصفحة غير موجودة", 500: "حدث خطأ ما" } } as const;
  /** A 500 from a loader: the customers table is renamed away for the one request (the tenant file is shared, so it is put back). */
  async function failing(lang: string) {
    rw((db) => db.exec("alter table app__customers rename to app__customers_gone"));
    try {
      return await dispatcher.page(withLang("/customers", lang));
    } finally {
      rw((db) => db.exec("alter table app__customers_gone rename to app__customers"));
    }
  }
  for (const lang of ["en", "ar"] as const) {
    const dir = lang === "ar" ? "rtl" : "ltr";
    test(`404, ${lang}: html lang and dir, the title, the way home and the request id`, async () => {
      const res = await anonymous.page(withLang("/nothing-here", lang));
      expect(res.status).toBe(404);
      expect(res.html).toContain(`<html lang="${lang}" dir="${dir}"`);
      expect(res.html).toContain(`<h1>${TITLES[lang][404]}</h1>`);
      expect(res.html).toMatch(/<a href="\/">[^<]+<\/a>/u);
      expect(res.html).toMatch(/<span dir="ltr">[^<]+<\/span><\/small>/u);
      expect(audit(res.html, lang)).toEqual([]);
    });
    test(`500, ${lang}: html lang and dir, the title with the status, the code and the request id`, async () => {
      const res = await failing(lang);
      expect(res.status).toBe(500);
      expect(res.html).toContain(`<html lang="${lang}" dir="${dir}"`);
      expect(res.html).toContain(lang === "en" ? `<h1>${TITLES.en[500]}</h1>` : TITLES.ar[500]);
      expect(res.html).toMatch(/<small><span dir="ltr">[^<]+<\/span> · /u);
      expect(audit(res.html, lang)).toEqual([]);
    });
  }
  test("Accept-Language picks the language of a page that has no ?lang", async () => {
    const res = await t.request("GET", "/nothing-here", { headers: { "accept-language": "ar" } });
    expect(res.html).toContain('<html lang="ar" dir="rtl"');
    expect(res.html).toContain(TITLES.ar[404]);
  });
  test("the brand falls back to the app's name when there is no loader data", async () => {
    const res = await anonymous.page("/nothing-here?lang=en");
    expect(res.html).toContain(">home-services</strong></a>");
  });
});

// -- the board ------------------------------------------------------------------------------------------------------------

describe("the dispatch board", () => {
  test("a polite live region, a section per column named by its heading, and the sentences it says", async () => {
    const res = await dispatcher.page(withLang("/dispatch", "en"));
    expect(res.html).toMatch(/<div aria-live="polite" class="visually-hidden" id="board-announcer"/u);
    expect((res.html.match(/aria-live=/gu) ?? []).length).toBe(1);
    expect(res.html).toContain('data-new="New job {number} in {column}."');
    expect(res.html).toContain('data-moved="Job {number} moved to {column}."');
    for (const status of ["new", "scheduled", "en_route", "in_progress", "done"]) {
      expect(res.html).toMatch(new RegExp(`<section class="board-column" aria-labelledby="head-${status}">\\s*<h2 id="head-${status}"`, "u"));
    }
    // The card's one action is a link, and a high priority is written out, not only coloured.
    expect(res.html).toMatch(/<article id="job-jb_seed_07" class="job-card priority-high"><a href="\/jobs\/jb_seed_07" dir="ltr">J-000007<\/a>[^]*?<span class="priority" dir="auto">High<\/span>/u);
  });

  test("the sentences are in Arabic too", async () => {
    const res = await dispatcher.page(withLang("/dispatch", "ar"));
    expect(res.html).toContain('data-new="مهمة جديدة {number} في {column}."');
    expect(res.html).toContain('data-moved="انتقلت المهمة {number} إلى {column}."');
  });

  test("the client script announces a new card and a card that changed column", async () => {
    // The script is the file public/board.js since #728 (no inline script): the same text, served from /board.<hash>.js.
    const res = await dispatcher.page(withLang("/dispatch", "en"));
    const src = /<script src="(\/board\.[0-9a-f]{16}\.js)"/u.exec(res.html)?.[1] ?? "";
    expect(src).not.toBe("");
    const js = (await dispatcher.request("GET", src)).html;
    expect(js).toContain('sentence("new"');
    expect(js).toContain('sentence("moved"');
    expect(js).toContain("say(sentence");
  });
});

// -- an invalid form --------------------------------------------------------------------------------------------------------

// -- the back-office steps that only an action shows (#735, #736) --------------------------------------------------------

describe("the confirmation of a second-factor reset and the working hours that cannot be saved", () => {
  for (const lang of ["en", "ar"] as const) {
    test(`/admin/people, the confirmation step (#735), ${lang}`, async () => {
      // Ali gets a confirmed authenticator for the one request, so the owner's page offers the reset.
      rw((db) => db.run("insert into twofa__totp (user_id, secret_sealed, confirmed_at, last_step, created_at) values ('u_dxb_ali', 'sealed', ?, null, ?)", [Date.now(), Date.now()]));
      try {
        await owner.page(withLang("/admin/people", lang));
        const res = await owner.action("/admin/people", "reset_2fa", { user_id: "u_dxb_ali" });
        expect(res.status).toBe(200);
        expect(res.html).toContain('id="confirm-reset"');
        expect(res.html).toContain(`<html lang="${lang}"`);
        expect(audit(res.html, lang)).toEqual([]);
      } finally {
        rw((db) => db.run("delete from twofa__totp where user_id = 'u_dxb_ali'"));
        await owner.page(withLang("/admin/people", "en"));
      }
    });
    test(`/admin/branches, working hours with every day closed (422, #736), ${lang}`, async () => {
      await owner.page(withLang("/admin/branches", lang));
      try {
        const res = await owner.action("/admin/branches", "hours", { branch_id: "br_dubai", ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [`closed_${d}`, "on"])) });
        expect(res.status).toBe(422);
        expect(res.html).toMatch(/<section class="problem" role="alert" tabindex="-1" id="form-errors">/u);
        expect(res.html).toContain(`<html lang="${lang}"`);
        expect(audit(res.html, lang)).toEqual([]);
      } finally {
        await owner.page(withLang("/admin/branches", "en"));
      }
    });
  }
});

describe("a form that cannot be saved (422)", () => {
  test("the summary is an alert that can take focus and links to each control; each control is marked and described", async () => {
    const res = await dispatcher.action("/customers/new", "create", { kind: "household", name: "", phone: "12", email: "", language: "en" });
    expect(res.status).toBe(422);
    expect(res.html).toMatch(/<section class="problem" role="alert" tabindex="-1" id="form-errors">/u);
    expect(res.html).toContain('<a href="#f-name"><strong dir="auto">Name</strong></a>');
    expect(res.html).toMatch(/<input name="name"[^>]*id="f-name"[^>]*aria-invalid="true"[^>]*aria-describedby="err-name"/u);
    expect(res.html).toContain('id="err-name"');
    // A control with no error has neither attribute (#737): the page passes false and none, and the engine leaves them out.
    const trn = res.html.match(/<input name="trn"[^>]*>/u)?.[0] ?? "";
    expect(trn).not.toBe("");
    expect(trn).not.toContain("aria-invalid");
    expect(trn).not.toContain("aria-describedby");
    expect(audit(res.html, "en")).toEqual([]);
  });

  test("a valid form marks no control: no aria-invalid and no aria-describedby on any control (#737)", async () => {
    const res = await dispatcher.page(withLang("/customers/new", "en"));
    expect(res.status).toBe(200);
    const controls = res.html.match(/<(input|select|textarea)\b[^>]*>/gu) ?? [];
    expect(controls.length).toBeGreaterThan(3);
    for (const c of controls) {
      expect(c).not.toContain("aria-invalid");
      expect(c).not.toContain("aria-describedby");
    }
  });

  test('no page prints aria-invalid="false" or an empty aria-describedby (#737)', async () => {
    for (const p of PAGES) {
      const res = await p.as().page(withLang(p.path, "en"));
      expect(res.html.includes('aria-invalid="false"'), `${p.path} has aria-invalid="false"`).toBe(false);
      expect(res.html.includes('aria-describedby=""'), `${p.path} has an empty aria-describedby`).toBe(false);
    }
  });

  test("a page with several forms links to the control of the form that failed", async () => {
    const res = await dispatcher.action("/jobs/jb_seed_05", "schedule", { technician: "u_dxb_ali", note: "x" });
    expect(res.status).toBe(422);
    expect(res.html).toContain('href="#f-schedule-slot"');
    // With free slots the control is the slot list; with none it is the sentence that says so. Either way the link lands on it, whatever the day.
    expect(res.html).toMatch(/id="f-schedule-slot"/u);
    expect(audit(res.html, "en")).toEqual([]);
  });

  test("the same in Arabic", async () => {
    await manager.page(withLang("/customers/new", "ar"));
    const res = await manager.action("/customers/new", "create", { kind: "household", name: "", phone: "12", email: "", language: "ar" });
    expect(res.status).toBe(422);
    expect(audit(res.html, "ar")).toEqual([]);
    expect(res.html).toContain('<html lang="ar" dir="rtl"');
  });

  test("required fields say so to a screen reader", async () => {
    const res = await dispatcher.page(withLang("/customers/new", "en"));
    expect(res.html).toMatch(/<input name="name"[^>]* required[^>]*aria-required="true"/u);
  });
});

// -- the import pages -------------------------------------------------------------------------------------------------------

// tests/import.test.ts pins these pages' markup by cutting out a literal `<main>`; the landmark is `<main id="main" tabindex="-1">`
// now (the skip link's target), so that cut is empty. The same pins, here.
describe("the import pages, in Arabic", () => {
  const steady = (html: string) =>
    /<main\b[^>]*>[\s\S]*<\/main>/u
      .exec(html)?.[0]
      .replace(/<table id="imports">[\s\S]*?<\/table>/u, '<table id="imports">(the latest imports)</table>')
      .replace(/(["']\/[^"'\s]*\.)[0-9a-f]{16}(\.[A-Za-z0-9]+["'])/gu, "$1<hash>$2")
      .replace(/(value=")[^"]*("[^>]*name="_csrf")/gu, "$1<csrf>$2")
      .replace(/ nonce="[^"]*"/gu, ' nonce="<nonce>"')
      .replace(/\d{4}-\d{2}-\d{2}/gu, "DATE") ?? "";

  test("the upload page and the report of a file with errors", async () => {
    const page = await owner.page(withLang("/admin/import", "ar"));
    expect(page.html).toContain("افحص الملف");
    snapshot(steady(page.html), { role: "import page, owner, ar" });
    const report = await owner.page(withLang("/admin/import/im_00000000000a11b0", "ar"));
    expect(report.html).toContain("تقرير الفحص");
    snapshot(steady(report.html), { role: "import report with errors, owner, ar" });
  });
});

// -- the technician's signature -------------------------------------------------------------------------------------------------

describe("the signature step", () => {
  test("the canvas has a name and a typed name can stand in for the drawing", async () => {
    const res = await ali.page(withLang("/me/visits/jb_seed_06", "en"));
    expect(res.html).toMatch(/<canvas id="sig-canvas" class="sig-canvas" role="img" aria-label="Sign in the box"/u);
    expect(res.html).toMatch(/<input type="checkbox" id="sig-typed">\s*Type the customer(&#39;|')s name instead/u);
    // The script is the file public/visit.js since #728: the typed name is written onto the canvas there.
    const src = /<script src="(\/visit\.[0-9a-f]{16}\.js)"/u.exec(res.html)?.[1] ?? "";
    expect(src).not.toBe("");
    expect((await ali.request("GET", src)).html).toContain('document.getElementById("sig-typed")');
  });

  test("every control of the technician's pages is at least 44 px: the rule is on the page", async () => {
    const res = await ali.page(withLang("/me/visits/jb_seed_06", "en"));
    expect(res.html).toContain('<div class="touch">');
    const css = await Bun.file(new URL("../public/app.css", import.meta.url)).text();
    expect(css).toContain(".touch :is(a, button, input:not([type=\"hidden\"]), select, textarea, summary) { min-block-size: 44px; min-inline-size: 44px; }");
  });
});

// -- colour ---------------------------------------------------------------------------------------------------------------------

describe("the brand colour", () => {
  const BRANDS = ["#e8634a", "#1f6f5c", "#ffd400", "#ffffff", "#000000", "#7f7f7f", "#0057b8", "#f5f500", "#2a2a2a", "#ff00ff"];

  test("the text on a brand button is black or white, whichever reads better, at 4.5:1 or better for these colours", () => {
    for (const brand of BRANDS) {
      const ink = inkOn(brand);
      expect(ratio(ink, brand)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(ink, brand)).toBeGreaterThanOrEqual(ratio(ink === "#000000" ? "#ffffff" : "#000000", brand));
    }
  });

  test("white is not assumed: the coral default and a yellow take black", () => {
    expect(inkOn("#e8634a")).toBe("#000000");
    expect(inkOn("#ffd400")).toBe("#000000");
    expect(inkOn("#1f6f5c")).toBe("#ffffff");
  });

  test("a line or focus ring in the brand colour is 3:1 against the page, light and dark", () => {
    for (const brand of BRANDS) {
      expect(ratio(lineOn(brand, PAPER.light, "dark"), PAPER.light)).toBeGreaterThanOrEqual(3);
      expect(ratio(lineOn(brand, PAPER.dark, "light"), PAPER.dark)).toBeGreaterThanOrEqual(3);
    }
  });

  test("/theme prints them", async () => {
    const css = await anonymous.request("GET", "/theme");
    expect(css.html).toMatch(/^:root \{ --brand: #[0-9a-f]{6}; \}\n:root \{ --brand-ink: #(000000|ffffff); --brand-line: #[0-9a-f]{6}; \}\n@media \(prefers-color-scheme: dark\) \{ :root \{ --brand-line: #[0-9a-f]{6}; \} \}/u);
  });

  test("the focus ring is never removed by the app's stylesheet", async () => {
    const css = await Bun.file(new URL("../public/app.css", import.meta.url)).text();
    expect(css).toContain(":focus-visible { outline: 3px solid var(--brand-line); outline-offset: 2px; }");
    expect(css).not.toMatch(/outline:\s*(none|0)\b/u);
  });
});

// -- the technician's "Needs attention" list (#810) ---------------------------------------------------------------------------------

describe("/me with refused items rendered", () => {
  const entities = (v: string): string => v.replace(/&#39;/gu, "'").replace(/&quot;/gu, '"').replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
  const refusedAction = (seq: number, job: string, action: string, reason: string, at: number, extra: Record<string, unknown> = {}) => ({
    seq, action_id: `fixture-action-${String(seq).padStart(4, "0")}`, user_id: "u_dxb_ali", job_id: job, url: `/me/visits/${job}`, action, fields: {}, performed_at: at,
    state: reason === "" ? "pending" : "refused", attempts: 0, job_number: job === "jb_a" ? "J-001042" : "J-001043", customer: job === "jb_a" ? "Layla Haddad" : "Peter Nowak", ...(reason === "" ? {} : { refused_reason: reason }), ...extra,
  });

  for (const lang of ["en", "ar"] as const) {
    test(`${lang}: the list the script draws is a labelled live region with named buttons, a call link and no id twice, also with a question open`, async () => {
      const res = await ali.page(withLang("/me", lang));
      const tags = tagsOf(res.html);
      const section = tags.find((x) => x.name === "section" && x.attrs.id === "needs-attention");
      expect(section).toBeDefined();
      expect(section?.attrs["aria-live"]).toBe("polite");
      expect(section?.attrs.hidden).toBeDefined();
      expect(section?.attrs["aria-labelledby"]).toBe("needs-attention-title");
      // The texts the script reads are on the container, in the page's language.
      const t = (key: string, values?: Record<string, string | number>) => fill(entities(section?.attrs[`data-${key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`] ?? ""), values ?? {});
      const records = [
        refusedAction(1, "jb_a", "checkin", "job_cancelled", 1_794_000_000_000),
        refusedAction(2, "jb_a", "part", "", 1_794_000_100_000, { fields: { description: "Filter", qty: "2", price: "10" } }),
        refusedAction(3, "jb_b", "notes", "job_reassigned", 1_794_000_200_000, { fields: { notes: "x" } }),
        refusedAction(4, "jb_b", "signature", "invalid", 1_794_000_300_000, { refused_message: "Draw the signature first." }),
      ];
      const photos = [{ id: 1, user_id: "u_dxb_ali", job_id: "jb_a", phase: "after", caption: "", blob: null, type: "image/jpeg", size: 1, taken_at: 1_794_000_150_000, action_id: "fixture-photo-0000001", state: "pending", job_number: "J-001042", customer: "Layla Haddad" }];
      const groups = attention(records as never, photos as never, "u_dxb_ali");
      expect(groups.map((g) => [g.job_id, g.later, g.retry])).toEqual([["jb_a", true, false], ["jb_b", false, true]]);
      for (const confirming of [null, "jb_a"]) {
        const list = attentionHtml(groups, t, { phone: "+971 4 555 0100", confirming });
        // The page, as the script leaves it: the list drawn, the container shown.
        const page = res.html.replace('<div id="needs-attention-list"></div>', `<div id="needs-attention-list">${list}</div>`).replace(/(<section id="needs-attention"[^>]*?) hidden/u, "$1");
        expect(page).toContain("Layla Haddad");
        expect(page).toContain('href="tel:+97145550100"');
        expect(page).toContain(t("later"));
        expect(page).toContain(t("reasonJobCancelled").replace(/'/gu, "&#39;"));
        expect(audit(page, lang)).toEqual([]);
      }
    });
  }
});
