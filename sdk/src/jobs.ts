// Scheduled jobs (#284; docs/contracts/ops.md section 20; run by the F6
// scheduler, #297). A `jobs/*.ts` module exports `schedule` (five cron
// fields), optionally `tz`, and `run(ctx)`. `renox build` reads `schedule`
// and `tz` into the `job` route entry and checks them (V27) with
// `parseSchedule` below.

import type { JobModule } from "./ctx.ts";

/** One field: allowed range and name. */
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
] as const;

/** The values of each field of a schedule (`0 3 * * 1-5`), or the first problem as a string. */
export function parseSchedule(expr: string): number[][] | string {
  if (typeof expr !== "string" || expr.length > 128) return "a schedule is a string of at most 128 characters";
  const parts = expr.trim().split(/\s+/u);
  if (parts.length !== 5) return `a schedule has 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`;
  const out: number[][] = [];
  for (let f = 0; f < 5; f++) {
    const { name, min, max } = FIELDS[f] as (typeof FIELDS)[number];
    const values = new Set<number>();
    for (const item of (parts[f] as string).split(",")) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/u.exec(item);
      if (!m) return `${name}: ${JSON.stringify(item)} is not a number, *, a range a-b, or a step /n`;
      const from = m[1] === "*" ? min : Number(m[2]);
      const to = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : from;
      const step = m[4] !== undefined ? Number(m[4]) : 1;
      if (from < min || to > max || from > to) return `${name}: ${item} is outside ${min}-${max}`;
      if (step < 1) return `${name}: the step of ${item} must be at least 1`;
      for (let v = from; v <= to; v += step) values.add(v);
    }
    out.push([...values].sort((a, b) => a - b));
  }
  return out;
}

/** Whether `tz` is an IANA zone the runtime knows (`Asia/Dubai`, `UTC`). */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks a job declaration and returns it unchanged; spread it into the
 * module's exports or use its fields:
 *
 * ```ts
 * export const schedule = "0 3 * * *";
 * export const tz = "Asia/Dubai";
 * export async function run(ctx: JobContext) { ... }
 * ```
 */
export function defineJob<const J extends JobModule>(job: J): J {
  const parsed = parseSchedule(job.schedule);
  if (typeof parsed === "string") throw new TypeError(`defineJob: ${parsed}`);
  if (job.tz !== undefined && !isTimeZone(job.tz)) throw new TypeError(`defineJob: ${job.tz} is not an IANA time zone`);
  if (typeof job.run !== "function") throw new TypeError("defineJob: run must be a function");
  return job;
}
