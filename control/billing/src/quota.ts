// Tier quotas (signal only). A tenant over a monthly quota is reported; F3
// never suspends or throttles on it (suspension is F7, docs/15-roadmap.md).
// The numbers are proposals: docs/01-business.md prices are hypotheses until
// F7, and the unit-cost report (unit-cost.ts) is what they will be set from.

import { monthOf, nextMonthOf, type Queryable } from "./db.ts";
import { tenantUsage, ZERO, type Usage } from "./usage.ts";

export type Tier = "free" | "paid";

/** Monthly limits per billing dimension (meter.md section 7). */
export interface Quota {
  /** Charged requests (status <> busy). */
  requests: number;
  /** Billed CPU: cpu_ms + render_ms. */
  cpu_ms: number;
  /** Billed egress: egress_bytes + fetch_sent_bytes. */
  egress_bytes: number;
}

const GiB = 1024 ** 3;

/** Proposed monthly quotas. `paid` is usage-billed; its numbers are an abuse signal, not a cap. */
export const TIER_QUOTAS: Record<Tier, Quota> = {
  free: { requests: 3_000_000, cpu_ms: 30_000_000, egress_bytes: 10 * GiB },
  paid: { requests: 100_000_000, cpu_ms: 1_000_000_000, egress_bytes: 1024 * GiB },
};

export type Dimension = keyof Quota;

/** The billing dimensions of `u`. */
export const billed = (u: Usage): Quota => ({ requests: u.requests, cpu_ms: u.cpu_ms, egress_bytes: u.egress_bytes + u.fetch_sent_bytes });

export interface QuotaState {
  tenant_id: string;
  tier: Tier;
  period_start: number;
  period_end: number;
  used: Quota;
  limits: Quota;
  /** Dimensions whose use is above the limit; empty when within quota. */
  over: Dimension[];
}

function state(tenantId: string, tier: Tier, usage: Usage, now: number, quotas: Record<Tier, Quota>): QuotaState {
  const used = billed(usage);
  const limits = quotas[tier];
  return {
    tenant_id: tenantId,
    tier,
    period_start: monthOf(now),
    period_end: nextMonthOf(now),
    used,
    limits,
    over: (Object.keys(limits) as Dimension[]).filter((d) => used[d] > limits[d]),
  };
}

/** The quota state of one tenant for the calendar month (UTC) holding `now`. */
export async function quotaOf(db: Queryable, tenantId: string, now: number, quotas = TIER_QUOTAS): Promise<QuotaState> {
  const rows = await db.query<{ tier: Tier }>("select tier from tenants where id = $1", [tenantId]);
  const tier = rows[0]?.tier ?? "free";
  const usage = (await tenantUsage(db, monthOf(now), nextMonthOf(now), tenantId)).get(tenantId) ?? ZERO;
  return state(tenantId, tier, usage, now, quotas);
}

/** Every tenant over a quota this month, by tenant id. */
export async function overQuota(db: Queryable, now: number, quotas = TIER_QUOTAS): Promise<QuotaState[]> {
  const usage = await tenantUsage(db, monthOf(now), nextMonthOf(now));
  if (usage.size === 0) return [];
  const tiers = new Map(
    (await db.query<{ id: string; tier: Tier }>("select id, tier from tenants where id = any($1::text[])", [[...usage.keys()]])).map((r) => [r.id, r.tier]),
  );
  return [...usage.entries()]
    .map(([tenant, u]) => state(tenant, tiers.get(tenant) ?? "free", u, now, quotas))
    .filter((s) => s.over.length > 0)
    .sort((a, b) => a.tenant_id.localeCompare(b.tenant_id));
}
