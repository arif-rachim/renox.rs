// Tenant erasure (#308; docs/contracts/deploy-api.md 0.4 section 3,
// docs/24-threat-model.md G "Erasure incomplete"). `deleteTenant` records a
// `pending` erasure and answers 202; the steps run outside the request and
// are retried hourly until each one is confirmed:
//
// | Step | What |
// | --- | --- |
// | routes | the tenant is suspended: every route entry removed and published (no hostname is served) |
// | tokens | every token of the tenant revoked |
// | node_drop | `nodeDropTenant` on every registered node with a listener (an unknown tenant answers 200), so the owner drains its cells and stops the sidecar after the last frames |
// | exports | every export object deleted from the store, then its row |
// | records | the tenant's apps, deployments, secrets, domains, client error groups, meters, permissions and reports deleted |
//
// `done` sets `completed_at` and emails the owner; a step that still fails 24
// hours after the request makes the erasure `failed` with that step, plus an
// operator alert row. What stays: the audit rows, the memberships (so members'
// sessions can read the tombstone with getTenant) and the tenant row itself,
// suspended, as the tombstone.

import type { Hono } from "hono";
import { operation, writeAudit } from "../audit.ts";
import { tenantAuth } from "../auth/middleware.ts";
import type { Deps, Env } from "../context.ts";
import { num, type Db } from "../db/db.ts";
import { ApiError, conflict, notFound } from "../errors.ts";
import { jsonBody, pathParam } from "../http.ts";
import { onTenantState } from "../routes/activation.ts";
import { routeService } from "../routes/service.ts";
import { requestScope, tenantDb } from "../tenancy/scope.ts";
import { nodeCall, nodeTarget } from "../workers/failover.ts";
import { logIngest } from "../ingest/logs.ts";
import { flagged } from "../signup/friction.ts";

export type ErasureState = "pending" | "erasing" | "done" | "failed";

export const STEPS = ["routes", "tokens", "node_drop", "exports", "records"] as const;
export type Step = (typeof STEPS)[number];

/** deploy-api.md 0.4 section 3: done within 24 hours while the node and the store answer. */
export const TIME_BOX_MS = 24 * 3_600_000;
/** A failed step is retried after this long. */
export const RETRY_MS = 3_600_000;

export interface Erasure {
  state: ErasureState;
  requested_at: number;
  completed_at: number | null;
  failure: Step | null;
  /** 0.4.1: when the owning node confirmed the replica purge; null until then. */
  replica_purged_at: number | null;
}

/** The erasure record of `tenantId`, or null. */
export async function erasureOf(db: Db, tenantId: string): Promise<Erasure | null> {
  const rows = await db.query<{ state: ErasureState; requested_at: unknown; completed_at: unknown; failure: Step | null; replica_purged_at: unknown }>(
    "select state, requested_at, completed_at, failure, replica_purged_at from tenant_erasures where tenant_id = $1",
    [tenantId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    state: r.state,
    requested_at: num(r.requested_at),
    completed_at: r.completed_at === null ? null : num(r.completed_at),
    failure: r.failure,
    replica_purged_at: r.replica_purged_at === null ? null : num(r.replica_purged_at),
  };
}

/** The tenant's records, deleted in this order (children before `apps`); static statements (tests/sql-lint.test.ts). */
const RECORD_DELETES = [
  "delete from client_error_events where tenant_id = $1",
  "delete from client_error_deployments where tenant_id = $1",
  "delete from client_error_groups where tenant_id = $1",
  "delete from domains where tenant_id = $1",
  "delete from exports where tenant_id = $1",
  "delete from route_entries where tenant_id = $1",
  "delete from secrets where tenant_id = $1",
  "delete from secret_sets where tenant_id = $1",
  "delete from permissions where tenant_id = $1",
  "delete from deployments where tenant_id = $1",
  "delete from meters_raw where tenant_id = $1",
  "delete from meters_hourly where tenant_id = $1",
  "delete from replication_reports where tenant_id = $1",
  "delete from tenant_keys where tenant_id = $1",
  "delete from tenant_pins where tenant_id = $1",
  "delete from failovers where tenant_id = $1",
  "delete from invitations where tenant_id = $1",
  "delete from owner_transfers where tenant_id = $1",
  "delete from device_codes where tenant_id = $1",
  "delete from apps where tenant_id = $1",
];

const running = new WeakMap<Deps, Set<string>>();

async function step(deps: Deps, db: Db, tenantId: string, s: Step, now: number): Promise<boolean> {
  switch (s) {
    case "routes": {
      await db.transaction(async (tx) => {
        await tx.query("update tenants set state = 'suspended' where id = $1", [tenantId]);
        await onTenantState(deps, tx, tenantId, "suspended", now, { neutralPage: false });
      });
      await routeService(deps).publisher.publish();
      return true;
    }
    case "tokens":
      await db.query("update tokens set revoked_at = $2 where tenant_id = $1 and revoked_at is null", [tenantId, now]);
      return true;
    case "node_drop": {
      const nodes = await db.query<{ node_id: string }>("select node_id from workers order by node_id", []);
      let all = true;
      for (const { node_id: node } of nodes) {
        const target = await nodeTarget(deps, db, node);
        if (target.listen_url === null || target.token === null) continue;
        try {
          // 0.4.1: the node also purges every generation of the tenant from the replica store.
          const res = await nodeCall(deps)(target, "DELETE", `/nodes/${node}/tenants/${tenantId}?purge_replica=true`, undefined, 60_000);
          if (res.status !== 200) {
            all = false;
            continue;
          }
          const at = (res.body as { replica_purged_at?: unknown } | null)?.replica_purged_at;
          if (typeof at === "number") {
            await db.query("update tenant_erasures set replica_purged_at = greatest(coalesce(replica_purged_at, 0), $2) where tenant_id = $1", [tenantId, at]);
          }
        } catch {
          all = false;
        }
      }
      return all;
    }
    case "exports": {
      const rows = await db.query<{ id: string; object_key: string }>("select id, object_key from exports where tenant_id = $1", [tenantId]);
      for (const r of rows) {
        await deps.store.delete(r.object_key);
        await db.query("delete from exports where tenant_id = $1 and id = $2", [tenantId, r.id]);
      }
      return true;
    }
    case "records":
      await db.transaction(async (tx) => {
        for (const sql of RECORD_DELETES) await tx.query(sql, [tenantId]);
      });
      // deploy-api.md 0.4 section 3: the tenant's log lines go too.
      await logIngest(deps).store.dropTenant(tenantId);
      return true;
  }
}

/**
 * Runs the steps of `tenantId`'s erasure that are not confirmed yet; returns
 * the state reached. Safe to call again (each step is idempotent); calls for
 * the same tenant do not overlap.
 */
export async function runErasure(deps: Deps, tenantId: string): Promise<ErasureState | null> {
  const busy = running.get(deps) ?? new Set<string>();
  running.set(deps, busy);
  if (busy.has(tenantId)) return null;
  busy.add(tenantId);
  try {
    // Outside any request (requestScope.exit, the sweep): the platform's handle.
    const db = deps.db;
    const rows = await db.query<{ state: ErasureState; requested_at: unknown; steps: string[] | string }>(
      "select state, requested_at, steps from tenant_erasures where tenant_id = $1",
      [tenantId],
    );
    const row = rows[0];
    if (row === undefined || row.state === "done") return row?.state ?? null;
    const done = new Set<string>(typeof row.steps === "string" ? (JSON.parse(row.steps) as string[]) : row.steps);
    const now = deps.now();
    await db.query("update tenant_erasures set state = 'erasing', attempts = attempts + 1 where tenant_id = $1", [tenantId]);
    let failed: Step | null = null;
    for (const s of STEPS) {
      if (done.has(s)) continue;
      let ok = false;
      try {
        ok = await step(deps, db, tenantId, s, now);
      } catch (e) {
        deps.log.warn("erasure step failed", { tenant_id: tenantId, step: s, error: e instanceof Error ? e.name : "error" });
      }
      if (!ok) {
        failed = s;
        break;
      }
      done.add(s);
      await db.query("update tenant_erasures set steps = $2::text::jsonb where tenant_id = $1", [tenantId, JSON.stringify([...done])]);
    }
    if (failed === null) {
      await db.query("update tenant_erasures set state = 'done', completed_at = $2, failure = null where tenant_id = $1", [tenantId, now]);
      await writeAudit(db, { at: now, tenantId, actor: "platform", action: "deleteTenant", target: { tenant_id: tenantId, state: "done", completed_at: String(now) }, status: 200, requestId: `erasure-${tenantId}` });
      await notifyOwner(deps, db, tenantId, now);
      return "done";
    }
    if (now - num(row.requested_at) >= TIME_BOX_MS) {
      await db.query("update tenant_erasures set state = 'failed', failure = $2 where tenant_id = $1", [tenantId, failed]);
      await db.query("insert into alerts (at, kind, tenant_id, detail) values ($1, 'erasure_failed', $2, $3::text::jsonb)", [now, tenantId, JSON.stringify({ step: failed })]).catch(() => undefined);
      await writeAudit(db, { at: now, tenantId, actor: "platform", action: "deleteTenant", target: { tenant_id: tenantId, state: "failed", step: failed }, status: 500, requestId: `erasure-${tenantId}` });
      return "failed";
    }
    await db.query("update tenant_erasures set next_at = $2 where tenant_id = $1", [tenantId, now + (deps.config.erasureRetryMs ?? RETRY_MS)]);
    return "erasing";
  } finally {
    busy.delete(tenantId);
  }
}

/** The hourly sweep: every erasure due now (and a `failed` one an operator set back to `erasing`). */
export async function sweepErasures(deps: Deps): Promise<number> {
  const db = deps.db;
  const due = await db.query<{ tenant_id: string }>("select tenant_id from tenant_erasures where state in ('pending', 'erasing') and next_at <= $1", [deps.now()]);
  for (const r of due) await runErasure(deps, r.tenant_id);
  return due.length;
}

async function notifyOwner(deps: Deps, db: Db, tenantId: string, at: number): Promise<void> {
  const rows = await db.query<{ email: string }>(
    "select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.role = 'owner'",
    [tenantId],
  );
  for (const r of rows) {
    await deps.mailer.send({
      to: r.email,
      kind: "tenant_erased",
      subject: `Your Renox tenant ${tenantId} was erased`,
      text: `Every app, database, backup replica on its node, export and secret of ${tenantId} has been deleted. Erasure completed at ${new Date(at).toISOString()}.`,
    });
  }
}

/** Is a move, a restore or an import of the tenant in progress? The reason, or null. */
async function busyReason(db: Db, tenantId: string): Promise<string | null> {
  const rows = await db.query<{ moving_since: unknown }>("select moving_since from tenants where id = $1", [tenantId]);
  return rows[0] !== undefined && rows[0].moving_since !== null ? "moving" : null;
}

/**
 * deploy-api.md 0.5 section 21: a new free tenant has reduced quotas and no
 * custom domain until a payment method is confirmed, or 7 days pass
 * without an abuse flag or an anomaly (src/signup/friction.ts).
 */
export async function newTenantRestrictions(db: Db, tenantId: string, createdAt: number, now: number): Promise<string[]> {
  // Only a free tenant starts restricted (section 21); an operator's paid tier has none.
  const tier = (await db.query<{ tier: string }>("select tier from tenants where id = $1", [tenantId]))[0]?.tier;
  if (tier !== undefined && tier !== "free") return [];
  const pm = await db.query<Record<string, unknown>>("select payment_method from tenant_billing where tenant_id = $1", [tenantId]);
  if (pm[0]?.payment_method !== undefined && pm[0]?.payment_method !== null) return [];
  // #123: 7 days lift them only without an abuse flag or an anomaly in the last 7 days.
  if (now - createdAt >= 7 * 86_400_000 && !(await flagged(db, tenantId, now))) return [];
  return ["reduced_quotas", "no_custom_domain"];
}

export function registerErasure(app: Hono<Env>, deps: Deps): void {
  app.get("/v1/tenants/:tenant_id", operation(deps, "getTenant"), tenantAuth(deps, "apps:read"), async (c) => {
    const db = tenantDb(deps, c);
    if (pathParam(c, "tenant_id", "TenantId") !== db.tenantId) throw notFound();
    const rows = await db.query<Record<string, unknown>>("select id, name, tier, state, created_at from tenants where id = $1", [db.tenantId]);
    const r = rows[0];
    if (r === undefined) throw notFound();
    // deploy-api.md 0.5 section 21 (#326): the first activation, and the new-tenant limits still in force.
    const first = (await db.query<Record<string, unknown>>("select min(activated_at) as t from deployments where tenant_id = $1 and activated_at is not null", [db.tenantId]))[0]?.t;
    const restrictions = await newTenantRestrictions(db, db.tenantId, num(r.created_at), deps.now());
    return c.json({ tenant_id: r.id, name: r.name, tier: r.tier, state: r.state, created_at: num(r.created_at), first_deploy_at: first === null || first === undefined ? null : num(first), restrictions, erasure: await erasureOf(db, db.tenantId) });
  });

  app.delete("/v1/tenants/:tenant_id", operation(deps, "deleteTenant"), tenantAuth(deps, "tenant:delete"), async (c) => {
    const db = tenantDb(deps, c);
    const id = db.tenantId;
    if (pathParam(c, "tenant_id", "TenantId") !== id) throw notFound();
    const body = await jsonBody<{ confirm: string }>(c, "DeleteTenantRequest");
    if (body.confirm !== id) throw new ApiError("RENOX_VALIDATION", [{ field: "confirm", reason: "must be the tenant id" }]);
    const existing = await erasureOf(db, id);
    if (existing === null) {
      const busy = await busyReason(db, id);
      if (busy !== null) throw conflict("tenant", busy);
      const now = deps.now();
      const p = c.get("principal");
      await db.query(
        "insert into tenant_erasures (tenant_id, state, requested_at, requested_by, next_at) values ($1, 'pending', $2, $3, $2) on conflict (tenant_id) do nothing",
        [id, now, p !== undefined && p.kind === "tenant" && p.userId !== null ? p.userId : "unknown"],
      );
    }
    const record = (await erasureOf(db, id)) as Erasure;
    c.set("auditTarget", { tenant_id: id, state: record.state });
    // Outside the request's scope: the steps run as the platform, after the answer.
    requestScope.exit(() => {
      setTimeout(() => void runErasure(deps, id).catch(() => undefined), 0);
    });
    return c.json(record, 202);
  });
}
