// Sending reputation (#123; docs/24-threat-model.md, abuse of the email
// module for spam): every send, bounce and complaint is counted per day;
// over the last 7 days a complaint rate above 0.3 % (at least 3 complaints)
// or a bounce rate above 5 % (at least 20 sends) pauses this tenant's
// sending until the owner (email.manage) resumes it. A daily cap grows with
// the tenant's sending age: 200 a day in its first week, 2,000 in its first
// month, then the module's per-minute limit only.

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export const THRESHOLDS = { complaintRate: 0.003, minComplaints: 3, bounceRate: 0.05, minSends: 20, days: 7 } as const;
const DAY = 86_400_000;
const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

const COUNT = {
  sent: "insert into email__reputation (day, sent) values (?, 1) on conflict (day) do update set sent = sent + 1",
  bounced: "insert into email__reputation (day, bounced) values (?, 1) on conflict (day) do update set bounced = bounced + 1",
  complained: "insert into email__reputation (day, complained) values (?, 1) on conflict (day) do update set complained = complained + 1",
} as const;

export async function count(db: Db, kind: keyof typeof COUNT, now = Date.now()): Promise<void> {
  await db.execute(COUNT[kind], [dayOf(now)]);
}

export async function paused(db: Db): Promise<{ at: number; reason: string } | null> {
  const r = await db.queryOne<{ paused_at: number | null; reason: string | null }>("select paused_at, reason from email__state where id = 1");
  return r === null || r.paused_at === null ? null : { at: r.paused_at, reason: r.reason ?? "" };
}

/** Pauses sending when the last 7 days pass a threshold; answers the reason when it just paused. */
export async function judge(db: Db, now = Date.now()): Promise<string | null> {
  if ((await paused(db)) !== null) return null;
  const r = await db.queryOne<{ sent: number | null; bounced: number | null; complained: number | null }>("select sum(sent) as sent, sum(bounced) as bounced, sum(complained) as complained from email__reputation where day >= ?", [dayOf(now - THRESHOLDS.days * DAY)]);
  const [sent, bounced, complained] = [r?.sent ?? 0, r?.bounced ?? 0, r?.complained ?? 0];
  let reason: string | null = null;
  if (complained >= THRESHOLDS.minComplaints && complained / Math.max(sent, 1) > THRESHOLDS.complaintRate) reason = `complaints ${complained} of ${sent}`;
  else if (sent >= THRESHOLDS.minSends && bounced / sent > THRESHOLDS.bounceRate) reason = `bounces ${bounced} of ${sent}`;
  if (reason === null) return null;
  await db.execute("insert into email__state (id, paused_at, reason) values (1, ?, ?) on conflict (id) do update set paused_at = excluded.paused_at, reason = excluded.reason", [now, reason]);
  return reason;
}

export async function resume(db: Db): Promise<void> {
  await db.execute("update email__state set paused_at = null, reason = null where id = 1");
}

/** The daily cap of a tenant whose first message was at `firstAt` (null: no cap). */
export function dailyCap(firstAt: number | null, now = Date.now()): number | null {
  if (firstAt === null) return 200;
  const age = now - firstAt;
  return age < 7 * DAY ? 200 : age < 30 * DAY ? 2000 : null;
}

export async function underDailyCap(db: Db, now = Date.now()): Promise<boolean> {
  const first = (await db.queryOne<{ t: number | null }>("select min(at) as t from email__messages"))?.t ?? null;
  const cap = dailyCap(first, now);
  if (cap === null) return true;
  const today = (await db.queryOne<{ n: number }>("select count(*) as n from email__messages where at >= ?", [Math.floor(now / DAY) * DAY]))?.n ?? 0;
  return today < cap;
}
