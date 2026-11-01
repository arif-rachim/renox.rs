// GET /: the landing page of renoxium.com. The plan summary comes from
// pricing.toml (the pricing page's source), so the landing page never states
// a price or a quota the billing plans do not have.
import { PRICING, quotaText } from "../lib/pricing.ts";

export function load() {
  return {
    currency: PRICING.currency,
    plans: PRICING.plans.map((p) => ({
      name: p.name,
      price: p.price_month,
      free: Number(p.price_month) === 0,
      requests: quotaText("requests", p.quotas.requests ?? null),
      apps: quotaText("apps", p.quotas.apps ?? null),
      db: quotaText("db_bytes", p.quotas.db_bytes ?? null),
    })),
  };
}
