// Platform plans in AED (#325; deploy-api.md 0.5 section 20; docs/01-business.md
// pricing hypotheses). The numbers are proposals (deploy-api.md Open 18):
// the owner fixes them before billing goes live.

export type PlanId = "free" | "starter" | "pro" | "agency";

export interface PlanQuotas {
  requests: number | null;
  cpu_ms: number | null;
  egress_bytes: number | null;
  db_bytes: number | null;
  storage_bytes: number | null;
  ai_tokens: number | null;
  apps: number | null;
  custom_domains: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** AED per month, excluding VAT, as a decimal string. */
  price_month: string;
  quotas: PlanQuotas;
}

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

export const PLANS: readonly Plan[] = [
  { id: "free", name: "Free", price_month: "0.00", quotas: { requests: 100_000, cpu_ms: 3_600_000, egress_bytes: 5 * GiB, db_bytes: 100 * MiB, storage_bytes: 1 * GiB, ai_tokens: 0, apps: 2, custom_domains: 0 } },
  { id: "starter", name: "Starter", price_month: "79.00", quotas: { requests: 2_000_000, cpu_ms: 36_000_000, egress_bytes: 50 * GiB, db_bytes: 1 * GiB, storage_bytes: 10 * GiB, ai_tokens: 1_000_000, apps: 5, custom_domains: 3 } },
  { id: "pro", name: "Pro", price_month: "299.00", quotas: { requests: 20_000_000, cpu_ms: 360_000_000, egress_bytes: 250 * GiB, db_bytes: 10 * GiB, storage_bytes: 50 * GiB, ai_tokens: 10_000_000, apps: 20, custom_domains: 20 } },
  { id: "agency", name: "Agency", price_month: "499.00", quotas: { requests: null, cpu_ms: null, egress_bytes: null, db_bytes: 50 * GiB, storage_bytes: 200 * GiB, ai_tokens: 50_000_000, apps: null, custom_domains: 100 } },
];

export const VAT_RATE = "0.05";

export function planOf(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

/** The data-plane tier a plan runs on: `free`, or `paid` for every paid plan. */
export const tierOfPlan = (id: PlanId): "free" | "paid" => (id === "free" ? "free" : "paid");
