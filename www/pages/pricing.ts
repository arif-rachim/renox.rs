// GET /pricing: the plans of pricing.toml (#326), which the billing plans
// equal; prices in AED, excluding and including 5 % VAT.
import { PRICING, quotaText, withVat } from "../lib/pricing.ts";

const LABELS: Record<string, string> = {
  requests: "Requests / month",
  cpu_ms: "CPU / month",
  egress_bytes: "Egress / month",
  db_bytes: "Database",
  storage_bytes: "File storage",
  ai_tokens: "AI tokens / month",
  apps: "Apps",
  custom_domains: "Custom domains",
};

export function load() {
  return {
    currency: PRICING.currency,
    plans: PRICING.plans.map((p) => ({
      name: p.name,
      // Whole dirhams in the dot face (it draws a period as a cross); the VAT-inclusive price keeps its fils.
      price: p.price_month.replace(/\.00$/u, ""),
      with_vat: withVat(p.price_month, PRICING.vat_rate),
      quotas: Object.entries(p.quotas).map(([k, v]) => ({ label: LABELS[k] ?? k, value: quotaText(k, v) })),
    })),
  };
}
