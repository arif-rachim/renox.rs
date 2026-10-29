// docs/04-isolation-security.md (cookies row): the session and the OAuth
// flow cookies are `__Host-` (so Path=/, no Domain, Secure), HttpOnly, and
// SameSite=Lax; logout clears the session cookie.

import { describe, expect, test } from "bun:test";

import { account, authCookie, PASSWORD, start, worker } from "./helpers.ts";

const t = await start();
const ATTRS = /^__Host-renox_(auth|oauth)=[^;]*; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+$/u;

describe.skipIf(!worker)("cookie attributes", () => {
  test("session, logout and OAuth flow cookies", async () => {
    await account(t, "cat", "cat@example.com");
    const session = authCookie(await t.as("cat").action("/auth/login", "default", { email: "cat@example.com", password: PASSWORD })) as string;
    expect(session).toMatch(ATTRS);
    expect(session).not.toMatch(/Domain=/iu);
    const cleared = authCookie(await t.as("cat").action("/auth/account", "logout", {})) as string;
    expect(cleared).toMatch(ATTRS);
    expect(cleared).toContain("Max-Age=0");
    const flow = (await t.request("GET", "/auth/oauth/google/start")).headers.getSetCookie().find((c) => c.startsWith("__Host-renox_oauth=")) as string;
    expect(flow).toMatch(ATTRS);
  });
});
