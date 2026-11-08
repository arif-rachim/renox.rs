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

describe("the brand stylesheet", () => {
  test("serves the seeded brand colour as a CSS variable, linked by the layout", async () => {
    const css = await t.request("GET", "/theme");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type") ?? "").toContain("text/css");
    expect(css.html).toMatch(/^:root \{ --brand: #[0-9a-fA-F]{6}; \}/u);
    const page = await t.page("/");
    expect(page.html).toContain('<link rel="stylesheet" href="/theme">');
    expect(page.html).not.toContain("{{ brand.color }}");
  });
});
