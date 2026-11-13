// Sign-up by phone (#773) under a worker, in the app of tests/app_signup
// (phone_login and phone_signup on): a new phone gets a code through
// `auth.send_otp` (the otpbox fixture), the code creates the account and a
// session, the second sign-in creates no second user, a known and an unknown
// phone are answered byte for byte alike, a phone-only user has no password
// or reset path, and `auth.after_login` still runs. The library level (argon2
// runs, events, the per-IP cap) is in phone-signup-unit.test.ts.
//
// Every request shares one client address, so the file creates two accounts
// at most (3 an hour).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, type Reply, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "signup_app");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

const NEW_PHONE = "+971507770001";
const UNKNOWN = "+971507770002";
const codes = (phone: string) => t.db.query<{ code: string; purpose: string }>("select code, purpose from otpbox__codes where phone = ? order by seq", [phone]);
const lastCode = (phone: string) => codes(phone).at(-1)?.code as string;
const authCookie = (r: Reply) => r.headers.getSetCookie().find((c) => c.startsWith("__Host-renox_auth="));
const userRows = (phone: string) => t.db.query<Record<string, unknown>>("select id, email, display_name, password_hash, phone, phone_verified_at from auth__users where phone = ?", [phone]);
/** Status, headers and body with the phone, the CSP nonce and the request id masked: what a client sees. */
const seen = (r: Reply, phone: string) =>
  JSON.stringify({ status: r.status, body: r.html, headers: [...r.headers.entries()].filter(([k]) => k !== "set-cookie" && k !== "date" && k !== "x-renox-request-id").map(([k, v]) => [k, v.split(encodeURIComponent(phone)).join("<phone>").replace(/nonce-[A-Za-z0-9+/=]+/gu, "nonce-<n>")]).sort() });
const withDb = (f: (db: Database) => void) => {
  const rw = new Database(t.dbFile);
  rw.exec("pragma busy_timeout = 5000");
  try {
    f(rw);
  } finally {
    rw.close();
  }
};

describe.skipIf(!worker)("phone sign-up", () => {
  let newcomer: TestApp;

  test("a new phone gets a code; the correct code creates the account and a session", async () => {
    newcomer = t.as("newcomer");
    const page = await newcomer.page("/auth/phone");
    expect(page.html).toContain("New here? Enter your number and we will set up your account.");
    const r = await newcomer.action("/auth/phone", "default", { phone: "+971 50 777 0001", next: "/" });
    expect(r.status).toBe(303);
    expect(codes(NEW_PHONE)).toEqual([{ code: expect.stringMatching(/^[0-9]{6}$/u), purpose: "login" }]);
    // Pending: no user yet, and nothing in the public view.
    expect(userRows(NEW_PHONE)).toEqual([]);
    expect(t.db.query("select count(*) as n from auth__phone_signups")).toEqual([{ n: 1 }]);
    expect(t.db.query("select code_hash from auth__phone_signups where code_hash not like '$argon2id$%'")).toEqual([]);
    const verifyPage = await newcomer.page(`/auth/phone/verify?phone=${encodeURIComponent(NEW_PHONE)}`);
    expect(verifyPage.html).toContain("A code is on its way to this number.");
    expect((await newcomer.action("/auth/phone/verify", "default", { phone: NEW_PHONE, code: lastCode(NEW_PHONE) === "000000" ? "111111" : "000000", next: "/" })).html).toContain("The code is incorrect");
    const done = await newcomer.action("/auth/phone/verify", "default", { phone: NEW_PHONE, code: lastCode(NEW_PHONE), next: "/" });
    expect(done.status).toBe(303);
    expect(authCookie(done)).toBeDefined();
    expect((await newcomer.request("GET", "/api/me")).status).toBe(200);
    const rows = userRows(NEW_PHONE);
    expect(rows).toEqual([{ id: expect.any(String), email: expect.stringMatching(/^!phone:/u), display_name: "", password_hash: "!phone", phone: NEW_PHONE, phone_verified_at: expect.any(Number) }]);
    expect(t.db.query("select count(*) as n from auth__phone_signups")).toEqual([{ n: 0 }]);
    // The code is single use.
    const replay = await t.as("replay").action("/auth/phone/verify", "default", { phone: NEW_PHONE, code: lastCode(NEW_PHONE), next: "/" });
    expect(replay.html).toContain("The code is incorrect");
    // The principal says: phone verified, email not.
    const p = (await newcomer.request("GET", "/api/principal")).json<{ attrs: Record<string, unknown> }>();
    expect(p.attrs).toMatchObject({ phone_verified: true, email_verified: false });
  });

  test("the second sign-in creates no second user", async () => {
    const again = t.as("newcomer-again");
    await again.action("/auth/phone", "default", { phone: NEW_PHONE, next: "/" });
    expect(t.db.query("select count(*) as n from auth__phone_signups")).toEqual([{ n: 0 }]);
    const done = await again.action("/auth/phone/verify", "default", { phone: NEW_PHONE, code: lastCode(NEW_PHONE), next: "/" });
    expect(done.status).toBe(303);
    expect(authCookie(done)).toBeDefined();
    expect(userRows(NEW_PHONE).length).toBe(1);
    expect(t.db.query("select count(*) as n from auth__users")).toEqual([{ n: 1 }]);
  });

  test("a known and an unknown phone are answered byte for byte alike", async () => {
    const a = await t.as("probe-known").action("/auth/phone", "default", { phone: NEW_PHONE, next: "/" });
    const b = await t.as("probe-unknown").action("/auth/phone", "default", { phone: UNKNOWN, next: "/" });
    expect(seen(b, UNKNOWN)).toBe(seen(a, NEW_PHONE));
    // Both got a code.
    expect(codes(UNKNOWN).length).toBe(1);
  });

  test("a wrong code five times locks the code of a new phone; no user results", async () => {
    // UNKNOWN has a pending code from the test above.
    const right = lastCode(UNKNOWN);
    const wrong = right === "000000" ? "111111" : "000000";
    const g = t.as("guesser");
    for (let i = 0; i < 5; i++) expect((await g.action("/auth/phone/verify", "default", { phone: UNKNOWN, code: wrong, next: "/" })).html).toContain("The code is incorrect");
    const late = await g.action("/auth/phone/verify", "default", { phone: UNKNOWN, code: right, next: "/" });
    expect(late.html).toContain("The code is incorrect");
    expect(authCookie(late)).toBeUndefined();
    expect(userRows(UNKNOWN)).toEqual([]);
  });

  test("a phone-only user cannot sign in with a password, and gets no password-reset or magic-link mail", async () => {
    const email = userRows(NEW_PHONE)[0]?.email as string;
    const v = t.as("attacker");
    for (const [e, pw] of [[email, "!phone"], [email, "correct horse battery"], ["", "correct horse battery"], ["", ""]] as const) {
      const r = await v.action("/auth/login", "default", { email: e, password: pw, next: "/" });
      expect(r.status).toBe(200);
      expect(authCookie(r)).toBeUndefined();
      expect(r.html).toContain("incorrect");
    }
    const mails = () => t.db.query<{ n: number }>("select count(*) as n from mailer__sent")[0]?.n;
    const before = mails();
    const reset = await v.action("/auth/reset", "default", { email });
    expect(reset.status).toBe(200);
    await v.action("/auth/magic", "default", { email });
    expect(mails()).toBe(before);
    // Registering that address is refused (no `@`).
    expect((await v.action("/auth/register", "default", { email, password: "correct horse battery", display_name: "x" })).html).toContain("valid email");
  });

  test("setDisplayName and hasPassword for the signed-in user", async () => {
    const auth = newcomer.service("auth");
    expect(await auth.hasPassword()).toBe(false);
    expect(await auth.setDisplayName("  Noor Al Mansoori ")).toEqual({ display_name: "Noor Al Mansoori" });
    expect(userRows(NEW_PHONE)[0]?.display_name).toBe("Noor Al Mansoori");
    expect(await auth.setDisplayName("   ")).toEqual({ error: expect.any(String) });
    expect(await auth.setDisplayName("x".repeat(81))).toEqual({ error: expect.any(String) });
    expect(await auth.setDisplayName("x".repeat(80))).toEqual({ display_name: "x".repeat(80) });
    // Signed out: AUTH_REQUIRED, and no password.
    await expect(t.as("nobody").service("auth").setDisplayName("Eve")).rejects.toThrow();
    expect(await t.as("nobody").service("auth").hasPassword()).toBe(false);
    // An account with a password has one.
    const pw = t.as("pw");
    await pw.action("/auth/register", "default", { email: "pw@example.com", password: "correct horse battery", display_name: "Pw" });
    expect((await pw.action("/auth/login", "default", { email: "pw@example.com", password: "correct horse battery" })).status).toBe(303);
    expect(await pw.service("auth").hasPassword()).toBe(true);
  });

  test("auth.after_login fillers (the second factor) still run for a known user", async () => {
    const id = userRows(NEW_PHONE)[0]?.id as string;
    withDb((db) => db.query("insert into otpbox__halt (user_id) values (?)").run(id));
    const v = t.as("two-factor");
    await v.action("/auth/phone", "default", { phone: NEW_PHONE, next: "/" });
    const halted = await v.action("/auth/phone/verify", "default", { phone: NEW_PHONE, code: lastCode(NEW_PHONE), next: "/" });
    expect(halted.status).toBe(401);
    expect(halted.html).toBe("second factor");
    expect(authCookie(halted)).toBeUndefined();
    withDb((db) => db.query("delete from otpbox__halt").run());
  });
});
