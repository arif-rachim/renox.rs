// Reads of the hourly rollup: per app (the tenant's usage view) and per
// tenant (quota evaluation). An artifact's manifest names its app (rule V3)
// and app names are global, so a deployment hash belongs to one app.

import { num, type Queryable } from "./db.ts";

export interface Usage {
  requests: number;
  cpu_ms: number;
  wall_ms: number;
  egress_bytes: number;
  fetch_sent_bytes: number;
  db_ms: number;
  db_rows: number;
  render_fuel: number;
}

export interface UsageHour extends Usage {
  hour_start: number;
}

const SUMS = `coalesce(sum(m.requests), 0) as requests, coalesce(sum(m.cpu_ms), 0) as cpu_ms, coalesce(sum(m.wall_ms), 0) as wall_ms,
  coalesce(sum(m.egress_bytes), 0) as egress_bytes, coalesce(sum(m.fetch_sent_bytes), 0) as fetch_sent_bytes,
  coalesce(sum(m.db_ms), 0) as db_ms, coalesce(sum(m.db_rows), 0) as db_rows, coalesce(sum(m.render_fuel), 0) as render_fuel`;

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

function toUsage(r: Record<string, unknown>): Usage {
  return {
    requests: num(r.requests),
    cpu_ms: round3(num(r.cpu_ms)),
    wall_ms: round3(num(r.wall_ms)),
    egress_bytes: num(r.egress_bytes),
    fetch_sent_bytes: num(r.fetch_sent_bytes),
    db_ms: round3(num(r.db_ms)),
    db_rows: num(r.db_rows),
    render_fuel: num(r.render_fuel),
  };
}

export const ZERO: Usage = { requests: 0, cpu_ms: 0, wall_ms: 0, egress_bytes: 0, fetch_sent_bytes: 0, db_ms: 0, db_rows: 0, render_fuel: 0 };

/** Hour by hour usage of `app` (of `tenantId`) in [from, to), oldest first; hours without records are absent. */
export async function appUsageHours(db: Queryable, tenantId: string, app: string, from: number, to: number): Promise<UsageHour[]> {
  const rows = await db.query(
    `select m.hour_start, ${SUMS}
     from meters_hourly m join deployments d on d.tenant_id = m.tenant_id and d.hash = m.deployment_hash
     where m.tenant_id = $1 and d.app = $2 and m.hour_start >= $3 and m.hour_start < $4
     group by m.hour_start order by m.hour_start`,
    [tenantId, app, from, to],
  );
  return rows.map((r) => ({ hour_start: num(r.hour_start), ...toUsage(r) }));
}

/** Sum of usage over `hours`. */
export function total(hours: readonly Usage[]): Usage {
  const t = { ...ZERO };
  for (const h of hours) for (const k of Object.keys(t) as (keyof Usage)[]) t[k] += h[k];
  for (const k of ["cpu_ms", "wall_ms", "db_ms"] as const) t[k] = round3(t[k]);
  return t;
}

/** Usage of every tenant with records in [from, to). */
export async function tenantUsage(db: Queryable, from: number, to: number, tenantId?: string): Promise<Map<string, Usage>> {
  const rows = await db.query(
    `select m.tenant_id, ${SUMS} from meters_hourly m
     where m.hour_start >= $1 and m.hour_start < $2 and ($3::text is null or m.tenant_id = $3)
     group by m.tenant_id`,
    [from, to, tenantId ?? null],
  );
  return new Map(rows.map((r) => [r.tenant_id as string, toUsage(r)]));
}
