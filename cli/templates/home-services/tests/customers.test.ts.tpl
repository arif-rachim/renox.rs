// Customers, sites and the service catalogue (#556): a dispatcher works in
// one branch and never sees another's customers; the forms refuse what the
// gcc module's validators refuse, naming the field; the catalogue is edited
// only through a sensitive action (owner, second factor).
// Runs on the local worker with the seed's users (password below).
import { describe, expect, test } from "bun:test";
import { totp } from "@renoxium/sdk";
import { app, snapshot } from "@renoxium/sdk/test";

const t = await app();
const PASSWORD = "correct horse battery";

/** A signed-in browser: its own cookie jar, the seed's user. */
async function signIn(jar: string, email: string, next = "/customers") {
  const u = t.as(jar);
  const res = await u.action("/auth/login", "default", { email, password: PASSWORD, next });
  expect(res.status).toBe(303);
  return u;
}

const dubai = await signIn("dubai", "dispatcher.dubai@fixit.example");
const sharjah = await signIn("sharjah", "dispatcher.sharjah@fixit.example");
// A page asked for with ?lang=ar keeps that language for the user (not the browser), so Arabic has its own user.
const dubaiAr = await signIn("dubai-ar", "manager.dubai@fixit.example");

const CUSTOMER = { kind: "household", name: "Yusuf Rahman", phone: "+971 50 777 1234", email: "yusuf@example.com", language: "en", trn: "" };
const SITE = { label: "Flat", emirate: "AE-DU", area: "Al Quoz", address: "Al Quoz 3, building 12, flat 5", makani: "3055566677", lat: "25.14", lng: "55.23", access_notes: "Call on arrival." };

const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);

describe("the customer list is the branch's own", () => {
  test("a Dubai dispatcher sees Dubai customers only", async () => {
    const res = await dubai.page("/customers");
    expect(res.status).toBe(200);
    expect(res.html).toContain("Layla Haddad");
    expect(res.html).toContain("Marina Heights Property Management");
    expect(res.html).not.toContain("Khalid Mansoor");
    expect(res.html).not.toContain("Nahda Towers Management");
    snapshot(res.html, { role: "customers, dispatcher, en" });
  });

  test("the Sharjah dispatcher's list does not contain Dubai customers", async () => {
    const res = await sharjah.page("/customers");
    expect(res.status).toBe(200);
    expect(res.html).toContain("Khalid Mansoor");
    expect(res.html).not.toContain("Layla Haddad");
    expect(res.html).not.toContain("Marina Heights");
    // Not even by searching for one.
    const search = await sharjah.page("/customers?q=Layla");
    expect(search.html).not.toContain("Layla Haddad");
  });

  test("the list in Arabic, right to left", async () => {
    const res = await dubaiAr.page("/customers?lang=ar");
    expect(res.status).toBe(200);
    expect(res.html).toContain('<html lang="ar" dir="rtl"');
    expect(res.html).toContain("العملاء");
    snapshot(res.html, { role: "customers, branch manager, ar" });
  });

  test("search by name or by phone as typed (050… or +971…)", async () => {
    expect((await dubai.page("/customers?q=peter")).html).toContain("Peter Nowak");
    const byPhone = await dubai.page("/customers?q=052 111 0002");
    expect(byPhone.html).toContain("Peter Nowak");
    expect(byPhone.html).not.toContain("Layla Haddad");
    expect((await dubai.page("/customers?q=%2B971521110002")).html).toContain("Peter Nowak");
    // A literal %: no wildcard.
    expect((await dubai.page("/customers?q=%25")).html).not.toContain("Peter Nowak");
  });

  test("the search box's fragment is the table only", async () => {
    const res = await dubai.request("GET", "/customers?q=layla", { headers: { "hx-request": "true", "hx-target": "customer-list" } });
    expect(res.status).toBe(200);
    expect(res.html).toStartWith('<table id="customer-list"');
    expect(res.html).toContain("Layla Haddad");
  });
});

describe("a customer and a site are created in the dispatcher's branch", () => {
  let id = "";

  test("normal case: 303 to the customer, the rows carry the branch", async () => {
    const res = await dubai.action("/customers/new", "create", { ...CUSTOMER, ...SITE });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/customers\/cu_[0-9a-f]{16}$/u);
    id = location.slice("/customers/".length);
    expect(rows("select branch_id, name, kind, language from app__customers where id = ?", [id])).toEqual([{ branch_id: "br_dubai", name: "Yusuf Rahman", kind: "household", language: "en" }]);
    expect(rows("select branch_id, makani, emirate from app__sites where customer_id = ?", [id])).toEqual([{ branch_id: "br_dubai", makani: "3055566677", emirate: "AE-DU" }]);
  });

  test("edge case: the phone is stored normalised, 0501234567 becomes +971501234567", async () => {
    const res = await dubai.action("/customers/new", "create", { ...CUSTOMER, name: "Zaid Local", phone: "0501234567", ...SITE, makani: "" });
    expect(res.status).toBe(303);
    expect(rows("select phone from app__customers where name = 'Zaid Local'")).toEqual([{ phone: "+971501234567" }]);
    expect(rows("select makani from app__sites where customer_id = ?", [(res.headers.get("location") ?? "").slice("/customers/".length)])).toEqual([{ makani: null }]);
  });

  test("the new customer is in the Dubai list and not in the Sharjah one", async () => {
    expect((await dubai.page("/customers")).html).toContain("Yusuf Rahman");
    expect((await sharjah.page("/customers")).html).not.toContain("Yusuf Rahman");
  });

  test("a company is created with its TRN, stored as the digits", async () => {
    const res = await dubai.action("/customers/new", "create", { ...CUSTOMER, kind: "company", name: "Creek Estates", trn: "100123456780045", phone: "+97145551234", ...SITE });
    expect(res.status).toBe(303);
    expect(rows("select kind, trn, phone from app__customers where name = 'Creek Estates'")).toEqual([{ kind: "company", trn: "100123456780045", phone: "+97145551234" }]);
  });

  test("the customer page shows the sites; a site is added", async () => {
    const page = await dubai.page(`/customers/${id}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain("Al Quoz 3, building 12, flat 5");
    const added = await dubai.action(`/customers/${id}`, "addSite", { ...SITE, label: "Garage", address: "Al Quoz 3, garage 2", makani: "" });
    expect(added.status).toBe(303);
    expect(rows("select label, branch_id from app__sites where customer_id = ? order by label", [id])).toEqual([
      { label: "Flat", branch_id: "br_dubai" },
      { label: "Garage", branch_id: "br_dubai" },
    ]);
  });

  test("the customer page, a seeded customer with two sites, in English and Arabic", async () => {
    const en = await dubai.page("/customers/cu_dxb_04");
    expect(en.status).toBe(200);
    expect(en.html).toContain("Tower A");
    expect(en.html).toContain("Tower B");
    snapshot(en.html, { role: "customer, dispatcher, en" });
    const ar = await dubaiAr.page("/customers/cu_dxb_04?lang=ar");
    expect(ar.html).toContain('<html lang="ar" dir="rtl"');
    snapshot(ar.html, { role: "customer, branch manager, ar" });
  });
});

describe("invalid input is refused with the field named", () => {
  const post = (extra: Record<string, string>) => dubai.action("/customers/new", "create", { ...CUSTOMER, ...SITE, ...extra });
  const before = () => rows("select count(*) as n from app__customers")[0]?.n;

  test("error case: trn 123 is 422 and names trn", async () => {
    const n = before();
    const res = await post({ kind: "company", name: "Bad TRN LLC", trn: "123" });
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-trn"');
    expect(res.html).toContain("A TRN has 15 digits.");
    expect(res.html).not.toContain('id="err-phone"');
    expect(before()).toBe(n);
  });

  test("a company without a TRN is refused", async () => {
    const res = await post({ kind: "company", name: "No TRN LLC", trn: "" });
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-trn"');
  });

  test("a phone that is not a UAE number is refused", async () => {
    const res = await post({ phone: "+44 7700 900123" });
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-phone"');
    expect(res.html).not.toContain('id="err-trn"');
  });

  test("a Makani number, an emirate and the coordinates are checked", async () => {
    const res = await post({ makani: "12345", emirate: "AE-XX", lat: "95", lng: "abc" });
    expect(res.status).toBe(422);
    for (const field of ["makani", "emirate", "lat", "lng"]) expect(res.html).toContain(`id="err-${field}"`);
  });

  test("the refusal is in Arabic when the page is", async () => {
    await dubaiAr.page("/customers/new?lang=ar");
    const res = await dubaiAr.request("POST", "/customers/new?/create", {
      headers: { "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": dubaiAr.cookie("__Host-renox_csrf") ?? "" },
      body: new URLSearchParams({ ...CUSTOMER, ...SITE, trn: "123", kind: "company" }).toString(),
    });
    expect(res.status).toBe(422);
    expect(res.html).toContain("الرقم الضريبي مكوّن من 15 رقماً.");
  });

  test("a site with a bad Makani number is refused and nothing is stored", async () => {
    const n = rows("select count(*) as n from app__sites")[0]?.n;
    const res = await dubai.action("/customers/cu_dxb_01", "addSite", { ...SITE, makani: "abc" });
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-makani"');
    expect(rows("select count(*) as n from app__sites")[0]?.n).toBe(n);
  });
});

describe("another branch's customer does not exist", () => {
  test("error case: the Sharjah dispatcher opening a Dubai customer id gets 404", async () => {
    expect((await sharjah.page("/customers/cu_dxb_01")).status).toBe(404);
    expect((await sharjah.page("/customers/cu_shj_01")).status).toBe(200);
  });

  test("and cannot add a site to it", async () => {
    const n = rows("select count(*) as n from app__sites")[0]?.n;
    expect((await sharjah.action("/customers/cu_shj_01", "addSite", SITE)).status).toBe(303);
    const res = await sharjah.request("POST", "/customers/cu_dxb_01?/addSite", {
      headers: { "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": sharjah.cookie("__Host-renox_csrf") ?? "" },
      body: new URLSearchParams(SITE).toString(),
    });
    expect(res.status).toBe(404);
    expect(rows("select count(*) as n from app__sites where customer_id = 'cu_dxb_01'")[0]?.n).toBe(1);
    expect(rows("select count(*) as n from app__sites")[0]?.n).toBe((n as number) + 1);
  });

  test("an id that is no id is a 404 too", async () => {
    expect((await dubai.page("/customers/%27%20or%201=1")).status).toBe(404);
  });

  test("signed out: the guard refuses the list", async () => {
    expect((await t.as("anonymous").page("/customers")).status).toBe(403);
  });
});

describe("read-only roles", () => {
  test("an accountant reads customers but has no way to create one", async () => {
    const accountant = await signIn("accountant", "accountant.dubai@fixit.example");
    const list = await accountant.page("/customers");
    expect(list.status).toBe(200);
    expect(list.html).toContain("Layla Haddad");
    expect(list.html).not.toContain('href="/customers/new"');
    expect((await accountant.page("/customers/new")).status).toBe(403);
    const page = await accountant.page("/customers/cu_dxb_01");
    expect(page.status).toBe(200);
    expect(page.html).not.toContain('name="label"');
    expect((await accountant.action("/customers/cu_dxb_01", "addSite", SITE)).status).toBe(403);
  });
});

describe("the service catalogue", () => {
  test("a dispatcher reads the eight services, in English and Arabic, and has no edit form", async () => {
    const en = await dubai.page("/services");
    expect(en.status).toBe(200);
    for (const name of ["AC service", "Deep cleaning", "Pest control", "AMC visit"]) expect(en.html).toContain(name);
    expect(en.html).not.toContain('name="price"');
    snapshot(en.html, { role: "services, dispatcher, en" });
    const ar = await dubaiAr.page("/services?lang=ar");
    expect(ar.html).toContain("قائمة الخدمات");
    snapshot(ar.html, { role: "services, branch manager, ar" });
  });

  test("a dispatcher's edit is denied", async () => {
    const res = await dubai.action("/services", "save", { service: "1", price: "1", active: "1" });
    expect(res.status).toBe(403);
    expect(rows("select price_fils from app__services where id = 1")).toEqual([{ price_fils: 15000 }]);
  });

  test("the owner is denied without the second factor, and edits with it", async () => {
    const owner = await signIn("owner", "owner@fixit.example", "/services");
    expect((await owner.page("/services")).html).not.toContain('name="price"');
    expect((await owner.action("/services", "save", { service: "1", price: "160", active: "1" })).status).toBe(403);
    expect(rows("select price_fils from app__services where id = 1")).toEqual([{ price_fils: 15000 }]);

    const enrol = await owner.page("/2fa/enroll/totp");
    const secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(enrol.html)?.[1] ?? "").replace(/ /gu, "");
    expect((await owner.action("/2fa/enroll/totp", "confirm", { code: await totp(secret) })).status).toBe(200);
    const halted = await t.as("owner-2").action("/auth/login", "default", { email: "owner@fixit.example", password: PASSWORD, next: "/services" });
    expect(halted.headers.get("location")).toBe("/2fa/verify?next=%2Fservices");
    const verified = await t.as("owner-2").action("/2fa/verify", "totp", { code: await totp(secret, Date.now() / 1000 + 30), next: "/services" });
    expect(verified.status).toBe(303);

    const page = await t.as("owner-2").page("/services");
    expect(page.html).toContain('name="price"');
    const ok = await t.as("owner-2").action("/services", "save", { service: "1", price: "160.50", active: "1" });
    expect(ok.status).toBe(200);
    expect(ok.html).toContain("Saved AC-SERVICE.");
    expect(rows("select price_fils, active from app__services where id = 1")).toEqual([{ price_fils: 16050, active: 1 }]);
    // Off: the checkbox left unticked.
    expect((await t.as("owner-2").action("/services", "save", { service: "2", price: "180" })).status).toBe(200);
    expect(rows("select active from app__services where id = 2")).toEqual([{ active: 0 }]);
    // A bad price is a 422 and changes nothing.
    expect((await t.as("owner-2").action("/services", "save", { service: "3", price: "free" })).status).toBe(422);
    expect(rows("select price_fils from app__services where id = 3")).toEqual([{ price_fils: 45000 }]);
  });
});
