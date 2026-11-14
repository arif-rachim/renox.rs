// Rename one app (#537; docs/contracts/deploy-api.md 0.7 section 3).
//
// `renameApp` moves an app to a new name in one transaction: the `apps` row
// and, through the `on update cascade` foreign keys of
// migrations/0034_app_rename.sql, every row keyed by the name (deployments
// and their permissions, secrets and the secret set, domains, client error
// groups, deployments and events, exports, route entries); `app_modules` and
// `deployment_advisories` hold the name without a foreign key and are
// updated here. The route entries of `<old>.<platform domain>` are removed
// and the same entries (same deployment, status, node, tier, secret version
// and database) are written for `<new>.<platform domain>`; the custom domains'
// entries are written again with the new app name; one route delta carries
// it all. The old name goes to quarantine (slugs.ts) and to `app_renames`, so
// `getApp` of the old name answers a 404 that names the new one to the same
// tenant (`renox deploy` from a stale `renox.toml` stops with a hint).
//
// What does not change: the database id (`apps.database`, `<tenant_id>.<old>`
// for an app with its own database: an id, not the name), the deployments
// and their hashes (V3, `manifest.app.name` = `{app}`, is checked at upload
// only, so the active deployment keeps serving under the new name), the
// meters (keyed by deployment), the source maps (by tenant and hash), the
// export objects (by database). The log lines kept in the API's log store are
// re-labelled after the commit.

import type { Deps } from "../context.ts";
import type { Db } from "../db/db.ts";
import { conflict, invalid, notFound } from "../errors.ts";
import { isUniqueViolation } from "../domains/ownership.ts";
import { logIngest } from "../ingest/logs.ts";
import { routeService } from "../routes/service.ts";
import { manifestOf, moduleConfigFor } from "../routes/module-config.ts";
import { entriesWhere, lockRoutes, upsertEntry, type RouteEntry } from "../routes/table.ts";
import type { TenantDb } from "../tenancy/scope.ts";
import { assertAppIdle } from "./busy.ts";
import { removeAppRoutes } from "./delete.ts";
import { appViews, requireApp, type AppView } from "./repo.ts";
import { QUARANTINE_MS, quarantineSlug } from "./slugs.ts";

/** The other rows keyed by the app name without a foreign key; static statements (tests/sql-lint.test.ts). */
const UNKEYED_UPDATES = [
  "update app_modules set app = $3 where tenant_id = $1 and app = $2",
  "update deployment_advisories set app = $3 where tenant_id = $1 and app = $2",
];

export interface Renamed {
  view: AppView;
  /** Route entries removed (the old platform hostname) and written (the new one, the custom domains). */
  removed: number;
  written: number;
}

/** The new name `old` of `tenantId` was renamed to, while the hint lasts; null otherwise. */
export async function renamedTo(db: Db, tenantId: string, old: string, now: number): Promise<string | null> {
  const rows = await db.query<{ new_name: string }>("select new_name from app_renames where tenant_id = $1 and old_name = $2 and until > $3", [tenantId, old, now]);
  return rows[0]?.new_name ?? null;
}

/** `renameApp`: `from` becomes `to`, with everything it holds; 404, 400, 409 as in the contract. */
export async function renameApp(deps: Deps, db: TenantDb, from: string, to: string): Promise<Renamed> {
  const tenant = db.tenantId;
  await requireApp(db, tenant, from);
  if (to === from) throw invalid("name", "must differ from the app's name");
  await assertAppIdle(deps, db, tenant, from);
  const now = deps.now();
  const platform = deps.config.platformDomain;
  const oldHost = `${from}.${platform}`;
  const newHost = `${to}.${platform}`;
  const result = await db.transaction(async (tx) => {
    // The trigger of 0034 checks the slug rules at the API's clock.
    await tx.query("select set_config('renox.now', $1, true)", [String(now)]);
    const live = await tx.query("select name from apps where tenant_id = $1 and name = $2 and deleted_at is null for update", [tenant, from]);
    // A concurrent delete or rename won the row.
    if (live.length === 0) throw notFound();
    await lockRoutes(tx);
    const before: RouteEntry[] = await entriesWhere(tx, "tenant_id = $1 and app = $2", [tenant, from]);
    const removals = await removeAppRoutes(tx, tenant, from, now);
    let moved: unknown[];
    try {
      moved = await tx.query("update apps set name = $3 where tenant_id = $1 and name = $2 returning name", [tenant, from, to]);
    } catch (e) {
      // The name is held by an app (of any tenant, a deleted one included): the same answer, no owner named.
      if (isUniqueViolation(e)) throw conflict("name", "not available");
      throw e;
    }
    // Reserved, or in another tenant's quarantine: the trigger skipped the update.
    if (moved.length === 0) throw conflict("name", "not available");
    for (const sql of UNKEYED_UPDATES) await tx.query(sql, [tenant, from, to]);
    // The same entries under the new name; draining first, for the one-active-per-hostname index.
    const sorted = [...before].sort((a, b) => (a.status === b.status ? 0 : a.status === "draining" ? -1 : 1));
    for (const { version: _v, module_config: _m, ...e } of sorted) {
      // 0.12 (#826): the email `app_url` is recomputed, since it may name the old platform host.
      const module_config = await moduleConfigFor(tx, deps, tenant, to, await manifestOf(tx, tenant, to, e.deployment_hash));
      await upsertEntry(tx, { ...e, hostname: e.hostname === oldHost ? newHost : e.hostname, app: to, updated_at: now, ...(module_config === undefined ? {} : { module_config }) });
    }
    await quarantineSlug(tx, from, tenant, now);
    // The hint: `from` now means `to`; earlier names of the app follow it; `to` is a live name again.
    await tx.query("delete from app_renames where tenant_id = $1 and old_name = $2", [tenant, to]);
    await tx.query("update app_renames set new_name = $3 where tenant_id = $1 and new_name = $2", [tenant, from, to]);
    await tx.query(
      `insert into app_renames (tenant_id, old_name, new_name, renamed_at, until) values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, old_name) do update set new_name = excluded.new_name, renamed_at = excluded.renamed_at, until = excluded.until`,
      [tenant, from, to, now, now + QUARANTINE_MS],
    );
    return { removed: removals.length, written: sorted.length };
  });
  if (result.removed + result.written > 0) await routeService(deps).publisher.publish();
  await logIngest(deps)
    .store.renameApp(tenant, from, to)
    .catch((e: unknown) => deps.log.warn("renameApp: log lines not re-labelled", { tenant_id: tenant, error: e instanceof Error ? e.message : String(e) }));
  const [view] = await appViews(db, platform, [await requireApp(db, tenant, to)]);
  return { view: view as AppView, ...result };
}
