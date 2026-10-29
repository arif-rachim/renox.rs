// Detection order (#244): ?lang=, the user's stored choice, the session's,
// the organisation's default, Accept-Language, the configured default;
// only offered locales count.
import { expect, test } from "bun:test";

import { dirOf, digitsOf, match, negotiate, options, pick } from "../lib/detect.ts";

const o = options({ locales: "en,ar", default_locale: "en", digits: "latin" });

test("options: the offered locales and the default; bad entries are dropped", () => {
  expect(o).toEqual({ locales: ["en", "ar"], fallback: "en", digits: "latin" });
  expect(options({ locales: "ar, en ,x!,", default_locale: "fr" })).toEqual({ locales: ["ar", "en"], fallback: "ar", digits: "latin" });
  expect(options({ locales: "", default_locale: "en" }).locales).toEqual(["en"]);
});

test("match: exact, then by language; anything else is null", () => {
  expect(match("ar", o.locales)).toBe("ar");
  expect(match("ar-AE", o.locales)).toBe("ar");
  expect(match("EN", o.locales)).toBe("en");
  expect(match("fr", o.locales)).toBeNull();
  expect(match("<script>", o.locales)).toBeNull();
  expect(match(null, o.locales)).toBeNull();
});

test("Accept-Language: by quality, then order; q=0 and * are ignored", () => {
  expect(negotiate("fr-FR,ar;q=0.8,en;q=0.9", o.locales)).toBe("en");
  expect(negotiate("ar-AE,ar;q=0.9,en;q=0.5", o.locales)).toBe("ar");
  expect(negotiate("en;q=0,ar;q=0.1", o.locales)).toBe("ar");
  expect(negotiate("*", o.locales)).toBeNull();
  expect(negotiate("fr, de", o.locales)).toBeNull();
  expect(negotiate("x".repeat(2000), o.locales)).toBeNull();
});

test("the order: query, user, session, org, Accept-Language, default", () => {
  const all = { query: "ar", user: "en", session: "en", org: "en", accept_language: "en" };
  expect(pick(all, o)).toEqual({ locale: "ar", source: "query" });
  expect(pick({ ...all, query: null, user: "ar" }, o)).toEqual({ locale: "ar", source: "user" });
  expect(pick({ ...all, query: null, user: null, session: "ar" }, o)).toEqual({ locale: "ar", source: "session" });
  expect(pick({ query: null, user: null, session: null, org: "ar", accept_language: "en" }, o)).toEqual({ locale: "ar", source: "org" });
  expect(pick({ accept_language: "ar" }, o)).toEqual({ locale: "ar", source: "accept_language" });
  expect(pick({}, o)).toEqual({ locale: "en", source: "default" });
  // A locale the app does not offer is skipped, not used.
  expect(pick({ query: "fr", user: "ar" }, o)).toEqual({ locale: "ar", source: "user" });
});

test("direction and digits", () => {
  expect(dirOf("ar")).toBe("rtl");
  expect(dirOf("ar-AE")).toBe("rtl");
  expect(dirOf("en")).toBe("ltr");
  const indic = options({ locales: "en,ar", digits: "arabic_indic" });
  expect(digitsOf("ar", indic)).toBe("arabic_indic");
  expect(digitsOf("en", indic)).toBe("latin");
  expect(digitsOf("ar", o)).toBe("latin");
});
