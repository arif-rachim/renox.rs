// Day arithmetic of the maintenance contracts, on `YYYY-MM-DD` strings (calendar
// days: no time zone is involved). No module is imported, so the tests can use it.

/** How far ahead of its due day a visit is made a job: fourteen days. */
export const VISIT_AHEAD_DAYS = 14;
/** The customer is reminded this many days before the contract ends. */
export const RENEWAL_NOTICE_DAYS = 30;

const MS = 86_400_000;

/** `d` plus `n` days. */
export function addDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`. */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS);

/** The day before the next anniversary of `start`: a one-year term (29 February moves to 28 February). */
export function yearEnd(start: string): string {
  const t = new Date(`${start}T00:00:00Z`);
  const month = t.getUTCMonth();
  t.setUTCFullYear(t.getUTCFullYear() + 1);
  if (t.getUTCMonth() !== month) t.setUTCDate(0);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

/** The offset in days from the start of visit number `k` (from 0) of an item with `n` visits a year: 365 / n apart, rounded down. */
const offsetOf = (k: number, n: number): number => Math.floor((k * 365) / n);

/**
 * The first visit day after `after` for an item that starts on `start` and has
 * `n` visits a year: the visits are 365 / n days apart (the first gap of 12 a
 * year is 30 days, of 4 a year 91), counted from the contract's start so that
 * a term of 365 days holds exactly n visits.
 */
export function nextVisit(start: string, after: string, n: number): string {
  const off = daysBetween(start, after);
  let k = Math.max(0, Math.floor((off * n) / 365));
  while (offsetOf(k, n) <= off) k++;
  return addDays(start, offsetOf(k, n));
}

/** Every visit day of a term `start` to `end` (both included) for `n` visits a year. */
export function visitDays(start: string, end: string, n: number): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = nextVisit(start, d, n)) out.push(d);
  return out;
}
