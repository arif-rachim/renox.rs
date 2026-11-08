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

/** deploy-api.md 0.7 section 3 (#536): a deleted app can be restored this long after `deleted_at`, then it is purged. */
export const RESTORE_WINDOW_MS = 7 * 86_400_000;

/** The live app `name` of `tenantId`, or 404; a deleted app (0.7, `deleted_at` set) is 404 too. */
export async function requireApp(db: Db, tenantId: string, name: string): Promise<AppRow> {
  const rows = await db.query<{ name: string; tenant_id: string; created_at: unknown }>(
    "select name, tenant_id, created_at from apps where tenant_id = $1 and name = $2 and deleted_at is null",
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
  /** 0.7: only on `listApps?deleted=true`. */
  deleted_at?: number;
  restorable_until?: number;
}

/** The `App` schema of the contract for `rows` (all of one tenant). */
export async function appViews(db: Db, platformDomain: string, rows: AppRow[]): Promise<AppView[]> {
  if (rows.length === 0) return [];
  const names = rows.map((r) => r.name);
  // deploy-api.md section 3: the platform hostname and every verified custom domain.
  const custom = await db.query<{ app: string; hostname: string }>(
    "select app, hostname from domains where tenant_id = $1 and state = 'verified' and app = any($2::text[]) order by hostname",
    [rows[0]?.tenant_id, names],
  );
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
    hostnames: [`${r.name}.${platformDomain}`, ...custom.filter((c) => c.app === r.name).map((c) => c.hostname)],
  }));
}
