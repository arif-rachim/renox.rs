// docs/24-threat-model.md F4, "Session fixation"; docs/23-failure-modes.md
// section 5: a session token planted in the victim's browser before sign-in
// is revoked at sign-in (a new token is issued), and a privilege change
// (password change) rotates the session and signs out every other one.

import { describe, expect, test } from "bun:test";

import { account, authCookie, PASSWORD, start, worker } from "./helpers.ts";

const t = await start();

describe.skipIf(!worker)("session fixation", () => {
  test("a planted token is revoked when the victim signs in; the attacker's copy opens nothing", async () => {
    await account(t, "mallory", "mallory@example.com");
    // The attacker's own valid session token...
    const planted = (authCookie(await t.as("mallory").action("/auth/login", "default", { email: "mallory@example.com", password: PASSWORD })) as string).split(";")[0] as string;
    await t.as("setup").action("/auth/register", "default", { email: "victim@example.com", password: PASSWORD, display_name: "victim" });
    // ...planted in the victim's browser, which then signs in as the victim.
    const browser = t.as("victim-browser");
    browser.cookie("__Host-renox_auth", planted.split("=")[1] as string);
    const signedIn = await browser.action("/auth/login", "default", { email: "victim@example.com", password: PASSWORD });
    expect(signedIn.status).toBe(303);
    const issued = (authCookie(signedIn) as string).split(";")[0] as string;
    expect(issued).not.toBe(planted);
    // The planted token is dead: neither mallory nor the victim's browser can use it.
    expect((await t.request("GET", "/private", { headers: { cookie: planted } })).status).toBe(303);
    expect((await t.request("GET", "/private", { headers: { cookie: issued } })).html).toContain("Hello victim");
  });

  test("a password change rotates this session and signs out the others", async () => {
    await account(t, "rita", "rita@example.com");
    const other = t.as("rita-tablet");
    await other.action("/auth/login", "default", { email: "rita@example.com", password: PASSWORD });
    const before = (authCookie(await t.as("rita").action("/auth/login", "default", { email: "rita@example.com", password: PASSWORD })) as string).split(";")[0] as string;
    const changed = await t.as("rita").action("/auth/account", "password", { current: PASSWORD, password: "an entirely new passphrase" });
    const after = (authCookie(changed) as string).split(";")[0] as string;
    expect(after).not.toBe(before);
    expect((await t.request("GET", "/private", { headers: { cookie: before } })).status).toBe(303);
    expect((await other.page("/private")).status).toBe(303);
    expect((await t.request("GET", "/private", { headers: { cookie: after } })).status).toBe(200);
  });
});

