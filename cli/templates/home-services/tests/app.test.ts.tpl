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

  test("is cached for five minutes, privately, and carries an ETag (#728)", async () => {
    const css = await t.request("GET", "/theme");
    expect(css.headers.get("cache-control")).toBe("private, max-age=300");
    expect(css.headers.get("etag") ?? "").toMatch(/^"[0-9a-f]{8}"$/u);
    expect(css.html.length).toBeLessThan(1024);
  });

  test("answers 304 without a body to a matching If-None-Match, and 200 to another tag (#728)", async () => {
    const first = await t.request("GET", "/theme");
    const etag = first.headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    const second = await t.request("GET", "/theme", { headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
    expect(second.html).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe("private, max-age=300");
    expect((await t.request("GET", "/theme", { headers: { "if-none-match": `W/${etag}, "other"` } })).status).toBe(304);
    const other = await t.request("GET", "/theme", { headers: { "if-none-match": '"00000000"' } });
    expect(other.status).toBe(200);
    expect(other.html).toBe(first.html);
  });
});

describe("the technician's visit page loads only the scripts it uses (#728)", () => {
  test("upload.js only with a file input, visit.js only with the check-in form or the signature canvas, and never an inline script", async () => {
    const ali = t.as("ali-scripts");
    const login = await ali.action("/auth/login", "default", { email: "ali.dubai@fixit.example", password: "correct horse battery", next: "/me" });
    expect(login.status).toBe(303);
    const scripts = (html: string) => [...html.matchAll(/<script src="\/(upload|visit|me)\.[0-9a-f]{16}\.js"/gu)].map((m) => m[1]);
    // Not checked in yet: the check-in form, no file input.
    const waiting = await ali.page("/me/visits/jb_seed_06");
    expect(waiting.html).not.toContain('type="file"');
    expect(scripts(waiting.html)).toEqual(["me", "visit"]);
    // Checked in (open): the photo forms and the signature canvas.
    expect((await ali.action("/me/visits/jb_seed_06", "checkin", { lat: "", lng: "" })).status).toBe(303);
    const open = await ali.page("/me/visits/jb_seed_06");
    expect(open.html).toContain('type="file"');
    expect(scripts(open.html)).toEqual(["me", "upload", "visit"]);
    // Closed: nothing to type into, no script of the page's own.
    const closed = await ali.page("/me/visits/jb_seed_12");
    expect(closed.html).not.toContain('type="file"');
    expect(scripts(closed.html)).toEqual(["me"]);
    for (const page of [waiting, open, closed]) expect(page.html).not.toMatch(/<script(?![^>]*\bsrc=)/u);
  });
});
