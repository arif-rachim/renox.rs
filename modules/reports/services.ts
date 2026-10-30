// The reports module's services (#333): see lib/core.ts.
import * as core from "./lib/core.ts";

export const sales = (_ctx: unknown, from: number, to: number, documents: core.Document[]) => core.sales(documents ?? [], from, to);
export const csv = (_ctx: unknown, rows: Record<string, unknown>[], headers?: string[]) => core.csv(rows ?? [], headers);
export const accounting = (_ctx: unknown, system: string, documents: core.Document[]) => core.accounting(system, documents ?? []);
