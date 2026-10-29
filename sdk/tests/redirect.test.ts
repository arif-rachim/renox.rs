// docs/24-threat-model.md, "Open redirect via `next`/`return_to`" (#111):
// redirect.safe() accepts only paths of the app and allowlisted origins.
import { expect, test } from "bun:test";

import { redirect, safeRedirectTarget } from "../src/index.ts";

const ALLOW = ["https://accounts.example.com"];

const REJECTED = [
  "//evil.example",
  "//evil.example/path",
  "/\\evil.example",
  "\\\\evil.example",
  "/\t/evil.example",
  "/\n/evil.example",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "https://evil.example/",
  "http://accounts.example.com/",
  "https://accounts.example.com.evil.example/",
  "https://accounts.example.com@evil.example/",
  "https://user:pw@accounts.example.com/",
  "dashboard",
  "../admin",
  "",
];

const ACCEPTED: [string, string][] = [
  ["/", "/"],
  ["/account/settings?tab=billing#top", "/account/settings?tab=billing#top"],
  ["https://accounts.example.com/login?next=%2F", "https://accounts.example.com/login?next=%2F"],
  ["https://ACCOUNTS.example.com/", "https://accounts.example.com/"],
];

test("every unsafe target is rejected", () => {
  for (const t of REJECTED) expect([t, safeRedirectTarget(t, ALLOW)]).toEqual([t, null]);
});

test("paths of the app and allowlisted origins are accepted", () => {
  for (const [t, location] of ACCEPTED) expect(safeRedirectTarget(t, ALLOW)).toBe(location);
  expect(safeRedirectTarget("https://accounts.example.com/")).toBeNull();
});

test("redirect.safe answers 303 to the target, or to the fallback when it is unsafe", () => {
  const ok = redirect.safe("/cart", { allow: ALLOW });
  expect(ok.status).toBe(303);
  expect(ok.headers.get("location")).toBe("/cart");
  const bad = redirect.safe("//evil.example", { allow: ALLOW, fallback: "/home", status: 302 });
  expect(bad.status).toBe(302);
  expect(bad.headers.get("location")).toBe("/home");
  // An unsafe fallback is replaced by "/".
  expect(redirect.safe("//evil.example", { fallback: "https://evil.example" }).headers.get("location")).toBe("/");
});
