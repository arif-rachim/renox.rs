// The control plane's metric families for Prometheus (#296,
// ops/observability/README.md): node health, cells, tenants, moves,
// replication as the nodes last reported it, failovers and alerts, all read
// from Postgres on each scrape. The crate-side families (requests, CPU,
// heap, outbox, sandbox, cold starts) are the workers' own (#295).
//
// `GET /v1/ops/metrics` in the Prometheus text format, for an operator token
// with `ops:read` (Prometheus reads it from a file). Not a deploy API
// operation: no tenant id is in a label, so a scrape is not a read of one
// tenant's data and is not audited (the per-tenant view is getOpsTenant,
// which is).

import type { Hono } from "hono";
import { num } from "../db/db.ts";
import { operation } from "../audit.ts";
import type { Deps, Env } from "../context.ts";
import { REPORT_STALE_MS } from "../workers/health.ts";
import { opsAuth } from "./auth.ts";

/** deploy-api.md section 16 FO6: the lag an alert fires at. */
export const LAG_ALERT_SECONDS = 10;

type Labels = Record<string, string>;

const escape = (v: string): string => v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');

class Exposition {
  private readonly out: string[] = [];

  family(name: string, type: "gauge" | "counter", help: string, samples: [Labels, number][]): void {
    this.out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) {
      const l = Object.entries(labels)
        .map(([k, v]) => `${k}="${escape(v)}"`)
        .join(",");
      this.out.push(`${name}${l === "" ? "" : `{${l}}`} ${Number.isFinite(value) ? value : 0}`);
    }
  }

  text(): string {
    return `${this.out.join("\n")}\n`;
  }
}

export async function metricsText(deps: Deps): Promise<string> {
  const db = deps.db;
  const now = deps.now();
  const e = new Exposition();

  const workers = await db.query<{ node_id: string; region: string; healthy: boolean; cells: unknown; max_cells: unknown; last_heartbeat_at: unknown }>(
    "select node_id, region, healthy, cells, max_cells, last_heartbeat_at from workers order by node_id",
  );
  e.family(
    "renox_cp_node_healthy",
    "gauge",
    "1 while the node's heartbeats arrive (deploy-api.md section 7), 0 once the sweep marked it unhealthy.",
    workers.map((w) => [{ node_id: w.node_id, region: w.region }, w.healthy ? 1 : 0]),
  );
  e.family("renox_cp_node_heartbeat_age_seconds", "gauge", "Seconds since the node's last heartbeat.", workers.map((w) => [{ node_id: w.node_id }, Math.max(0, (now - num(w.last_heartbeat_at)) / 1000)]));
  e.family("renox_cp_node_cells", "gauge", "Warm cells the node reported in its last heartbeat.", workers.map((w) => [{ node_id: w.node_id }, num(w.cells)]));
  e.family("renox_cp_node_max_cells", "gauge", "The node's cell capacity (node_register).", workers.map((w) => [{ node_id: w.node_id }, num(w.max_cells)]));

  const tenants = await db.query<{ tier: string; state: string; n: unknown }>("select tier, state, count(*) as n from tenants group by tier, state order by tier, state");
  e.family("renox_cp_tenants", "gauge", "Tenants by tier and state.", tenants.map((t) => [{ tier: t.tier, state: t.state }, num(t.n)]));
  const moving = await db.query<{ n: unknown }>("select count(*) as n from tenants where moving_since is not null");
  e.family("renox_cp_tenants_moving", "gauge", "Tenants being moved to a microVM (requests answer 503 RENOX_TENANT_MOVING).", [[{}, num(moving[0]?.n)]]);

  const reports = await db.query<{ report: { replication: string; lag_seconds: number | null }; reported_at: unknown }>("select report, reported_at from replication_reports");
  const replicated = reports.filter((r) => r.report.replication === "litestream");
  const lags = replicated.map((r) => r.report.lag_seconds ?? 0);
  e.family("renox_cp_replication_databases", "gauge", "Databases whose last report says Litestream replicates them.", [[{}, replicated.length]]);
  e.family("renox_cp_replication_lag_max_seconds", "gauge", "The largest replication lag among the last reports (FO6: alert above 10 s).", [[{}, lags.length === 0 ? 0 : Math.max(...lags)]]);
  e.family("renox_cp_replication_lagging_databases", "gauge", `Databases whose last report has a lag above ${LAG_ALERT_SECONDS} s.`, [[{}, lags.filter((l) => l > LAG_ALERT_SECONDS).length]]);
  e.family(
    "renox_cp_replication_stale_reports",
    "gauge",
    "Databases whose last replication report is older than two heartbeats.",
    [[{}, reports.filter((r) => now - num(r.reported_at) > REPORT_STALE_MS).length]],
  );

  const failovers = await db.query<{ reason: string; status: string; n: unknown }>("select reason, status, count(*) as n from failovers group by reason, status order by reason, status");
  e.family("renox_cp_failovers_total", "counter", "Tenant moves by failover or operator (deploy-api.md section 16), by outcome.", failovers.map((f) => [{ reason: f.reason, status: f.status }, num(f.n)]));
  const alerts = await db.query<{ kind: string; n: unknown }>("select kind, count(*) as n from alerts group by kind order by kind");
  e.family("renox_cp_alerts_total", "counter", "Rows of the control plane's alerts table, by kind.", alerts.map((a) => [{ kind: a.kind }, num(a.n)]));

  const deployments = await db.query<{ state: string; n: unknown }>("select state, count(*) as n from deployments group by state order by state");
  e.family("renox_cp_deployments", "gauge", "Deployments by state.", deployments.map((d) => [{ state: d.state }, num(d.n)]));
  e.family("renox_cp_up", "gauge", "1: the control plane answered and Postgres answered.", [[{}, 1]]);
  return e.text();
}

export function registerOpsMetrics(app: Hono<Env>, deps: Deps): void {
  // A refused credential is audited like on any route (#113); a scrape is not.
  app.get("/v1/ops/metrics", operation(deps, "getOpsMetrics"), opsAuth(deps, "ops:read"), async (c) => {
    const text = await metricsText(deps);
    return c.body(text, 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
  });
}
