// App lookups shared by every module. Every query is scoped by the tenant id
// of the principal; an app of another tenant is "not found" (deploy-api.md
// section 2).

import { num, type Db } from "../db/db.ts";
import { notFound } from "../errors.ts";

export interface AppRow {
  name: string;
  tenant_id: string;
  created_at: number;
}

/** The app `name` of `tenantId`, or 404. */
export async function requireApp(db: Db, tenantId: string, name: string): Promise<AppRow> {
  const rows = await db.query<{ name: string; tenant_id: string; created_at: unknown }>(
    "select name, tenant_id, created_at from apps where tenant_id = $1 and name = $2",
    [tenantId, name],
  );
  const row = rows[0];
  if (row === undefined) throw notFound();
  return { name: row.name, tenant_id: row.tenant_id, created_at: num(row.created_at) };
}

export interface AppView {
  name: string;
  tenant_id: string;
  created_at: number;
  active_deployment: string | null;
  hostnames: string[];
}

/** The `App` schema of the contract for `rows` (all of one tenant). */
export async function appViews(db: Db, platformDomain: string, rows: AppRow[]): Promise<AppView[]> {
  if (rows.length === 0) return [];
  const names = rows.map((r) => r.name);
  const active = new Map(
    (
      await db.query<{ app: string; hash: string }>(
        "select app, hash from deployments where tenant_id = $1 and state = 'active' and app = any($2::text[])",
        [rows[0]?.tenant_id, names],
      )
    ).map((r) => [r.app, r.hash]),
  );
  return rows.map((r) => ({
    name: r.name,
    tenant_id: r.tenant_id,
    created_at: r.created_at,
    active_deployment: active.get(r.name) ?? null,
    hostnames: [`${r.name}.${platformDomain}`],
  }));
}
