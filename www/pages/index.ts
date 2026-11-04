// GET /: the landing page of renoxium.com in the renox-ui v2 "dot matrix"
// language (#428). No script. The plan teaser comes from pricing.toml (the
// pricing page's source), so the landing page never states a price or a
// quota the billing plans do not have. The stats are measured numbers of
// docs/14-benchmarks.md, each with the caption that says what was measured.
// The decorative dot fields are pre-generated here from a fixed pattern, so
// the page renders the same every time (tests/pages.test.ts).
import { PRICING, quotaText } from "../lib/pricing.ts";

/** Numbers that are true and measured (docs/14-benchmarks.md, "F1 results"), whole, as the dot face asks. */
export const STATS: readonly { value: string; unit: string; caption: string; source: string }[] = [
  { value: "107", unit: "KB", caption: "held by an idle app on the node (B2, node-small, 500 tenants)", source: "docs/14-benchmarks.md" },
  { value: "45", unit: "ms", caption: "cold start at p99, first request of a hello function (B4, provisional)", source: "docs/14-benchmarks.md" },
  { value: "1", unit: "", caption: "command to deploy: renox deploy builds, uploads, validates and activates", source: "cli/README.md" },
];

export interface Feature {
  id: string;
  head: string;
  muted: string;
  text: string;
  items: string[] | null;
  link: string;
  href: string;
  dots: string;
}

/**
 * Cells lighting up on a node, drawn as an inline SVG: a dot per idle slot,
 * a rounded square per cell of a node, the `lit` cells in the accent. Only
 * <svg>, <circle> and <rect> with fixed attributes: the markup is built here
 * from numbers, never from input, so it is safe for r-html.
 */
export function dotField(columns: number, rows: number, cells: readonly number[], lit: readonly number[]): string {
  const P = 20;
  const on = new Set(cells);
  const hot = new Set(lit);
  const marks: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const i = r * columns + c;
      const [x, y] = [c * P + P / 2, r * P + P / 2];
      if (hot.has(i)) marks.push(`<rect class="lit" x="${x - 6}" y="${y - 6}" width="12" height="12" rx="2"/>`);
      else if (on.has(i)) marks.push(`<rect class="cell" x="${x - 6}" y="${y - 6}" width="12" height="12" rx="2"/>`);
      else marks.push(`<circle class="dot-idle" cx="${x}" cy="${y}" r="1.6"/>`);
    }
  }
  return `<svg viewBox="0 0 ${columns * P} ${rows * P}" xmlns="http://www.w3.org/2000/svg" focusable="false">${marks.join("")}</svg>`;
}

const COLS = 24;
const ROWS = 14;
/** The cells of six 2 x 2 nodes on the field, like the mark: their top-left slots. */
const NODE_AT: readonly [col: number, row: number][] = [[2, 2], [9, 1], [17, 3], [4, 9], [12, 8], [19, 10]];
const NODES = NODE_AT.flatMap(([c, r]) => [r * COLS + c, r * COLS + c + 1, (r + 1) * COLS + c, (r + 1) * COLS + c + 1]);

export const FEATURES: readonly Omit<Feature, "dots">[] = [
  {
    id: "modules",
    head: "Sign-in, teams, billing:",
    muted: "installed, not rewritten.",
    text: "renox add auth brings the login, register and account pages with passwords and passkeys; org brings organisations with roles and invitations; billing brings plans, checkouts and invoices; admin brings the back office. Each module keeps its tables under its own prefix and asks for its permissions at install.",
    items: ["auth", "org", "billing", "admin", "storage", "email"],
    link: "Read about modules",
    href: "/docs/modules",
  },
  {
    id: "runs",
    head: "One isolate, one SQLite file",
    muted: "for every app.",
    text: "Your code runs in a V8 isolate with its own CPU, memory and wall-clock limits, and reads its own SQLite file in the same process. An idle app holds nothing but bookkeeping, so the Free plan can be free and a paid plan pays for what runs.",
    items: ["isolate", "sqlite", "cpu limit", "backup"],
    link: "How an app runs",
    href: "/docs/tenant-lifecycle",
  },
  {
    id: "domains",
    head: "Your own domain,",
    muted: "TLS at the edge.",
    text: "Every app answers at <app>.renoxium.app. Attach a custom domain with one CNAME to renoxium.app: ownership is verified, the certificate is issued and renewed at Cloudflare's edge, and TLS ends near your visitors.",
    items: ["cname", "tls", "hsts"],
    link: "Custom domains",
    href: "/docs/tenant-lifecycle#custom-domains-and-dns",
  },
  {
    id: "agents",
    head: "Built for coding agents,",
    muted: "and for you.",
    text: "renox new writes an AGENTS.md and registers renox mcp, a local MCP server with the docs, your project's routes and the results of renox check and renox test. Every app can be an MCP server of its own, and the remote platform MCP works behind OAuth.",
    items: ["renox mcp", "app mcp", "ctx.ai"],
    link: "AI agents and MCP",
    href: "/docs/ai-agents-mcp",
  },
];

/** One lit cell in two of the nodes, different for each section (the slot index on the field). */
const at = (c: number, r: number): number => r * COLS + c;
const LIT: Record<string, number[]> = { modules: [at(2, 2), at(13, 9)], runs: [at(10, 2), at(5, 10)], domains: [at(18, 4), at(20, 10)], agents: [at(9, 1), at(4, 9)] };

export function features(): Feature[] {
  return FEATURES.map((f) => ({ ...f, dots: dotField(COLS, ROWS, NODES, LIT[f.id] ?? []) }));
}

export function load() {
  return {
    stats: STATS.map(({ value, unit, caption }) => ({ value, unit, caption })),
    features: features(),
    currency: PRICING.currency,
    plans: PRICING.plans.map((p) => ({
      name: p.name,
      price: p.price_month.replace(/\.00$/u, ""),
      free: Number(p.price_month) === 0,
      requests: quotaText("requests", p.quotas.requests ?? null),
      apps: quotaText("apps", p.quotas.apps ?? null),
      db: quotaText("db_bytes", p.quotas.db_bytes ?? null),
    })),
  };
}
