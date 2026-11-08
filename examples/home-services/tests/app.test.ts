// `renox test --seed seeds/001_demo.sql` runs this file on the local worker.
import { describe, expect, test } from "bun:test";
import { app } from "@renoxium/sdk/test";

const t = await app();

describe("the landing", () => {
  test("renders in English with the brand name from the settings", async () => {
    const res = await t.page("/");
    expect(res.status).toBe(200);
    expect(res.html).toContain("FixIt Services");
    expect(res.html).toContain("Sign in");
  });

  test("renders right to left with ?lang=ar", async () => {
    const res = await t.page("/?lang=ar");
    expect(res.status).toBe(200);
    expect(res.html).toContain('<html lang="ar" dir="rtl"');
  });
});

describe("the notifications list (the badge links to it)", () => {
  test("needs a signed-in user", async () => {
    const res = await t.request("GET", "/notifications");
    expect(res.status).toBe(303);
    expect(res.headers.get("location") ?? "").toContain("/auth/login");
  });
});
