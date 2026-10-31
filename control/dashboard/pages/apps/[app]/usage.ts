// GET /apps/:app/usage[?range=24h|7d|30d]: the app's metered usage per hour
// (`GET /v1/apps/{app}/usage`, the hourly rollup of #56) as bar charts, the
// totals, and the tenant's monthly quota (docs/19-platform-wireframes.md,
// 3.13 for one app). The bars are SVG computed here (lib/view.ts): no script,
// no inline style, so the strict CSP holds.
import type { LoaderContext } from "renox";

import { apiBase, type UsageHour } from "../../../lib/api.ts";
import { appParam, notFound, problem, signedIn } from "../../../lib/guard.ts";
import { trOf } from "../../../lib/i18n.ts";
import { bytes, CHART, clock, hourlyBars, percent, round } from "../../../lib/view.ts";

const HOUR = 3_600_000;
export const RANGES = { "24h": 24, "7d": 7 * 24, "30d": 30 * 24 } as const;
type Range = keyof typeof RANGES;

/**
 * #296: the mean wall time per request of one hour. The hourly rollup has no
 * percentiles and no realtime fields (deploy-api.yaml `UsageHour`), so p50,
 * p95 and realtime connections wait for the contract to carry them.
 */
export const meanLatencyMs = (h: UsageHour): number => (h.requests === 0 ? 0 : h.wall_ms / h.requests);

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const name = appParam(ctx.params.app);
  if (name === null) return notFound();
  const raw = ctx.url.searchParams.get("range");
  const range: Range = raw !== null && raw in RANGES ? (raw as Range) : "24h";
  const slots = RANGES[range];
  // Whole hours, the current one included.
  const to = (Math.floor(Date.now() / HOUR) + 1) * HOUR;
  const from = to - slots * HOUR;
  const base = { signed_in: true, impersonation: api.impersonation, api_host: new URL(apiBase(ctx.secrets)).host, app: name, section: "usage", range, ranges: Object.keys(RANGES), chart: CHART };
  const r = await api.usage(name, from, to);
  if (!r.ok) return { ...base, problem: await problem(ctx, r), totals: null, charts: [], quota: null };
  const u = r.value;
  const last = to - HOUR;
  const q = u.quota;
  const tr = trOf(ctx);
  return {
    ...base,
    problem: null,
    period: tr("dash.usage.period", { from: clock(from).slice(0, 16), to: clock(to).slice(0, 16) }),
    totals: {
      requests: round(u.total.requests),
      cpu: `${round(u.total.cpu_ms)} ms`,
      wall: `${round(u.total.wall_ms)} ms`,
      egress: bytes(u.total.egress_bytes),
      fetch: bytes(u.total.fetch_sent_bytes),
      db: `${round(u.total.db_ms)} ms, ${round(u.total.db_rows)} rows`,
      fuel: round(u.total.render_fuel),
    },
    charts: [
      { title: tr("dash.usage.chart_requests"), bars: hourlyBars(u.hours, last, slots, (h) => h.requests, tr("dash.usage.unit_requests"), tr) },
      { title: tr("dash.usage.chart_cpu"), bars: hourlyBars(u.hours, last, slots, (h) => h.cpu_ms, tr("dash.usage.unit_cpu"), tr) },
      { title: tr("dash.usage.chart_egress"), bars: hourlyBars(u.hours, last, slots, (h) => h.egress_bytes / 1024, tr("dash.usage.unit_kb"), tr) },
      { title: tr("dash.usage.chart_latency"), bars: hourlyBars(u.hours, last, slots, meanLatencyMs, tr("dash.usage.unit_latency"), tr) },
    ],
    quota: {
      tier: q.tier,
      period: tr("dash.usage.quota_period", { from: clock(q.period_start).slice(0, 10), to: clock(q.period_end).slice(0, 10) }),
      rows: [
        { name: tr("dash.overview.requests"), used: round(q.used.requests), limit: round(q.limits.requests), pct: percent(q.used.requests, q.limits.requests), over: q.over.includes("requests") },
        { name: tr("dash.usage.cpu"), used: `${round(q.used.cpu_ms)} ms`, limit: `${round(q.limits.cpu_ms)} ms`, pct: percent(q.used.cpu_ms, q.limits.cpu_ms), over: q.over.includes("cpu_ms") },
        { name: tr("dash.overview.egress"), used: bytes(q.used.egress_bytes), limit: bytes(q.limits.egress_bytes), pct: percent(q.used.egress_bytes, q.limits.egress_bytes), over: q.over.includes("egress_bytes") },
      ],
    },
  };
}
