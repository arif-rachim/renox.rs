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
