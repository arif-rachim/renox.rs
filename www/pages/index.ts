// GET /: the landing page of renoxium.com. The plan summary comes from
// pricing.toml (the pricing page's source), so the landing page never states
// a price or a quota the billing plans do not have.
import { PRICING, quotaText } from "../lib/pricing.ts";

/**
 * The hero's illustration: one node as a grid of tenant cells (packages/ui
 * README, "Visual idea"). Most are idle; `on` cells are serving a request;
 * `blink` cells (1-4) switch on and off in turn. A fixed pattern, so the page
 * renders the same every time.
 */
export const NODE = { columns: 20, rows: 10 } as const;
const ON = new Set([7, 23, 41, 58, 66, 89, 95, 112, 131, 147, 158, 176, 183, 194]);
const BLINK: Record<number, number> = { 30: 1, 74: 2, 121: 3, 167: 4 };

export function nodeCells(): { cls: string }[] {
  return Array.from({ length: NODE.columns * NODE.rows }, (_, i) => ({
    cls: ON.has(i) ? "on" : BLINK[i] !== undefined ? `blink b${BLINK[i]}` : "",
  }));
}

export function load() {
  return {
    cells: nodeCells(),
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
