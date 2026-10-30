// The hourly billing pass (#325; deploy-api.md 0.5 section 20): for every
// tenant, the tier signal (the dimensions over the plan's quota and the
// anomaly rule) drives the tier machine, the owner is emailed at each step,
// and a period that has ended is closed into its invoice.
//
// - Anomaly: an hour of requests, CPU-ms or egress over 10 times the
//   tenant's own 7-day hourly median (`anomalous`, at least a floor) writes
//   one operator review row (`billing_reviews`). For a free tenant it also
//   counts as over quota, so the machine moves it on its usual steps
//   (`over_quota`, then `grace` after 24 hours); a paid tenant is only
//   reviewed. The email volume dimension of the issue has no meter yet.
// - Close: one invoice per tenant per month, numbered without gaps per year
//   under an advisory lock; the seller TRN is `RENOX_SELLER_TRN` (no TRN, no
//   tax invoice: the close waits and logs). A pending downgrade takes effect
//   with the new period.
// Card testing, disputes and payments arrive through the webhook instead.

import { anomalous, closePeriod, DAY_MS, HOUR_MS, PLANS, planOf, tenantUsage, type TierState } from "@renox/billing";

import type { Deps } from "../context.ts";
import { num } from "../db/db.ts";
import { ulid } from "../ids.ts";
import { MONTH, tickTier } from "./routes.ts";

type Row = Record<string, unknown>;

/** The dimensions the anomaly rule watches (columns of the query below), with the floor of an hour. */
const WATCHED = [
  { dimension: "requests", floor: 100 },
  { dimension: "cpu_ms", floor: 1_000 },
  { dimension: "egress_bytes", floor: 10 * 1024 * 1024 },
] as const;

const INVOICE_LOCK = 0x72656e78_01;

/** The owner's address of a tenant, or null. */
async function ownerEmail(deps: Deps, tenantId: string): Promise<string | null> {
  const r = await deps.db.query<Row>("select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.role = 'owner' limit 1", [tenantId]);
  return typeof r[0]?.email === "string" ? r[0].email : null;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The email of a tier step; never a usage figure beyond the dimension names. */
export function tierMail(to: TierState, from: TierState, tenantId: string, over: string[], since: number): { kind: "tier_over_quota" | "tier_grace" | "tier_suspended" | "tier_reinstated"; subject: string; text: string } | null {
  const upgrade = `https://dashboard.renox.app/billing (tenant ${tenantId})`;
  if (to === "over_quota")
    return { kind: "tier_over_quota", subject: "Your Renox usage is over the Free plan's quota", text: `Tenant ${tenantId} is over its monthly quota for: ${over.join(", ") || "usage"}. Requests are still served. If it is still over in 24 hours, a 7-day grace period starts. Upgrade: ${upgrade}` };
  if (to === "grace")
    return { kind: "tier_grace", subject: "Grace period started for your Renox tenant", text: `Tenant ${tenantId} is in a grace period until ${day(since + 7 * DAY_MS)} (UTC). Requests are served until then; after it the tenant is suspended unless it is back within quota or upgraded. Upgrade: ${upgrade}` };
  if (to === "suspended")
    return { kind: "tier_suspended", subject: "Your Renox tenant is suspended", text: `Tenant ${tenantId} is suspended: its sites answer the suspension page. Your data, deployments and the dashboard stay. A payment or an upgrade ends it: ${upgrade}` };
  if (to === "active" && from !== "active") return { kind: "tier_reinstated", subject: "Your Renox tenant is active again", text: `Tenant ${tenantId} is active again.` };
  return null;
}

async function notify(deps: Deps, tenantId: string, to: TierState, from: TierState, over: string[], since: number): Promise<void> {
  const mail = tierMail(to, from, tenantId, over, since);
  const email = mail === null ? null : await ownerEmail(deps, tenantId);
  if (mail !== null && email !== null) await deps.mailer.send({ to: email, ...mail }).catch(() => undefined);
}

/** The anomaly rule over the last full hour; writes the review rows and answers the dimensions flagged. */
export async function anomalies(deps: Deps, tenantId: string, now: number): Promise<string[]> {
  const last = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
  const flagged: string[] = [];
  const rows = await deps.db.query<Row>(
    "select hour_start, sum(requests) as requests, sum(cpu_ms) as cpu_ms, sum(egress_bytes + fetch_sent_bytes) as egress_bytes from meters_hourly where tenant_id = $1 and hour_start >= $2 and hour_start <= $3 group by hour_start",
    [tenantId, last - 7 * DAY_MS, last],
  );
  for (const w of WATCHED) {
    const latest = num(rows.find((r) => num(r.hour_start) === last)?.[w.dimension] ?? 0);
    const history = rows.filter((r) => num(r.hour_start) !== last).map((r) => num(r[w.dimension]));
    if (latest === 0 || !anomalous(history, latest, 10, w.floor)) continue;
    const sorted = [...history].sort((a, b) => a - b);
    const median = sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] as number);
    await deps.db.query(
      "insert into billing_reviews (id, tenant_id, dimension, hour_start, observed, median, created_at) values ($1, $2, $3, $4, $5, $6, $7) on conflict (tenant_id, dimension, hour_start) do nothing",
      [`brv_${ulid(now)}`, tenantId, w.dimension, last, latest, median, now],
    );
    flagged.push(w.dimension);
  }
  return flagged;
}

/** Dimensions over the plan's quota in the current period. */
async function overQuota(deps: Deps, row: Row, now: number): Promise<string[]> {
  const plan = planOf(row.plan as string) ?? (PLANS[0] as (typeof PLANS)[number]);
  const u = (await tenantUsage(deps.db, num(row.period_start), now, row.tenant_id as string)).get(row.tenant_id as string);
  if (u === undefined) return [];
  const used: Record<string, number> = { requests: u.requests, cpu_ms: u.cpu_ms, egress_bytes: u.egress_bytes + u.fetch_sent_bytes };
  return Object.entries(used).filter(([k, v]) => {
    const q = plan.quotas[k as "requests" | "cpu_ms" | "egress_bytes"];
    return q !== null && v > q;
  }).map(([k]) => k);
}

/** Closes the tenant's ended period: the invoice (paid plans), the next period, a pending downgrade. Answers the invoice id or null. */
export async function closeDue(deps: Deps, tenantId: string, now: number): Promise<string | null> {
  const sellerTrn = process.env.RENOX_SELLER_TRN ?? "";
  return deps.db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1)", [INVOICE_LOCK]);
    const row = (await tx.query<Row>("select * from tenant_billing where tenant_id = $1", [tenantId]))[0];
    if (row === undefined) return null;
    const start = num(row.period_start);
    if (start + MONTH > now) return null;
    const period = { start, end: start + MONTH };
    const plan = planOf(row.plan as string) ?? (PLANS[0] as (typeof PLANS)[number]);
    let id: string | null = null;
    if (plan.id !== "free") {
      if (!/^[0-9]{15}$/u.test(sellerTrn)) {
        deps.log.warn("billing close waits: RENOX_SELLER_TRN is not a 15-digit TRN", { tenant_id: tenantId });
        return null;
      }
      const year = new Date(period.end - 1).getUTCFullYear();
      const n = (await tx.query<Row>("select count(*) as n from invoices where id like $1", [`INV-${year}-%`]))[0]?.n;
      const profile = row.profile === null ? null : (JSON.parse(row.profile as string) as { trn?: string });
      const inv = closePeriod({
        tenantId,
        plan,
        period,
        sequence: num(n) + 1,
        sellerTrn,
        buyerTrn: profile?.trn ?? null,
        now,
        monthLabel: new Date(period.start).toISOString().slice(0, 7),
      });
      if (inv !== null) {
        await tx.query(
          "insert into invoices (id, tenant_id, period_start, period_end, status, body, issued_at) values ($1, $2, $3, $4, $5, $6, $7)",
          [inv.id, tenantId, period.start, period.end, inv.status, JSON.stringify(inv), now],
        );
        id = inv.id;
      }
    }
    // The next period; a downgrade chosen during the period starts with it.
    const next = row.pending_plan === null ? (row.plan as string) : (row.pending_plan as string);
    await tx.query("update tenant_billing set period_start = $2, plan = $3, pending_plan = null where tenant_id = $1", [tenantId, period.end, next]);
    if (next !== row.plan) await tx.query("update tenants set tier = $2 where id = $1", [tenantId, next === "free" ? "free" : "paid"]);
    return id;
  });
}

/** One hourly pass over every tenant. */
export async function sweepBilling(deps: Deps, now = deps.now()): Promise<{ tenants: number; invoices: string[]; reviews: number }> {
  // Every tenant has a billing row from its first pass.
  await deps.db.query("insert into tenant_billing (tenant_id, state_since, period_start) select id, $1, $1 from tenants where id not in (select tenant_id from tenant_billing)", [now]);
  const rows = await deps.db.query<Row>("select * from tenant_billing order by tenant_id");
  const invoices: string[] = [];
  let reviews = 0;
  for (const row of rows) {
    const tenantId = row.tenant_id as string;
    const invoice = await closeDue(deps, tenantId, now);
    if (invoice !== null) invoices.push(invoice);
    const flagged = await anomalies(deps, tenantId, now);
    reviews += flagged.length;
    const fresh = (await deps.db.query<Row>("select * from tenant_billing where tenant_id = $1", [tenantId]))[0] as Row;
    const over = await overQuota(deps, fresh, now);
    const free = fresh.plan === "free";
    const before = fresh.state as TierState;
    const to = await tickTier(deps, tenantId, over.length > 0 || (free && flagged.length > 0), now);
    if (to !== before) await notify(deps, tenantId, to, before, [...over, ...(free ? flagged : [])], now);
  }
  return { tenants: rows.length, invoices, reviews };
}
