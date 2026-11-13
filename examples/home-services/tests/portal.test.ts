// Customer identity (#774): a person who signs in with their phone only is a
// customer and nothing else. Their phone links them to their customer rows in
// every branch, `/my` greets them and asks their name once, `customerDb` reads
// their rows and no one else's, and every staff page refuses them. Staff cannot
// use the customer path: by phone, a staff member without a second factor is
// refused, and one with a second factor still passes it and lands on `/`.
// Runs on the local worker with the seed's users (password below); the phone
// sign-ins go through auth's real pages (tests/outbox.ts phoneSignIn: a code
// goes out through WhatsApp, and the test plants its own in auth's store). auth
// makes at most 3 accounts an hour per IP address: this file signs up one.
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { totp, type Row } from "@renoxium/sdk";
import { app } from "@renoxium/sdk/test";

import { customerDb } from "../lib/customer-db";
import type { Scopable } from "../lib/scope";
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
const write = (sql: string, params: (string | number | null)[]) => rw((db) => db.run(sql, params));
const located = (res: { headers: Headers }) => res.headers.get("location") ?? "";

async function signIn(jar: string, email: string, next = "/") {
  const u = t.as(jar);
  expect((await u.action("/auth/login", "default", { email, password: PASSWORD, next })).status).toBe(303);
  return u;
}

// Layla Haddad is a customer of Dubai (cu_dxb_01, +971501110001) and, here, of Sharjah too.
const LAYLA = "+971501110001";
rw((db) => db.run("insert into app__customers (id, branch_id, kind, name, trn, phone, email, language, created_at) values ('cu_shj_layla', 'br_sharjah', 'household', 'Layla Haddad', null, ?, null, 'ar', 1793200000)", [LAYLA]));

const layla = t.as("layla");
const signedUp = await phoneSignIn(layla, rows, write, LAYLA, "/");
const laylaId = String(rows("select id from auth__users where phone = ?", [LAYLA])[0]?.id ?? "");

describe("a phone-only customer", () => {
  test("normal case: the sign-up by phone makes an account with no password, and / sends them to /my", async () => {
    expect(signedUp.status).toBe(303);
    expect(laylaId).not.toBe("");
    expect(String(rows("select password_hash from auth__users where id = ?", [laylaId])[0]?.password_hash)).not.toMatch(/^\$/u);
    const home = await layla.page("/");
    expect(home.status).toBe(303);
    expect(located(home)).toBe("/my");
  });

  test("a phone that matches two customers in two branches links both, and gives the global role customer", async () => {
    expect((await layla.page("/my")).status).toBe(200);
    expect(rows("select id from app__customers where user_id = ? order by id", [laylaId]).map((r) => r.id)).toEqual(["cu_dxb_01", "cu_shj_layla"]);
    expect(rows("select phone from app__customer_users where user_id = ?", [laylaId])).toEqual([{ phone: LAYLA }]);
    expect(rows("select role, scope_type from renox__role_assignments where user_id = ?", [laylaId])).toEqual([{ role: "customer", scope_type: "global" }]);
  });

  test("a customer row with their phone created since is linked on the next visit; another phone's row is not", async () => {
    rw((db) => {
      db.run("insert into app__customers (id, branch_id, kind, name, trn, phone, email, language, created_at) values ('cu_dxb_layla2', 'br_dubai', 'company', 'Haddad Trading', null, ?, null, 'en', 1793300000)", [LAYLA]);
    });
    const page = await layla.page("/my");
    expect(page.status).toBe(200);
    expect(rows("select id from app__customers where user_id = ? order by id", [laylaId]).map((r) => r.id)).toEqual(["cu_dxb_01", "cu_dxb_layla2", "cu_shj_layla"]);
    expect(rows("select count(*) as n from app__customers where user_id is not null and phone != ?", [LAYLA])).toEqual([{ n: 0 }]);
    expect(page.html).toContain("Your customer records with us: 3.");
  });

  test("/my greets them, shows the phone left to right, and asks their name once; an empty name is a 422", async () => {
    const before = await layla.page("/my?lang=en");
    expect(before.html).toMatch(/<h1>Welcome<\/h1>/u);
    expect(before.html).toContain(`<span dir="ltr">${LAYLA}</span>`);
    expect(before.html).toContain('name="display_name"');
    const bad = await layla.action("/my", "name", { display_name: "   " });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain("Enter a name of 1 to 80 characters.");
    expect(bad.html).toContain('aria-invalid="true"');
    const ok = await layla.action("/my", "name", { display_name: "Layla Haddad" });
    expect(ok.status).toBe(303);
    expect(located(ok)).toBe("/my?saved=name");
    const after = await layla.page("/my?saved=name");
    expect(after.html).toContain("Hello, Layla Haddad");
    expect(after.html).toContain("Thank you, your name is saved.");
    expect(after.html).not.toContain('name="display_name"');
  });

  test("Arabic: the portal speaks Arabic, right to left", async () => {
    const ar = await layla.page("/my?lang=ar");
    expect(ar.html).toMatch(/<html lang="ar" dir="rtl"/u);
    expect(ar.html).toContain("تسجيل الخروج");
    expect(ar.html).toContain("مرحبًا");
    await layla.page("/my?lang=en");
  });

  test("the portal layout has the brand, the language switch and Sign out, and no staff navigation", async () => {
    const page = await layla.page("/my");
    expect(page.html).toContain("FixIt Services");
    expect(page.html).toContain('class="i18n-language"');
    expect(page.html).toContain('action="?/signout"');
    for (const staff of ['href="/jobs"', 'href="/dispatch"', 'href="/invoices"', 'href="/contracts"', 'href="/admin"', 'href="/reports', 'href="/customers"', 'href="/me"']) expect(page.html).not.toContain(staff);
  });

  // The issue (#774 task 5) asks for a 303 to /my on every staff route. A page's `guard` deny is a 403 decided in Rust
  // before its loader runs (#795), and no guard is weakened for it: a guarded route REFUSES the customer with a 403,
  // the unguarded `/` sends them to /my. When #795 lands, the guarded ones become 303s to /my as well.
  const STAFF_ROUTES: { path: string; refusal: 403 | "/my" }[] = [
    { path: "/", refusal: "/my" },
    { path: "/dispatch", refusal: 403 },
    { path: "/jobs", refusal: 403 },
    { path: "/customers", refusal: 403 },
    { path: "/quotes", refusal: 403 },
    { path: "/invoices", refusal: 403 },
    { path: "/contracts", refusal: 403 },
    { path: "/reports/outstanding", refusal: 403 },
    { path: "/services", refusal: 403 },
    { path: "/admin", refusal: 403 },
    { path: "/admin/people", refusal: 403 },
    { path: "/me", refusal: 403 },
  ];
  for (const r of STAFF_ROUTES) {
    test(`refused on ${r.path} (${r.refusal === 403 ? "403, guarded" : "303 to /my"})`, async () => {
      const res = await layla.page(r.path);
      if (r.refusal === 403) expect(res.status).toBe(403);
      else {
        expect(res.status).toBe(303);
        expect(located(res)).toBe(r.refusal);
      }
      expect(res.html).not.toContain("Layla");
    });
  }
});

describe("customerDb", () => {
  // The fence of db.scoped() is the worker's (tested with the pages); here, a database without it, to show that
  // customerDb's own customer filter holds by itself: every statement names the customer.
  const db = new Database(t.dbFile, { readonly: true });
  db.exec("pragma busy_timeout = 5000");
  const statements = {
    query: async <T extends Row = Row>(sql: string, params: readonly (string | number | null)[] = []) => db.query(sql).all(...(params as (string | number | null)[])) as T[],
    queryOne: async <T extends Row = Row>(sql: string, params: readonly (string | number | null)[] = []) => (db.query(sql).get(...(params as (string | number | null)[])) ?? null) as T | null,
    execute: async () => {
      throw new Error("read only");
    },
  };
  const fake = { ...statements, scoped: () => statements } as unknown as Scopable;
  const cdb = customerDb(fake, { user_id: "u", customers: [{ id: "cu_dxb_01", branch_id: "br_dubai" }, { id: "cu_shj_layla", branch_id: "br_sharjah" }] });

  test("reads the customer's own job by id, and not another customer's (same branch, other branch)", async () => {
    expect((await cdb.job("jb_seed_01"))?.id).toBe("jb_seed_01");
    expect(await cdb.job("jb_seed_02")).toBeNull();
    expect(await cdb.job("jb_seed_15")).toBeNull();
  });

  test("every list holds only the customer's rows", async () => {
    const mine = new Set(["cu_dxb_01", "cu_shj_layla"]);
    const jobs = await cdb.jobs();
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => mine.has(String(j.customer_id)))).toBe(true);
    expect((await cdb.sites()).every((s) => mine.has(String(s.customer_id)))).toBe(true);
    expect((await cdb.invoices()).every((i) => mine.has(String(i.customer_id)))).toBe(true);
    expect((await cdb.contracts()).every((c) => mine.has(String(c.customer_id)))).toBe(true);
    const jobIds = new Set(jobs.map((j) => j.id));
    expect((await cdb.visits()).every((v) => jobIds.has(v.job_id))).toBe(true);
    expect((await cdb.customers()).map((c) => c.id).sort()).toEqual(["cu_dxb_01", "cu_shj_layla"]);
  });

  test("the customer's invoice and its payments are theirs; another customer's view of them is empty", async () => {
    // The seed's one invoice, INV-000001 (J-000013), is Layla's (cu_dxb_01), with a payment.
    expect((await cdb.invoice("INV-000001"))?.customer_id).toBe("cu_dxb_01");
    expect((await cdb.payments("INV-000001")).length).toBeGreaterThan(0);
    const peter = customerDb(fake, { user_id: "u2", customers: [{ id: "cu_dxb_02", branch_id: "br_dubai" }] });
    expect(await peter.invoice("INV-000001")).toBeNull();
    expect(await peter.payments("INV-000001")).toEqual([]);
    expect(await peter.job("jb_seed_13")).toBeNull();
    expect((await peter.job("jb_seed_02"))?.customer_id).toBe("cu_dxb_02");
  });

  test("a portal user with no customer rows reads nothing", async () => {
    const none = customerDb(fake, { user_id: "u", customers: [] });
    expect(none.customer_ids).toEqual([]);
    expect(await none.jobs()).toEqual([]);
    expect(await none.job("jb_seed_01")).toBeNull();
  });
});

describe("staff and /my", () => {
  test("a dispatcher who opens /my goes to /", async () => {
    const dispatcher = await signIn("dispatcher", "dispatcher.dubai@fixit.example");
    const res = await dispatcher.page("/my");
    expect(res.status).toBe(303);
    expect(located(res)).toBe("/");
    expect((await dispatcher.page("/")).status).toBe(200);
  });

  test("a signed-out visitor on /my goes to phone sign-in, coming back to /my", async () => {
    const res = await t.as("anonymous").page("/my");
    expect(res.status).toBe(303);
    expect(located(res)).toBe("/auth/phone?next=%2Fmy");
  });
});

describe("staff cannot use the customer path (task 7)", () => {
  test("a staff member without a second factor who signs in by phone is refused and told to use their email and password", async () => {
    const phone = "+971500000201";
    rw((db) => db.run("update auth__users set phone = ?, phone_verified_at = ? where id = 'u_shj_dispatcher'", [phone, Date.now()]));
    const sami = t.as("sami-phone");
    const res = await phoneSignIn(sami, rows, write, phone, "/");
    expect(res.status).toBe(403);
    expect(res.html).toContain("Staff accounts cannot sign in with a phone code. Please sign in with your email and password.");
    expect(res.html).toContain('href="/auth/login?next=%2F"');
    // No session started: they are still signed out.
    expect(located(await sami.page("/my"))).toBe("/auth/phone?next=%2Fmy");
    expect(rows("select count(*) as n from renox__role_assignments where user_id = 'u_shj_dispatcher' and role = 'customer'")).toEqual([{ n: 0 }]);
  });

  test("a staff member with a second factor who signs in by phone passes it and lands on /, never on /my", async () => {
    const email = "manager.dubai@fixit.example";
    const enrolling = await signIn("manager-enrol", email);
    const enrol = await enrolling.page("/2fa/enroll/totp");
    const secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(enrol.html)?.[1] ?? "").replace(/ /gu, "");
    expect((await enrolling.action("/2fa/enroll/totp", "confirm", { code: await totp(secret) })).status).toBe(200);
    const phone = "+971500000202";
    rw((db) => db.run("update auth__users set phone = ?, phone_verified_at = ? where id = 'u_dxb_manager'", [phone, Date.now()]));
    const mona = t.as("mona-phone");
    const halted = await phoneSignIn(mona, rows, write, phone, "/");
    expect(halted.status).toBe(303);
    expect(located(halted)).toBe("/2fa/verify?next=%2F");
    const passed = await mona.action("/2fa/verify", "totp", { code: await totp(secret, Date.now() / 1000 + 30), next: "/" });
    expect(passed.status).toBe(303);
    expect(located(passed)).toBe("/");
    const home = await mona.page("/");
    expect(home.status).toBe(200);
    expect(home.html).toContain('href="/jobs"');
    expect(located(await mona.page("/my"))).toBe("/");
    expect(rows("select count(*) as n from renox__role_assignments where user_id = 'u_dxb_manager' and role = 'customer'")).toEqual([{ n: 0 }]);
  });
});

describe("signing out", () => {
  test("Sign out ends the customer's session: /my asks for the phone again", async () => {
    const out = await layla.action("/my", "signout", {});
    expect(out.status).toBe(303);
    expect(located(out)).toBe("/");
    expect(located(await layla.page("/my"))).toBe("/auth/phone?next=%2Fmy");
  });
});
