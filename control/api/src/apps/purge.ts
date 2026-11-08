// The purge of deleted apps (#536; docs/contracts/deploy-api.md 0.7 section
// 3). `sweepAppDeletions` runs every 10 minutes (src/main.ts): an app whose
// `deleted_at` is older than RESTORE_WINDOW_MS loses, in this order,
//
// | Step | What |
// | --- | --- |
// | own database | an app with a database of its own (`<tenant_id>.<app>`): `nodeDropTenant?database=<id>&purge_replica=true` on every registered node with a listener, so its cells drain and every Litestream generation of that database goes; a node that does not answer 200 keeps the app pending and the next tick retries (as the erasure does) |
// | custom hostnames | the Cloudflare custom hostname of each remaining domain, before its row (as the erasure does, #419); a failure retries next tick |
// | records | in one transaction: client error events, deployments and groups, domains, exports, route entries, secrets and the secret set, permissions, module installs, advisories, deployments, then the `apps` row; the name goes to quarantine (slugs.ts) |
// | objects | after commit: the artifact of each hash no other deployment holds (content-addressed objects shared with another app stay, as `prune` decides), the app's source maps, its export objects |
//
// What stays: the audit rows, the meter rows (billing), and an app sharing
// the tenant's file leaves its tables (`app__…`) in that file: the shared
// database is never touched. One `source: platform` log line (`fields.kind:
// "purge"`) records each purge.

import type { Deps } from "../context.ts";
import type { Db } from "../db/db.ts";
import { artifactKey, sourcemapKey } from "../deployments/repo.ts";
import { domainService } from "../domains/service.ts";
import { logIngest } from "../ingest/logs.ts";
import { routeService } from "../routes/service.ts";
import { nodeCall, nodeTarget } from "../workers/failover.ts";
import { removeAppRoutes } from "./delete.ts";
import { RESTORE_WINDOW_MS } from "./repo.ts";
import { quarantineSlug } from "./slugs.ts";

/** How often main.ts runs the sweep. */
export const PURGE_INTERVAL_MS = 10 * 60_000;

/** The app's rows, children before `apps`; static statements (tests/sql-lint.test.ts). */
const APP_DELETES = [
  "delete from client_error_events where tenant_id = $1 and app = $2",
  "delete from client_error_deployments where tenant_id = $1 and app = $2",
  "delete from client_error_groups where tenant_id = $1 and app = $2",
  "delete from domains where tenant_id = $1 and app = $2",
  "delete from exports where tenant_id = $1 and app = $2",
  "delete from route_entries where tenant_id = $1 and app = $2",
  "delete from secrets where tenant_id = $1 and app = $2",
  "delete from secret_sets where tenant_id = $1 and app = $2",
  "delete from permissions where tenant_id = $1 and app = $2",
  "delete from app_modules where tenant_id = $1 and app = $2",
  "delete from deployment_advisories where tenant_id = $1 and app = $2",
  "delete from deployments where tenant_id = $1 and app = $2",
  "delete from apps where tenant_id = $1 and name = $2 and deleted_at is not null",
];

type Pending = {
  name: string;
  tenant_id: string;
  database: string | null;
};

/** Drops the app's own database on every node with a listener; true when each answered 200. */
async function dropOwnDatabase(deps: Deps, db: Db, app: Pending): Promise<boolean> {
  if (app.database === null) return true;
  const nodes = await db.query<{ node_id: string }>("select node_id from workers order by node_id", []);
  let all = true;
  for (const { node_id: node } of nodes) {
    const target = await nodeTarget(deps, db, node);
    if (target.listen_url === null || target.token === null) continue;
    try {
      const res = await nodeCall(deps)(target, "DELETE", `/nodes/${node}/tenants/${app.tenant_id}?database=${encodeURIComponent(app.database)}&purge_replica=true`, undefined, 60_000);
      if (res.status !== 200) all = false;
    } catch {
      all = false;
    }
  }
  return all;
}

/** Deletes the Cloudflare custom hostname of every remaining domain of the app; true when none is left. */
async function deleteHostnames(deps: Deps, db: Db, app: Pending): Promise<boolean> {
  const rows = await db.query<{ id: string; cf_hostname_id: string }>("select id, cf_hostname_id from domains where tenant_id = $1 and app = $2 and cf_hostname_id is not null", [app.tenant_id, app.name]);
  if (rows.length === 0) return true;
  const cf = domainService(deps).cloudflare;
  if (cf === null) return false;
  for (const r of rows) {
    try {
      await cf.delete(r.cf_hostname_id);
    } catch (e) {
      deps.log.warn("app purge: cloudflare custom hostname not deleted", { tenant_id: app.tenant_id, domain: r.id, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
    await db.query("update domains set cf_hostname_id = null where tenant_id = $1 and id = $2", [app.tenant_id, r.id]);
  }
  return true;
}

/** Purges one app: `purged`, `retry` (a step failed; the next tick tries again) or `skipped` (restored meanwhile). */
export async function purgeApp(deps: Deps, app: Pending): Promise<"purged" | "retry" | "skipped"> {
  const db = deps.db;
  const now = deps.now();
  if (!(await dropOwnDatabase(deps, db, app))) return "retry";
  if (!(await deleteHostnames(deps, db, app))) return "retry";
  const objects = await db.transaction(async (tx) => {
    const still = await tx.query("select 1 from apps where tenant_id = $1 and name = $2 and deleted_at is not null and deleted_at < $3 for update", [app.tenant_id, app.name, now - RESTORE_WINDOW_MS]);
    // Restored meanwhile, or purged by another instance.
    if (still.length === 0) return null;
    const hashes = (await tx.query<{ hash: string }>("select hash from deployments where tenant_id = $1 and app = $2", [app.tenant_id, app.name])).map((r) => r.hash);
    const exports = (await tx.query<{ object_key: string }>("select object_key from exports where tenant_id = $1 and app = $2", [app.tenant_id, app.name])).map((r) => r.object_key);
    // Any route entry left (the delete removed them) goes with a route version, so nodes see it.
    const removed = await removeAppRoutes(tx, app.tenant_id, app.name, now);
    for (const sql of APP_DELETES) await tx.query(sql, [app.tenant_id, app.name]);
    await quarantineSlug(tx, app.name, app.tenant_id, now);
    const keys: string[] = [...exports];
    for (const hash of new Set(hashes)) {
      // As prune: the content-addressed object stays while another deployment (of any tenant) holds the hash.
      // The sweep runs outside any request, on the platform's handle, so this read needs no crossTenant.
      const refs = await tx.query("select 1 from deployments where hash = $1 and state not in ('pruned', 'rejected') limit 1", [hash]);
      if (refs.length === 0) keys.push(artifactKey(hash));
      // Source maps are per tenant and hash: they stay while another app of the tenant holds it.
      const mine = await tx.query("select 1 from deployments where tenant_id = $1 and hash = $2 limit 1", [app.tenant_id, hash]);
      if (mine.length === 0) keys.push(sourcemapKey(app.tenant_id, hash));
    }
    return { keys, routes: removed.length };
  });
  if (objects === null) return "skipped";
  if (objects.routes > 0) await routeService(deps).publisher.publish();
  for (const key of objects.keys) await deps.store.delete(key).catch(() => undefined);
  await logIngest(deps).store.append([
    {
      ts: now,
      tenant_id: app.tenant_id,
      app: app.name,
      deployment_hash: "0".repeat(64),
      request_id: null,
      module: "platform",
      level: "info",
      message: `app ${app.name} purged ${RESTORE_WINDOW_MS / 86_400_000} days after its deletion${app.database === null ? "" : `, with its database ${app.database}`}`,
      fields: { kind: "purge" },
      source: "platform",
      node_id: "control-plane",
    },
  ]).catch(() => undefined);
  return "purged";
}

/** The sweep: every app deleted more than RESTORE_WINDOW_MS ago. Returns the number purged. */
export async function sweepAppDeletions(deps: Deps): Promise<number> {
  const due = await deps.db.query<Pending>(
    "select name, tenant_id, database from apps where deleted_at is not null and deleted_at < $1 order by deleted_at, name",
    [deps.now() - RESTORE_WINDOW_MS],
  );
  let purged = 0;
  for (const app of due) {
    try {
      if ((await purgeApp(deps, app)) === "purged") purged++;
    } catch (e) {
      deps.log.warn("app purge failed", { tenant_id: app.tenant_id, app: app.name, error: e instanceof Error ? e.name : "error" });
    }
  }
  return purged;
}
