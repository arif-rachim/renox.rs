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

/** Cells lighting up on a node: a fixed field of glyphs, `lit` cells in the accent. Only `·`, `▪`, `<b>` and newlines. */
export function dotField(columns: number, rows: number, cells: readonly number[], lit: readonly number[]): string {
  const on = new Set(cells);
  const hot = new Set(lit);
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < columns; c++) {
      const i = r * columns + c;
      row.push(hot.has(i) ? "<b>▪</b>" : on.has(i) ? "▪" : "·");
    }
    lines.push(row.join(" "));
  }
  return lines.join("\n");
}

const COLS = 18;
const ROWS = 7;
/** Four nodes of 2 × 2 cells, like the mark, with one lit cell each; the lit ones differ per field. */
const NODES = [20, 21, 38, 39, 25, 26, 43, 44, 30, 31, 48, 49, 74, 75, 92, 93, 79, 80, 97, 98, 84, 85, 102, 103];

export const FEATURES: readonly Omit<Feature, "dots">[] = [
  {
    id: "modules",
    head: "Sign-in, teams, billing and admin",
    muted: "as installed modules, not rewrites.",
    text: "renox add auth brings the login, register and account pages with passwords and passkeys; org brings organisations with roles and invitations; billing brings plans, checkouts and invoices; admin brings the back office. Each module keeps its tables under its own prefix and asks for its permissions at install.",
    items: ["auth", "org", "billing", "admin", "storage", "email"],
    link: "Read about modules",
    href: "/docs/modules",
  },
  {
    id: "runs",
    head: "One isolate and one SQLite file per app,",
    muted: "under limits the platform enforces.",
    text: "Your code runs in a V8 isolate with its own CPU, memory and wall-clock limits, and reads its own SQLite file in the same process. An idle app holds nothing but bookkeeping, so the Free plan can be free and a paid plan pays for what runs.",
    items: ["isolate", "sqlite", "cpu limit", "backup"],
    link: "How an app runs",
    href: "/docs/tenant-lifecycle",
  },
  {
    id: "domains",
    head: "Your own domain,",
    muted: "a certificate issued at the edge.",
    text: "Every app answers at <app>.renoxium.app. Attach a custom domain with one CNAME to renoxium.app: ownership is verified, the certificate is issued and renewed at Cloudflare's edge, and TLS ends near your visitors.",
    items: ["cname", "tls", "hsts"],
    link: "Custom domains",
    href: "/docs/tenant-lifecycle#custom-domains-and-dns",
  },
  {
    id: "agents",
    head: "Built to be driven by a coding agent",
    muted: "as well as by you.",
    text: "renox new writes an AGENTS.md and registers renox mcp, a local MCP server with the docs, your project's routes and the results of renox check and renox test. Every app can be an MCP server of its own, and the remote platform MCP works behind OAuth.",
    items: ["renox mcp", "app mcp", "ctx.ai"],
    link: "AI agents and MCP",
    href: "/docs/ai-agents-mcp",
  },
];

const LIT: Record<string, number[]> = { modules: [20, 43], runs: [25, 97], domains: [30, 84], agents: [74, 48] };

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
