// docs/24-threat-model.md F4, "Login brute force, credential stuffing":
// 10 failed sign-ins per account in 15 minutes lock it (the right password
// then gets the generic message), 30 per IP address lock every account from
// that address; the messages are generic and snapshotted.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { snapshot } from "../../../../sdk/src/test.ts";
import { account, authCookie, messageOf, PASSWORD, start, worker } from "./helpers.ts";

const t = await start();
const login = (as: string, email: string, password: string) => t.as(as).action("/auth/login", "default", { email, password });

describe.skipIf(!worker)("brute force buckets", () => {
  test("10 failures per account: locked with the generic message", async () => {
    await account(t, "bo", "bo@example.com");
    const first = await login("bf", "bo@example.com", "wrong guess 0");
    for (let i = 1; i < 10; i++) await login("bf", "bo@example.com", `wrong guess ${i}`);
    const locked = await login("bo-real", "bo@example.com", PASSWORD);
    expect(locked.status).toBe(200);
    expect(authCookie(locked)).toBeUndefined();
    expect(messageOf(locked.html)).toBe(messageOf(first.html));
    snapshot(messageOf(locked.html) ?? "", { role: "generic login message" });
  }, 60_000);

  test("30 failures from one address lock every account from it", async () => {
    await account(t, "ivy", "ivy@example.com");
    // Spread over accounts so no account bucket fills first; 10 failures happened above.
    for (let i = 0; i < 20; i++) await login("spray", `user${i}@example.com`, "wrong");
    const locked = await login("ivy-real", "ivy@example.com", PASSWORD);
    expect(locked.status).toBe(200);
    expect(authCookie(locked)).toBeUndefined();
    // A new window (the buckets aged 15 minutes): the right password works again.
    const rw = new Database(t.dbFile);
    rw.exec("pragma busy_timeout = 5000");
    rw.exec("update auth__attempts set window_start = window_start - 901");
    rw.close();
    expect((await login("ivy-later", "ivy@example.com", PASSWORD)).status).toBe(303);
  }, 60_000);

  test("the generic messages of register, reset and magic links", async () => {
    snapshot(messageOf((await t.as("g1").action("/auth/register", "default", { email: "bo@example.com", password: PASSWORD })).html) ?? "", { role: "generic register message" });
    snapshot(messageOf((await t.as("g2").action("/auth/reset", "default", { email: "anyone@example.com" })).html) ?? "", { role: "generic reset message" });
    snapshot(messageOf((await t.as("g3").action("/auth/magic", "default", { email: "anyone@example.com" })).html) ?? "", { role: "generic magic link message" });
  });
});
