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

/**
 * The comparison on the landing page: the rows and the verdicts of
 * docs/02-comparison.md, section B ("Hosting platforms vs needs"), for the
 * needs a visitor weighs first. "yes", "part" or "no", with the doc's note.
 * Change this table only together with that document (tests/pages.test.ts).
 */
export const COMPARE_AS_OF = "November 2026";
export const PLATFORMS = ["Renoxium", "Vercel", "Cloudflare Workers", "Supabase", "Fly.io", "Railway / Render"] as const;
type Verdict = "yes" | "part" | "no";
type Cell = readonly [Verdict, string?];
export const COMPARE: readonly { need: string; doc: string; cells: readonly Cell[] }[] = [
  { need: "Deploy TypeScript without Docker", doc: "Deploy TS without Docker", cells: [["yes"], ["yes"], ["yes"], ["yes", "functions"], ["part"], ["part"]] },
  { need: "Idle apps cost almost nothing", doc: "Idle tenants nearly free", cells: [["yes"], ["part"], ["yes"], ["part"], ["part", "scale to zero"], ["no"]] },
  { need: "A database per app, built in", doc: "Built-in per-tenant database", cells: [["yes", "SQLite"], ["no"], ["yes", "D1"], ["yes", "Postgres"], ["no"], ["part"]] },
  { need: "Server-rendered HTML, built in", doc: "Built-in HTML-first SSR", cells: [["yes"], ["no"], ["no"], ["no"], ["no"], ["no"]] },
  { need: "Sign-in, billing and admin as modules", doc: "Installed auth/billing/admin modules", cells: [["yes"], ["no"], ["no"], ["part", "auth, storage"], ["no"], ["no"]] },
  { need: "UAE payments and FTA tax invoices", doc: "UAE local payments, BNPL, FTA tax invoices", cells: [["yes"], ["no"], ["no"], ["no"], ["no"], ["no"]] },
  { need: "Prices in AED", doc: "AED pricing, data in the UAE", cells: [["yes"], ["no"], ["no"], ["no"], ["no"], ["no"]] },
];
const WORD: Record<Verdict, string> = { yes: "Yes", part: "Partly", no: "No" };

export function compareRows() {
  return COMPARE.map((r) => ({
    need: r.need,
    cells: r.cells.map(([v, note], i) => ({ v, word: WORD[v], note: note ?? "", ours: i === 0, platform: PLATFORMS[i] })),
  }));
}

/** Tile heights step up with the plan, like bars (the sheet's "Plans that step up"). */
const STEP = ["s1", "s2", "s3", "s4"] as const;

export function load() {
  return {
    cells: nodeCells(),
    platforms: PLATFORMS.map((name, i) => ({ name, ours: i === 0 })),
    compare: compareRows(),
    compare_as_of: COMPARE_AS_OF,
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
