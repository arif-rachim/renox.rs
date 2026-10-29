// docs/23-failure-modes.md section 5, "replayed token": logout ends the
// session on the server, so a copy of the cookie taken before is refused
// afterwards; "sign out everywhere" does it for every session of the user.

import { describe, expect, test } from "bun:test";

import { account, authCookie, PASSWORD, start, worker } from "./helpers.ts";

const t = await start();

describe.skipIf(!worker)("logout invalidates server side", () => {
  test("a cookie copied before logout is refused after it", async () => {
    await account(t, "lou", "lou@example.com");
    const stolen = (authCookie(await t.as("lou").action("/auth/login", "default", { email: "lou@example.com", password: PASSWORD })) as string).split(";")[0] as string;
    expect((await t.request("GET", "/private", { headers: { cookie: stolen } })).status).toBe(200);
    const out = await t.as("lou").action("/auth/account", "logout", {});
    expect(authCookie(out)).toContain("Max-Age=0");
    expect((await t.request("GET", "/private", { headers: { cookie: stolen } })).status).toBe(303);
    expect((await t.request("GET", "/api/me", { headers: { cookie: stolen } })).status).toBe(401);
  });

  test("sign out everywhere revokes every session of the user", async () => {
    await account(t, "eva", "eva@example.com");
    const phone = t.as("eva-phone");
    await phone.action("/auth/login", "default", { email: "eva@example.com", password: PASSWORD });
    expect((await phone.page("/private")).status).toBe(200);
    await t.as("eva").action("/auth/account", "everywhere", {});
    expect((await phone.page("/private")).status).toBe(303);
    expect((await t.as("eva").page("/private")).status).toBe(303);
  });
});
