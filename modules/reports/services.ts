// The reports module's services (#333): see lib/core.ts.
import { ValidationError } from "@renoxium/sdk";

import * as core from "./lib/core.ts";
import { readXlsx as readXlsxFile, xlsx as xlsxFile, type Cell } from "./lib/xlsx.ts";

export const sales = (_ctx: unknown, from: number, to: number, documents: core.Document[]) => core.sales(documents ?? [], from, to);
export const csv = (_ctx: unknown, rows: Record<string, unknown>[], headers?: string[]) => core.csv(rows ?? [], headers);
export const accounting = (_ctx: unknown, system: string, documents: core.Document[]) => core.accounting(system, documents ?? []);
import { cash as cashRows, type Db } from "./lib/cash.ts";

const MAX_CELLS = 100_000;

const bad = (message: string, path: (string | number)[]): ValidationError => new ValidationError([{ message, path }]);

/** Rows as a one-sheet .xlsx: numbers stay numbers, strings are never formulas. Sheet name 1 to 31 characters without []:*?/\, at most 100,000 cells. */
export const xlsx = (_ctx: unknown, sheet: unknown, rows: unknown): Uint8Array => {
  if (typeof sheet !== "string" || sheet.length < 1 || sheet.length > 31 || /[\[\]:*?/\\]/u.test(sheet)) throw bad("sheet must be 1 to 31 characters without [ ] : * ? / \\", ["sheet"]);
  if (!Array.isArray(rows)) throw bad("rows must be an array of arrays", ["rows"]);
  let cells = 0;
  rows.forEach((r: unknown, i: number) => {
    if (!Array.isArray(r)) throw bad("a row must be an array", ["rows", i]);
    cells += r.length;
    if (cells > MAX_CELLS) throw bad(`at most ${MAX_CELLS} cells`, ["rows"]);
    r.forEach((v: unknown, j: number) => {
      if (v !== null && typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v))) throw bad("a cell must be a string, a finite number or null", ["rows", i, j]);
    });
  });
  return xlsxFile(sheet, rows as Cell[][]);
};

const MAX_BYTES = 10 * 1024 * 1024;

/** The first sheet of an .xlsx as rows of cells (a formula gives its cached value; a gap is null; rows padded to the widest, trailing empty rows dropped). At most 10 MiB and 100,000 cells. */
export const readXlsx = (_ctx: unknown, bytes: unknown): Cell[][] => {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("reports.readXlsx: bytes must be a Uint8Array");
  if (bytes.byteLength > MAX_BYTES) throw new RangeError("reports.readXlsx: file over 10 MiB");
  let rows: Cell[][];
  try {
    rows = readXlsxFile(bytes);
  } catch {
    throw new Error("reports.readXlsx: not an .xlsx file");
  }
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  if (width * rows.length > MAX_CELLS) throw new RangeError("reports.readXlsx: over 100,000 cells");
  for (const r of rows) while (r.length < width) r.push(null);
  return rows;
};

export const cash = (ctx: { db: Db }, from: number, to: number) => cashRows(ctx.db, from, to);
import { nightly as nightlyRun, type NightlyCtx } from "./jobs/nightly.ts";

/** The nightly report for the day before `now_ms` (the job runs it at 03:00 UTC): the snapshot, and the email when an address is known (the `reports.nightly_to` hook, else email_to). */
export const nightly = (ctx: NightlyCtx, now: unknown) => nightlyRun(ctx, typeof now === "number" ? now : Date.now());
