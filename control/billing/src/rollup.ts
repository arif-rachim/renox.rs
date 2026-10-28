// The hourly rollup: meters_raw -> meters_hourly, one row per (tenant,
// deployment, UTC hour). Each run recomputes whole hours from the raw rows,
// so it is idempotent, and a record that arrives late (a retry, a dead-letter
// replay) is counted when the run after its arrival covers its hour.
//
// Column meanings follow docs/contracts/meter.md section 7:
//   requests          records with status <> 'busy' (busy rejections are not charged)
//   cpu_ms            billed CPU: cpu_ms + render_ms (absent render_ms = 0)
//   egress_bytes      response bytes; billed egress is egress_bytes + fetch_sent_bytes
//   the rest          plain sums, kept for limits and dashboards

import { HOUR_MS, hourOf, type Queryable } from "./db.ts";

/** How far back a scheduled run recomputes: late records older than this need an explicit backfill run. */
export const LOOKBACK_HOURS = 48;

const f = (field: string): string => `(record->>'${field}')::double precision`;
const i = (field: string): string => `(record->>'${field}')::bigint`;

const ROLLUP = `
insert into meters_hourly (tenant_id, deployment_hash, hour_start, requests, cpu_ms, wall_ms, egress_bytes, fetch_sent_bytes, db_ms, db_rows, render_fuel)
select tenant_id, deployment_hash, started_at - mod(started_at, ${HOUR_MS}) as hour_start,
  count(*) filter (where record->>'status' <> 'busy'),
  round(sum(${f("cpu_ms")} + coalesce(${f("render_ms")}, 0))::numeric, 3)::double precision,
  round(sum(${f("wall_ms")})::numeric, 3)::double precision,
  sum(${i("egress_bytes")}),
  sum(${i("fetch_sent_bytes")}),
  round(sum(${f("db_ms")})::numeric, 3)::double precision,
  sum(${i("db_rows")}),
  sum(${i("render_fuel")})
from meters_raw
where started_at >= $1 and started_at < $2
group by tenant_id, deployment_hash, started_at - mod(started_at, ${HOUR_MS})
on conflict (tenant_id, deployment_hash, hour_start) do update set
  requests = excluded.requests, cpu_ms = excluded.cpu_ms, wall_ms = excluded.wall_ms,
  egress_bytes = excluded.egress_bytes, fetch_sent_bytes = excluded.fetch_sent_bytes,
  db_ms = excluded.db_ms, db_rows = excluded.db_rows, render_fuel = excluded.render_fuel
returning 1`;

export interface RollupWindow {
  /** Inclusive; rounded down to the hour. */
  from: number;
  /** Exclusive; rounded up to the hour. */
  to: number;
}

/** The window of a scheduled run at `now`: the last LOOKBACK_HOURS closed hours and the current one. */
export const scheduledWindow = (now: number, lookbackHours = LOOKBACK_HOURS): RollupWindow => ({
  from: hourOf(now) - lookbackHours * HOUR_MS,
  to: hourOf(now) + HOUR_MS,
});

/** Recomputes every hour in `window`; returns the number of hourly rows written. */
export async function rollup(db: Queryable, window: RollupWindow): Promise<number> {
  const from = hourOf(window.from);
  const to = hourOf(window.to - 1) + HOUR_MS;
  if (to <= from) return 0;
  return (await db.query(ROLLUP, [from, to])).length;
}
