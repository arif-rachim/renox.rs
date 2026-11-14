// Parts and suppliers (#812, wave D): /admin/parts and /admin/suppliers. The owner (and a branch manager) adds, edits
// and deactivates a part and a supplier, each with an audit row; a SKU is stored upper-case and is unique (a duplicate
// is a 422 that names the part holding it); an invalid form is a 422 naming the fields; the search and the 25 to a page;
// a dispatcher, an accountant and a technician see only what their role reads, with no form, and are refused on a post.
// Runs on the local worker with the seed's users (password below).
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { app, snapshot } from "@renoxium/sdk/test";

setDefaultTimeout(60_000);
const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string, next = "/") {
  const u = t.as(jar);
  expect((await u.action("/auth/login", "default", { email, password: PASSWORD, next })).status).toBe(303);
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
const located = (res: { headers: Headers }) => res.headers.get("location") ?? "";
const part = (sku: string) => rows("select * from app__parts where sku = ?", [sku])[0];
const audited = (action: string, id: string) => Number(rows("select count(*) as n from audit__events where action = ? and resource_id = ?", [action, id])[0]?.n);

const owner = await signIn("owner", "owner@fixit.example", "/admin/parts");
const manager = await signIn("manager", "manager.dubai@fixit.example");
const dispatcher = await signIn("dispatcher", "dispatcher.dubai@fixit.example");
const accountant = await signIn("accountant", "accountant.dubai@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example", "/me");

const FILTER = { sku: "ac-filter-01", name_en: "AC filter", name_ar: "فلتر مكيف", unit: "piece", cost: "12.50", sell: "20", vat_rate: "5", min_stock: "2.5" };
const SUPPLIER = { name: "Gulf Cooling Supplies", trn: "100123456700003", phone: "+971 4 411 0099", email: "sales@gulfcooling.example", address: "Al Quoz, Dubai", notes: "Net 30" };

// Fixed rows for the snapshots, planted before anything else adds one.
rw((db) => {
  db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values ('pt_00000000000000a1', 'PIPE-15', 'Copper pipe 15 mm', 'أنبوب نحاسي 15 مم', 'metre', 850, 1400, 5, 20, 1, 1700000000)");
  db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values ('pt_00000000000000a2', 'GAS-R32', 'R32 refrigerant', 'غاز التبريد R32', 'kg', 4500, 0, 0, 3.5, 0, 1700000001)");
  db.run("insert into app__suppliers (id, name, trn, phone, email, address, notes, active, created_at) values ('su_00000000000000a1', 'Al Noor Trading', '100123456700003', '+97144110088', 'orders@alnoor.example', 'Dubai', '', 1, 1700000000)");
  db.run("insert into app__suppliers (id, name, trn, phone, email, address, notes, active, created_at) values ('su_00000000000000a2', 'Old Pipes LLC', null, '', '', '', 'closed', 0, 1700000001)");
});

describe("the pages, as the owner sees them", () => {
  test("/admin/parts lists the parts with the add form, in English and in Arabic", async () => {
    const en = await owner.page("/admin/parts?lang=en");
    expect(en.status).toBe(200);
    expect(en.html).toContain('id="part-pt_00000000000000a1"');
    expect(en.html).toContain("Copper pipe 15 mm");
    expect(en.html).toContain('id="part-form"');
    snapshot(en.html, { role: "parts, owner, en" });
    const ar = await owner.page("/admin/parts?lang=ar");
    expect(ar.html).toContain("أنبوب نحاسي 15 مم");
    expect(ar.html).not.toContain("Copper pipe 15 mm");
    snapshot(ar.html, { role: "parts, owner, ar" });
  });

  test("/admin/suppliers lists the suppliers with the add form, in English and in Arabic", async () => {
    const en = await owner.page("/admin/suppliers?lang=en");
    expect(en.status).toBe(200);
    expect(en.html).toContain("Al Noor Trading");
    expect(en.html).toContain('id="supplier-form"');
    snapshot(en.html, { role: "suppliers, owner, en" });
    const ar = await owner.page("/admin/suppliers?lang=ar");
    expect(ar.status).toBe(200);
    snapshot(ar.html, { role: "suppliers, owner, ar" });
    // The choice of language is kept by the session: back to English for the rest of the file.
    expect((await owner.page("/admin/suppliers?lang=en")).html).toContain('dir="ltr"');
  });

  test("the back office's sidebar links both pages to the owner", async () => {
    const nav = /<nav class="renox-admin-sidebar"[\s\S]*?<\/nav>/u.exec((await owner.page("/admin")).html)?.[0] ?? "";
    expect(nav).toContain('id="nav-parts"');
    expect(nav).toContain('id="nav-suppliers"');
  });
});

describe("parts", () => {
  test("normal case: the owner adds a part; the SKU is stored upper-case; an audit row says who", async () => {
    const res = await owner.action("/admin/parts", "save", FILTER);
    expect(res.status).toBe(303);
    expect(located(res)).toBe("/admin/parts?saved=created");
    const row = part("AC-FILTER-01");
    expect(row).toMatchObject({ name_en: "AC filter", name_ar: "فلتر مكيف", unit: "piece", cost_fils: 1250, sell_fils: 2000, vat_rate: 5, min_stock: 2.5, active: 1 });
    expect(part("ac-filter-01")).toBeUndefined();
    expect(audited("part.create", String(row?.id))).toBe(1);
    const page = await owner.page("/admin/parts?saved=created");
    expect(page.html).toContain('id="saved"');
    expect(page.html).toContain("AC-FILTER-01");
  });

  test("error case: a duplicate SKU is a 422 naming the field and the part that holds it, in either language", async () => {
    const count = Number(rows("select count(*) as n from app__parts")[0]?.n);
    const res = await owner.action("/admin/parts", "save", { ...FILTER, sku: " Ac-Filter-01 ", name_en: "Another filter" });
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-sku"');
    expect(res.html).toContain("AC filter");
    expect(res.html).toContain("AC-FILTER-01");
    expect(Number(rows("select count(*) as n from app__parts")[0]?.n)).toBe(count);
    await owner.page("/admin/parts?lang=ar");
    const ar = await owner.action("/admin/parts", "save", { ...FILTER, sku: "AC-FILTER-01" });
    expect(ar.status).toBe(422);
    expect(ar.html).toContain("فلتر مكيف");
    await owner.page("/admin/parts?lang=en");
  });

  test("error case: a bad form is a 422 naming each field, and nothing is stored", async () => {
    const before = Number(rows("select count(*) as n from app__parts")[0]?.n);
    const res = await owner.action("/admin/parts", "save", { sku: "no spaces!", name_en: "", name_ar: "x".repeat(121), unit: "bucket", cost: "1.234", sell: "-3", vat_rate: "9", min_stock: "1.2345" });
    expect(res.status).toBe(422);
    for (const field of ["sku", "name_en", "name_ar", "unit", "cost", "sell", "vat_rate", "min_stock"]) expect([field, res.html.includes(`id="err-${field}"`)]).toEqual([field, true]);
    expect((await owner.action("/admin/parts", "save", { ...FILTER, sku: "A".repeat(33) })).status).toBe(422);
    expect((await owner.action("/admin/parts", "save", { ...FILTER, sku: "X1", min_stock: "-1" })).status).toBe(422);
    expect(Number(rows("select count(*) as n from app__parts")[0]?.n)).toBe(before);
    // The typed values come back in the form.
    expect(res.html).toContain('value="no spaces!"');
  });

  test("normal case: the owner edits a part (?edit= fills the form); keeping the SKU is fine; another part's SKU is not", async () => {
    const id = String(part("AC-FILTER-01")?.id);
    const form = await owner.page(`/admin/parts?edit=${id}`);
    expect(form.status).toBe(200);
    expect(form.html).toContain(`name="id" value="${id}"`);
    expect(form.html).toContain('value="AC-FILTER-01"');
    expect(form.html).toContain('value="12.50"');
    const saved = await owner.action("/admin/parts", "save", { ...FILTER, id, sku: "AC-FILTER-01", name_en: "AC filter, washable", sell: "22.75", min_stock: "4" });
    expect(saved.status).toBe(303);
    expect(located(saved)).toBe("/admin/parts?saved=updated");
    expect(part("AC-FILTER-01")).toMatchObject({ id, name_en: "AC filter, washable", sell_fils: 2275, min_stock: 4, cost_fils: 1250 });
    expect(audited("part.update", id)).toBe(1);
    const clash = await owner.action("/admin/parts", "save", { ...FILTER, id, sku: "pipe-15" });
    expect(clash.status).toBe(422);
    expect(clash.html).toContain("Copper pipe 15 mm");
    expect(part("AC-FILTER-01")?.id).toBe(id);
    // A form with an id that is not a part's is a 404, and a part's id that is gone too.
    expect((await owner.action("/admin/parts", "save", { ...FILTER, id: "pt_ffffffffffffffff", sku: "NEW-1" })).status).toBe(404);
    expect((await owner.action("/admin/parts", "save", { ...FILTER, id: "nope" })).status).toBe(404);
  });

  test("normal case: a part is deactivated and activated again, with an audit row each; its row stays", async () => {
    const id = String(part("AC-FILTER-01")?.id);
    const off = await owner.action("/admin/parts", "active", { id, active: "0" });
    expect(located(off)).toBe("/admin/parts?saved=deactivated");
    expect(part("AC-FILTER-01")?.active).toBe(0);
    expect(audited("part.deactivate", id)).toBe(1);
    expect((await owner.page("/admin/parts")).html).toContain(`id="active-${id}"`);
    const on = await owner.action("/admin/parts", "active", { id, active: "1" });
    expect(located(on)).toBe("/admin/parts?saved=activated");
    expect(part("AC-FILTER-01")?.active).toBe(1);
    expect(audited("part.activate", id)).toBe(1);
    expect((await owner.action("/admin/parts", "active", { id: "pt_ffffffffffffffff", active: "0" })).status).toBe(404);
  });

  test("normal case: ?q= matches the SKU and both names; 25 to a page", async () => {
    const find = async (q: string) => (await owner.page(`/admin/parts?q=${encodeURIComponent(q)}`)).html;
    const bySku = await find("pipe");
    expect(bySku).toContain("PIPE-15");
    expect(bySku).not.toContain("AC-FILTER-01");
    expect(await find("washable")).toContain("AC-FILTER-01");
    expect(await find("نحاسي")).toContain("PIPE-15");
    expect(await find("zzz-nothing")).toContain("No parts found.");
    // `%` is a plain character of the search.
    expect(await find("%")).toContain("No parts found.");
    rw((db) => {
      for (let i = 1; i <= 30; i++) db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values (?, ?, ?, ?, 'piece', 0, 0, 5, 0, 1, 1700000100)", [`pt_${String(i).padStart(16, "0")}`, `BULK-${String(i).padStart(2, "0")}`, `Bulk ${i}`, `كمية ${i}`]);
    });
    const first = await find("bulk");
    expect(first.match(/id="part-pt_/gu)?.length).toBe(25);
    expect(first).toContain("BULK-25");
    expect(first).not.toContain("BULK-26");
    expect(first).toContain('rel="next"');
    const second = (await owner.page("/admin/parts?q=bulk&page=2")).html;
    expect(second.match(/id="part-pt_/gu)?.length).toBe(5);
    expect(second).toContain("BULK-30");
    expect(second).toContain('rel="prev"');
    // A page past the last one shows the last.
    expect((await owner.page("/admin/parts?q=bulk&page=99")).html).toContain("BULK-30");
  });
});

describe("suppliers", () => {
  test("normal case: the owner adds, edits and deactivates a supplier, each with an audit row", async () => {
    const made = await owner.action("/admin/suppliers", "save", SUPPLIER);
    expect(made.status).toBe(303);
    expect(located(made)).toBe("/admin/suppliers?saved=created");
    const row = rows("select * from app__suppliers where name = ?", [SUPPLIER.name])[0];
    const id = String(row?.id);
    expect(row).toMatchObject({ trn: "100123456700003", phone: "+97144110099", email: "sales@gulfcooling.example", active: 1 });
    expect(audited("supplier.create", id)).toBe(1);
    const form = await owner.page(`/admin/suppliers?edit=${id}`);
    expect(form.html).toContain(`name="id" value="${id}"`);
    expect(form.html).toContain("Al Quoz, Dubai");
    const saved = await owner.action("/admin/suppliers", "save", { ...SUPPLIER, id, name: "Gulf Cooling Supplies LLC", trn: "", phone: "" });
    expect(located(saved)).toBe("/admin/suppliers?saved=updated");
    expect(rows("select name, trn, phone from app__suppliers where id = ?", [id])[0]).toEqual({ name: "Gulf Cooling Supplies LLC", trn: null, phone: "" });
    expect(audited("supplier.update", id)).toBe(1);
    expect(located(await owner.action("/admin/suppliers", "active", { id, active: "0" }))).toBe("/admin/suppliers?saved=deactivated");
    expect(rows("select active from app__suppliers where id = ?", [id])[0]?.active).toBe(0);
    expect(audited("supplier.deactivate", id)).toBe(1);
    expect(located(await owner.action("/admin/suppliers", "active", { id, active: "1" }))).toBe("/admin/suppliers?saved=activated");
    expect(audited("supplier.activate", id)).toBe(1);
    expect((await owner.action("/admin/suppliers", "active", { id: "su_ffffffffffffffff", active: "0" })).status).toBe(404);
    expect((await owner.action("/admin/suppliers", "save", { ...SUPPLIER, id: "su_ffffffffffffffff" })).status).toBe(404);
  });

  test("error case: a bad name, phone, TRN or email is a 422 naming the field", async () => {
    const before = Number(rows("select count(*) as n from app__suppliers")[0]?.n);
    const res = await owner.action("/admin/suppliers", "save", { name: "", trn: "123", phone: "12", email: "not-an-email" });
    expect(res.status).toBe(422);
    for (const field of ["name", "trn", "phone", "email"]) expect([field, res.html.includes(`id="err-${field}"`)]).toEqual([field, true]);
    expect((await owner.action("/admin/suppliers", "save", { name: "n".repeat(121) })).status).toBe(422);
    // Only the name is required.
    expect((await owner.action("/admin/suppliers", "save", { name: "Just a name" })).status).toBe(303);
    expect(Number(rows("select count(*) as n from app__suppliers")[0]?.n)).toBe(before + 1);
  });
});

describe("who may do what", () => {
  test("a branch manager keeps both lists", async () => {
    expect((await manager.page("/admin/parts")).html).toContain('id="part-form"');
    expect((await manager.page("/admin/suppliers")).html).toContain('id="supplier-form"');
    expect((await manager.action("/admin/parts", "save", { ...FILTER, sku: "MGR-1" })).status).toBe(303);
    expect((await manager.action("/admin/suppliers", "save", { name: "Manager's supplier" })).status).toBe(303);
  });

  test("a dispatcher reads /admin/parts with no form, and a post is a 403; /admin/suppliers is a 403", async () => {
    const res = await dispatcher.page("/admin/parts?q=pipe");
    expect(res.status).toBe(200);
    expect(res.html).toContain('id="part-pt_00000000000000a1"');
    expect(res.html).not.toContain('id="part-form"');
    expect(res.html).not.toContain('name="sku"');
    expect(res.html).not.toContain("?/save");
    expect(res.html).not.toContain('id="edit-pt_');
    const before = Number(rows("select count(*) as n from app__parts")[0]?.n);
    expect((await dispatcher.action("/admin/parts", "save", { ...FILTER, sku: "DSP-1" })).status).toBe(403);
    expect((await dispatcher.action("/admin/parts", "active", { id: "pt_00000000000000a1", active: "0" })).status).toBe(403);
    expect(Number(rows("select count(*) as n from app__parts")[0]?.n)).toBe(before);
    expect(rows("select active from app__parts where id = 'pt_00000000000000a1'")[0]?.active).toBe(1);
    expect((await dispatcher.page("/admin/suppliers")).status).toBe(403);
    expect((await dispatcher.action("/admin/suppliers", "save", SUPPLIER)).status).toBe(403);
    // ?edit= does not open the form for a reader.
    expect((await dispatcher.page("/admin/parts?edit=pt_00000000000000a1")).html).not.toContain('name="sku"');
  });

  test("an accountant reads both lists with no form and cannot post", async () => {
    const parts = await accountant.page("/admin/parts");
    expect(parts.status).toBe(200);
    expect(parts.html).not.toContain('id="part-form"');
    const suppliers = await accountant.page("/admin/suppliers");
    expect(suppliers.status).toBe(200);
    expect(suppliers.html).toContain("Al Noor Trading");
    expect(suppliers.html).not.toContain('id="supplier-form"');
    expect((await accountant.action("/admin/parts", "save", { ...FILTER, sku: "ACC-1" })).status).toBe(403);
    expect((await accountant.action("/admin/suppliers", "save", SUPPLIER)).status).toBe(403);
  });

  test("a technician sees the parts list and nothing else of it: /admin/suppliers is a 403", async () => {
    const res = await ali.page("/admin/parts");
    expect(res.status).toBe(200);
    expect(res.html).not.toContain('id="part-form"');
    expect((await ali.page("/admin/suppliers")).status).toBe(403);
    expect((await ali.action("/admin/suppliers", "save", SUPPLIER)).status).toBe(403);
    expect((await ali.action("/admin/parts", "save", { ...FILTER, sku: "TEC-1" })).status).toBe(403);
  });

  test("nobody signed in gets a 403", async () => {
    expect((await t.as("nobody").page("/admin/parts")).status).toBe(403);
    expect((await t.as("nobody").page("/admin/suppliers")).status).toBe(403);
  });
});
