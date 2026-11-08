// Delete and restore one app (#536; docs/contracts/deploy-api.md 0.7
// section 3). `deleteApp` is a soft delete: the app stops serving at once
// (its route entries removed, one route delta), its custom domains are
// detached, and it is hidden from every app endpoint; `restoreApp` brings it
// back within RESTORE_WINDOW_MS and re-publishes its active deployment; the
// purge (purge.ts) removes what is left after the window.
//
// Helpers #537 (rename) reuses: `removeAppRoutes` (every route entry of an
// app, inside the caller's transaction, under the route lock),
// `deleteAppHostnames` then `detachAppDomains` (Cloudflare first, then the
// rows), `deletedApp` (the row
// of a deleted app), and from busy.ts `assertAppIdle`.

import type { Deps } from "../context.ts";
import type { Db } from "../db/db.ts";
import { notFound } from "../errors.ts";
import { domainService } from "../domains/service.ts";
import { republishApp } from "../routes/activation.ts";
import { routeService } from "../routes/service.ts";
import { entriesWhere, lockRoutes, removeEntry, type RouteRemoval } from "../routes/table.ts";
import type { TenantDb } from "../tenancy/scope.ts";
import { assertAppIdle } from "./busy.ts";
import { appViews, requireApp, RESTORE_WINDOW_MS, type AppView } from "./repo.ts";

export interface DeletedApp {
  name: string;
  deleted_at: number;
  restorable_until: number;
}

/** Removes every route entry of `app` (all hostnames, all deployments); the caller publishes after commit. */
export async function removeAppRoutes(tx: Db, tenantId: string, app: string, now: number): Promise<RouteRemoval[]> {
  await lockRoutes(tx);
  const removals: RouteRemoval[] = [];
  for (const e of await entriesWhere(tx, "tenant_id = $1 and app = $2", [tenantId, app])) {
    const r = await removeEntry(tx, e.hostname, e.deployment_hash, now);
    if (r !== null) removals.push(r);
  }
  return removals;
}

/**
 * Deletes the Cloudflare custom hostname of each of `app`'s claimed domains
 * (as the erasure does, #419), before their rows change; returns the ids of
 * the domains whose custom hostname is gone. A Cloudflare failure keeps that
 * domain's `cf_hostname_id`: the domain job retries a released one, the purge
 * retries the rest. Called outside any transaction (network).
 */
export async function deleteAppHostnames(deps: Deps, db: Db, tenantId: string, app: string): Promise<Set<string>> {
  const rows = await db.query<{ id: string; cf_hostname_id: string }>(
    "select id, cf_hostname_id from domains where tenant_id = $1 and app = $2 and state <> 'released' and cf_hostname_id is not null",
    [tenantId, app],
  );
  const cf = domainService(deps).cloudflare;
  const gone = new Set<string>();
  if (cf === null) return gone;
  for (const r of rows) {
    try {
      await cf.delete(r.cf_hostname_id);
      gone.add(r.id);
    } catch (e) {
      deps.log.warn("deleteApp: cloudflare custom hostname not deleted", { tenant_id: tenantId, domain: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return gone;
}

/**
 * Detaches the rows of `app`'s domains, inside the caller's transaction:
 * `verified` -> `detached` (still owned by the tenant, ownership.ts),
 * `pending` -> `released`; `cf_hostname_id` is cleared for the ids in
 * `gone` (deleteAppHostnames). The caller removes the route entries.
 */
export async function detachAppDomains(tx: Db, tenantId: string, app: string, now: number, gone: Set<string>): Promise<number> {
  const rows = await tx.query<{ id: string }>("select id from domains where tenant_id = $1 and app = $2 and state <> 'released' for update", [tenantId, app]);
  for (const r of rows) {
    await tx.query(
      `update domains set
         state = case when state = 'verified' then 'detached' when state = 'pending' then 'released' else state end,
         detached_at = case when state = 'verified' then $3::bigint else detached_at end,
         detach_reason = case when state = 'verified' then 'removed' else detach_reason end,
         released_at = case when state = 'pending' then $3::bigint else released_at end,
         cf_hostname_id = case when $4::boolean then null else cf_hostname_id end
       where tenant_id = $1 and id = $2`,
      [tenantId, r.id, now, gone.has(r.id)],
    );
  }
  return rows.length;
}

/** The row of `name` when it is a deleted app of `tenantId`, or null. */
export async function deletedApp(db: Db, tenantId: string, name: string): Promise<DeletedApp | null> {
  const rows = await db.query<{ name: string; deleted_at: unknown }>("select name, deleted_at from apps where tenant_id = $1 and name = $2 and deleted_at is not null", [tenantId, name]);
  const r = rows[0];
  if (r === undefined) return null;
  const at = Number(r.deleted_at);
  return { name: r.name, deleted_at: at, restorable_until: at + RESTORE_WINDOW_MS };
}

/** `deleteApp`: the app stops serving now and is hidden; restorable for RESTORE_WINDOW_MS. */
export async function deleteApp(deps: Deps, db: TenantDb, name: string): Promise<{ result: DeletedApp; removals: RouteRemoval[] }> {
  const tenant = db.tenantId;
  await requireApp(db, tenant, name);
  await assertAppIdle(deps, db, tenant, name);
  const gone = await deleteAppHostnames(deps, db, tenant, name);
  const now = deps.now();
  const removals = await db.transaction(async (tx) => {
    const marked = await tx.query("update apps set deleted_at = $3 where tenant_id = $1 and name = $2 and deleted_at is null returning name", [tenant, name, now]);
    // A concurrent delete won the row.
    if (marked.length === 0) throw notFound();
    const removed = await removeAppRoutes(tx, tenant, name, now);
    await detachAppDomains(tx, tenant, name, now, gone);
    return removed;
  });
  await routeService(deps).publisher.publish();
  return { result: { name, deleted_at: now, restorable_until: now + RESTORE_WINDOW_MS }, removals };
}

/** `restoreApp`: within the window, the app is live again and its active deployment routed; 404 otherwise. */
export async function restoreApp(deps: Deps, db: TenantDb, name: string): Promise<AppView> {
  const tenant = db.tenantId;
  const now = deps.now();
  const gone = await deletedApp(db, tenant, name);
  if (gone === null || now >= gone.restorable_until) throw notFound();
  await assertAppIdle(deps, db, tenant, name);
  const routed = await db.transaction(async (tx) => {
    const back = await tx.query("update apps set deleted_at = null where tenant_id = $1 and name = $2 and deleted_at = $3 returning name", [tenant, name, gone.deleted_at]);
    if (back.length === 0) throw notFound();
    return republishApp(deps, tx, tenant, name, now);
  });
  if (routed) await routeService(deps).publisher.publish();
  const [view] = await appViews(db, deps.config.platformDomain, [await requireApp(db, tenant, name)]);
  return view as AppView;
}

/** `listApps?deleted=true`: the tenant's deleted apps still inside the window, by name. */
export async function listDeleted(deps: Deps, db: TenantDb): Promise<AppView[]> {
  const now = deps.now();
  const rows = await db.query<{ name: string; tenant_id: string; created_at: unknown; deleted_at: unknown }>(
    "select name, tenant_id, created_at, deleted_at from apps where tenant_id = $1 and deleted_at is not null and deleted_at > $2 order by name",
    [db.tenantId, now - RESTORE_WINDOW_MS],
  );
  const views = await appViews(
    db,
    deps.config.platformDomain,
    rows.map((r) => ({ name: r.name, tenant_id: r.tenant_id, created_at: Number(r.created_at) })),
  );
  return views.map((v, i) => {
    const at = Number(rows[i]?.deleted_at);
    return { ...v, deleted_at: at, restorable_until: at + RESTORE_WINDOW_MS };
  });
}
