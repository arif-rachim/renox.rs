// Excel and cash (#333): the .xlsx a pure-TypeScript writer makes opens in a
// reader (the package's CRCs, numbers as numbers, Arabic and formula-like
// text as plain strings); the cash ledger per day from billing's events,
// a redelivered event counted once.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cash, record } from "../lib/cash.ts";
import { readXlsx, xlsx } from "../lib/xlsx.ts";

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
