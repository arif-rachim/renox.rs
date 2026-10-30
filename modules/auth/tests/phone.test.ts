// Phone-first sign-in (#291): the account adds a phone (a code through
// `auth.send_otp`, here the otpbox fixture standing in for whatsapp), then
// signs in with it. The same answer for an unknown phone (nothing sent),
// 5 attempts per code, single use, expiry, the per-phone bucket, the
// after_login hook halting, and no code in the logs.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, snapshot, type TestApp } from "../../../sdk/src/test.ts";
import { normalizePhone } from "../lib/phone.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

const PHONE = "+971501234567";
const codes = (phone: string) => t.db.query<{ code: string; purpose: string }>("select code, purpose from otpbox__codes where phone = ? order by seq", [phone]);
const lastCode = (phone: string) => codes(phone).at(-1)?.code as string;
const stable = (html: string): string => html.replace(/\b[0-9a-f]{32}\b/gu, "<id>").replace(/\b1[0-9]{9}\b/gu, "<time>");

describe("phone numbers", () => {
  test("E.164, UAE local numbers, refusals", () => {
    expect(normalizePhone("+971 50 123 4567")).toBe(PHONE);
    expect(normalizePhone("050 123 4567")).toBe(PHONE);
    expect(normalizePhone("00971501234567")).toBe(PHONE);
    expect(normalizePhone("+9715012345")).toBeNull();
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });
});

describe.skipIf(!worker)("phone sign-in", () => {
  let ali: TestApp;

  test("the account adds a verified phone", async () => {
    ali = t.as("ali");
    await ali.action("/auth/register", "default", { email: "ali@example.com", password: "correct horse battery", display_name: "Ali" });
    expect((await ali.action("/auth/login", "default", { email: "ali@example.com", password: "correct horse battery" })).status).toBe(303);
    const sent = await ali.action("/auth/account", "phone_send", { phone: "050 123 4567" });
    expect(sent.html).toContain("A code is on its way.");
    expect(codes(PHONE)).toEqual([{ code: expect.stringMatching(/^[0-9]{6}$/u), purpose: "verify" }]);
    const wrong = await ali.action("/auth/account", "phone_verify", { phone: PHONE, code: "000000" === lastCode(PHONE) ? "111111" : "000000" });
    expect(wrong.html).toContain("The code is incorrect");
    const ok = await ali.action("/auth/account", "phone_verify", { phone: PHONE, code: lastCode(PHONE) });
    expect(ok.html).toContain("Phone number verified.");
    expect(t.db.query("select phone from auth__users where email = 'ali@example.com' and phone_verified_at is not null")).toEqual([{ phone: PHONE }]);
    // The code is stored as argon2id, never in clear.
    expect(t.db.query("select 1 from auth__phone_codes where code_hash not like '$argon2id$%'")).toEqual([]);
  });

  test("sign in with the phone; an unknown phone gets the same answer and no code", async () => {
    const page = await t.as("visitor").page("/auth/login");
    expect(page.html).toContain('href="phone?next=%2F"');
    expect(page.html).toContain('href="passkeys/login?next=%2F"');
    const v = t.as("phone-visitor");
    const r = await v.action("/auth/phone", "default", { phone: "+971 50 123 4567", next: "/" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`/auth/phone/verify?phone=${encodeURIComponent(PHONE)}&next=%2F`);
    const unknown = await v.action("/auth/phone", "default", { phone: "+971509999999", next: "/" });
    expect(unknown.status).toBe(303);
    expect(codes("+971509999999")).toEqual([]);
    const verify = await v.page(`/auth/phone/verify?phone=${encodeURIComponent(PHONE)}`);
    snapshot(stable(verify.html), { role: "phone verify" });
    const code = lastCode(PHONE);
    const done = await v.action("/auth/phone/verify", "default", { phone: PHONE, code, next: "/" });
    expect(done.status).toBe(303);
    expect(done.headers.getSetCookie().some((c) => c.startsWith("__Host-renox_auth="))).toBe(true);
    expect((await v.request("GET", "/api/me")).status).toBe(200);
    // Single use.
    const again = await t.as("replay").action("/auth/phone/verify", "default", { phone: PHONE, code, next: "/" });
    expect(again.status).toBe(200);
    expect(again.html).toContain("The code is incorrect");
  });

  test("5 attempts per code; an expired code; the halt of auth.after_login", async () => {
    const v = t.as("guesser");
    await v.action("/auth/phone", "default", { phone: PHONE, next: "/" });
    const right = lastCode(PHONE);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await v.action("/auth/phone/verify", "default", { phone: PHONE, code: wrong, next: "/" })).html).toContain("The code is incorrect");
    expect((await v.action("/auth/phone/verify", "default", { phone: PHONE, code: right, next: "/" })).html).toContain("The code is incorrect");
    // Expired.
    await v.action("/auth/phone", "default", { phone: PHONE, next: "/" });
    const rw = new Database(t.dbFile);
    rw.exec("pragma busy_timeout = 5000");
    try {
      rw.query("update auth__phone_codes set expires_at = 1 where phone = ?").run(PHONE);
    } finally {
      rw.close();
    }
    expect((await v.action("/auth/phone/verify", "default", { phone: PHONE, code: lastCode(PHONE), next: "/" })).html).toContain("The code is incorrect");
    // The hook halts: no session, the filler's answer.
    const id = t.db.query<{ id: string }>("select id from auth__users where email = 'ali@example.com'")[0]?.id as string;
    const rw2 = new Database(t.dbFile);
    rw2.exec("pragma busy_timeout = 5000");
    try {
      rw2.query("insert into otpbox__halt (user_id) values (?)").run(id);
      rw2.query("delete from auth__attempts").run();
    } finally {
      rw2.close();
    }
    await v.action("/auth/phone", "default", { phone: PHONE, next: "/" });
    const halted = await v.action("/auth/phone/verify", "default", { phone: PHONE, code: lastCode(PHONE), next: "/" });
    expect(halted.status).toBe(401);
    expect(halted.html).toBe("second factor");
    expect(halted.headers.getSetCookie().filter((c) => c.startsWith("__Host-renox_auth="))).toEqual([]);
    const rw3 = new Database(t.dbFile);
    rw3.exec("pragma busy_timeout = 5000");
    try {
      rw3.query("delete from otpbox__halt").run();
    } finally {
      rw3.close();
    }
  });

  test("5 codes per phone in 15 minutes; no code in the logs", async () => {
    const v = t.as("spammer");
    const before = codes(PHONE).length;
    for (let i = 0; i < 8; i++) await v.action("/auth/phone", "default", { phone: PHONE, next: "/" });
    expect(codes(PHONE).length - before).toBeLessThanOrEqual(5);
    const logs = JSON.stringify(t.logs());
    for (const c of codes(PHONE)) expect(logs).not.toContain(`"${c.code}"`);
  });
});
