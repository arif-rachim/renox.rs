// Per-role template snapshots (#241; module definition of done 8): the
// auth pages and the app header's user menu, anonymous and signed in
// (admin is reserved for F5's policies). What changes per request (ids,
// nonces, CSRF tokens, times) is stripped before the comparison.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, snapshot, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

const stable = (html: string): string => html.replace(/since \d+/gu, "since <time>");

describe.skipIf(!worker)("snapshots per role", () => {
  test("anonymous: login, register, the account redirect, the header", async () => {
    const anon = t.as("anonymous-visitor");
    snapshot(stable((await anon.page("/auth/login")).html), { role: "anonymous login" });
    snapshot(stable((await anon.page("/auth/register")).html), { role: "anonymous register" });
    const account = await anon.page("/auth/account");
    expect(account.status).toBe(303);
    snapshot(account.headers.get("location") ?? "", { role: "anonymous account" });
    snapshot(stable((await anon.page("/")).html), { role: "anonymous header" });
  });

  test("user: the account page and the header", async () => {
    const user = t.as("signed-in-user");
    expect((await user.action("/auth/register", "default", { email: "sam@example.com", password: "correct horse battery", display_name: "Sam" })).status).toBe(303);
    snapshot(stable((await user.page("/auth/account")).html), { role: "user account" });
    snapshot(stable((await user.page("/private")).html), { role: "user header" });
    // Signed in, the login page sends the user on.
    expect((await user.page("/auth/login")).status).toBe(303);
  });
});
