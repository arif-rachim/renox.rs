// The 2fa module on the real worker (#287): enrol TOTP (QR and key), the
// sign-in halted after the password and resumed by the second factor, a
// replayed TOTP code within its window refused, a recovery code single
// use, passkeys with the recorded vectors (sdk/tests/fixtures/webauthn),
// `mfa_verified` flipping on the principal and a refund policy denying
// before and permitting after (docs/23-failure-modes.md "2FA: refund
// denied before mfa_verified, TOTP replay within the window refused,
// recovery code single-use"), step-up expiry, the rate limit on verify,
// snapshots in English and Arabic, and no secret in logs or snapshots.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { app, snapshot, type TestApp } from "../../../sdk/src/test.ts";
import { totp } from "../../../sdk/src/totp.ts";
import { qrMatrix } from "../lib/qr.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

const PASSWORD = "correct horse battery";
const V = (JSON.parse(readFileSync(join(MODULE, "../../sdk/tests/fixtures/webauthn/webauthn.json"), "utf8")) as { es256: { registration: { challenge: string; response: { clientDataJSON: string; attestationObject: string } }; assertion: { challenge: string; response: { clientDataJSON: string; authenticatorData: string; signature: string } }; credentialId: string } }).es256;

const login = (jar: string) => t.as(jar).action("/auth/login", "default", { email: "sara@example.com", password: PASSWORD, next: "/" });
const principal = async (u: TestApp) => (await u.request("GET", "/api/principal")).json<{ attrs: Record<string, unknown> } | null>();
/** The guarded refund route: 200 with mfa_verified, 403 RENOX_FORBIDDEN without. */
const refund = async (u: TestApp) => (await u.request("POST", "/api/refund")).status === 200;
const authCookie = (r: { headers: Headers }) => r.headers.getSetCookie().some((c) => c.startsWith("__Host-renox_auth=") && !c.startsWith("__Host-renox_auth=;"));
const stable = (html: string): string => html.replace(/\btfk_[0-9a-f]+\b/gu, "<passkey>").replace(/\b[0-9a-f]{32}\b/gu, "<id>").replace(/data-options="[^"]*"/gu, 'data-options="<options>"');

function rw(fn: (db: Database) => void) {
  const db = new Database(t.dbFile);
  db.exec("pragma busy_timeout = 5000");
  try {
    fn(db);
  } finally {
    db.close();
  }
}

describe("qr", () => {
  test("an otpauth URI fits; the finder patterns are where they belong", () => {
    const m = qrMatrix("otpauth://totp/shop.example:sara%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=shop.example&algorithm=SHA1&digits=6&period=30");
    expect(m.length % 4).toBe(1);
    for (const [x, y] of [[0, 0], [m.length - 7, 0], [0, m.length - 7]] as const) {
      expect(m[y]?.slice(x, x + 7)).toEqual([true, true, true, true, true, true, true]);
      expect(m[y + 1]?.slice(x, x + 7)).toEqual([true, false, false, false, false, false, true]);
    }
  });
});

describe.skipIf(!worker)("2fa", () => {
  let sara: TestApp;
  let secret = "";
  let codes: string[] = [];
  let confirmCode = "";

  test("enrol TOTP: a QR code and the key; the first code turns it on and shows the recovery codes once", async () => {
    sara = t.as("sara");
    await sara.action("/auth/register", "default", { email: "sara@example.com", password: PASSWORD, display_name: "Sara" });
    // Without a second factor the sign-in is not halted.
    expect(authCookie(await sara.action("/auth/login", "default", { email: "sara@example.com", password: PASSWORD, next: "/" }))).toBe(true);
    expect(await refund(sara)).toBe(false);
    const page = await sara.page("/2fa/enroll/totp");
    expect(page.status).toBe(200);
    expect(page.html).toContain("<svg");
    secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(page.html)?.[1] ?? "").replace(/ /gu, "");
    expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
    // At rest the secret is sealed.
    expect(JSON.stringify(t.db.query("select * from twofa__totp"))).not.toContain(secret);
    confirmCode = await totp(secret);
    const done = await sara.action("/2fa/enroll/totp", "confirm", { code: confirmCode });
    codes = [...done.html.matchAll(/<code dir="ltr">([a-z2-7]{5}-[a-z2-7]{5})<\/code>/gu)].map((m) => m[1] as string);
    expect(codes).toHaveLength(4);
    expect(JSON.stringify(t.db.query("select code_hash from twofa__recovery"))).not.toContain(codes[0] as string);
    // Enrolling proved possession: this session is verified now. The cell
    // caches the principal (60 s, dropped on a role change, login, logout):
    // a role change shows it at once.
    expect((await sara.request("POST", "/api/role")).status).toBe(200);
    let mfa: unknown = false;
    for (let i = 0; i < 40 && mfa !== true; i++) {
      mfa = (await principal(sara))?.attrs.mfa_verified;
      if (mfa !== true) await Bun.sleep(50);
    }
    expect(mfa).toBe(true);
    expect(await refund(sara)).toBe(true);
    // The account page of auth shows the 2fa section through its slot.
    expect((await sara.page("/auth/account")).html).toContain('<a href="/2fa">Manage two-step verification</a>');
  });

  test("sign-in: halted after the password, a replayed code refused, the next code resumes it", async () => {
    const jar = t.as("sara-2");
    const r = await login("sara-2");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/2fa/verify?next=%2F");
    expect(authCookie(r)).toBe(false);
    expect(r.headers.getSetCookie().some((c) => c.startsWith("__Host-renox_2fa="))).toBe(true);
    expect(await principal(jar)).toBeNull();
    expect(await refund(jar)).toBe(false);
    const page = await jar.page("/2fa/verify?next=%2F");
    expect(page.status).toBe(200);
    snapshot(stable(page.html), { role: "verify en" });
    // The code used at enrolment, again within its window: refused.
    const replay = await jar.action("/2fa/verify", "totp", { code: confirmCode, next: "/" });
    expect(replay.status).toBe(200);
    expect(replay.html).toContain("That code or passkey did not work.");
    const next = await totp(secret, Date.now() / 1000 + 30);
    const ok = await jar.action("/2fa/verify", "totp", { code: next, next: "/" });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/");
    expect(authCookie(ok)).toBe(true);
    expect((await principal(jar))?.attrs.mfa_verified).toBe(true);
    expect(await refund(jar)).toBe(true);
    // The same code once more (a new sign-in): refused, it was used.
    await login("sara-2b");
    expect((await t.as("sara-2b").action("/2fa/verify", "totp", { code: next, next: "/" })).html).toContain("That code or passkey did not work.");
  });

  test("a recovery code works once", async () => {
    await login("sara-3");
    const ok = await t.as("sara-3").action("/2fa/verify", "recovery", { code: (codes[0] as string).toUpperCase(), next: "/" });
    expect(ok.status).toBe(303);
    expect(authCookie(ok)).toBe(true);
    await login("sara-4");
    const again = await t.as("sara-4").action("/2fa/verify", "recovery", { code: codes[0] as string, next: "/" });
    expect(again.html).toContain("That code or passkey did not work.");
    expect(t.db.query<{ n: number }>("select count(*) as n from twofa__recovery where used_at is null")[0]?.n).toBe(3);
  });

  test("step-up: the verification expires, mfa_verified turns false and the refund is denied; a recovery code steps up again", async () => {
    const u = t.as("sara-2");
    rw((db) => db.query("update twofa__sessions set verified_at = verified_at - 20 * 60000").run());
    // Drop the cell's cached principal (a role change does).
    expect((await u.request("POST", "/api/role")).status).toBe(200);
    let mfa: unknown = true;
    for (let i = 0; i < 40 && mfa !== false; i++) {
      mfa = (await principal(u))?.attrs.mfa_verified;
      if (mfa !== false) await Bun.sleep(50);
    }
    expect(mfa).toBe(false);
    expect(await refund(u)).toBe(false);
    // Removing a factor needs a recent verification.
    expect((await u.action("/2fa", "remove_totp", {})).html).toContain("Confirm it is you with your second factor first.");
    const step = await u.action("/2fa/verify", "recovery", { code: codes[1] as string, next: "/2fa" });
    expect(step.status).toBe(303);
    expect(step.headers.get("location")).toBe("/2fa");
    expect(t.db.query("select method from twofa__sessions order by verified_at desc limit 1")).toEqual([{ method: "recovery" }]);
  });

  test("passkeys as a second factor (recorded ES256 vectors)", async () => {
    const id = t.db.query<{ id: string }>("select id from auth__users where email = 'sara@example.com'")[0]?.id as string;
    expect((await sara.page("/2fa/enroll/passkey")).html).toContain("navigator.credentials.create");
    rw((db) => db.query("insert or replace into twofa__challenges (challenge, purpose, user_id, expires_at, used_at) values (?, 'register', ?, ?, null)").run(V.registration.challenge, id, Date.now() + 300000));
    const reg = await sara.action("/2fa/enroll/passkey", "default", { name: "Key", client_data: V.registration.response.clientDataJSON, attestation_object: V.registration.response.attestationObject });
    expect(reg.status).toBe(303);
    expect(t.db.query("select credential_id from twofa__webauthn")).toEqual([{ credential_id: V.credentialId }]);
    await login("sara-5");
    const page = await t.as("sara-5").page("/2fa/verify");
    expect(page.html).toContain("navigator.credentials.get");
    rw((db) => db.query("insert or replace into twofa__challenges (challenge, purpose, user_id, expires_at, used_at) values (?, 'verify', ?, ?, null)").run(V.assertion.challenge, id, Date.now() + 300000));
    const ok = await t.as("sara-5").action("/2fa/verify", "passkey", { next: "/", credential_id: V.credentialId, client_data: V.assertion.response.clientDataJSON, authenticator_data: V.assertion.response.authenticatorData, signature: V.assertion.response.signature });
    expect(ok.status).toBe(303);
    expect(authCookie(ok)).toBe(true);
    // Replayed: the challenge is used.
    await login("sara-6");
    const replay = await t.as("sara-6").action("/2fa/verify", "passkey", { next: "/", credential_id: V.credentialId, client_data: V.assertion.response.clientDataJSON, authenticator_data: V.assertion.response.authenticatorData, signature: V.assertion.response.signature });
    expect(replay.html).toContain("That code or passkey did not work.");
  });

  test("verify is rate limited: five failures end the pending sign-in", async () => {
    // (Unused codes so far: the right one below is still refused.)
    rw((db) => db.query("delete from twofa__attempts").run());
    await login("sara-7");
    const u = t.as("sara-7");
    for (let i = 0; i < 5; i++) expect((await u.action("/2fa/verify", "totp", { code: "000000", next: "/" })).html).toContain("That code or passkey did not work.");
    const sixth = await u.action("/2fa/verify", "totp", { code: await totp(secret, Date.now() / 1000 + 30), next: "/" });
    // Even the right code: the pending sign-in ended, back to the login page, no session.
    expect(sixth.status).toBe(303);
    expect(sixth.headers.get("location")).toStartWith("/auth/login?next=");
    expect(authCookie(sixth)).toBe(false);
    expect(t.db.query("select 1 from twofa__pending where attempts >= 5")).toEqual([]);
    const after = await u.page("/2fa/verify");
    expect(after.status).toBe(303);
    expect(after.headers.get("location")).toStartWith("/auth/login?next=");
  });

  test("Arabic; the management page; no secret, key or code in logs or snapshots", async () => {
    const index = await sara.page("/2fa");
    expect(index.html).toContain("Two-step verification is on.");
    snapshot(stable(index.html), { role: "index en" });
    const ar = await sara.page("/2fa/verify?lang=ar");
    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
    snapshot(stable(ar.html), { role: "verify ar" });
    const logs = JSON.stringify(t.logs());
    const snaps = readdirSync(join(import.meta.dir, "__snapshots__"))
      .map((f) => readFileSync(join(import.meta.dir, "__snapshots__", f), "utf8"))
      .join("\n");
    for (const s of [secret, ...codes, "twofa-test-key-0123456789abcdef"]) {
      expect(logs).not.toContain(s);
      expect(snaps).not.toContain(s);
    }
  });
});
