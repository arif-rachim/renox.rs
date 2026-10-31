// Operator actions on a tenant (docs/contracts/deploy-api.md 0.3 section 17,
// #259): change its tier, move it to a named node, or move it to a microVM
// through the owning node's hook; and the read of 0.3.1 (#296) that the
// console's status panel shows, served from Postgres only and audited. Every request carries a reason (10 to 500
// characters), kept in the audit row with the operator and the result; every
// action also writes one `source: platform` line per app, without the
// reason.
//
// docs/24-threat-model.md section E, "Operator console abuse".

import { activeImpersonations } from "./breakglass.ts";
import { safeBrowsingOf } from "../safe-browsing/check.ts";
import type { Context, Hono } from "hono";
import { operation, writeAudit } from "../audit.ts";
import { clientIp } from "../auth/ip.ts";
import { num, type Db } from "../db/db.ts";
import { ApiError, conflict, notFound } from "../errors.ts";
import { jsonBody, pathParam } from "../http.ts";
import { ulid } from "../ids.ts";
import { logIngest, type StoredLine } from "../ingest/logs.ts";
import type { Deps, Env } from "../context.ts";
import { entriesWhere, lockRoutes, processOf, upsertEntry } from "../routes/table.ts";
import { routeService } from "../routes/service.ts";
import { moveTenant, nodeCall, nodeTarget } from "../workers/failover.ts";
import { replicationOf } from "../workers/health.ts";
import { findWorker } from "../workers/repo.ts";
import { accountRef, operatorOf, opsAuth } from "./auth.ts";

/** The hook may run 10 minutes (node-listener.yaml, nodeMoveTenant). */
const MOVE_TIMEOUT_MS = 10 * 60_000 + 5_000;

type Tier = "free" | "paid";

interface TenantRow {
  tier: Tier;
  moving_since: number | null;
}

async function tenantRow(db: Db, id: string): Promise<TenantRow> {
  const rows = await db.query<{ tier: Tier; moving_since: unknown }>("select tier, moving_since from tenants where id = $1", [id]);
  const r = rows[0];
  if (r === undefined) throw notFound();
  return { tier: r.tier, moving_since: r.moving_since === null ? null : num(r.moving_since) };
}

/** 503 `RENOX_TENANT_MOVING` while the tenant is being moved to a microVM (also export and import, #258). */
export async function assertNotMoving(db: Db, tenantId: string): Promise<void> {
  const rows = await db.query<{ moving_since: unknown }>("select moving_since from tenants where id = $1", [tenantId]);
  if (rows[0] !== undefined && rows[0].moving_since !== null) throw new ApiError("RENOX_TENANT_MOVING", undefined, { retryAfter: 30 });
}

/** The node the tenant's active entries name, or null. */
async function currentNode(db: Db, tenantId: string): Promise<string | null> {
  const rows = await db.query<{ node_id: string }>("select node_id from route_entries where tenant_id = $1 order by status, version desc limit 1", [tenantId]);
  return rows[0]?.node_id ?? null;
}

async function routeVersion(db: Db, tenantId: string): Promise<number> {
  const rows = await db.query<{ v: unknown }>("select coalesce(max(version), 0) as v from route_entries where tenant_id = $1", [tenantId]);
  return num(rows[0]?.v);
}

/** One `source: platform` line per app of the tenant (section 17: without the reason). */
async function platformLines(deps: Deps, tenantId: string, kind: "tier" | "move", message: string, fields: Record<string, unknown>): Promise<void> {
  const apps = await deps.db.query<{ app: string; deployment_hash: string; node_id: string }>(
    "select distinct on (app) app, deployment_hash, node_id from route_entries where tenant_id = $1 order by app, status",
    [tenantId],
  );
  const lines: StoredLine[] = apps.map((a) => ({
    ts: deps.now(),
    tenant_id: tenantId,
    deployment_hash: a.deployment_hash,
    request_id: null,
    module: "platform",
    level: "info",
    message,
    fields: { kind, ...fields },
    source: "platform",
    node_id: a.node_id,
    app: a.app,
  }));
  if (lines.length > 0) await logIngest(deps).store.append(lines);
}

/** The audit row's target (operator, reason, the action's fields) and its id. */
function audit(c: Context<Env>, fields: Record<string, string>): string {
  const id = `aud_${ulid()}`;
  // The wire form (deploy-api.md 0.3.1 section 2): `acct_<ulid>`, never the internal `usr_` id (#310).
  c.set("auditTarget", { ...c.get("auditTarget"), audit_id: id, operator: accountRef(operatorOf(c)), ...fields });
  return id;
}

function result(tenantId: string, action: "setTenantTier" | "moveTenant", changed: boolean, tier: Tier, node: string | null, version: number, auditId: string, extra: Record<string, number> = {}) {
  return { tenant_id: tenantId, action, changed, tier, process: processOf(tier), node_id: node ?? "none", route_version: version, audit_id: auditId, ...extra };
}

/** One `OpsAction` per audit row of the tenant's operator actions, newest first. */
async function lastActions(db: Db, tenantId: string): Promise<{ audit_id: string; at: number; action: string; operator: string; reason: string; result: string }[]> {
  const rows = await db.query<{ at: unknown; action: string; target: Record<string, string> }>(
    "select at, action, target from audit where tenant_id = $1 and action in ('setTenantTier', 'moveTenant') and target->>'audit_id' is not null and target->>'result' is not null order by id desc limit 5",
    [tenantId],
  );
  return rows.map((r) => ({
    audit_id: r.target.audit_id as string,
    at: num(r.at),
    action: r.action,
    operator: accountRef(r.target.operator ?? "operator"),
    reason: r.target.reason as string,
    result: r.target.result as string,
  }));
}

export function registerOps(app: Hono<Env>, deps: Deps): void {
  app.get("/v1/ops/tenants/:tenant_id", operation(deps, "getOpsTenant"), opsAuth(deps, "ops:read"), async (c) => {
    const tenantId = pathParam(c, "tenant_id", "TenantId");
    const rows = await deps.db.query<{ name: string; tier: Tier; state: "active" | "suspended"; moving_since: unknown; microvm_at: unknown }>(
      "select name, tier, state, moving_since, microvm_at from tenants where id = $1",
      [tenantId],
    );
    const t = rows[0];
    const now = deps.now();
    // A read of operator data is audited too (section 2), found or not.
    const auditRead = (status: number) =>
      writeAudit(deps.db, {
        at: now,
        tenantId: t === undefined ? null : tenantId,
        actor: "operator",
        action: "getOpsTenant",
        target: { tenant_id: tenantId, operator: accountRef(operatorOf(c)) },
        status,
        requestId: c.get("requestId"),
        ip: clientIp(c),
      });
    if (t === undefined) {
      await auditRead(404);
      throw notFound();
    }
    const pins = await deps.db.query<{ node_id: string }>("select node_id from tenant_pins where tenant_id = $1", [tenantId]);
    const body = {
      tenant_id: tenantId,
      name: t.name,
      tier: t.tier,
      state: t.state,
      process: processOf(t.tier),
      node_id: await currentNode(deps.db, tenantId),
      pinned_node: pins[0]?.node_id ?? null,
      moving: t.moving_since !== null,
      moving_since: t.moving_since === null ? null : num(t.moving_since),
      microvm_at: t.microvm_at === null ? null : num(t.microvm_at),
      replication: await replicationOf(deps.db, tenantId, now),
      // 0.4 (#310): active break-glass impersonations first, then the last actions, five at most.
      actions: [
        ...(await activeImpersonations(deps.db, tenantId, deps.now())).map((i) => ({
          audit_id: i.audit_id,
          at: i.started_at,
          action: "impersonateTenant",
          operator: i.operator,
          reason: i.reason,
          result: "active",
          impersonation_id: i.impersonation_id,
          expires_at: i.expires_at,
        })),
        ...(await lastActions(deps.db, tenantId)),
      ].slice(0, 5),
      // 0.5 section 22 (#123): the last Safe Browsing check of each checked hostname, and the open tickets' ids.
      safe_browsing: await safeBrowsingOf(deps, tenantId),
      abuse_tickets: (
        await deps.db.query<{ id: string }>("select id from abuse_tickets where tenant_id = $1 and state in ('open', 'reviewing') order by reported_at limit 20", [tenantId])
      ).map((r) => r.id),
    };
    await auditRead(200);
    return c.json(body);
  });

  app.post("/v1/ops/tenants/:tenant_id/tier", operation(deps, "setTenantTier"), opsAuth(deps), async (c) => {
    const tenantId = pathParam(c, "tenant_id", "TenantId");
    // The reason is checked first, so even a refused request has it in its audit row.
    const body = await jsonBody<{ tier: Tier; reason: string }>(c, "SetTierRequest");
    const auditId = audit(c, { to_tier: body.tier, reason: body.reason });
    const t = await tenantRow(deps.db, tenantId);
    c.set("auditTarget", { ...c.get("auditTarget"), from_tier: t.tier });
    if (t.moving_since !== null) throw new ApiError("RENOX_TENANT_MOVING", undefined, { retryAfter: 30 });
    const node = await currentNode(deps.db, tenantId);
    if (t.tier === body.tier) {
      c.set("auditTarget", { ...c.get("auditTarget"), result: "unchanged" });
      return c.json(result(tenantId, "setTenantTier", false, t.tier, node, await routeVersion(deps.db, tenantId), auditId));
    }
    const now = deps.now();
    const version = await deps.db.transaction(async (tx) => {
      await tx.query("update tenants set tier = $2 where id = $1", [tenantId, body.tier]);
      await lockRoutes(tx);
      let last = 0;
      // Every entry of the tenant in one delta, with the new tier and process.
      for (const e of await entriesWhere(tx, "tenant_id = $1", [tenantId])) {
        const { version: _old, process: _p, ...rest } = e;
        last = (await upsertEntry(tx, { ...rest, tier: body.tier, updated_at: now })).version;
      }
      return last;
    });
    await routeService(deps).publisher.publish();
    c.set("auditTarget", { ...c.get("auditTarget"), result: "changed" });
    await platformLines(deps, tenantId, "tier", `tier: ${t.tier} -> ${body.tier} (process ${processOf(body.tier)})`, { from_tier: t.tier, to_tier: body.tier, process: processOf(body.tier) });
    deps.log.info("tenant tier changed", { tenant_id: tenantId, from: t.tier, to: body.tier, operator: operatorOf(c) });
    return c.json(result(tenantId, "setTenantTier", true, body.tier, node, version || (await routeVersion(deps.db, tenantId)), auditId));
  });

  app.post("/v1/ops/tenants/:tenant_id/move", operation(deps, "moveTenant"), opsAuth(deps), async (c) => {
    const tenantId = pathParam(c, "tenant_id", "TenantId");
    const body = await jsonBody<{ target: "node" | "microvm"; node_id?: string; reason: string }>(c, "MoveRequest");
    const auditId = audit(c, { target: body.target, reason: body.reason, ...(body.node_id === undefined ? {} : { to_node: body.node_id }) });
    const t = await tenantRow(deps.db, tenantId);
    if (t.moving_since !== null) throw new ApiError("RENOX_TENANT_MOVING", undefined, { retryAfter: 30 });
    const from = await currentNode(deps.db, tenantId);
    if (from === null) throw conflict("tenant_id", "the tenant has no route entry to move");
    c.set("auditTarget", { ...c.get("auditTarget"), from_node: from });

    if (body.target === "node") {
      const to = body.node_id as string;
      const w = await findWorker(deps.db, to);
      if (w === null || !w.healthy) throw conflict("node_id", "not a healthy node");
      if (to === from) throw conflict("node_id", "the tenant is already on this node");
      const full = await deps.db.query("select 1 from workers where node_id = $1 and cells >= max_cells", [to]);
      if (full.length > 0) throw conflict("node_id", "the node is full");
      // FO3 and FO4 with the named node as the only candidate; the result pins it.
      const moved = await moveTenant(deps, tenantId, from, [to], "move", "operator");
      if (moved.status !== "moved") {
        c.set("auditTarget", { ...c.get("auditTarget"), result: "restore_failed" });
        throw new ApiError("RENOX_BACKUP_UNAVAILABLE", [{ field: "node_id", reason: moved.tried[0]?.reason ?? "the restore failed" }], { retryAfter: 30 });
      }
      c.set("auditTarget", { ...c.get("auditTarget"), result: "moved" });
      return c.json(result(tenantId, "moveTenant", true, t.tier, to, moved.route_version ?? (await routeVersion(deps.db, tenantId)), auditId));
    }

    // microVM: mark the tenant, ask the owning node to run its hook.
    const marked = await deps.db.query("update tenants set moving_since = $2 where id = $1 and moving_since is null returning id", [tenantId, deps.now()]);
    if (marked.length === 0) throw new ApiError("RENOX_TENANT_MOVING", undefined, { retryAfter: 30 });
    let code: number;
    try {
      const target = await nodeTarget(deps, deps.db, from);
      if (target.listen_url === null || target.token === null) throw new ApiError("RENOX_BACKUP_UNAVAILABLE", [{ field: "node", reason: "the node has no listener" }], { retryAfter: 30 });
      const res = await nodeCall(deps)(
        target,
        "POST",
        `/nodes/${from}/tenants/${tenantId}/move`,
        { type: "move_request", schema_version: 0, tenant_id: tenantId, target: "microvm", reason: body.reason, operator: accountRef(operatorOf(c)) },
        MOVE_TIMEOUT_MS,
      );
      if (res.status === 503) throw new ApiError("RENOX_TENANT_MOVING", undefined, { retryAfter: 30 });
      const r = res.body as { hook_exit_code?: unknown } | null;
      if (res.status !== 200 || typeof r?.hook_exit_code !== "number") throw new ApiError("RENOX_BACKUP_UNAVAILABLE", [{ field: "node", reason: `move answered ${res.status}` }], { retryAfter: 30 });
      code = r.hook_exit_code;
    } catch (e) {
      await deps.db.query("update tenants set moving_since = null where id = $1", [tenantId]);
      if (e instanceof ApiError) throw e;
      throw new ApiError("RENOX_BACKUP_UNAVAILABLE", [{ field: "node", reason: e instanceof Error ? e.message : String(e) }], { retryAfter: 30 });
    }
    // Exit 0: moved (recorded). Anything else: the tenant serves where it was.
    await deps.db.query("update tenants set moving_since = null, microvm_at = case when $2 then $3::bigint else microvm_at end where id = $1", [tenantId, code === 0, deps.now()]);
    c.set("auditTarget", { ...c.get("auditTarget"), result: code === 0 ? "moved" : "hook_failed", hook_exit_code: String(code) });
    await platformLines(deps, tenantId, "move", code === 0 ? `move: to a microVM from ${from}` : `move: to a microVM failed (hook exit ${code}); the tenant stays on ${from}`, { target: "microvm", from_node: from, hook_exit_code: code });
    deps.log.info("tenant microVM move", { tenant_id: tenantId, node: from, hook_exit_code: code, operator: operatorOf(c) });
    return c.json(result(tenantId, "moveTenant", code === 0, t.tier, from, await routeVersion(deps.db, tenantId), auditId, { hook_exit_code: code }));
  });
}
