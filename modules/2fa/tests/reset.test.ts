// The 2fa `reset` service (#735): an administrator with `twofa.reset` on a
// user, and a recent second factor of their own, deletes that user's second
// factors so their next sign-in enrols again. Security tests of the threat
// model row "Account takeover" (docs/24-threat-model.md): a stolen session
// or a rogue operator cannot strip a user's second factor without the
// action, a recent second factor, or by resetting themselves; the refusals
// leave the data untouched; the event carries no secret.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";
import { totp } from "../../../sdk/src/totp.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";

/** Register a user, sign in and turn TOTP on; the session counts as verified. */
async function enrol(name: string): Promise<{ jar: TestApp; id: string; secret: string }> {
  const jar = t.as(name);
  const email = `${name}@example.com`;
  await jar.action("/auth/register", "default", { email, password: PASSWORD, display_name: name });
  await jar.action("/auth/login", "default", { email, password: PASSWORD, next: "/" });
  const page = await jar.page("/2fa/enroll/totp");
  const secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(page.html)?.[1] ?? "").replace(/ /gu, "");
  await jar.action("/2fa/enroll/totp", "confirm", { code: await totp(secret) });
  const id = t.db.query<{ id: string }>("select id from auth__users where email = ?", [email])[0]?.id as string;
  return { jar, id, secret };
}

const reset = async (u: TestApp, userId: string) => {
  const r = await u.request("POST", "/api/reset", { body: { user_id: userId } });
  return { status: r.status, body: r.json<{ reset?: boolean; error?: string; message?: string }>() };
};
const rows = (table: string, id: string) => t.db.query<{ n: number }>(`select count(*) as n from ${table} where user_id = ?`, [id])[0]?.n ?? 0;
/** The deliveries of `twofa.reset` the test app's listener (app/hooks.ts) logged; the outbox is delivered in the background, so wait a little. */
const events = async (expected = 0): Promise<{ payload: Record<string, unknown> }[]> => {
  const seen = () => t.logs().filter((l) => l.message === "twofa.reset seen").map((l) => ({ payload: (l.fields as { payload: Record<string, unknown> }).payload }));
  for (let i = 0; i < 40 && seen().length < expected; i++) await Bun.sleep(50);
  await Bun.sleep(150);
  return seen();
};

describe.skipIf(!worker)("2fa reset", () => {
  let admin: Awaited<ReturnType<typeof enrol>>;
  let plain: Awaited<ReturnType<typeof enrol>>;
  let target: Awaited<ReturnType<typeof enrol>>;

  test("setup: three enrolled users, one of them support", async () => {
    admin = await enrol("ada");
    plain = await enrol("pam");
    target = await enrol("tom");
    expect((await admin.jar.request("POST", "/api/support")).status).toBe(200);
    expect(rows("twofa__totp", target.id)).toBe(1);
  });

  test("refused without the action: RENOX_FORBIDDEN, nothing deleted", async () => {
    const r = await reset(plain.jar, target.id);
    expect(r.body.error).toBe("RENOX_FORBIDDEN");
    expect(rows("twofa__totp", target.id)).toBe(1);
    expect(rows("twofa__recovery", target.id)).toBeGreaterThan(0);
    expect(await events()).toHaveLength(0);
  });

  test("a user cannot reset themselves through it, even with the action", async () => {
    const r = await reset(admin.jar, admin.id);
    expect(r.body.message).toContain("SELF_RESET");
    expect(rows("twofa__totp", admin.id)).toBe(1);
    expect(await events()).toHaveLength(0);
  });

  test("not a user id: INVALID", async () => {
    expect((await reset(admin.jar, "")).body.message).toContain("INVALID");
    expect((await reset(admin.jar, 7 as unknown as string)).body.message).toContain("INVALID");
  });

  test("refused without a recent second factor: the step-up message", async () => {
    const db = new Database(t.dbFile);
    db.exec("pragma busy_timeout = 5000");
    db.query("update twofa__sessions set verified_at = verified_at - 20 * 60000 where user_id = ?").run(admin.id);
    db.close();
    const r = await reset(admin.jar, target.id);
    // A plain error of the module reaches another module as RENOX_MODULE_SERVICE with its message.
    expect(r.body.message).toContain("Confirm it is you with your second factor first.");
    expect(rows("twofa__totp", target.id)).toBe(1);
    expect(await events()).toHaveLength(0);
    // The administrator steps up again (a fresh TOTP code of the next window).
    const up = await admin.jar.action("/2fa/verify", "totp", { code: await totp(admin.secret, Date.now() / 1000 + 30), next: "/" });
    expect(up.status).toBe(303);
  });

  test("allowed: the target's factors, codes and sessions are gone, and the event is emitted once without a secret", async () => {
    expect(rows("twofa__sessions", target.id)).toBe(1);
    const r = await reset(admin.jar, target.id);
    expect(r.status).toBe(200);
    expect(r.body.reset).toBe(true);
    for (const table of ["twofa__totp", "twofa__webauthn", "twofa__recovery", "twofa__sessions", "twofa__pending", "twofa__challenges"]) expect(rows(table, target.id)).toBe(0);
    // The others are untouched.
    expect(rows("twofa__totp", plain.id)).toBe(1);
    expect(rows("twofa__totp", admin.id)).toBe(1);
    const ev = await events(1);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toEqual({ user_id: target.id, by: admin.id });
    expect(JSON.stringify(t.logs())).not.toContain(target.secret);
    // Nothing left to delete: { reset: false } and no second event.
    const again = await reset(admin.jar, target.id);
    expect(again.body.reset).toBe(false);
    expect(await events()).toHaveLength(1);
  });

  test("the target enrols again at the next sign-in: not sent to /2fa/verify", async () => {
    const jar = t.as("tom-again");
    const r = await jar.action("/auth/login", "default", { email: "tom@example.com", password: PASSWORD, next: "/" });
    expect(r.headers.get("location") ?? "").not.toContain("/2fa/verify");
    expect(r.headers.getSetCookie().some((c) => c.startsWith("__Host-renox_auth=") && !c.startsWith("__Host-renox_auth=;"))).toBe(true);
    expect(r.headers.getSetCookie().some((c) => c.startsWith("__Host-renox_2fa="))).toBe(false);
    // The enrolment page offers a new secret.
    const page = await jar.page("/2fa/enroll/totp");
    expect(page.html).toMatch(/id="secret"[^>]*>[A-Z2-7 ]+</u);
  });
});
