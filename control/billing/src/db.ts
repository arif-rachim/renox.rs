// The one database method billing needs. control/api's `Db` satisfies it, so
// the API passes its own handle; the job runner (main.ts) opens its own.

export interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

/** Reads a bigint or numeric column, which the drivers return as number, bigint or string. */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint" || typeof v === "string") return Number(v);
  if (v === null || v === undefined) return 0;
  throw new TypeError(`expected a number, got ${typeof v}`);
}

export const HOUR_MS = 3_600_000;

/** The start of the UTC hour that holds `ms`. */
export const hourOf = (ms: number): number => ms - (((ms % HOUR_MS) + HOUR_MS) % HOUR_MS);

/** The start of the UTC calendar month that holds `ms`. */
export function monthOf(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** The start of the UTC calendar month after the one that holds `ms`. */
export function nextMonthOf(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
