// Password reset (#240): the request answers the same for any email, the
// link sets a new password once, every session is signed out, and
// auth.password_changed is delivered.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

const resetMails = () => t.db.query<{ url: string }>("select url from mailer__sent where template = 'password_reset' order by seq");

describe.skipIf(!worker)("password reset", () => {
  test("reset once: new password, other sessions out, the event; the link again is refused", async () => {
    await t.as("noor").action("/auth/register", "default", { email: "noor@example.com", password: "correct horse battery" });
    const laptop = t.as("noor-laptop");
    await laptop.action("/auth/login", "default", { email: "noor@example.com", password: "correct horse battery" });
    expect((await laptop.page("/private")).status).toBe(200);
    await t.as("noor").action("/auth/reset", "default", { email: "noor@example.com" });
    const url = new URL(resetMails().at(-1)?.url as string);
    const token = url.searchParams.get("token") as string;
    const form = await t.as("noor").page(`${url.pathname}${url.search}`);
    expect(form.status).toBe(200);
    const done = await t.as("noor").action("/auth/reset/confirm", "default", { token, password: "a brand new passphrase" });
    expect(done.status).toBe(303);
    expect(done.headers.getSetCookie().some((c) => c.startsWith("__Host-renox_auth="))).toBe(true);
    expect((await laptop.page("/private")).status).toBe(303);
    const old = await t.as("noor-old").action("/auth/login", "default", { email: "noor@example.com", password: "correct horse battery" });
    expect(old.status).toBe(200);
    const fresh = await t.as("noor-new").action("/auth/login", "default", { email: "noor@example.com", password: "a brand new passphrase" });
    expect(fresh.status).toBe(303);
    // Reuse of the token: refused, the password stays.
    const reuse = await t.as("noor").action("/auth/reset/confirm", "default", { token, password: "attacker chosen passphrase" });
    expect(reuse.status).toBe(200);
    expect(reuse.html).toContain("expired or was already used");
    let events: { name: string }[] = [];
    for (let i = 0; i < 100 && events.length === 0; i++) {
      await Bun.sleep(50);
      events = t.db.query<{ name: string }>("select name from mailer__events");
    }
    expect(events).toEqual([{ name: "auth.password_changed" }]);
  });
});
