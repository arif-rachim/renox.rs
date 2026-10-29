// The route table and its versioned change log (docs/contracts/deploy-api.md
// section 8). Every change takes the next route version; the transaction
// holds advisory lock ROUTE_LOCK so versions commit in increasing order.

import { jsonb, num, type Db } from "../db/db.ts";

const ROUTE_LOCK = 8;

export interface RouteEntry {
  hostname: string;
  tenant_id: string;
  app: string;
  deployment_hash: string;
  status: "active" | "draining";
  updated_at: number;
  version: number;
  tier: "free" | "paid";
  node_id: string;
  secrets_version: number;
  /** 0.3: the app's own database (deploy-api.md section 3); absent for the tenant's shared file. */
  database?: string;
}

export interface RouteRemoval {
  hostname: string;
  deployment_hash: string;
  version: number;
}

export interface RouteDelta {
  type: "route_delta";
  schema_version: 0;
  prev_version: number;
  version: number;
  upserts: RouteEntry[];
  removals: RouteRemoval[];
}

export interface RouteSnapshot {
  type: "route_snapshot";
  schema_version: 0;
  version: number;
  entries: RouteEntry[];
}

/** Takes the route lock for the rest of the transaction. */
export async function lockRoutes(tx: Db): Promise<void> {
  await tx.query("select pg_advisory_xact_lock($1)", [ROUTE_LOCK]);
}

async function nextVersion(tx: Db): Promise<number> {
  const rows = await tx.query<{ v: unknown }>("select nextval('route_version_seq') as v");
  return num(rows[0]?.v);
}

/** Inserts or replaces the entry for (hostname, deployment_hash) with a new version. */
export async function upsertEntry(tx: Db, e: Omit<RouteEntry, "version">): Promise<RouteEntry> {
  const entry: RouteEntry = { ...e, version: await nextVersion(tx) };
  await tx.query(
    `insert into route_entries (hostname, deployment_hash, tenant_id, app, status, updated_at, version, tier, node_id, secrets_version, database)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (hostname, deployment_hash) do update set tenant_id = excluded.tenant_id, app = excluded.app, status = excluded.status,
       updated_at = excluded.updated_at, version = excluded.version, tier = excluded.tier, node_id = excluded.node_id,
       secrets_version = excluded.secrets_version, database = excluded.database`,
    [entry.hostname, entry.deployment_hash, entry.tenant_id, entry.app, entry.status, entry.updated_at, entry.version, entry.tier, entry.node_id, entry.secrets_version, entry.database ?? null],
  );
  await tx.query("insert into route_changes (version, kind, hostname, deployment_hash, entry, at) values ($1, 'upsert', $2, $3, $4::text::jsonb, $5)", [
    entry.version,
    entry.hostname,
    entry.deployment_hash,
    jsonb(entry),
    entry.updated_at,
  ]);
  return entry;
}

/** Removes the entry for (hostname, deployment_hash), if any, with a new version. */
export async function removeEntry(tx: Db, hostname: string, hash: string, now: number): Promise<RouteRemoval | null> {
  const gone = await tx.query("delete from route_entries where hostname = $1 and deployment_hash = $2 returning hostname", [hostname, hash]);
  if (gone.length === 0) return null;
  const version = await nextVersion(tx);
  await tx.query("insert into route_changes (version, kind, hostname, deployment_hash, entry, at) values ($1, 'remove', $2, $3, null, $4)", [
    version,
    hostname,
    hash,
    now,
  ]);
  return { hostname, deployment_hash: hash, version };
}

function toEntry(r: Record<string, unknown>): RouteEntry {
  return {
    hostname: r.hostname as string,
    tenant_id: r.tenant_id as string,
    app: r.app as string,
    deployment_hash: r.deployment_hash as string,
    status: r.status as RouteEntry["status"],
    updated_at: num(r.updated_at),
    version: num(r.version),
    tier: r.tier as RouteEntry["tier"],
    node_id: r.node_id as string,
    secrets_version: num(r.secrets_version),
    ...(typeof r.database === "string" ? { database: r.database } : {}),
  };
}

export async function entriesWhere(db: Db, where: string, params: unknown[]): Promise<RouteEntry[]> {
  const rows = await db.query(`select * from route_entries where ${where} order by hostname, deployment_hash`, params);
  return rows.map(toEntry);
}

/** The latest committed route version (0 = nothing ever changed). */
export async function currentVersion(db: Db): Promise<number> {
  const rows = await db.query<{ v: unknown }>("select coalesce(max(version), 0) as v from route_changes");
  return num(rows[0]?.v);
}

export async function snapshot(db: Db): Promise<RouteSnapshot> {
  return db.transaction(async (tx) => {
    await lockRoutes(tx);
    const version = await currentVersion(tx);
    const entries = await entriesWhere(tx, "true", []);
    return { type: "route_snapshot", schema_version: 0, version, entries };
  });
}

/**
 * The changes after `since`, as one delta, or null when there are none. Several
 * changes of one (hostname, hash) collapse to the latest, so the delta keeps
 * rule R1 (deploy-api.md section 8).
 */
export async function deltaSince(db: Db, since: number): Promise<RouteDelta | null> {
  const rows = await db.query<{ version: unknown; kind: string; hostname: string; deployment_hash: string; entry: RouteEntry | null }>(
    "select version, kind, hostname, deployment_hash, entry from route_changes where version > $1 order by version",
    [since],
  );
  if (rows.length === 0) return null;
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(`${r.hostname} ${r.deployment_hash}`, r);
  const upserts: RouteEntry[] = [];
  const removals: RouteRemoval[] = [];
  for (const r of [...latest.values()].sort((a, b) => num(a.version) - num(b.version))) {
    if (r.kind === "upsert") upserts.push(r.entry as RouteEntry);
    else removals.push({ hostname: r.hostname, deployment_hash: r.deployment_hash, version: num(r.version) });
  }
  return { type: "route_delta", schema_version: 0, prev_version: since, version: num(rows.at(-1)?.version), upserts, removals };
}
