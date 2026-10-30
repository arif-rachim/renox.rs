// The tax_gcc module's services (#331): see lib/core.ts.
import * as core from "./lib/core.ts";

type Ctx = core.TaxCtx;

export const issue = (ctx: Ctx, input: Parameters<typeof core.issue>[1]) => core.issue(ctx, input ?? {});
export const creditNote = (ctx: Ctx, number: unknown, lines: unknown[] | undefined, reason: unknown) => core.creditNote(ctx, number, lines, reason);
export const invoice = (ctx: Ctx, number: unknown) => core.invoice(ctx, number);
export const vatReport = (ctx: Ctx, from: unknown, to: unknown) => core.vatReport(ctx, from, to);
export const recordPurchase = (ctx: Ctx, p: Parameters<typeof core.recordPurchase>[1]) => core.recordPurchase(ctx, p ?? {});
export const vatReturn = (ctx: Ctx, from: unknown, to: unknown) => core.vatReturn(ctx, from, to);
