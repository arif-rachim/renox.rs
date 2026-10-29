// Backups of an app's database (docs/contracts/deploy-api.md 0.3 section 14).
// getBackups (#257): the owning node's replication status (node listener,
// GET /nodes/{node}/tenants/{tenant}/replication) plus the control plane's
// own record of the last failover. When the node does not answer within 2 s
// the answer is the last status seen, with `stale: true`.

import type { Hono } from "hono";
import { operation } from "../audit.ts";
import { tenantAuth } from "../auth/middleware.ts";
import type { Deps, Env } from "../context.ts";
import type { Db } from "../db/db.ts";
import { pathParam } from "../http.ts";
import { requireApp } from "../apps/repo.ts";
import { tenantDb } from "../tenancy/scope.ts";
import { lastFailover, nodeCall, nodeTarget } from "../workers/failover.ts";

/** How long getBackups waits for the node. */
export const STATUS_TIMEOUT_MS = 2_000;

/** docs/04-isolation-security.md "Per-tenant limits": the database quota per tier. */
export const DB_QUOTA_BYTES = { free: 100 * 1024 * 1024, paid: 10 * 1024 * 1024 * 1024 } as const;

interface NodeStatus {
  replication: "none" | "litestream";
  state: "off" | "starting" | "replicating" | "stopped";
  replica: { kind: "file" | "s3"; region?: string } | null;
  last_sync_at: number | null;
  lag_seconds: number | null;
  retention_hours: number;
  generations: { id: string; start: number; end: number }[];
  db: { size_bytes: number; quota_bytes: number; wal_bytes: number };
}

const lastSeen = new WeakMap<Deps, Map<string, NodeStatus>>();

/** The database id of an app (deploy-api.md section 3): its own, or the tenant's shared file. */
export async function databaseOf(_db: Db, tenantId: string, _app: string): Promise<string> {
  return tenantId;
}

/** The node that serves the tenant now (its route entries), or null. */
export async function owningNode(db: Db, tenantId: string): Promise<string | null> {
  const rows = await db.query<{ node_id: string }>(
    "select node_id from route_entries where tenant_id = $1 order by status, version desc limit 1",
    [tenantId],
  );
  return rows[0]?.node_id ?? null;
}

/** The node's replication status of `database`, or null when it did not answer. */
export async function nodeStatus(deps: Deps, db: Db, tenantId: string, database: string): Promise<NodeStatus | null> {
  const node = await owningNode(db, tenantId);
  if (node === null) return null;
  const target = await nodeTarget(deps, db, node);
  try {
    const res = await nodeCall(deps)(target, "GET", `/nodes/${node}/tenants/${tenantId}/replication?database=${encodeURIComponent(database)}`, undefined, STATUS_TIMEOUT_MS);
    if (res.status !== 200) return null;
    return res.body as NodeStatus;
  } catch {
    return null;
  }
}

export function registerBackups(app: Hono<Env>, deps: Deps): void {
  app.get("/v1/apps/:app/backups", operation(deps, "getBackups"), tenantAuth(deps, "apps:read"), async (c) => {
    const db = tenantDb(deps, c);
    const tenant = db.tenantId;
    const row = await requireApp(db, tenant, pathParam(c, "app", "AppName"));
    const database = await databaseOf(db, tenant, row.name);
    const tierRows = await db.query<{ tier: "free" | "paid" }>("select tier from tenants where id = $1", [tenant]);
    const quota = DB_QUOTA_BYTES[tierRows[0]?.tier ?? "free"];
    let seen = lastSeen.get(deps);
    if (seen === undefined) {
      seen = new Map();
      lastSeen.set(deps, seen);
    }
    const key = `${tenant}/${database}`;
    const fresh = await nodeStatus(deps, db, tenant, database);
    if (fresh !== null) seen.set(key, fresh);
    const s = fresh ?? seen.get(key) ?? null;
    const failover = await lastFailover(db, tenant);
    return c.json({
      app: row.name,
      database,
      replication: s?.replication ?? "none",
      state: s?.state ?? "off",
      replica: s?.replica ?? null,
      last_sync_at: s?.last_sync_at ?? null,
      lag_seconds: s?.lag_seconds ?? null,
      retention_hours: s?.retention_hours ?? 0,
      generations: s?.generations ?? [],
      db: { size_bytes: s?.db.size_bytes ?? 0, quota_bytes: quota, wal_bytes: s?.db.wal_bytes ?? 0 },
      last_failover: failover,
      stale: fresh === null,
    });
  });
}
