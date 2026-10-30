// Card-testing limits of the billing module (#123; docs/24-threat-model.md,
// "Card testing through tenant checkouts"): fixed-window buckets of payment
// attempts per client IP and per customer, and a customer blocked for the
// day after repeated declines. Checked before a checkout session is created,
// so a refused attempt never reaches the PSP.

export interface Db {
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export const LIMITS = {
  /** Attempts per client IP per minute. */
  ip: { max: 20, window: 60_000 },
  /** Attempts per customer per minute. */
  customer: { max: 10, window: 60_000 },
  /** Declines per customer per day before the customer is blocked for the day. */
  declines: { max: 5, window: 86_400_000 },
} as const;

/** Counts one hit of `bucket`; answers whether it is still within `max`. */
async function hit(db: Db, bucket: string, max: number, window: number, now: number): Promise<boolean> {
  const row = await db.queryOne<{ window_start: number; count: number }>("select window_start, count from billing__attempts where bucket = ?", [bucket]);
  if (row === null || now - row.window_start >= window) {
    await db.execute("insert into billing__attempts (bucket, window_start, count) values (?, ?, 1) on conflict (bucket) do update set window_start = excluded.window_start, count = 1", [bucket, now]);
    return true;
  }
  await db.execute("update billing__attempts set count = count + 1 where bucket = ?", [bucket]);
  return row.count + 1 <= max;
}

/** Why an attempt is refused, or null. Every attempt counts, refused or not. */
export async function attemptRefused(db: Db, o: { ip?: string | null; customer: string }, now = Date.now()): Promise<"ip" | "customer" | "declines" | null> {
  const declines = await db.queryOne<{ window_start: number; count: number }>("select window_start, count from billing__attempts where bucket = ?", [`declines:${o.customer}`]);
  if (declines !== null && now - declines.window_start < LIMITS.declines.window && declines.count >= LIMITS.declines.max) return "declines";
  const ipOk = typeof o.ip === "string" && o.ip !== "" ? await hit(db, `ip:${o.ip}`, LIMITS.ip.max, LIMITS.ip.window, now) : true;
  const customerOk = await hit(db, `customer:${o.customer}`, LIMITS.customer.max, LIMITS.customer.window, now);
  return !ipOk ? "ip" : !customerOk ? "customer" : null;
}

/** A declined payment of a customer (the PSP's payment_failed). */
export async function recordDecline(db: Db, customer: string, now = Date.now()): Promise<void> {
  await hit(db, `declines:${customer}`, Number.MAX_SAFE_INTEGER, LIMITS.declines.window, now);
}
