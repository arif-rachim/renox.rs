// The reports module's services (#333): see lib/core.ts.
import * as core from "./lib/core.ts";

export const sales = (_ctx: unknown, from: number, to: number, documents: core.Document[]) => core.sales(documents ?? [], from, to);
export const csv = (_ctx: unknown, rows: Record<string, unknown>[], headers?: string[]) => core.csv(rows ?? [], headers);
export const accounting = (_ctx: unknown, system: string, documents: core.Document[]) => core.accounting(system, documents ?? []);
import { cash as cashRows, type Db } from "./lib/cash.ts";

export const cash = (ctx: { db: Db }, from: number, to: number) => cashRows(ctx.db, from, to);
import { nightly as nightlyRun } from "./jobs/nightly.ts";

/** The nightly report for the day before `now_ms` (the job runs it at 03:00 UTC): the snapshot, and the email when email_to is set. */
export const nightly = (ctx: { db: Db; config: { email_to?: string } }, now: unknown) => nightlyRun(ctx, typeof now === "number" ? now : Date.now());
