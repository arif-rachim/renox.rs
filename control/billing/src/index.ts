// @renox/billing: billing v0 (P14, #56). The control API uses ingestBatch for
// POST /v1/ingest/meters and the usage reads for GET /v1/apps/{app}/usage;
// the job runner (main.ts) runs the hourly rollup and the quota signal.

export { HOUR_MS, hourOf, monthOf, nextMonthOf, num } from "./db.ts";
export type { Queryable } from "./db.ts";
export { ingestBatch, UnknownDeployment } from "./ingest.ts";
export type { IngestResult, MeterBatch, MeterRecord } from "./ingest.ts";
export { LOOKBACK_HOURS, rollup, scheduledWindow } from "./rollup.ts";
export type { RollupWindow } from "./rollup.ts";
export { appUsageHours, tenantUsage, total, ZERO } from "./usage.ts";
export type { Usage, UsageHour } from "./usage.ts";
export { billed, overQuota, quotaOf, TIER_QUOTAS } from "./quota.ts";
export type { Dimension, Quota, QuotaState, Tier } from "./quota.ts";
export { runOnce } from "./job.ts";
export { PLANS, planOf, tierOfPlan, VAT_RATE } from "./plans.ts";
export type { Plan, PlanId, PlanQuotas } from "./plans.ts";
export { aed, closePeriod, fils, invoiceHtml, invoiceNumber, vatOf } from "./invoice.ts";
export type { Invoice, InvoiceLine } from "./invoice.ts";
export { anomalous, GRACE_MS, nextState, reinstate, TRANSITIONS } from "./tier.ts";
export type { TierInput, TierState } from "./tier.ts";
