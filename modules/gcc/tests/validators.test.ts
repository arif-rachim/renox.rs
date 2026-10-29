// lib/validators.ts with valid and invalid fixtures for every branch (#243):
// phones in every typed form, Emirates IDs (country, year, Luhn check
// digit), TRN, Makani, P.O. Box, trade licences per emirate.
import { describe, expect, test } from "bun:test";

import { emiratesId, isEmirate, luhn, makani, phone, poBox, trn, tradeLicence } from "../lib/validators.ts";

describe("phone", () => {
  test.each([
    ["+971 50 123 4567", "+971501234567"],
    ["00971501234567", "+971501234567"],
    ["971-52-765-4321", "+971527654321"],
    ["050 123 4567", "+971501234567"],
    ["(04) 123 4567", "+97141234567"],
    ["501234567", "+971501234567"],
    ["02 6123456", "+97126123456"],
  ])("%s -> %s", (input, e164) => expect(phone(input)).toEqual({ ok: true, value: e164 }));
  test.each([
    [42, "not_a_string"],
    ["050-ABC-4567", "characters"],
    ["+44 20 7946 0958", "country"],
    ["+971 51 123 4567", "format"],
    ["+971 50 123 456", "format"],
    ["", "characters"],
  ])("%p refused: %s", (input, reason) => expect(phone(input)).toEqual({ ok: false, reason }));
});

describe("Emirates ID", () => {
  test.each([
    ["784-1990-1234567-6", "784-1990-1234567-6"],
    ["784200511111112", "784-2005-1111111-2"],
    ["784 1975 0000001 9", "784-1975-0000001-9"],
  ])("%s valid", (input, value) => expect(emiratesId(input)).toEqual({ ok: true, value }));
  test.each([
    [null, "not_a_string"],
    ["784-1990-123456-6", "format"],
    ["124-1990-1234567-6", "country"],
    ["784-1890-1234567-6", "year"],
    ["784-2190-1234567-6", "year"],
    // One digit off: the check digit no longer matches.
    ["784-1990-1234567-5", "check_digit"],
    ["784-1990-1234576-6", "check_digit"],
  ])("%p refused: %s", (input, reason) => expect(emiratesId(input)).toEqual({ ok: false, reason }));
  test("luhn", () => {
    expect(luhn("79927398713")).toBe(true);
    expect(luhn("79927398710")).toBe(false);
  });
});

describe("TRN, Makani, P.O. Box", () => {
  test("TRN: 15 digits", () => {
    expect(trn("100-1234-5678-901")).toEqual({ ok: false, reason: "format" });
    expect(trn("1001234567890123")).toEqual({ ok: false, reason: "format" });
    expect(trn("100 123 456 789 012")).toEqual({ ok: true, value: "100123456789012" });
    expect(trn(15)).toEqual({ ok: false, reason: "not_a_string" });
  });
  test("Makani: 10 digits", () => {
    expect(makani("30654 95733")).toEqual({ ok: true, value: "3065495733" });
    expect(makani("306549573")).toEqual({ ok: false, reason: "format" });
    expect(makani(undefined)).toEqual({ ok: false, reason: "not_a_string" });
  });
  test("P.O. Box", () => {
    expect(poBox("P.O. Box 12345")).toEqual({ ok: true, value: "12345" });
    expect(poBox("PO Box 9")).toEqual({ ok: true, value: "9" });
    expect(poBox("1234567")).toEqual({ ok: false, reason: "format" });
    expect(poBox(1)).toEqual({ ok: false, reason: "not_a_string" });
  });
});

describe("trade licence", () => {
  test.each([
    ["cn-1234567", "AE-AZ", "CN-1234567"],
    ["123456", "AE-DU", "123456"],
    ["54321", "AE-SH", "54321"],
    ["1234", "AE-AJ", "1234"],
    ["uaq-77-a", "AE-UQ", "UAQ-77-A"],
    ["RAK1234", "AE-RK", "RAK1234"],
    ["fuj-1", "AE-FU", "FUJ-1"],
  ])("%s in %s", (input, emirate, value) => expect(tradeLicence(input, emirate)).toEqual({ ok: true, value }));
  test("refused", () => {
    expect(tradeLicence("1234567", "AE-AZ")).toEqual({ ok: false, reason: "format" });
    expect(tradeLicence("123", "AE-DU")).toEqual({ ok: false, reason: "format" });
    expect(tradeLicence("123456", "AE-XX")).toEqual({ ok: false, reason: "emirate" });
    expect(tradeLicence(123456, "AE-DU")).toEqual({ ok: false, reason: "not_a_string" });
    expect(isEmirate("AE-DU")).toBe(true);
    expect(isEmirate(7)).toBe(false);
  });
});
