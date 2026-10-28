// Activation and rollback (docs/contracts/deploy-api.md section 6): a pointer
// switch per app, published to every node as one route delta.

import { assertTransition } from "../contract.ts";
import type { Db } from "../db/db.ts";
import { ApiError, conflict } from "../errors.ts";
import { prune, requireDeployment, transition, type Actor, type DeploymentRow } from "../deployments/repo.ts";
import { ownerOf } from "../workers/assign.ts";
import { healthyNodes } from "../workers/repo.ts";
import type { Deps } from "../context.ts";
import { routeService } from "./service.ts";
import { entriesWhere, lockRoutes, removeEntry, upsertEntry } from "./table.ts";

/** deploy-api.md section 8: a draining entry is removed this long after the switch. */
export const DRAIN_MS = 120_000;

export const hostnamesOf = (deps: Deps, app: string): string[] => [`${app}.${deps.config.platformDomain}`];

async function tenantInfo(db: Db, tenantId: string): Promise<{ tier: "free" | "paid"; state: string }> {
  const rows = await db.query<{ tier: "free" | "paid"; state: string }>("select tier, state from tenants where id = $1", [tenantId]);
  const row = rows[0];
  if (row === undefined) throw new ApiError("RENOX_UNAUTHENTICATED");
  return row;
}

async function latestSecretsVersion(db: Db, app: string): Promise<number> {
  const rows = await db.query<{ version: number }>("select version from secret_sets where app = $1", [app]);
  return Number(rows[0]?.version ?? 0);
}

async function activeOf(tx: Db, tenantId: string, app: string): Promise<DeploymentRow | null> {
  const rows = await tx.query<{ hash: string }>("select hash from deployments where tenant_id = $1 and app = $2 and state = 'active' for update", [tenantId, app]);
  return rows[0] === undefined ? null : requireDeployment(tx, tenantId, app, rows[0].hash);
}

/**
 * Points the app's hostnames at `hash` (active) and the previous deployment's
 * entries at draining, in the order the one-active-per-hostname index needs.
 */
async function pointAt(tx: Db, deps: Deps, d: { tenant_id: string; app: string }, hash: string, previous: string | null, node: string, tier: "free" | "paid", secretsVersion: number, now: number): Promise<void> {
  for (const hostname of hostnamesOf(deps, d.app)) {
    const base = { hostname, tenant_id: d.tenant_id, app: d.app, updated_at: now, tier, node_id: node };
    if (previous !== null && previous !== hash) {
      const [old] = await entriesWhere(tx, "hostname = $1 and deployment_hash = $2", [hostname, previous]);
      await upsertEntry(tx, { ...base, deployment_hash: previous, status: "draining", secrets_version: old?.secrets_version ?? 0 });
    }
    await upsertEntry(tx, { ...base, deployment_hash: hash, status: "active", secrets_version: secretsVersion });
  }
}

export async function activate(deps: Deps, tenantId: string, app: string, hash: string, by: Actor): Promise<DeploymentRow> {
  const { db } = deps;
  const service = routeService(deps);
  const { tier, state } = await tenantInfo(db, tenantId);
  if (state === "suspended") throw conflict("tenant", "the tenant is suspended");

  const start = await db.transaction(async (tx) => {
    const d = await requireDeployment(tx, tenantId, app, hash, true);
    if (d.state === "active") return "unchanged" as const;
    if (d.state === "superseded") throw conflict("state", "superseded -> activating is not allowed; use rollback");
    assertTransition("deployment", d.state, "activating");
    const busy = await tx.query("select 1 from deployments where app = $1 and state = 'activating'", [app]);
    if (busy.length > 0) throw conflict("state", "another activation of this app is in progress");
    // The secret version is pinned here, so prepare and the node's bundle fetch agree.
    const secretsVersion = await latestSecretsVersion(tx, app);
    await transition(tx, d, d.state, "activating", by, { last_error: null, secrets_version: secretsVersion });
    return secretsVersion;
  });
  if (start === "unchanged") return requireDeployment(db, tenantId, app, hash);
  const secretsVersion = start;

  const d = { tenant_id: tenantId, app, hash };
  const fail = async (error: Record<string, unknown>, err: ApiError): Promise<never> => {
    await db.transaction((tx) => transition(tx, d, "activating", "validated", { ...by, now: deps.now() }, { last_error: error, secrets_version: null }));
    throw err;
  };

  const node = ownerOf(tenantId, await healthyNodes(db));
  if (node === null) {
    await fail({ stage: "no_worker", reason: "no healthy node can take the tenant" }, new ApiError("RENOX_UNAVAILABLE", undefined, { retryAfter: 5 }));
  }
  const result = await service.prepare({ tenantId, app, hash, nodeId: node as string, tier, secretsVersion });
  if (!result.ok) {
    await fail(result.error, new ApiError("RENOX_ACTIVATION_FAILED", [result.error], { deployment: hash }));
  }

  const now = deps.now();
  const orphaned = await db.transaction(async (tx) => {
    await lockRoutes(tx);
    const previous = await activeOf(tx, tenantId, app);
    if (previous !== null) await transition(tx, previous, "active", "superseded", { ...by, now });
    await transition(tx, d, "activating", "active", { ...by, now }, { activated_at: now, secrets_version: secretsVersion });
    await pointAt(tx, deps, d, hash, previous?.hash ?? null, node as string, tier, secretsVersion, now);
    return prune(tx, tenantId, app, { ...by, now });
  });
  await service.publisher.publish();
  for (const key of orphaned) await deps.store.delete(key).catch(() => {});
  return requireDeployment(db, tenantId, app, hash);
}

export async function rollback(deps: Deps, tenantId: string, app: string, hash: string | undefined, by: Actor): Promise<DeploymentRow> {
  const { db } = deps;
  const service = routeService(deps);
  const { tier, state } = await tenantInfo(db, tenantId);
  if (state === "suspended") throw conflict("tenant", "the tenant is suspended");
  const node = ownerOf(tenantId, await healthyNodes(db));
  if (node === null) throw new ApiError("RENOX_UNAVAILABLE", undefined, { retryAfter: 5 });

  const target = await db.transaction(async (tx) => {
    await lockRoutes(tx);
    const current = await activeOf(tx, tenantId, app);
    let targetHash = hash;
    if (targetHash === undefined) {
      const rows = await tx.query<{ hash: string }>(
        "select hash from deployments where tenant_id = $1 and app = $2 and state = 'superseded' order by updated_at desc, hash limit 1",
        [tenantId, app],
      );
      targetHash = rows[0]?.hash;
      if (targetHash === undefined) throw conflict("state", "there is no superseded deployment to roll back to");
    }
    const t = await requireDeployment(tx, tenantId, app, targetHash, true);
    if (t.state === "active") return t.hash;
    if (current === null) throw conflict("state", "there is no active deployment");
    assertTransition("deployment", t.state, "active");
    const secretsVersion = await latestSecretsVersion(tx, app);
    await transition(tx, current, "active", "superseded", by);
    await transition(tx, t, "superseded", "active", by, { activated_at: by.now, secrets_version: secretsVersion });
    await pointAt(tx, deps, t, t.hash, current.hash, node, tier, secretsVersion, by.now);
    return t.hash;
  });
  await service.publisher.publish();
  return requireDeployment(db, tenantId, app, target);
}

/** Tenant suspension (deploy-api.md section 5): active <-> suspended and the routes removed or restored. */
export async function onTenantState(deps: Deps, tx: Db, tenantId: string, state: "active" | "suspended", now: number): Promise<void> {
  const by: Actor = { actor: "operator", requestId: "tenant-state", now };
  await lockRoutes(tx);
  if (state === "suspended") {
    const active = await tx.query<{ app: string; hash: string }>("select app, hash from deployments where tenant_id = $1 and state = 'active'", [tenantId]);
    for (const a of active) await transition(tx, { tenant_id: tenantId, app: a.app, hash: a.hash }, "active", "suspended", by);
    for (const e of await entriesWhere(tx, "tenant_id = $1", [tenantId])) await removeEntry(tx, e.hostname, e.deployment_hash, now);
    return;
  }
  const { tier } = await tenantInfo(tx, tenantId);
  const node = ownerOf(tenantId, await healthyNodes(tx));
  const suspended = await tx.query<{ app: string; hash: string; secrets_version: number | null }>(
    "select app, hash, secrets_version from deployments where tenant_id = $1 and state = 'suspended'",
    [tenantId],
  );
  for (const s of suspended) {
    const d = { tenant_id: tenantId, app: s.app, hash: s.hash };
    await transition(tx, d, "suspended", "active", by);
    if (node !== null) await pointAt(tx, deps, d, s.hash, null, node, tier, Number(s.secrets_version ?? 0), now);
  }
}
