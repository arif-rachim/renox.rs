// Quotations (#557): a dispatcher prices lines with 5 % VAT in fils, sends the
// customer a signed link and the customer approves without signing in, once;
// the PDF renders in English and Arabic; the AI draft is off without a provider.
// Runs on the local worker with the seed's users (password below).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { fakeAi } from "@renoxium/sdk/fakes";
import { snapshot, app } from "@renoxium/sdk/test";

import { draftLines, parseDraft } from "../lib/draft";
import { lineTotal, totals } from "../lib/money";
import type { ServiceRow } from "../lib/quotes";

const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string, next = "/quotes") {
  const u = t.as(jar);
  const res = await u.action("/auth/login", "default", { email, password: PASSWORD, next });
  expect(res.status).toBe(303);
  return u;
}

const dubai = await signIn("dubai", "dispatcher.dubai@fixit.example");
const sharjah = await signIn("sharjah", "dispatcher.sharjah@fixit.example");
const manager = await signIn("manager", "manager.dubai@fixit.example");
const accountant = await signIn("accountant", "accountant.dubai@fixit.example");
const customer = t.as("customer"); // never signs in
const customerAr = t.as("customer-ar"); // the language sticks to a browser, so Arabic has its own

// The seed has no technician: add one (the dispatcher's row with another id and the technician role).
{
  const db = new Database(t.dbFile);
  db.run("insert into auth__users (id, email, display_name, password_hash, email_verified_at, created_at, updated_at) select 'u_dxb_tech', 'tech.dubai@fixit.example', 'Tariq Technician', password_hash, email_verified_at, created_at, updated_at from auth__users where id = 'u_dxb_dispatcher'");
  db.run("insert into org__members (org_id, user_id, role, created_at) values ('org_dubai', 'u_dxb_tech', 'member', 1793000000)");
  db.run("insert into renox__role_assignments (user_id, role, scope_type, scope_id, granted_by, at) values ('u_dxb_tech', 'technician', 'global', '', 'test', 1793000000000)");
  db.close();
}
const technician = await signIn("technician", "tech.dubai@fixit.example");

const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);
const csrf = (u: typeof dubai) => u.cookie("__Host-renox_csrf") ?? "";

const ac = rows("select id from app__services where code = 'AC-SERVICE'")[0]?.id as number;
const SITE = "st_dxb_02a"; // Peter Nowak, villa
const EXPIRED_TOKEN = "demo-q000006-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SENT_TOKEN = "demo-q000003-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const APPROVED_TOKEN = "demo-q000004-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

/** The form's fields for a free-text or catalogue line at row `i`. */
const line = (i: number, f: Record<string, string>) => Object.fromEntries(Object.entries(f).map(([k, v]) => [`${k}_${i}`, v]));

describe("the arithmetic is in fils, half up per line", () => {
  test("edge case: 3 x AED 150 at 5 % is 45000 + 2250 = 47250", () => {
    expect(lineTotal(3, 15000, 5)).toEqual({ net_fils: 45000, vat_fils: 2250, total_fils: 47250 });
    expect(totals([{ qty: 3, unit_price_fils: 15000, vat_rate: 5 }])).toEqual({ subtotal_fils: 45000, vat_fils: 2250, total_fils: 47250 });
  });

  test("VAT is rounded half up on each line, and the totals are the sums of the lines", () => {
    // 0.10 AED x 1 at 5 % is 0.5 fils of VAT: rounds up to 1.
    expect(lineTotal(1, 10, 5).vat_fils).toBe(1);
    expect(lineTotal(1, 9, 5).vat_fils).toBe(0);
    // 1.5 hours at AED 120.01: net 18001.5 fils rounds up to 18002.
    expect(lineTotal(1.5, 12001, 5).net_fils).toBe(18002);
    const sum = totals([
      { qty: 1, unit_price_fils: 10, vat_rate: 5 },
      { qty: 1, unit_price_fils: 10, vat_rate: 5 },
    ]);
    expect(sum).toEqual({ subtotal_fils: 20, vat_fils: 2, total_fils: 22 });
  });
});

describe("the quotation list is the branch's own", () => {
  test("a Dubai dispatcher sees the six seeded quotations, one per state", async () => {
    const res = await dubai.page("/quotes");
    expect(res.status).toBe(200);
    for (const n of ["Q-000001", "Q-000002", "Q-000003", "Q-000004", "Q-000005", "Q-000006"]) expect(res.html).toContain(n);
    for (const s of ["Draft", "Sent", "Approved", "Rejected", "Expired"]) expect(res.html).toContain(s);
    snapshot(res.html, { role: "quotes, dispatcher, en" });
  });

  test("a status filter narrows the list", async () => {
    const res = await dubai.page("/quotes?status=sent");
    expect(res.html).toContain("Q-000002");
    expect(res.html).toContain("Q-000003");
    expect(res.html).not.toContain("Q-000001");
  });

  test("the Sharjah dispatcher sees none of them, and cannot open one", async () => {
    const res = await sharjah.page("/quotes");
    expect(res.status).toBe(200);
    expect(res.html).not.toContain("Q-000001");
    expect(res.html).toContain("No quotations found.");
    expect((await sharjah.page("/quotes/qt_seed_01")).status).toBe(404);
    expect((await sharjah.page("/quotes/qt_seed_01/pdf")).status).toBe(404);
  });

  test("the list in Arabic, right to left", async () => {
    const res = await manager.page("/quotes?lang=ar");
    expect(res.html).toContain('<html lang="ar" dir="rtl"');
    expect(res.html).toContain("عروض الأسعار");
    snapshot(res.html, { role: "quotes, branch manager, ar" });
  });

  test("the seeded quotation's page: lines, totals, PDF links", async () => {
    const res = await dubai.page("/quotes/qt_seed_02");
    expect(res.status).toBe(200);
    expect(res.html).toContain("Deep cleaning");
    expect(res.html).toContain("Pest control");
    expect(res.html).toContain("/quotes/qt_seed_02/pdf?lang=ar");
    snapshot(res.html, { role: "quote, dispatcher, en" });
  });
});

describe("a dispatcher creates, sends and the customer approves", () => {
  let id = "";
  let linkPath = "";

  test("normal case: two lines, the totals are the sum of the lines with 5 % VAT", async () => {
    const res = await dubai.action("/quotes/new", "create", {
      site_id: SITE,
      valid_days: "14",
      notes: "Call before arriving.",
      ...line(0, { service: String(ac), qty: "2" }),
      ...line(1, { desc: "Custom bracket", desc_ar: "حامل مخصص", qty: "1", price: "80" }),
    });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/quotes\/qt_[0-9a-f]{16}$/u);
    id = location.slice("/quotes/".length);
    expect(rows("select branch_id, customer_id, site_id, number, status, created_by from app__quotes where id = ?", [id])).toEqual([
      { branch_id: "br_dubai", customer_id: "cu_dxb_02", site_id: SITE, number: "Q-000007", status: "draft", created_by: "u_dxb_dispatcher" },
    ]);
    // 2 x 150.00 = 300.00 + 15.00 VAT; 1 x 80.00 + 4.00 VAT.
    expect(rows("select subtotal_fils, vat_fils, total_fils from app__quotes where id = ?", [id])).toEqual([{ subtotal_fils: 38000, vat_fils: 1900, total_fils: 39900 }]);
    expect(rows("select service_id, description_en, description_ar, qty, unit_price_fils, vat_rate, line_total_fils, branch_id from app__quote_lines where quote_id = ? order by id", [id])).toEqual([
      { service_id: ac, description_en: "AC service", description_ar: "صيانة المكيف", qty: 2, unit_price_fils: 15000, vat_rate: 5, line_total_fils: 30000, branch_id: "br_dubai" },
      { service_id: null, description_en: "Custom bracket", description_ar: "حامل مخصص", qty: 1, unit_price_fils: 8000, vat_rate: 5, line_total_fils: 8000, branch_id: "br_dubai" },
    ]);
    const page = await dubai.page(location);
    expect(page.status).toBe(200);
    expect(page.html).toContain("Q-000007");
    expect(page.html).toContain("Custom bracket");
  });

  test("edge case: 3 x AED 150 stores 45000, 2250 and 47250", async () => {
    const res = await dubai.action("/quotes/new", "create", { site_id: SITE, ...line(0, { desc: "Wall unit", qty: "3", price: "150" }) });
    expect(res.status).toBe(303);
    const q = (res.headers.get("location") ?? "").slice("/quotes/".length);
    expect(rows("select subtotal_fils, vat_fils, total_fils from app__quotes where id = ?", [q])).toEqual([{ subtotal_fils: 45000, vat_fils: 2250, total_fils: 47250 }]);
  });

  test("sending moves it to sent and shows the link once; only its hash is stored", async () => {
    const res = await dubai.action(`/quotes/${id}`, "send", {});
    expect(res.status).toBe(200);
    const m = /\/l\/approve\/([A-Za-z0-9_-]{43})/u.exec(res.html);
    expect(m).not.toBeNull();
    const token = m?.[1] ?? "";
    linkPath = `/l/approve/${token}`;
    expect(rows("select status from app__quotes where id = ?", [id])).toEqual([{ status: "sent" }]);
    const stored = rows("select token_hash, kind, ref_id, used_at from app__links where ref_id = ?", [id]);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.kind).toBe("approve");
    expect(stored[0]?.used_at).toBeNull();
    expect(stored[0]?.token_hash).not.toBe(token);
    expect(stored[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows("select kind, customer_id from app__customer_messages where ref_id = ?", [id])).toEqual([{ kind: "quote_sent", customer_id: "cu_dxb_02" }]);
    // The page after a reload does not show the link again.
    expect((await dubai.page(`/quotes/${id}`)).html).not.toContain(token);
  });

  test("the customer opens the link without signing in and sees the quotation", async () => {
    const res = await customer.page(linkPath);
    expect(res.status).toBe(200);
    expect(res.html).toContain("Q-000007");
    expect(res.html).toContain("Custom bracket");
    expect(res.html).toContain("Approve");
    // Only the quotation the token names: no navigation into the staff pages, no other quotation.
    expect(res.html).not.toContain("Q-000002");
    expect(res.html).not.toContain('href="/quotes');
  });

  test("approving sets the status, the time and the dispatcher is notified in the app", async () => {
    const res = await customer.action(linkPath, "approve", {});
    expect(res.status).toBe(303);
    const q = rows("select status, approved_at, approved_ip from app__quotes where id = ?", [id])[0];
    expect(q?.status).toBe("approved");
    expect(typeof q?.approved_at).toBe("number");
    expect(rows("select used_at from app__links where ref_id = ?", [id])[0]?.used_at).not.toBeNull();
    const n = rows("select category, title, link from notifications__items where user_id = 'u_dxb_dispatcher' and title like '%Q-000007%approved%'");
    expect(n).toEqual([{ category: "quotes", title: "Quotation Q-000007 was approved by Peter Nowak", link: `/quotes/${id}` }]);
    expect(rows("select kind from app__customer_messages where ref_id = ? order by id", [id]).map((r) => r.kind)).toEqual(["quote_sent", "quote_approved"]);
    // Nobody else was told.
    expect(rows("select count(*) as n from notifications__items where user_id = 'u_shj_dispatcher' and category = 'quotes'")).toEqual([{ n: 0 }]);
  });

  test("a second visit shows it is already approved", async () => {
    const res = await customer.page(linkPath);
    expect(res.status).toBe(200);
    expect(res.html).toContain('id="state-approved"');
    expect(res.html).toContain("already approved");
    expect(res.html).not.toContain('id="answer"');
  });

  test("error case: the used link answers 409 and changes nothing", async () => {
    const res = await customer.action(linkPath, "reject", {});
    expect(res.status).toBe(409);
    expect(res.html).toContain("already answered");
    expect(rows("select status from app__quotes where id = ?", [id])).toEqual([{ status: "approved" }]);
  });

  test("the dispatcher's page shows approved, with the time", async () => {
    const res = await dubai.page(`/quotes/${id}`);
    expect(res.html).toContain("Approved");
    expect(res.html).not.toContain('name="request"');
  });
});

describe("the customer's link", () => {
  test("error case: a tampered or unknown token is a 404, on the page and on the action", async () => {
    const tampered = `${SENT_TOKEN.slice(0, -1)}y`;
    expect((await customer.page(`/l/approve/${tampered}`)).status).toBe(404);
    expect((await customer.action(`/l/approve/${tampered}`, "approve", {})).status).toBe(404);
    expect((await customer.page("/l/approve/short")).status).toBe(404);
    expect((await customer.page(`/l/approve/${"a".repeat(43)}`)).status).toBe(404);
    expect(rows("select status from app__quotes where id = 'qt_seed_03'")).toEqual([{ status: "sent" }]);
  });

  test("an expired link shows 'expired' and cannot approve", async () => {
    const page = await customer.page(`/l/approve/${EXPIRED_TOKEN}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('id="state-expired"');
    expect(page.html).not.toContain('id="answer"');
    const res = await customer.action(`/l/approve/${EXPIRED_TOKEN}`, "approve", {});
    expect(res.status).toBe(410);
    expect(rows("select status from app__quotes where id = 'qt_seed_06'")).toEqual([{ status: "expired" }]);
  });

  test("a link whose quotation date has passed expires the quotation on the next read", async () => {
    const db = new Database(t.dbFile);
    db.run("update app__quotes set valid_until = 1700000000 where id = 'qt_seed_05'");
    db.run("update app__quotes set status = 'sent', approved_at = null where id = 'qt_seed_05'");
    db.close();
    expect((await dubai.page("/quotes?status=expired")).html).toContain("Q-000005");
    expect(rows("select status from app__quotes where id = 'qt_seed_05'")).toEqual([{ status: "expired" }]);
  });

  test("the seeded approved quotation's link is used: its page says approved, in Arabic too", async () => {
    const en = await customer.page(`/l/approve/${APPROVED_TOKEN}`);
    expect(en.html).toContain('id="state-approved"');
    snapshot(en.html, { role: "approve link, used, en" });
    const ar = await customerAr.page(`/l/approve/${APPROVED_TOKEN}?lang=ar`);
    expect(ar.html).toContain('<html lang="ar" dir="rtl"');
    expect(ar.html).toContain("تمت الموافقة");
  });

  test("the customer can reject, once, and the dispatcher is told", async () => {
    const page = await customer.page(`/l/approve/${SENT_TOKEN}`);
    expect(page.html).toContain("Reject");
    snapshot(page.html, { role: "approve link, open, en" });
    const res = await customer.action(`/l/approve/${SENT_TOKEN}`, "reject", {});
    expect(res.status).toBe(303);
    expect(rows("select status from app__quotes where id = 'qt_seed_03'")).toEqual([{ status: "rejected" }]);
    expect(rows("select title from notifications__items where title like '%Q-000003%rejected%'")).toHaveLength(1);
    expect((await customer.action(`/l/approve/${SENT_TOKEN}`, "approve", {})).status).toBe(409);
  });

  test("a link of one kind is no other kind's: a sent quotation's link cannot be forged from its id", async () => {
    expect((await customer.page("/l/approve/qt_seed_02")).status).toBe(404);
  });
});

describe("the PDF", () => {
  test("renders in English and in Arabic, application/pdf starting with %PDF", async () => {
    for (const lang of ["en", "ar"]) {
      const res = await dubai.page(`/quotes/qt_seed_02/pdf?lang=${lang}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.html.startsWith("%PDF")).toBe(true);
    }
  });

  test("without ?lang it is in the customer's language, and a bad quotation id is a 404", async () => {
    expect((await dubai.page("/quotes/qt_seed_04/pdf")).headers.get("content-disposition")).toContain("Q-000004-ar.pdf");
    expect((await dubai.page("/quotes/nope/pdf")).status).toBe(404);
  });

  test("the PDF needs quote.read", async () => {
    expect((await technician.page("/quotes/qt_seed_02/pdf")).status).toBe(403);
    expect((await t.as("nobody").page("/quotes/qt_seed_02/pdf")).status).toBe(403);
  });
});

describe("invalid input and the branch fence", () => {
  const post = (u: typeof dubai, extra: Record<string, string>) => u.action("/quotes/new", "create", { site_id: SITE, ...line(0, { service: String(ac), qty: "1" }), ...extra });
  const count = () => rows("select count(*) as n from app__quotes")[0]?.n;

  test("error case: no lines is a 422 naming lines", async () => {
    const n = count();
    const res = await dubai.action("/quotes/new", "create", { site_id: SITE });
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-lines"');
    expect(count()).toBe(n);
  });

  test("a free-text line needs a price, a bad quantity and a bad price are named by line", async () => {
    const res = await dubai.action("/quotes/new", "create", { site_id: SITE, ...line(0, { desc: "Thing" }), ...line(1, { desc: "Other", price: "12.345", qty: "0" }) });
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-price_0"');
    expect(res.html).toContain('id="err-price_1"');
    expect(res.html).toContain('id="err-qty_1"');
    expect(res.html).toContain("line 2");
  });

  test("an unknown service and a bad validity are refused", async () => {
    const unknown = await post(dubai, { service_0: "9999" });
    expect(unknown.status).toBe(422);
    expect(unknown.html).toContain('id="err-service_0"');
    const days = await post(dubai, { valid_days: "0" });
    expect(days.status).toBe(422);
    expect(days.html).toContain('id="err-valid_days"');
  });

  test("the refusal is in Arabic when the page is", async () => {
    await manager.page("/quotes/new?lang=ar");
    const res = await manager.request("POST", "/quotes/new?/create", {
      headers: { "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": csrf(manager) },
      body: new URLSearchParams({ site_id: SITE }).toString(),
    });
    expect(res.status).toBe(422);
    expect(res.html).toContain("أضف بنداً واحداً على الأقل.");
  });

  test("a site of another branch is refused; the other branch's own works and is invisible to Dubai", async () => {
    const n = count();
    const res = await dubai.action("/quotes/new", "create", { site_id: "st_shj_01a", ...line(0, { service: String(ac) }) });
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-site_id"');
    expect(count()).toBe(n);
    const ok = await sharjah.action("/quotes/new", "create", { site_id: "st_shj_01a", ...line(0, { service: String(ac), qty: "1" }) });
    expect(ok.status).toBe(303);
    const sid = (ok.headers.get("location") ?? "").slice("/quotes/".length);
    expect(rows("select branch_id, customer_id from app__quotes where id = ?", [sid])).toEqual([{ branch_id: "br_sharjah", customer_id: "cu_shj_01" }]);
    expect((await dubai.page(`/quotes/${sid}`)).status).toBe(404);
    expect((await dubai.action(`/quotes/${sid}`, "send", {})).status).toBe(404);
    expect((await dubai.page("/quotes")).html).not.toContain(sid);
    expect((await sharjah.page(`/quotes/${sid}`)).status).toBe(200);
  });

  test("a sent quotation is not sent twice as a draft: sending again only issues a new link", async () => {
    const before = rows("select count(*) as n from app__links where ref_id = 'qt_seed_02'")[0]?.n as number;
    const res = await dubai.action("/quotes/qt_seed_02", "send", {});
    expect(res.status).toBe(200);
    expect(rows("select status from app__quotes where id = 'qt_seed_02'")).toEqual([{ status: "sent" }]);
    expect(rows("select count(*) as n from app__links where ref_id = 'qt_seed_02'")[0]?.n).toBe(before + 1);
    // An approved one cannot be sent.
    expect((await dubai.action("/quotes/qt_seed_04", "send", {})).status).toBe(409);
  });
});

describe("who may use quotations", () => {
  test("error case: a technician opening /quotes gets 403, and so does a signed-out visitor", async () => {
    expect((await technician.page("/quotes")).status).toBe(403);
    expect((await technician.page("/quotes/new")).status).toBe(403);
    expect((await technician.page("/quotes/qt_seed_02")).status).toBe(403);
    expect((await t.as("anonymous").page("/quotes")).status).toBe(403);
  });

  test("an accountant has no quote.read either", async () => {
    expect((await accountant.page("/quotes")).status).toBe(403);
    expect((await accountant.action("/quotes/qt_seed_01", "send", {})).status).toBe(403);
  });

  test("the technician cannot create or send, and nothing changed", async () => {
    expect((await technician.action("/quotes/new", "create", { site_id: SITE, ...line(0, { service: String(ac) }) })).status).toBe(403);
    expect((await technician.action("/quotes/qt_seed_01", "send", {})).status).toBe(403);
    expect(rows("select status from app__quotes where id = 'qt_seed_01'")).toEqual([{ status: "draft" }]);
  });

  test("the new-quotation page for a dispatcher", async () => {
    const res = await dubai.page("/quotes/new");
    expect(res.status).toBe(200);
    expect(res.html).toContain("AC service");
    expect(res.html).toContain('name="request"');
    snapshot(res.html, { role: "quote form, dispatcher, en" });
  });
});

describe("the AI draft is off without a provider, and the form still works", () => {
  test("the page says AI off and keeps what was typed", async () => {
    const res = await dubai.action("/quotes/new", "draft", { site_id: SITE, request: "Two AC services please", notes: "keep me" });
    expect(res.status).toBe(200);
    expect(res.html).toContain('id="ai-off"');
    expect(res.html).toContain("AI is off");
    expect(res.html).toContain("Two AC services please");
    expect(res.html).toContain("keep me");
  });

  test("the function answers { lines: [], ai: 'off' }", async () => {
    await dubai.page("/quotes/new");
    const res = await dubai.request("POST", "/api/quotes/draft", { headers: { "x-renox-csrf": csrf(dubai) }, body: { request: "two AC services" } });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ lines: [], ai: "off" });
  });

  test("the function refuses a body that is not a request, and a technician", async () => {
    const bad = await dubai.request("POST", "/api/quotes/draft", { headers: { "x-renox-csrf": csrf(dubai) }, body: { request: "" } });
    expect(bad.status).toBe(400);
    const denied = await technician.request("POST", "/api/quotes/draft", { headers: { "x-renox-csrf": csrf(technician) }, body: { request: "x" } });
    expect(denied.status).toBe(403);
  });
});

describe("the draft with a provider (the SDK's fake)", () => {
  const catalogue: ServiceRow[] = [
    { id: 1, code: "AC-SERVICE", name_en: "AC service", name_ar: "صيانة المكيف", unit: "unit", price_fils: 15000, vat_rate: 5 },
    { id: 3, code: "DEEP-CLEAN", name_en: "Deep cleaning", name_ar: "تنظيف شامل", unit: "visit", price_fils: 45000, vat_rate: 5 },
  ];

  test("returns catalogue lines, and the prompt lists the catalogue", async () => {
    const ai = fakeAi([{ text: 'Here you go: {"lines":[{"code":"AC-SERVICE","qty":2},{"code":"DEEP-CLEAN","qty":1}]}' }]);
    const r = await draftLines(ai, catalogue, "two AC services and a deep clean");
    expect(r).toEqual({
      ai: "on",
      lines: [
        { code: "AC-SERVICE", service_id: 1, qty: 2 },
        { code: "DEEP-CLEAN", service_id: 3, qty: 1 },
      ],
    });
    const system = ai.requests[0]?.system ?? "";
    expect(system).toContain("AC-SERVICE | AC service | per unit | AED 150.00");
    expect(system).toContain("DEEP-CLEAN");
  });

  test("a code that is not in the catalogue, a bad quantity and text that is not JSON are dropped", async () => {
    expect(parseDraft('{"lines":[{"code":"ROCKET","qty":1},{"code":"AC-SERVICE","qty":-1},{"code":"AC-SERVICE","qty":"2"},{"code":"AC-SERVICE","qty":1.234}]}', catalogue)).toEqual([{ code: "AC-SERVICE", service_id: 1, qty: 1.23 }]);
    expect(parseDraft("I cannot help with that.", catalogue)).toEqual([]);
    expect(parseDraft('{"lines": "no"}', catalogue)).toEqual([]);
    expect(parseDraft("{ not json }", catalogue)).toEqual([]);
  });

  test("an unavailable provider is 'off', an used-up allowance is 'quota', another error is thrown", async () => {
    const failing = (code: string) => ({
      chat: async () => {
        throw Object.assign(new Error("x"), { code });
      },
    });
    expect(await draftLines(failing("RENOX_AI_UNAVAILABLE"), catalogue, "x")).toEqual({ lines: [], ai: "off" });
    expect(await draftLines(failing("RENOX_AI_QUOTA"), catalogue, "x")).toEqual({ lines: [], ai: "quota" });
    expect(draftLines(failing("RENOX_OTHER"), catalogue, "x")).rejects.toThrow("x");
    // An empty request never calls the provider.
    expect(await draftLines(fakeAi([]), catalogue, "   ")).toEqual({ lines: [], ai: "on" });
  });
});
