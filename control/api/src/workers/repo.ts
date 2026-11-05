// The worker registry (deploy-api.md section 7).

import { num, type Db } from "../db/db.ts";

/** deploy-api.md section 7: intervals sent to nodes at registration. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const UNHEALTHY_AFTER_MS = 30_000;
export const RESYNC_INTERVAL_MS = 60_000;

export async function healthyNodes(db: Db): Promise<string[]> {
  const rows = await db.query<{ node_id: string }>("select node_id from workers where healthy order by node_id");
  return rows.map((r) => r.node_id);
}

export interface WorkerRow {
  node_id: string;
  healthy: boolean;
  last_heartbeat_at: number;
}

export async function findWorker(db: Db, nodeId: string): Promise<WorkerRow | null> {
  const rows = await db.query<{ node_id: string; healthy: boolean; last_heartbeat_at: unknown }>(
    "select node_id, healthy, last_heartbeat_at from workers where node_id = $1",
    [nodeId],
  );
  const r = rows[0];
  return r === undefined ? null : { node_id: r.node_id, healthy: r.healthy, last_heartbeat_at: num(r.last_heartbeat_at) };
}

/** The heartbeat's `disk` (deploy-api.md 0.4 section 7, #311). */
export interface DiskReport {
  level: "ok" | "warn" | "critical";
  free_bytes: number;
  watermark: number | null;
}

export async function recordDisk(db: Db, nodeId: string, disk: DiskReport, now: number): Promise<void> {
  await db.query("update workers set disk = $2::text::jsonb, disk_reported_at = $3 where node_id = $1", [nodeId, JSON.stringify(disk), now]);
}

/** The heartbeat's `process_isolation` (deploy-api.md 0.6.2 section 7, #460). */
export interface ProcessIsolationReport {
  enabled: boolean;
  own_ignored: string[];
}

/**
 * Keeps the last heartbeat's `process_isolation`; a heartbeat without it
 * (a worker older than 0.6.2) clears it, so the console never shows an old
 * report as current.
 */
export async function recordProcessIsolation(db: Db, nodeId: string, report: ProcessIsolationReport | undefined, now: number): Promise<void> {
  await db.query("update workers set process_isolation = $2::text::jsonb, process_isolation_reported_at = $3 where node_id = $1", [
    nodeId,
    report === undefined ? null : JSON.stringify({ enabled: report.enabled, own_ignored: report.own_ignored }),
    report === undefined ? null : now,
  ]);
}

function jsonColumn<T>(v: T | string | null): T | null {
  return typeof v === "string" ? (JSON.parse(v) as T) : v;
}

/** The last `process_isolation` of `nodeId`, or null (never reported, or an unknown node). */
export async function processIsolationOf(db: Db, nodeId: string): Promise<ProcessIsolationReport | null> {
  const rows = await db.query<{ process_isolation: ProcessIsolationReport | string | null }>("select process_isolation from workers where node_id = $1", [nodeId]);
  return jsonColumn(rows[0]?.process_isolation ?? null);
}

/**
 * getOpsTenant's `process_effective` (deploy-api.md 0.6.2 section 17): what
 * the owning node actually runs, in the contract's order.
 */
export function processEffective(process: "shared" | "own", nodeId: string | null, report: ProcessIsolationReport | null): "shared" | "own" | "unknown" {
  if (nodeId === null) return "unknown";
  if (process === "shared") return "shared";
  if (report === null) return "unknown";
  return report.enabled ? "own" : "shared";
}

/** A node as getNode answers it (deploy-api.md 0.4 section 7, `NodeDetail`), or null. */
export async function nodeDetail(db: Db, nodeId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.query<{ node_id: string; region: string; worker_version: string; healthy: boolean; last_heartbeat_at: unknown; route_version: unknown; cells: unknown; max_cells: unknown; disk: DiskReport | string | null; process_isolation: ProcessIsolationReport | string | null }>(
    "select node_id, region, worker_version, healthy, last_heartbeat_at, route_version, cells, max_cells, disk, process_isolation from workers where node_id = $1",
    [nodeId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    node_id: r.node_id,
    region: r.region,
    worker_version: r.worker_version,
    healthy: r.healthy,
    last_heartbeat_at: num(r.last_heartbeat_at),
    route_version: num(r.route_version),
    cells: num(r.cells),
    max_cells: num(r.max_cells),
    disk: jsonColumn(r.disk),
    // 0.6.2 (#460): null when the node's last heartbeat did not carry it.
    process_isolation: jsonColumn(r.process_isolation),
  };
}
