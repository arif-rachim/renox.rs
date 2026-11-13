// Excel and cash (#333): the .xlsx a pure-TypeScript writer makes opens in a
// reader (the package's CRCs, numbers as numbers, Arabic and formula-like
// text as plain strings); the cash ledger per day from billing's events,
// a redelivered event counted once.
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cash, record } from "../lib/cash.ts";
import { readXlsx, xlsx } from "../lib/xlsx.ts";
import { ValidationError } from "../../../sdk/src/validate.ts";

// The module imports "@renoxium/sdk" (a worker resolves it); plain bun gets the source.
mock.module("@renoxium/sdk", () => ({ ValidationError }));
// services.ts loads jobs/nightly.ts and lib/report.ts, which import "renox:modules"; this file must not depend on
// another test file having mocked it first (the order of files in a root `bun test` run is not fixed).
mock.module("renox:modules", () => ({ tax_gcc: { documents: async () => [] }, auth: {}, i18n: {}, email: { sendRaw: async () => ({ id: null }) } }));
const services = await import("../services.ts");

test("an .xlsx: one sheet, numbers stay numbers, strings stay text (no formula), Arabic intact", () => {
  const rows = [["date", "net", "buyer"], ["2026-10-30", 299.5, "شركة المثال"], ["2026-10-31", 0, "=HYPERLINK(\"http://x\")"]];
  const bytes = xlsx("sales", rows);
  expect(bytes[0]).toBe(0x50);
  expect(readXlsx(bytes)).toEqual(rows);
  const corrupt = bytes.slice();
  corrupt[200] = (corrupt[200] as number) ^ 0xff;
  expect(() => readXlsx(corrupt)).toThrow("CRC");
});

test("cash per day from received and refunded events; a redelivery counts once", async () => {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(import.meta.dir, "../migrations/001_init.sql"), "utf8"));
  const d = {
    async query<T>(sql: string, p: unknown[] = []) { return db.query(sql).all(...(p as never[])) as T[]; },
    async execute(sql: string, p: unknown[] = []) { return { changes: db.query(sql).run(...(p as never[])).changes }; },
  };
  const t0 = Date.UTC(2026, 9, 30, 10);
  await record(d, "received:e1", "received", "in_1", 31395, t0);
  await record(d, "received:e1", "received", "in_1", 31395, t0);
  await record(d, "received:e2", "received", "in_2", 10000, t0 + 86_400_000);
  await record(d, "refunded:e3", "refunded", "in_1", 5000, t0 + 86_400_000);
  expect(await cash(d, t0 - 3_600_000, t0 + 2 * 86_400_000)).toEqual([
    { date: "2026-10-30", received: 31395, refunded: 0, net: 31395 },
    { date: "2026-10-31", received: 10000, refunded: 5000, net: 5000 },
  ]);
});

test("the xlsx service: bytes the reader reads back; a bad sheet name or cell is a ValidationError", () => {
  const rows = [["technician", "jobs", "note"], ["Omar", 12, null], ["سارة", 7.5, "=SUM(A1)"]];
  const bytes = services.xlsx({}, "Technicians", rows);
  expect(bytes[0]).toBe(0x50);
  expect(readXlsx(bytes)).toEqual([["technician", "jobs", "note"], ["Omar", 12], ["سارة", 7.5, "=SUM(A1)"]]);
  expect(() => services.xlsx({}, "a/b", rows)).toThrow(ValidationError);
  expect(() => services.xlsx({}, "", rows)).toThrow(ValidationError);
  expect(() => services.xlsx({}, "x".repeat(32), rows)).toThrow(ValidationError);
  expect(() => services.xlsx({}, "ok", [[{}]] as never)).toThrow(ValidationError);
  expect(() => services.xlsx({}, "ok", [new Array(100_001).fill(1)])).toThrow(ValidationError);
});

// readXlsx (#724): the service reads what the writer and a real spreadsheet program make.
const read = (b: unknown) => services.readXlsx({}, b);

test("readXlsx: a round trip of the writer keeps strings (Arabic), integers, decimals and null", () => {
  const rows = [["name", "n", "x", "note"], ["محمد", 12, 1.5, null], ["Layla", 0, -3.25, "a & <b>"]];
  expect(read(services.xlsx({}, "s", rows))).toEqual(rows);
});

test("readXlsx: a LibreOffice file (deflate, shared strings, a gap, formulas with cached values)", () => {
  const bytes = new Uint8Array(readFileSync(join(import.meta.dir, "fixtures/customers.xlsx")));
  expect(read(bytes)).toEqual([
    ["id", "name", "city", "balance", "total"],
    [1, "محمد", "Dubai", 12, 2],
    [2, "Layla", null, 1.5, 4],
    [3, "Omar Al-Said", "Doha", null, 6],
  ]);
});

test("readXlsx: an empty sheet is [], a gap is null, a short row is padded, trailing empty rows go", () => {
  expect(read(xlsx("s", []))).toEqual([]);
  expect(read(xlsx("s", [[null, null]]))).toEqual([]);
  expect(read(xlsx("s", [["a", "b", "c"], [1, null, 3], ["x"], [null, null, null]]))).toEqual([["a", "b", "c"], [1, null, 3], ["x", null, null]]);
});

test("readXlsx: refusals", () => {
  expect(() => read(new Uint8Array([1, 2, 3]))).toThrow("reports.readXlsx: not an .xlsx file");
  expect(() => read("text")).toThrow(TypeError);
  expect(() => read("text")).toThrow("reports.readXlsx: bytes must be a Uint8Array");
  expect(() => read(new Uint8Array(10 * 1024 * 1024 + 1))).toThrow(new RangeError("reports.readXlsx: file over 10 MiB"));
  const wide = Array.from({ length: 1000 }, (_, i) => Array.from({ length: 100 }, (_, j) => i * j));
  expect(read(xlsx("s", wide))).toHaveLength(1000);
  wide.push([1]);
  expect(() => read(xlsx("s", wide))).toThrow(new RangeError("reports.readXlsx: over 100,000 cells"));
});
