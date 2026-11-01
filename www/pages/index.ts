// GET /: the landing page of renoxium.com. The plan tiles come from
// pricing.toml (the pricing page's source), so the landing page never states
// a price or a quota the billing plans do not have.
//
// The page follows one motif, the node's cell (packages/ui/README.md,
// "Principles"): the closing mark is a node of tenant cells, most idle, a few
// lit, from a fixed pattern so the page renders the same every time.
import { PRICING, quotaText } from "../lib/pricing.ts";

export const NODE = { columns: 40, rows: 6 } as const;
const ON = new Set([5, 22, 47, 61, 78, 93, 104, 126, 139, 152, 171, 188, 203, 219, 236]);
const BLINK: Record<number, number> = { 33: 1, 86: 2, 145: 3, 197: 4 };

export function nodeCells(): { cls: string }[] {
  return Array.from({ length: NODE.columns * NODE.rows }, (_, i) => ({
    cls: ON.has(i) ? "on" : BLINK[i] !== undefined ? `blink b${BLINK[i]}` : "",
  }));
}

/** Tile heights step up with the plan, like bars (the sheet's "Plans that step up"). */
const STEP = ["s1", "s2", "s3", "s4"] as const;

export function load() {
  return {
    cells: nodeCells(),
    currency: PRICING.currency,
    plans: PRICING.plans.map((p, i) => ({
      name: p.name,
      price: p.price_month,
      free: Number(p.price_month) === 0,
      step: STEP[Math.min(i, STEP.length - 1)],
      requests: quotaText("requests", p.quotas.requests ?? null),
      apps: quotaText("apps", p.quotas.apps ?? null),
      db: quotaText("db_bytes", p.quotas.db_bytes ?? null),
      domains: quotaText("custom_domains", p.quotas.custom_domains ?? null),
    })),
  };
}
