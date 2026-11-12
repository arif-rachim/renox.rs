// The back office (F7-128): the `admin` module's back office at /admin with
// the app's sidebar links and tile ([[slots]] in renox.toml) and the app's own
// pages beside it (branding, branches, people), for the owner only; the
// branding reaching the layout, the quotation PDF and the invoice email; a
// technician invited to Sharjah who gets the role when they accept (the
// `org.member_added` handler of hooks.ts, no page opened) and may open /me and
// nothing else; an accountant promoted without a second factor who cannot
// issue until one is set up; and the module's audit trail finding a row for
// every sensitive action. Runs on the local worker with the seed's users
// (password below).
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { totp } from "@renoxium/sdk";
import { app, snapshot, type TestApp } from "@renoxium/sdk/test";

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
/** The module's sidebar, with the app's links in it. */
const sidebar = (html: string) => /<nav class="renox-admin-sidebar"[\s\S]*?<\/nav>/u.exec(html)?.[0] ?? "";
/** The app's tile on the module's dashboard, as the dashboard renders it (before htmx asks for the numbers). */
const tileSlot = (html: string) => /<article id="home-services-tile"[\s\S]*?<\/article>/u.exec(html)?.[0] ?? "";
/** What htmx gets for the tile: the `tile` fragment of /admin/tile. */
const tileFragment = (who: TestApp, query = "") => who.request("GET", `/admin/tile${query}`, { headers: { "hx-request": "true", "hx-target": "home-services-tile" } });
/** Polls until `f` returns something other than undefined (an event handler runs after the commit, on the worker's outbox). */
async function until<T>(f: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) {
    const v = f();
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

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
  test("normal case: the owner sees the module's dashboard with the app's sidebar links and its tile", async () => {
    const res = await owner.page("/admin");
    expect(res.status).toBe(200);
    // The module's own page: its layout, its users card.
    expect(res.html).toContain('class="renox-admin-sidebar"');
    expect(res.html).toContain('id="admin-card-users"');
    // The admin.sidebar filler: the app's pages.
    const nav = sidebar(res.html);
    for (const href of ["/admin/branches", "/admin/people", "/admin/settings", "/admin/audit"]) expect(nav).toContain(`href="${href}"`);
    // The admin.dashboard filler: htmx asks /admin/tile for the numbers.
    const tile = tileSlot(res.html);
    expect(tile).toContain('hx-get="/admin/tile"');
    snapshot(`${nav}\n${tile}`, { role: "admin sidebar and tile, owner, en" });
    for (const path of ["/admin/settings", "/admin/branches", "/admin/people", "/admin/audit", "/admin/users", "/admin/tile"]) expect((await owner.page(path)).status).toBe(200);
  });

  test("the tile's fragment holds the branch's three numbers", async () => {
    const res = await tileFragment(owner);
    expect(res.status).toBe(200);
    expect(res.html).toStartWith('<article id="home-services-tile"');
    expect(res.html).toContain('id="tile-jobs"');
    expect(res.html).toContain('id="tile-amc"');
    // The seed: INV-000001 is part paid, so one open invoice in Dubai; two contracts, one per branch.
    expect(res.html).toMatch(/id="tile-invoices"><span>Open invoices<\/span><strong dir="ltr">1<\/strong>/u);
    expect(res.html).not.toContain("<html");
    snapshot(steady(res.html), { role: "admin tile fragment, owner, en" });
  });

  test("in Arabic: the sidebar links and the tile", async () => {
    const res = await owner.page("/admin?lang=ar");
    expect(res.status).toBe(200);
    expect(res.html).toContain('dir="rtl"');
    const nav = sidebar(res.html);
    expect(nav).toContain("الفروع");
    expect(nav).toContain("الأشخاص");
    expect(tileSlot(res.html)).toContain("اليوم في هذا الفرع");
    snapshot(`${nav}\n${tileSlot(res.html)}`, { role: "admin sidebar and tile, owner, ar" });
    const fragment = await tileFragment(owner, "?lang=ar");
    expect(fragment.status).toBe(200);
    expect(fragment.html).toContain("أعمال اليوم");
    snapshot(steady(fragment.html), { role: "admin tile fragment, owner, ar" });
    // The choice of language is kept: back to English for the rest of the file.
    expect((await owner.page("/admin?lang=en")).html).toContain('dir="ltr"');
  });

  test("error case: a dispatcher, a manager, an accountant and a technician get 403 on every page", async () => {
    for (const who of [dispatcher, manager, accountantDxb, ali]) {
      for (const path of ["/admin", "/admin/settings", "/admin/branches", "/admin/people", "/admin/audit", "/admin/users", "/admin/tile"]) expect((await who.page(path)).status).toBe(403);
      expect((await tileFragment(who)).status).toBe(403);
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
    const role = await owner.action("/admin/people", "role", { user_id: "u_owner", role: "dispatcher" });
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
    const res = await owner.page("/admin/people");
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
    const switched = await owner.action("/org", "switch", { org: "org_sharjah", next: "/admin/people" });
    expect(switched.status).toBe(303);
    expect((await owner.page("/admin/people")).html).toContain("Sami Dispatcher");
    expect((await dispatcher.action("/admin/people", "invite", { email: EMAIL, role: "technician" })).status).toBe(403);
    expect((await owner.action("/admin/people", "invite", { email: "not an email", role: "technician" })).status).toBe(422);
    expect((await owner.action("/admin/people", "invite", { email: EMAIL, role: "janitor" })).status).toBe(422);
    const sent = await owner.action("/admin/people", "invite", { email: EMAIL, role: "technician" });
    expect(sent.status).toBe(303);
    expect(rows("select org_id, role from org__invites where email = ?", [EMAIL])).toEqual([{ org_id: "org_sharjah", role: "member" }]);
    expect(rows("select branch_id, role, applied_at from app__staff_invites where email = ?", [EMAIL])).toEqual([{ branch_id: "br_sharjah", role: "technician", applied_at: null }]);
    const mail = rows("select text_body from email__messages where to_address = ?", [EMAIL]);
    token = /\/org\/accept\/([A-Za-z0-9_-]+)/u.exec(String(mail[0]?.text_body))?.[1] ?? "";
    expect(token).not.toBe("");
    expect((await owner.page("/admin/people")).html).toContain(EMAIL);
  });

  test("once they have accepted, the role is theirs without the people page being opened, and the owner is told", async () => {
    const newbie = t.as("newbie");
    expect((await newbie.action("/auth/register", "default", { email: EMAIL, password: PASSWORD, display_name: "Nadia Newtech" })).status).toBe(200);
    expect((await newbie.action("/auth/login", "default", { email: EMAIL, password: PASSWORD })).status).toBe(303);
    // The org module's own flow: its accept page. It emits org.member_added; hooks.ts applies the pending role after the commit.
    expect((await newbie.action(`/org/accept/${token}`, "accept", {})).status).toBe(303);
    const assigned = await until(() => {
      const r = rows("select scope_type, scope_id from renox__role_assignments where role = 'technician' and user_id = (select id from auth__users where email = ?)", [EMAIL]);
      return r.length > 0 ? r : undefined;
    }, "the technician role");
    expect(assigned).toEqual([{ scope_type: "org", scope_id: "org_sharjah" }]);
    expect(rows("select applied_at is not null as done from app__staff_invites where email = ?", [EMAIL])).toEqual([{ done: 1 }]);
    // app.member_ready, the app's own event, is handled by the app: the owner who invited her gets a notification.
    const told = await until(() => rows("select category, title, link from notifications__items where user_id = 'u_owner' and category = 'staff'")[0], "the owner's notification");
    expect(told).toEqual({ category: "staff", title: "Nadia Newtech joined Sharjah as technician.", link: "/admin/people" });
    expect((await owner.page("/admin/people")).html).toContain("Nadia Newtech");
    expect((await newbie.page("/me")).status).toBe(200);
    for (const path of ["/customers", "/quotes", "/invoices", "/contracts", "/dispatch", "/reports", "/admin", "/admin/people", "/admin/users", "/admin/audit", "/services"]) expect((await newbie.page(path)).status).toBe(403);
    expect((await newbie.action("/admin/settings", "save", { brand_name: "Mine", brand_color: "#000000" })).status).toBe(403);
    // The role does not reach Dubai: Dubai's technician list is unchanged.
    expect(rows("select count(*) as n from renox__role_assignments where role = 'technician'")[0]?.n).toBe(5);
  });

  test("promoted to accountant without a second factor, they cannot issue until one is set up", async () => {
    const id = String(rows("select id from auth__users where email = ?", [EMAIL])[0]?.id);
    // The owner cannot change their own role.
    expect((await owner.action("/admin/people", "role", { user_id: "u_owner", role: "technician" })).status).toBe(422);
    expect((await owner.action("/admin/people", "role", { user_id: id, role: "accountant" })).status).toBe(303);
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
    expect((await owner.action("/admin/people", "remove", { user_id: "u_owner" })).status).toBe(422);
    expect((await owner.action("/admin/people", "remove", { user_id: "u_nobody" })).status).toBe(422);
    expect((await owner.action("/admin/people", "remove", { user_id: id })).status).toBe(303);
    expect(rows("select count(*) as n from org__members where user_id = ?", [id])[0]?.n).toBe(0);
    expect(rows("select count(*) as n from renox__role_assignments where user_id = ?", [id])[0]?.n).toBe(0);
    expect((await t.as("newbie").page("/invoices")).status).toBe(403);
  });

  test("a seeded global role is kept for the person's other branches when it changes in one", async () => {
    // The owner belongs to both branches with a global `owner` role; Sami (Sharjah dispatcher) is changed to a manager.
    expect((await owner.action("/admin/people", "role", { user_id: "u_shj_dispatcher", role: "branch_manager" })).status).toBe(303);
    expect(rows("select role, scope_type, scope_id from renox__role_assignments where user_id = 'u_shj_dispatcher'")).toEqual([{ role: "branch_manager", scope_type: "org", scope_id: "org_sharjah" }]);
    const sami = await signIn("sami", "dispatcher.sharjah@fixit.example", "/jobs");
    expect((await sami.page("/reports/amc")).status).toBe(403);
    expect((await sami.page("/contracts")).status).toBe(200);
    expect((await sami.page("/quotes")).status).toBe(200);
    // And back to a dispatcher.
    expect((await owner.action("/admin/people", "role", { user_id: "u_shj_dispatcher", role: "dispatcher" })).status).toBe(303);
  });
});

// Reset of a person's second factor (#735): the owner's button on /admin/people,
// the `twofa` module's `reset` behind it. Threat-model row "Account takeover"
// (docs/24-threat-model.md): a lost authenticator must not lock a technician out
// for good, and the reset itself must not become the takeover: only the owner,
// with a recent second factor of their own, never on oneself, never outside the
// branch, one confirmation step, an audit row (actor: the owner, resource:
// `twofa:User`) and a notice to the person whose factor was reset.
describe("reset second factor", () => {
  /** A cell of the audit table holding exactly `text`. */
  const cell = (text: string) => new RegExp(`<td[^>]*>${text.replace(/\./gu, "\\.")}</td>`, "u");
  const HAMAD = "hamad.sharjah@fixit.example";
  const IMRAN = "imran.sharjah@fixit.example";
  const enrolled = (id: string) => Number(rows("select count(*) as n from twofa__totp where user_id = ?", [id])[0]?.n);
  const row = (html: string, id: string) => new RegExp(`<tr id="staff-${id}"[\\s\\S]*?</tr>`, "u").exec(html)?.[0] ?? "";
  const CONFIRM = "Reset the second factor of Hamad Saeed? They will set it up again at their next sign-in.";

  test("setup: Hamad (Sharjah technician) enrols a second factor; the owner's page offers the button only for people who have one", async () => {
    await withSecondFactor("hamad", HAMAD, "/me");
    expect(enrolled("u_shj_hamad")).toBe(1);
    const res = await owner.page("/admin/people");
    expect(res.status).toBe(200);
    expect(row(res.html, "u_shj_hamad")).toContain("Reset second factor");
    expect(row(res.html, "u_shj_imran")).not.toContain("Reset second factor");
    expect(row(res.html, "u_owner")).not.toContain("Reset second factor");
    expect(res.html).not.toContain('id="confirm-reset"');
  });

  test("the first POST asks for a confirmation and changes nothing, in English and in Arabic", async () => {
    const res = await owner.action("/admin/people", "reset_2fa", { user_id: "u_shj_hamad" });
    expect(res.status).toBe(200);
    expect(res.html).toContain('id="confirm-reset"');
    expect(res.html).toContain(CONFIRM);
    expect(res.html).toContain('name="confirm" value="1"');
    expect(res.html).toContain('href="/admin/people"');
    expect(enrolled("u_shj_hamad")).toBe(1);
    expect(rows("select count(*) as n from audit__events where action = 'twofa.reset'")[0]?.n).toBe(0);
    snapshot(/<section id="confirm-reset"[\s\S]*?<\/section>/u.exec(res.html)?.[0] ?? "", { role: "reset second factor confirmation, owner, en" });
    // ?lang=ar is stored for the owner; it is put back to English after the snapshot.
    expect((await owner.page("/admin/people?lang=ar")).status).toBe(200);
    const ar = await owner.action("/admin/people", "reset_2fa", { user_id: "u_shj_hamad" });
    expect((await owner.page("/admin/people?lang=en")).status).toBe(200);
    expect(ar.status).toBe(200);
    expect(ar.html).toContain('id="confirm-reset"');
    expect(ar.html).not.toContain(CONFIRM);
    snapshot(/<section id="confirm-reset"[\s\S]*?<\/section>/u.exec(ar.html)?.[0] ?? "", { role: "reset second factor confirmation, owner, ar" });
  });

  test("error cases: a manager, a dispatcher and an accountant get 403; an owner without a recent second factor is stopped; nothing changes", async () => {
    for (const who of [manager, dispatcher, accountantDxb]) {
      expect((await who.action("/admin/people", "reset_2fa", { user_id: "u_shj_hamad", confirm: "1" })).status).toBe(403);
    }
    // The owner's other session never passed a second factor: the policy refuses it (base.cedar), and nothing is called.
    const stale = await ownerNoFactor.action("/admin/people", "reset_2fa", { user_id: "u_shj_hamad", confirm: "1" });
    expect(stale.status).toBe(403);
    // And so does the owner's verified session once its verification is older than the window.
    const aged = rw((db) => {
      const before = db.query<{ session_id: string; verified_at: number }, []>("select session_id, verified_at from twofa__sessions where user_id = 'u_owner'").all();
      db.exec("update twofa__sessions set verified_at = verified_at - 20 * 60000 where user_id = 'u_owner'");
      return before;
    });
    const expired = await owner.action("/admin/people", "reset_2fa", { user_id: "u_shj_hamad", confirm: "1" });
    rw((db) => {
      for (const r of aged) db.query("update twofa__sessions set verified_at = ? where session_id = ?").run(r.verified_at, r.session_id);
    });
    expect([303, 403]).toContain(expired.status);
    if (expired.status === 303) expect(located(expired)).toBe("/2fa/verify?next=%2Fadmin%2Fpeople");
    expect(enrolled("u_shj_hamad")).toBe(1);
    expect(rows("select count(*) as n from audit__events where action = 'twofa.reset'")[0]?.n).toBe(0);
  });

  test("error cases: oneself, someone outside the active branch, a stranger and a person with no second factor are 422", async () => {
    // The owner's session works in Sharjah (see "people"): Ali is a Dubai technician.
    await withSecondFactor("ali-2fa", "ali.dubai@fixit.example", "/me");
    expect((await owner.action("/admin/people", "reset_2fa", { user_id: "u_owner", confirm: "1" })).status).toBe(422);
    expect((await owner.action("/admin/people", "reset_2fa", { user_id: "u_dxb_ali", confirm: "1" })).status).toBe(422);
    expect((await owner.action("/admin/people", "reset_2fa", { user_id: "u_nobody", confirm: "1" })).status).toBe(422);
    expect((await owner.action("/admin/people", "reset_2fa", { user_id: "u_shj_imran", confirm: "1" })).status).toBe(422);
    expect(enrolled("u_dxb_ali")).toBe(1);
    expect(enrolled("u_shj_hamad")).toBe(1);
  });

  test("normal case: the confirmed POST resets it; the next sign-in is not held at /2fa/verify; the person is told; the trail has the row", async () => {
    const done = await owner.action("/admin/people", "reset_2fa", { user_id: "u_shj_hamad", confirm: "1" });
    expect(done.status).toBe(303);
    expect(located(done)).toBe("/admin/people?saved=twofa_reset");
    expect(enrolled("u_shj_hamad")).toBe(0);
    const after = await owner.page("/admin/people?saved=twofa_reset");
    expect(after.html).toContain('id="saved-twofa-reset"');
    expect(row(after.html, "u_shj_hamad")).not.toContain("Reset second factor");

    // Hamad's password sign-in starts a session straight away (nothing to verify) and a second factor can be enrolled again.
    const again = await t.as("hamad-again").action("/auth/login", "default", { email: HAMAD, password: PASSWORD, next: "/me" });
    expect(again.status).toBe(303);
    expect(located(again)).not.toContain("/2fa/verify");
    expect((await t.as("hamad-again").page("/2fa/enroll/totp")).status).toBe(200);

    // The notice: the in-app item and the email (Hamad has no linked WhatsApp number).
    const text = "Your second factor was reset by Omar Owner. If this was not expected, tell your manager.";
    expect(rows("select title from notifications__items where user_id = 'u_shj_hamad'").map((r) => r.title)).toContain(text);
    const mail = await until(() => rows("select subject from email__messages where to_address = ?", [HAMAD]).find((r) => String(r.subject).includes("second factor was reset")), "the notice email");
    expect(String(mail.subject)).toBe(text);

    // The trail: actor the owner, resource twofa:User.
    const trail = await until(() => rows("select actor_id, resource_type, resource_id from audit__events where action = 'twofa.reset'")[0], "the audit row");
    expect(trail).toEqual({ actor_id: "u_owner", resource_type: "twofa:User", resource_id: "u_shj_hamad" });
    const page = await owner.page("/admin/audit?action=twofa.reset");
    expect(page.status).toBe(200);
    expect(page.html).toMatch(cell("twofa.reset"));
    expect(page.html).toMatch(cell("twofa:User:u_shj_hamad"));
    expect(page.html).toMatch(/<td[^>]*>twofa\.reset<\/td><td[^>]*>u_owner<\/td><td[^>]*>twofa:User:u_shj_hamad<\/td><td[^>]*>ok<\/td>/u);
  });

  test("a person with a linked WhatsApp number is told there too (the sandbox's outbox)", async () => {
    await withSecondFactor("imran", IMRAN, "/me");
    rw((db) => db.query("insert into whatsapp__contacts (user_id, phone, verified_at) values ('u_shj_imran', '+971500000042', 1793000000000)").run());
    expect((await owner.action("/admin/people", "reset_2fa", { user_id: "u_shj_imran", confirm: "1" })).status).toBe(303);
    expect(enrolled("u_shj_imran")).toBe(0);
    const sent = await until(() => rows("select body from whatsapp__messages where direction = 'out' and phone = '+971500000042'").find((r) => String(r.body).includes("second factor was reset")), "the WhatsApp notice");
    expect(String(sent.body)).toContain("Omar Owner");
  });
});

// The trail is the `admin` module's page (/admin/audit) over the audit module;
// the owner holds audit.read through the owner policy.
describe("the audit trail", () => {
  const today = (): string => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
  /** A cell of the module's audit table holding exactly `text`. */
  const cell = (text: string) => new RegExp(`<td[^>]*>${text.replace(/\./gu, "\\.")}</td>`, "u");

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
      expect(res.html).toMatch(cell(action));
    }
    // The decisions of the platform are in the trail as allowed or denied rows.
    const settingsRows = rows("select result from renox__authz_audit_v1 where action = 'settings.write' order by id").map((r) => r.result);
    expect(settingsRows).toContain("allow");
    expect(settingsRows).toContain("deny");
    // What the app records itself: the invitation and the new branch.
    for (const action of ["staff.invite", "branch.create"]) expect((await owner.page(`/admin/audit?action=${action}`)).html).toMatch(cell(action));
    expect((await owner.page("/admin/audit")).html).not.toContain('class="problem"');
  });

  test("the filter by actor narrows the rows, and anyone but the owner gets 403", async () => {
    const mine = await owner.page("/admin/audit?actor=u_owner&action=job.transition");
    expect(mine.html).toMatch(cell("u_owner"));
    expect(mine.html).not.toMatch(cell("quote.link_answer"));
    expect((await dispatcher.page("/admin/audit")).status).toBe(403);
    expect((await owner.page("/admin/audit?action=drop%20table")).status).toBe(200);
  });
});

describe("weekly working hours (/admin/branches)", () => {
  const ALI = "u_dxb_ali";
  const DAYS_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  /** The Dubai form's seven rows: Monday to Thursday and Saturday 08:00 to 18:00, Friday 14:00 to 18:00, Sunday closed (the seed's hours). */
  const week = (over: Record<string, string> = {}): Record<string, string> => ({
    branch_id: "br_dubai",
    ...Object.fromEntries([1, 2, 3, 4, 6].flatMap((d) => [[`open_${d}`, "08:00"], [`close_${d}`, "18:00"]])),
    open_5: "14:00",
    close_5: "18:00",
    closed_0: "on",
    open_0: "08:00",
    close_0: "18:00",
    ...over,
  });
  /** A Friday (Dubai) between 5 and 11 days ahead: `YYYY-MM-DD` and the unix seconds of 15:00 that day. */
  const friday = (() => {
    const d = new Date(Date.now() + 4 * 3_600_000 + 5 * 86_400_000);
    while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
    const day = d.toISOString().slice(0, 10);
    return { day, at15: Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) - 4 * 3600 + 15 * 3600 };
  })();
  const hoursRows = () => rows("select weekday, open_min, close_min from app__branch_hours where branch_id = 'br_dubai' order by weekday");
  const form = (html: string) => (/<form[^>]*id="hours-form-br_dubai"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? "").replace(/name="_csrf" value="[^"]*"/gu, 'name="_csrf" value="<csrf>"');
  const job = String(rows("select id from app__jobs where branch_id = 'br_dubai' and status = 'new' order by number limit 1")[0]?.id);
  const pickerStarts = async (): Promise<number[]> => {
    const res = await dispatcher.page(`/jobs/${job}?day=${friday.day}&technician=${ALI}`);
    expect(res.status).toBe(200);
    return [...res.html.matchAll(new RegExp(`value="${ALI}@(\\d+)"`, "gu"))].map((m) => Number(m[1]));
  };
  const toolDays = async (): Promise<string[]> => {
    const r = await t.tool("next_free_slot", { service: "AC-SERVICE", from: friday.day }, { as: dispatcher });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return ((r.result as { slots: { day: string }[] }).slots ?? []).map((s) => s.day);
  };

  test("normal case: the page shows each branch's seven days, Monday first, with the current hours", async () => {
    const res = await owner.page("/admin/branches");
    expect(res.status).toBe(200);
    const f = form(res.html);
    const at = DAYS_EN.map((d) => f.indexOf(`<strong dir="auto">${d}</strong>`));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(f.match(/type="time" step="1800"/gu)?.length).toBe(14);
    expect(f).toMatch(/name="open_5"[^>]*value="14:00"/u);
    expect(f).toMatch(/name="closed_0"[^>]*checked/u);
    expect(f).not.toMatch(/name="closed_1"[^>]*checked/u);
  });

  test("before: Friday has slots from 14:00 in the picker and in next_free_slot", async () => {
    const starts = await pickerStarts();
    expect(starts.length).toBeGreaterThan(0);
    expect(Math.min(...starts)).toBe(Date.parse(`${friday.day}T00:00:00Z`) - 4 * 3_600_000 + 14 * 3_600_000);
    expect(await toolDays()).toContain(friday.day);
  });

  test("error cases: a close before the open, a time off the half hour, and no open day are 422s naming the row; nothing changes", async () => {
    const before = hoursRows();
    const order = await owner.action("/admin/branches", "hours", week({ open_5: "15:00", close_5: "14:30" }));
    expect(order.status).toBe(422);
    expect(order.html).toContain('id="err-hours_5"');
    expect(order.html).toContain("Working hours: Friday");
    expect(order.html).toMatch(/name="open_5"[^>]*value="15:00"/u);
    expect(order.html).toMatch(/name="open_5"[^>]*aria-invalid="true"/u);
    const step = await owner.action("/admin/branches", "hours", week({ open_2: "08:15" }));
    expect(step.status).toBe(422);
    expect(step.html).toContain('id="err-hours_2"');
    expect(step.html).toContain("Working hours: Tuesday");
    const none = await owner.action("/admin/branches", "hours", { branch_id: "br_dubai", ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [`closed_${d}`, "on"])) });
    expect(none.status).toBe(422);
    expect(none.html).toContain('id="err-hours"');
    expect((await owner.action("/admin/branches", "hours", week({ close_3: "" }))).status).toBe(422);
    expect((await owner.action("/admin/branches", "hours", { ...week(), branch_id: "br_nowhere" })).status).toBe(404);
    expect(hoursRows()).toEqual(before);
    expect(rows("select count(*) as n from audit__events where action = 'branch.hours'")[0]?.n).toBe(0);
    snapshot(form(order.html), { role: "branch hours form, a 422 on Friday, owner, en" });
  });

  test("error cases: a branch manager, a dispatcher and an owner without a second factor change nothing", async () => {
    const before = hoursRows();
    for (const who of [manager, dispatcher, accountantDxb]) expect((await who.action("/admin/branches", "hours", week({ closed_5: "on" }))).status).toBe(403);
    expect((await manager.page("/admin/branches")).status).toBe(403);
    expect((await ownerNoFactor.action("/admin/branches", "hours", week({ closed_5: "on" }))).status).toBe(403);
    expect(hoursRows()).toEqual(before);
  });

  test("normal case: Friday closed is saved at once: the audit row, five rows, no Friday slots, and the jobs outside the hours are counted, not moved", async () => {
    // One job is already scheduled on that Friday at 15:00.
    rw((db) => db.run("update app__jobs set status = 'scheduled', technician_user_id = ?, scheduled_start = ?, scheduled_end = ? where id = ?", [ALI, friday.at15, friday.at15 + 3600, job]));
    const number = String(rows("select number from app__jobs where id = ?", [job])[0]?.number);
    const res = await owner.action("/admin/branches", "hours", week({ closed_5: "on" }));
    expect(res.status).toBe(303);
    expect(located(res)).toBe("/admin/branches?saved=hours&for=br_dubai");
    expect(hoursRows().map((r) => r.weekday)).toEqual([1, 2, 3, 4, 6]);
    expect(rows("select count(*) as n from audit__events where action = 'branch.hours'")[0]?.n).toBe(1);
    // The slots follow: none on Friday in the picker, none in next_free_slot.
    expect(await pickerStarts()).toEqual([]);
    expect(await toolDays()).not.toContain(friday.day);
    // The page says how many jobs are outside (the seed's own jobs near this Friday may be too), with the link that lists them.
    const page = await owner.page(located(res));
    expect(page.html).toContain('id="hours-saved"');
    const said = /(\d+) scheduled jobs are outside the new hours/u.exec(page.html);
    expect(said).not.toBeNull();
    expect(page.html).toContain('href="/jobs?branch=br_dubai&amp;outside_hours=1"');
    const list = await owner.page("/jobs?branch=br_dubai&outside_hours=1");
    expect(list.status).toBe(200);
    expect(list.html).toContain(number);
    expect(list.html.match(/<tr id="job-/gu)?.length).toBe(Number(said?.[1]));
    expect((await owner.page("/jobs?branch=br_dubai")).html.match(/<tr id="job-/gu)?.length).toBeGreaterThan(Number(said?.[1]));
    // The jobs are where they were.
    expect(rows("select scheduled_start, status from app__jobs where id = ?", [job])).toEqual([{ scheduled_start: friday.at15, status: "scheduled" }]);
  });

  test("the same week again changes nothing more, and opening Friday brings its slots back", async () => {
    expect((await owner.action("/admin/branches", "hours", week({ closed_5: "on" }))).status).toBe(303);
    expect(hoursRows().length).toBe(5);
    expect((await owner.action("/admin/branches", "hours", week())).status).toBe(303);
    expect(hoursRows().length).toBe(6);
    expect((await pickerStarts()).length).toBeGreaterThan(0);
    expect(await toolDays()).toContain(friday.day);
    // The 15:00 job is inside Friday's 14:00 to 18:00 again.
    const list = await owner.page("/jobs?branch=br_dubai&outside_hours=1");
    expect(list.html).not.toContain(String(rows("select number from app__jobs where id = ?", [job])[0]?.number));
  });

  test("in Arabic: the hours form", async () => {
    expect((await owner.page("/admin/branches?lang=ar")).status).toBe(200);
    const ar = await owner.page("/admin/branches");
    const bad = await owner.action("/admin/branches", "hours", week({ open_5: "15:00", close_5: "14:30" }));
    expect((await owner.page("/admin/branches?lang=en")).status).toBe(200);
    expect(ar.html).toContain("الجمعة");
    expect(bad.status).toBe(422);
    expect(bad.html).toContain("ساعات العمل: الجمعة");
    snapshot(form(ar.html), { role: "branch hours form, owner, ar" });
    snapshot(form(bad.html), { role: "branch hours form, a 422 on Friday, owner, ar" });
  });
});
