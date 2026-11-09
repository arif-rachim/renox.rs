// The back office (F7-128): /admin for the owner only (branding, branches,
// people, audit), the branding reaching the layout, the quotation PDF and the
// invoice email, a technician invited to Sharjah who may open /me and nothing
// else, an accountant promoted without a second factor who cannot issue until
// one is set up, and the audit trail finding a row for every sensitive action.
// Runs on the local worker with the seed's users (password below).
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { totp } from "@renoxium/sdk";
import { app, snapshot } from "@renoxium/sdk/test";

import { base64Of, solidPng } from "../lib/placeholder-png";

setDefaultTimeout(60_000);
const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string, next = "/admin") {
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
const located = (res: { headers: Headers }) => res.headers.get("location") ?? "";
const setting = (key: string): string => String(rows("select value from app__settings where key = ?", [key])[0]?.value);
const PNG = `data:image/png;base64,${base64Of(solidPng([200, 30, 30], 16).bytes)}`;
/** The numbers of the dashboard tiles move with the day: they are masked in the snapshots. */
const steady = (html: string) => html.replace(/(<strong dir="ltr">)\d+(<\/strong>)/gu, "$1<n>$2");

/** Enrols a TOTP factor for `email` on one session, then signs in on another that passed it (as invoices.test.ts does). */
async function withSecondFactor(jar: string, email: string, next: string) {
  const plain = await signIn(`${jar}-plain`, email, next);
  const enrolling = await signIn(`${jar}-enrol`, email, next);
  const enrol = await enrolling.page("/2fa/enroll/totp");
  const secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(enrol.html)?.[1] ?? "").replace(/ /gu, "");
  expect((await enrolling.action("/2fa/enroll/totp", "confirm", { code: await totp(secret) })).status).toBe(200);
  const halted = await t.as(jar).action("/auth/login", "default", { email, password: PASSWORD, next });
  expect(halted.headers.get("location")).toBe(`/2fa/verify?next=${encodeURIComponent(next)}`);
  expect((await t.as(jar).action("/2fa/verify", "totp", { code: await totp(secret, Date.now() / 1000 + 30), next })).status).toBe(303);
  return { plain, verified: t.as(jar), secret };
}

const dispatcher = await signIn("dispatcher", "dispatcher.dubai@fixit.example");
const manager = await signIn("manager", "manager.dubai@fixit.example");
const accountantDxb = await signIn("accountant", "accountant.dubai@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example", "/me");
const customer = t.as("customer");
const { plain: ownerNoFactor, verified: owner } = await withSecondFactor("owner", "owner@fixit.example", "/admin");

describe("/admin per role", () => {
  test("normal case: the owner sees the dashboard with the branch's three numbers", async () => {
    const res = await owner.page("/admin");
    expect(res.status).toBe(200);
    expect(res.html).toContain('id="tile-jobs"');
    expect(res.html).toContain('id="tile-invoices"');
    expect(res.html).toContain('id="tile-amc"');
    // The seed: INV-000001 is part paid, so one open invoice in Dubai; two contracts, one per branch.
    expect(res.html).toMatch(/id="tile-invoices"><span>Open invoices<\/span><strong dir="ltr">1<\/strong>/u);
    snapshot(steady(res.html), { role: "dashboard, owner, en" });
    for (const path of ["/admin/settings", "/admin/branches", "/admin/users", "/admin/audit"]) expect((await owner.page(path)).status).toBe(200);
  });

  test("error case: a dispatcher, a manager, an accountant and a technician get 403 on every page", async () => {
    for (const who of [dispatcher, manager, accountantDxb, ali]) {
      for (const path of ["/admin", "/admin/settings", "/admin/branches", "/admin/users", "/admin/audit"]) expect((await who.page(path)).status).toBe(403);
    }
    expect((await t.as("nobody").page("/admin")).status).toBe(403);
  });

  test("the landing links the owner to the back office and nobody else", async () => {
    expect((await owner.page("/")).html).toContain('href="/admin"');
    expect((await dispatcher.page("/")).html).not.toContain('href="/admin"');
  });
});

describe("branding", () => {
  const form = (extra: Record<string, string> = {}) => ({
    brand_name: "Blue Spanner",
    brand_name_ar: "المفتاح الأزرق",
    brand_color: "#112233",
    brand_footer_en: "Blue Spanner LLC",
    brand_footer_ar: "المفتاح الأزرق ذ.م.م",
    sender_name: "The Blue Spanner team",
    accounts_email: "billing@bluespanner.example",
    ...extra,
  });
  let before = "";

  test("edge case: a colour that is not #rrggbb is a 422 naming the field, and nothing changes", async () => {
    const res = await owner.action("/admin/settings", "save", form({ brand_color: "#GGGGGG" }));
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-brand_color"');
    expect(setting("brand_color")).toBe("#1f6f5c");
    expect(setting("brand_name")).toBe("FixIt Services");
    const empty = await owner.action("/admin/settings", "save", form({ brand_name: "", accounts_email: "nope" }));
    expect(empty.status).toBe(422);
    expect(empty.html).toContain('id="err-brand_name"');
    expect(empty.html).toContain('id="err-accounts_email"');
  });

  test("error case: a dispatcher is refused, and the owner without a second factor too", async () => {
    expect((await dispatcher.action("/admin/settings", "save", form())).status).toBe(403);
    expect((await ownerNoFactor.action("/admin/settings", "save", form())).status).toBe(403);
    expect(setting("brand_name")).toBe("FixIt Services");
  });

  test("normal case: the owner saves; the layout, the stylesheet and the footer show it, in both languages", async () => {
    before = (await dispatcher.page("/quotes/qt_seed_02/pdf?lang=en")).html;
    const res = await owner.action("/admin/settings", "save", form());
    expect(res.status).toBe(303);
    expect(located(res)).toBe("/admin/settings?saved=1");
    expect(setting("brand_color")).toBe("#112233");
    const home = await t.page("/");
    expect(home.html).toContain("Blue Spanner");
    expect(home.html).toContain("Blue Spanner LLC");
    expect(home.html).not.toContain("FixIt Services");
    expect((await t.request("GET", "/theme")).html).toContain("--brand: #112233;");
    const ar = await t.page("/?lang=ar");
    expect(ar.html).toContain("المفتاح الأزرق");
    // Every attempt that passed the policy is a row (the two invalid forms above too); only the valid one is a settings.update.
    expect(Number(rows("select count(*) as n from renox__authz_audit_v1 where action = 'settings.write' and result = 'allow'")[0]?.n)).toBeGreaterThanOrEqual(1);
    expect(rows("select count(*) as n from audit__events where action = 'settings.update'")[0]?.n).toBe(1);
    expect((await owner.page("/admin/settings?saved=1")).html).toContain('id="saved"');
  });

  test("the quotation PDF carries the new brand", async () => {
    const after = await dispatcher.page("/quotes/qt_seed_02/pdf?lang=en");
    expect(after.status).toBe(200);
    expect(after.html.startsWith("%PDF")).toBe(true);
    expect(after.html).not.toBe(before);
  });

  test("a logo: a PNG is stored public under app/brand/ and the layout loads it; other files are refused", async () => {
    const res = await owner.action("/admin/settings", "save", form({ logo_data: PNG }));
    expect(res.status).toBe(303);
    expect(located(res)).toBe("/admin/settings?saved=logo");
    const key = setting("brand_logo_key");
    expect(key).toMatch(/^app\/brand\/logo-[a-z0-9]+\.png$/u);
    expect((await t.page("/")).html).toContain(`/_img/${key}?w=400`);
    // A second logo replaces the first one.
    expect((await owner.action("/admin/settings", "save", form({ logo_data: PNG }))).status).toBe(303);
    const text = await owner.action("/admin/settings", "save", form({ logo_data: `data:text/plain;base64,${btoa("hello")}` }));
    expect(text.status).toBe(422);
    expect(setting("brand_logo_key")).toMatch(/^app\/brand\//u);
    const big = await owner.action("/admin/settings", "save", form({ logo_data: `data:image/png;base64,${btoa("x".repeat(600 * 1024))}` }));
    expect(big.status).toBe(422);
    expect(big.html).toContain('id="err-logo"');
  });

  test("the invoice email's subject and sender carry the brand", async () => {
    // Peter Nowak (English, with an address): his done job is invoiced by the owner. With no phone the invoice goes by email (a phone gets the WhatsApp template).
    rw((db) => db.run("update app__customers set phone = '' where id = 'cu_dxb_02'"));
    const issued = await owner.action("/jobs/jb_seed_11/invoice", "default", {});
    rw((db) => db.run("update app__customers set phone = '+971521110002' where id = 'cu_dxb_02'"));
    expect(issued.status).toBe(303);
    const number = located(issued).replace("/invoices/", "");
    const mail = rows("select subject, text_body, from_name from email__messages where to_address = 'peter.nowak@example.com' and subject like ?", [`%${number}%`]);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toBe(`Tax invoice ${number} from Blue Spanner`);
    // The sender's display name is the email module's `from_name`, not a line in the body.
    expect(mail[0]?.from_name).toBe("The Blue Spanner team");
    expect(String(mail[0]?.text_body)).not.toContain("The Blue Spanner team");
  });

  test("error case: a sender name the email module would refuse is a 422", async () => {
    const res = await owner.action("/admin/settings", "save", form({ sender_name: "Blue <Spanner>" }));
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-sender_name"');
    expect(setting("sender_name")).toBe("The Blue Spanner team");
  });
});

describe("branches", () => {
  test("normal case: the owner adds a branch with its hours; a bad form is a 422; a dispatcher is refused", async () => {
    const bad = await owner.action("/admin/branches", "create", { name_en: "", name_ar: "العين", emirate: "dubai" });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('id="err-name_en"');
    expect((await dispatcher.action("/admin/branches", "create", { name_en: "Ajman", name_ar: "عجمان", emirate: "ajman" })).status).toBe(403);
    // A refused edit of one branch shows what was typed in that row only, and a refused role change fills no other form.
    const edit = await owner.action("/admin/branches", "update", { branch_id: "br_dubai", name_en: "", name_ar: "دبي", emirate: "dubai", phone: "+971 4 111 2222", area: "Typed Area", address: "Typed address" });
    expect(edit.status).toBe(422);
    expect(edit.html).toMatch(/name="area"[^>]*value="Typed Area"/u);
    expect(edit.html.match(/value="Typed Area"/gu)?.length).toBe(1);
    const role = await owner.action("/admin/users", "role", { user_id: "u_owner", role: "dispatcher" });
    expect(role.status).toBe(422);
    const invite = role.html.split('action="?/invite"')[1] ?? "";
    expect(invite).toMatch(/<option value="technician"[^>]*selected/u);
    expect(invite).not.toMatch(/<option value="dispatcher"[^>]*selected/u);

    const res = await owner.action("/admin/branches", "create", { name_en: "Ajman", name_ar: "عجمان", emirate: "ajman", phone: "+971 6 000 0003", area: "Al Nuaimiya", address: "Ajman" });
    expect(res.status).toBe(303);
    const b = rows("select id, org_id, slug, emirate from app__branches where slug = 'ajman'")[0] as { id: string; org_id: string; slug: string; emirate: string };
    expect(b).toMatchObject({ id: "br_ajman", slug: "ajman", emirate: "ajman" });
    expect(rows("select name from org__orgs where id = ?", [b.org_id])).toEqual([{ name: "Ajman" }]);
    expect(rows("select count(*) as n from app__branch_hours where branch_id = 'br_ajman'")[0]?.n).toBe(6);
    // The owner stays in the branch they were working in.
    expect((await owner.page("/admin/branches")).html).toContain('id="branch-br_ajman"');
    expect((await owner.page("/customers")).html).toContain("Layla Haddad");
    // The same name again is refused.
    expect((await owner.action("/admin/branches", "create", { name_en: "Ajman", name_ar: "عجمان", emirate: "ajman" })).status).toBe(422);
  });

  test("the owner edits a branch's own fields", async () => {
    const res = await owner.action("/admin/branches", "update", { branch_id: "br_ajman", name_en: "Ajman City", name_ar: "مدينة عجمان", emirate: "ajman", phone: "+971 6 000 0004", area: "Al Rashidiya", address: "Ajman" });
    expect(res.status).toBe(303);
    expect(rows("select name_en, phone, area from app__branches where id = 'br_ajman'")).toEqual([{ name_en: "Ajman City", phone: "+971 6 000 0004", area: "Al Rashidiya" }]);
    // The organisation is renamed through org.rename (its slug stays).
    expect(rows("select o.name, o.slug from org__orgs o join app__branches b on b.org_id = o.id where b.id = 'br_ajman'")).toEqual([{ name: "Ajman City", slug: "ajman" }]);
    expect((await owner.action("/admin/branches", "update", { branch_id: "br_nowhere", name_en: "X", name_ar: "س", emirate: "dubai" })).status).toBe(404);
  });
});

describe("people", () => {
  const EMAIL = "new.tech@fixit.example";
  let token = "";

  test("the users page lists the branch with roles and who has a second factor", async () => {
    const res = await owner.page("/admin/users");
    expect(res.status).toBe(200);
    expect(res.html).toContain("Dina Dispatcher");
    expect(res.html).toContain("Ali Hassan");
    // The owner enrolled one; the dispatcher did not.
    expect(res.html).toMatch(/id="staff-u_owner"[\s\S]*?On/u);
    expect(res.html).toMatch(/id="staff-u_dxb_accountant"[\s\S]*?Off[\s\S]*?Needs a second factor/u);
    // The page around the table holds a generated logo name and organisation ids: the table is the snapshot.
    snapshot(/<table id="staff">[\s\S]*?<\/table>/u.exec(res.html)?.[0] ?? "", { role: "users table, owner, en" });
  });

  test("an owner works in Sharjah and invites a technician: an org invitation, the role waits for the person", async () => {
    // From here on the owner's session works in Sharjah (the active organisation is kept per session), to the end of the file.
    const switched = await owner.action("/org", "switch", { org: "org_sharjah", next: "/admin/users" });
    expect(switched.status).toBe(303);
    expect((await owner.page("/admin/users")).html).toContain("Sami Dispatcher");
    expect((await dispatcher.action("/admin/users", "invite", { email: EMAIL, role: "technician" })).status).toBe(403);
    expect((await owner.action("/admin/users", "invite", { email: "not an email", role: "technician" })).status).toBe(422);
    expect((await owner.action("/admin/users", "invite", { email: EMAIL, role: "janitor" })).status).toBe(422);
    const sent = await owner.action("/admin/users", "invite", { email: EMAIL, role: "technician" });
    expect(sent.status).toBe(303);
    expect(rows("select org_id, role from org__invites where email = ?", [EMAIL])).toEqual([{ org_id: "org_sharjah", role: "member" }]);
    expect(rows("select branch_id, role, applied_at from app__staff_invites where email = ?", [EMAIL])).toEqual([{ branch_id: "br_sharjah", role: "technician", applied_at: null }]);
    const mail = rows("select text_body from email__messages where to_address = ?", [EMAIL]);
    token = /\/org\/accept\/([A-Za-z0-9_-]+)/u.exec(String(mail[0]?.text_body))?.[1] ?? "";
    expect(token).not.toBe("");
    expect((await owner.page("/admin/users")).html).toContain(EMAIL);
  });

  test("once they have joined, the technician has /me and nothing else", async () => {
    const newbie = t.as("newbie");
    expect((await newbie.action("/auth/register", "default", { email: EMAIL, password: PASSWORD, display_name: "Nadia Newtech" })).status).toBe(200);
    expect((await newbie.action("/auth/login", "default", { email: EMAIL, password: PASSWORD })).status).toBe(303);
    expect((await newbie.action(`/org/accept/${token}`, "accept", {})).status).toBe(303);
    // The owner's next look at the page applies the role the owner chose.
    const page = await owner.page("/admin/users");
    expect(page.html).toContain("Nadia Newtech");
    expect(rows("select scope_type, scope_id from renox__role_assignments where role = 'technician' and user_id = (select id from auth__users where email = ?)", [EMAIL])).toEqual([{ scope_type: "org", scope_id: "org_sharjah" }]);
    expect(rows("select applied_at is not null as done from app__staff_invites where email = ?", [EMAIL])).toEqual([{ done: 1 }]);
    expect((await newbie.page("/me")).status).toBe(200);
    for (const path of ["/customers", "/quotes", "/invoices", "/contracts", "/dispatch", "/reports", "/admin", "/admin/users", "/services"]) expect((await newbie.page(path)).status).toBe(403);
    expect((await newbie.action("/admin/settings", "save", { brand_name: "Mine", brand_color: "#000000" })).status).toBe(403);
    // The role does not reach Dubai: Dubai's technician list is unchanged.
    expect(rows("select count(*) as n from renox__role_assignments where role = 'technician'")[0]?.n).toBe(5);
  });

  test("promoted to accountant without a second factor, they cannot issue until one is set up", async () => {
    const id = String(rows("select id from auth__users where email = ?", [EMAIL])[0]?.id);
    // The owner cannot change their own role.
    expect((await owner.action("/admin/users", "role", { user_id: "u_owner", role: "technician" })).status).toBe(422);
    expect((await owner.action("/admin/users", "role", { user_id: id, role: "accountant" })).status).toBe(303);
    expect(rows("select role, scope_type, scope_id from renox__role_assignments where user_id = ?", [id])).toEqual([{ role: "accountant", scope_type: "org", scope_id: "org_sharjah" }]);

    const newbie = t.as("newbie");
    expect((await newbie.page("/invoices")).status).toBe(200);
    expect((await newbie.page("/me")).status).toBe(403);
    const refused = await newbie.action("/jobs/jb_seed_19/invoice", "default", {});
    expect(refused.status).toBe(403);
    expect(rows("select status from app__jobs where id = 'jb_seed_19'")).toEqual([{ status: "done" }]);

    const { verified } = await withSecondFactor("newbie-2fa", EMAIL, "/invoices");
    const issued = await verified.action("/jobs/jb_seed_19/invoice", "default", {});
    expect(issued.status).toBe(303);
    expect(rows("select status from app__jobs where id = 'jb_seed_19'")).toEqual([{ status: "invoiced" }]);
  });

  test("the owner removes them from the branch: no role, no access", async () => {
    const id = String(rows("select id from auth__users where email = ?", [EMAIL])[0]?.id);
    expect((await owner.action("/admin/users", "remove", { user_id: "u_owner" })).status).toBe(422);
    expect((await owner.action("/admin/users", "remove", { user_id: "u_nobody" })).status).toBe(422);
    expect((await owner.action("/admin/users", "remove", { user_id: id })).status).toBe(303);
    expect(rows("select count(*) as n from org__members where user_id = ?", [id])[0]?.n).toBe(0);
    expect(rows("select count(*) as n from renox__role_assignments where user_id = ?", [id])[0]?.n).toBe(0);
    expect((await t.as("newbie").page("/invoices")).status).toBe(403);
  });

  test("a seeded global role is kept for the person's other branches when it changes in one", async () => {
    // The owner belongs to both branches with a global `owner` role; Sami (Sharjah dispatcher) is changed to a manager.
    expect((await owner.action("/admin/users", "role", { user_id: "u_shj_dispatcher", role: "branch_manager" })).status).toBe(303);
    expect(rows("select role, scope_type, scope_id from renox__role_assignments where user_id = 'u_shj_dispatcher'")).toEqual([{ role: "branch_manager", scope_type: "org", scope_id: "org_sharjah" }]);
    const sami = await signIn("sami", "dispatcher.sharjah@fixit.example", "/jobs");
    expect((await sami.page("/reports/amc")).status).toBe(403);
    expect((await sami.page("/contracts")).status).toBe(200);
    expect((await sami.page("/quotes")).status).toBe(200);
    // And back to a dispatcher.
    expect((await owner.action("/admin/users", "role", { user_id: "u_shj_dispatcher", role: "dispatcher" })).status).toBe(303);
  });
});

describe("the audit trail", () => {
  const today = (): string => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

  test("every sensitive action of the flow has a row: settings, issue, pay, a job transition, a link answer", async () => {
    // The end-to-end flow so far: settings.write and invoice.issue happened above. Now a payment and a customer's approval.
    // The Sharjah invoice of jb_seed_19 (issued by the promoted accountant above): the owner's session works in Sharjah now.
    const invoice = String(rows("select invoice_id from app__job_invoices where job_id = 'jb_seed_19'")[0]?.invoice_id);
    const paid = await owner.action(`/invoices/${invoice}`, "pay", { method: "cash", amount: "10", received_on: today() });
    expect(paid.status).toBe(303);
    const approved = await customer.action("/l/approve/demo-q000003-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "approve", {});
    expect(approved.status).toBe(303);

    for (const action of ["invoice.issue", "invoice.pay", "settings.write", "job.transition", "quote.link_answer"]) {
      const res = await owner.page(`/admin/audit?action=${action}`);
      expect(res.status).toBe(200);
      expect(res.html).toContain(`<td dir="ltr">${action}</td>`);
    }
    // The decisions of the platform are in the trail as allowed or denied rows.
    const settingsRows = rows("select result from renox__authz_audit_v1 where action = 'settings.write' order by id").map((r) => r.result);
    expect(settingsRows).toContain("allow");
    expect(settingsRows).toContain("deny");
    const all = await owner.page("/admin/audit");
    expect(all.html).toContain('<td dir="ltr">staff.invite</td>');
    expect(all.html).toContain('<td dir="ltr">branch.create</td>');
  });

  test("the filter by actor narrows the rows, and anyone but the owner gets 403", async () => {
    const mine = await owner.page("/admin/audit?actor=u_owner&action=job.transition");
    expect(mine.html).toContain('<td dir="ltr">u_owner</td>');
    expect((await dispatcher.page("/admin/audit")).status).toBe(403);
    expect((await owner.page("/admin/audit?action=drop%20table")).status).toBe(200);
  });
});
