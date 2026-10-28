// One run of the billing job: roll up the scheduled window, then report every
// tenant over a quota as a structured warning (the F3 signal; nothing is
// suspended).

import type { Queryable } from "./db.ts";
import { overQuota } from "./quota.ts";
import { rollup, scheduledWindow, type RollupWindow } from "./rollup.ts";

export interface JobLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export async function runOnce(db: Queryable, now: number, log: JobLog, window: RollupWindow = scheduledWindow(now)): Promise<{ rows: number; over: number }> {
  const rows = await rollup(db, window);
  const over = await overQuota(db, now);
  for (const s of over) {
    log.warn("tenant over quota", { tenant_id: s.tenant_id, tier: s.tier, period_start: s.period_start, over: s.over, used: s.used, limits: s.limits });
  }
  log.info("billing rollup", { from: window.from, to: window.to, rows, tenants_over_quota: over.length });
  return { rows, over: over.length };
}
