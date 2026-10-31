// Detection order (#244): ?lang=, the user's stored choice, the session's,
// the organisation's default, Accept-Language, the configured default;
// only offered locales count.
import { expect, test } from "bun:test";

import { calendarOf, dirOf, digitsOf, match, negotiate, options, pick, splitTag, tagOf } from "../lib/detect.ts";

const o = options({ locales: "en,ar", default_locale: "en", digits: "latn" });

test("options: the offered locales and the default; bad entries are dropped", () => {
  expect(o).toEqual({ locales: ["en", "ar"], fallback: "en", digits: "latn", calendar: "gregory" });
  expect(options({ locales: "ar, en ,x!,", default_locale: "fr" })).toEqual({ locales: ["ar", "en"], fallback: "ar", digits: "latn", calendar: "gregory" });
  expect(options({ calendar: "islamic-umalqura" }).calendar).toBe("islamic-umalqura");
  expect(options({ calendar: "persian" }).calendar).toBe("gregory");
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

test("direction and digits (#266): latn, arab, and auto following the stored choice", () => {
  expect(dirOf("ar")).toBe("rtl");
  expect(dirOf("ar-AE")).toBe("rtl");
  expect(dirOf("en")).toBe("ltr");
  const arab = options({ locales: "en,ar", digits: "arab" });
  const auto = options({ locales: "en,ar", digits: "auto" });
  expect(digitsOf("ar", arab)).toBe("arab");
  expect(digitsOf("en", arab)).toBe("latn");
  expect(digitsOf("ar", o)).toBe("latn");
  expect(digitsOf("ar", o, "arab")).toBe("latn"); // latn ignores the stored choice
  expect(digitsOf("ar", auto)).toBe("latn");
  expect(digitsOf("ar", auto, "arab")).toBe("arab");
  expect(digitsOf("ar", auto, "latn")).toBe("latn");
  expect(tagOf("ar", "arab")).toBe("ar-u-nu-arab");
  expect(tagOf("ar", "latn")).toBe("ar");
});

test("tags with a -u- extension: matched by their language, nu read out", () => {
  expect(splitTag("ar-AE-u-nu-arab")).toEqual({ base: "ar-AE", nu: "arab", ca: null });
  expect(splitTag("ar-u-ca-islamic-nu-latn")).toEqual({ base: "ar", nu: "latn", ca: "islamic" });
  expect(splitTag("ar-u-ca-islamic-umalqura-nu-arab")).toEqual({ base: "ar", nu: "arab", ca: "islamic-umalqura" });
  expect(splitTag("ar-u-ca-islamic-umalqura")).toEqual({ base: "ar", nu: null, ca: "islamic-umalqura" });
  // Only the calendars of ops.md 1.4.0.
  expect(splitTag("ar-u-ca-chinese").ca).toBeNull();
  expect(splitTag("ar")).toEqual({ base: "ar", nu: null, ca: null });
  expect(match("ar-u-nu-arab", o.locales)).toBe("ar");
  expect(pick({ query: "ar-AE-u-nu-arab" }, o)).toEqual({ locale: "ar", source: "query" });
});

test("calendar (#336): gregory, islamic-umalqura, and auto following the stored choice; the canonical tag", () => {
  const hijri = options({ locales: "en,ar", calendar: "islamic-umalqura" });
  const auto = options({ locales: "en,ar", calendar: "auto" });
  expect(calendarOf("ar", o)).toBe("gregory");
  expect(calendarOf("ar", o, "islamic-umalqura")).toBe("gregory"); // gregory ignores the stored choice
  expect(calendarOf("ar", hijri)).toBe("islamic-umalqura");
  expect(calendarOf("en", hijri)).toBe("gregory"); // Arabic pages only, like the digits
  expect(calendarOf("ar", auto)).toBe("gregory");
  expect(calendarOf("ar", auto, "islamic-umalqura")).toBe("islamic-umalqura");
  // ca before nu, as setLocale requires (ops.md 1.4.0).
  expect(tagOf("ar", "arab", "islamic-umalqura")).toBe("ar-u-ca-islamic-umalqura-nu-arab");
  expect(tagOf("ar", "latn", "islamic-umalqura")).toBe("ar-u-ca-islamic-umalqura");
  expect(tagOf("ar", "arab", "gregory")).toBe("ar-u-nu-arab");
  expect(tagOf("en", "latn")).toBe("en");
  expect(match("ar-u-ca-islamic-umalqura-nu-arab", o.locales)).toBe("ar");
});
