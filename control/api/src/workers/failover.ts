// Node failover and tenant moves (docs/contracts/deploy-api.md 0.3 section
// 16, rules FO1-FO6; #257). When a node stops heartbeating, each of its
// tenants moves to a healthy node with its file restored there first:
//
//   FO2  candidates: healthy nodes with capacity, in the tenant's rendezvous
//        order (assign.ts), never the dead node
//   FO3  POST /nodes/{node}/tenants/{tenant}/restore on the candidate (node
//        listener, schemas/node-listener.yaml) with a 20 s deadline; only on
//        200 are the tenant's route entries moved and published; a failure
//        tries the next candidate; when every candidate fails the tenant
//        stays and an alert row is written
//   FO4  the entries name the new node (new versions), the tenant is pinned
//        there, and a node that comes back is told to drop it
//   FO5  one `source: platform`, `kind: failover` log line per app, one
//        audit row, and the record getBackups reports as last_failover
//
// moveTenant() is the shared move: failover passes reason "failover", the
// operator action of #259 passes "move" with one named candidate.

import type { Db } from "../db/db.ts";
import type { Deps } from "../context.ts";
import { writeAudit } from "../audit.ts";
import { logIngest, type StoredLine } from "../ingest/logs.ts";
import { routeService } from "../routes/service.ts";
import { entriesWhere, lockRoutes, upsertEntry } from "../routes/table.ts";
import { EnvMasterKey } from "../secrets/crypto.ts";
import { candidatesFor, pinTenant } from "./assign.ts";

/** FO3: the restore deadline the candidate gets. */
export const RESTORE_DEADLINE_MS = 20_000;
/** FO1: tenants moved at most at a time per sweep. */
export const FAILOVER_CONCURRENCY = 16;

/** Where and how to reach one node's listener. */
export interface NodeTarget {
  node_id: string;
  listen_url: string | null;
  token: string | null;
}

/** One call to a node listener; tests replace it with fake nodes. */
export type NodeCall = (
  node: NodeTarget,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  timeoutMs: number,
) => Promise<{ status: number; body: unknown }>;

/** The real call: HTTP to `listen_url` with the callback token. */
export const httpNodeCall: NodeCall = async (node, method, path, body, timeoutMs) => {
  if (node.listen_url === null || node.token === null) return { status: 0, body: { error: "no node listener" } };
  const res = await fetch(`${node.listen_url.replace(/\/$/u, "")}${path}`, {
    method,
    headers: { authorization: `Bearer ${node.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
};

const calls = new WeakMap<Deps, NodeCall>();

/** Replaces how this API process calls nodes (tests). */
export function setNodeCall(deps: Deps, call: NodeCall): void {
  calls.set(deps, call);
}

export function nodeCall(deps: Deps): NodeCall {
  return calls.get(deps) ?? httpNodeCall;
}

/** Wraps a callback token for the workers table under the master key. */
export async function sealCallbackToken(deps: Deps, nodeId: string, token: string): Promise<{ wrapped: Uint8Array; nonce: Uint8Array } | null> {
  if (deps.config.masterKey === null) return null;
  return new EnvMasterKey(deps.config.masterKey).wrap(new TextEncoder().encode(token), `node:${nodeId}`);
}

/** The node's listener URL and callback token, when it registered one. */
export async function nodeTarget(deps: Deps, db: Db, nodeId: string): Promise<NodeTarget> {
  const rows = await db.query<{ listen_url: string | null; callback_token_wrapped: Uint8Array | null; callback_token_nonce: Uint8Array | null }>(
    "select listen_url, callback_token_wrapped, callback_token_nonce from workers where node_id = $1",
    [nodeId],
  );
  const r = rows[0];
  if (r === undefined || r.listen_url === null || r.callback_token_wrapped === null || r.callback_token_nonce === null || deps.config.masterKey === null) {
    return { node_id: nodeId, listen_url: r?.listen_url ?? null, token: null };
  }
  const plain = await new EnvMasterKey(deps.config.masterKey).unwrap(new Uint8Array(r.callback_token_wrapped), new Uint8Array(r.callback_token_nonce), `node:${nodeId}`);
  return { node_id: nodeId, listen_url: r.listen_url, token: new TextDecoder().decode(plain) };
}

export interface MoveResult {
  tenant_id: string;
  from_node: string;
  to_node: string | null;
  status: "moved" | "failed";
  generation: string | null;
  restored_to: number | null;
  elapsed_ms: number;
  route_version: number | null;
  /** Per candidate tried: why it was not chosen. */
  tried: { node_id: string; reason: string }[];
}

/**
 * Moves `tenantId` from `from` to the first of `candidates` that restores its
 * file (FO3), then moves its route entries there (FO4) and records it (FO5).
 */
export async function moveTenant(
  deps: Deps,
  tenantId: string,
  from: string,
  candidates: readonly string[],
  reason: "failover" | "move",
  actor: string,
  started = deps.now(),
): Promise<MoveResult> {
  const call = nodeCall(deps);
  const tried: { node_id: string; reason: string }[] = [];
  for (const node of candidates) {
    if (node === from) continue;
    const target = await nodeTarget(deps, deps.db, node);
    // An F3 worker has no node listener: the F3 move (no restore here; with
    // replication on, the node restores before it opens a missing file,
    // #255) and no pin, so the tenant moves back when its owner returns.
    const legacy = target.listen_url === null;
    let res: { status: number; body: unknown } = { status: 200, body: { generation: null, restored_to: null } };
    if (!legacy) try {
      res = await call(target, "POST", `/nodes/${node}/tenants/${tenantId}/restore`, {
        type: "restore_request",
        schema_version: 0,
        tenant_id: tenantId,
        database: tenantId,
        timestamp: null,
        reason,
        deadline_ms: RESTORE_DEADLINE_MS,
      }, RESTORE_DEADLINE_MS + 1_000);
    } catch (e) {
      tried.push({ node_id: node, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (res.status !== 200) {
      tried.push({ node_id: node, reason: `restore answered ${res.status}` });
      continue;
    }
    const restored = res.body as { generation?: string | null; restored_to?: number | null };
    const now = deps.now();
    const elapsed = now - started;
    const version = await deps.db.transaction(async (tx) => {
      await lockRoutes(tx);
      let last: number | null = null;
      for (const e of await entriesWhere(tx, "tenant_id = $1 and node_id = $2", [tenantId, from])) {
        const { version: _old, ...rest } = e;
        last = (await upsertEntry(tx, { ...rest, node_id: node, updated_at: now })).version;
      }
      if (!legacy || reason === "move") await pinTenant(tx, tenantId, node, reason, now);
      await tx.query(
        `insert into failovers (tenant_id, from_node, to_node, reason, status, generation, restored_to, elapsed_ms, at)
         values ($1, $2, $3, $4, 'moved', $5, $6, $7, $8)`,
        [tenantId, from, node, reason, restored.generation ?? null, restored.restored_to ?? null, elapsed, now],
      );
      return last;
    });
    await routeService(deps).publisher.publish();
    await record(deps, tenantId, from, node, reason, actor, 200, restored.generation ?? null, restored.restored_to ?? null, elapsed);
    deps.log.info("tenant moved", { tenant_id: tenantId, from, to: node, reason, elapsed_ms: elapsed });
    return { tenant_id: tenantId, from_node: from, to_node: node, status: "moved", generation: restored.generation ?? null, restored_to: restored.restored_to ?? null, elapsed_ms: elapsed, route_version: version, tried };
  }
  const now = deps.now();
  await deps.db.query(
    `insert into failovers (tenant_id, from_node, to_node, reason, status, elapsed_ms, at, error) values ($1, $2, null, $3, 'failed', $4, $5, $6)`,
    [tenantId, from, reason, now - started, now, JSON.stringify(tried)],
  );
  await deps.db.query("insert into alerts (at, kind, tenant_id, node_id, detail) values ($1, $2, $3, $4, $5::text::jsonb)", [
    now,
    reason === "failover" ? "failover_restore_failed" : "move_restore_failed",
    tenantId,
    from,
    JSON.stringify({ tried }),
  ]);
  await record(deps, tenantId, from, null, reason, actor, 503, null, null, now - started);
  deps.log.error("tenant not moved: every candidate failed its restore", { tenant_id: tenantId, from, tried: tried.length });
  return { tenant_id: tenantId, from_node: from, to_node: null, status: "failed", generation: null, restored_to: null, elapsed_ms: now - started, route_version: null, tried };
}

/** FO5: the audit row and one platform log line per app of the tenant. */
async function record(
  deps: Deps,
  tenantId: string,
  from: string,
  to: string | null,
  reason: "failover" | "move",
  actor: string,
  status: number,
  generation: string | null,
  restoredTo: number | null,
  elapsed: number,
): Promise<void> {
  const now = deps.now();
  await writeAudit(deps.db, {
    at: now,
    tenantId,
    actor,
    action: reason === "failover" ? "failover" : "moveTenant",
    target: { tenant_id: tenantId, from_node: from, ...(to === null ? {} : { to_node: to }) },
    status,
    requestId: `${reason}-${now}`,
  });
  const apps = await deps.db.query<{ app: string; deployment_hash: string }>(
    "select distinct on (app) app, deployment_hash from route_entries where tenant_id = $1 order by app, status",
    [tenantId],
  );
  const lines: StoredLine[] = apps.map((a) => ({
    ts: now,
    tenant_id: tenantId,
    deployment_hash: a.deployment_hash,
    request_id: null,
    module: "platform",
    level: to === null ? "error" : "info",
    message: to === null ? `${reason}: the tenant could not be moved off ${from}` : `${reason}: moved from ${from} to ${to}`,
    fields: { kind: reason, from_node: from, to_node: to, generation, restored_to: restoredTo, elapsed_ms: elapsed },
    source: "platform",
    node_id: to ?? from,
    app: a.app,
  }));
  if (lines.length > 0) await logIngest(deps).store.append(lines);
}

/** FO1-FO3 for the tenants of `nodes` (just marked unhealthy), at most FAILOVER_CONCURRENCY at a time. */
export async function failover(deps: Deps, nodes: readonly string[], started = deps.now()): Promise<MoveResult[]> {
  const out: MoveResult[] = [];
  for (const dead of nodes) {
    const tenants = (await deps.db.query<{ tenant_id: string }>("select distinct tenant_id from route_entries where node_id = $1 order by tenant_id", [dead])).map(
      (r) => r.tenant_id,
    );
    for (let i = 0; i < tenants.length; i += FAILOVER_CONCURRENCY) {
      const batch = tenants.slice(i, i + FAILOVER_CONCURRENCY);
      out.push(
        ...(await Promise.all(
          batch.map(async (t) => moveTenant(deps, t, dead, await candidatesFor(deps.db, t, [dead]), "failover", "platform", started)),
        )),
      );
    }
  }
  return out;
}

/** FO4: tells a node that is back to drop the tenants moved off it while it was gone. */
export async function dropMovedTenants(deps: Deps, nodeId: string): Promise<string[]> {
  const pending = await deps.db.query<{ id: unknown; tenant_id: string }>(
    "select id, tenant_id from failovers where from_node = $1 and status = 'moved' and dropped_at is null order by id",
    [nodeId],
  );
  if (pending.length === 0) return [];
  const target = await nodeTarget(deps, deps.db, nodeId);
  const call = nodeCall(deps);
  const dropped: string[] = [];
  for (const p of pending) {
    try {
      const res = await call(target, "DELETE", `/nodes/${nodeId}/tenants/${p.tenant_id}`, undefined, 30_000);
      if (res.status !== 200) {
        deps.log.warn("drop of a moved tenant refused", { node_id: nodeId, tenant_id: p.tenant_id, status: res.status });
        continue;
      }
    } catch (e) {
      deps.log.warn("drop of a moved tenant failed", { node_id: nodeId, tenant_id: p.tenant_id, error: String(e) });
      continue;
    }
    await deps.db.query("update failovers set dropped_at = $1 where id = $2", [deps.now(), p.id]);
    dropped.push(p.tenant_id);
  }
  return dropped;
}

/** The last move of a tenant, for getBackups. */
export async function lastFailover(db: Db, tenantId: string): Promise<{ at: number; from_node: string; to_node: string; generation: string | null; elapsed_ms: number } | null> {
  const rows = await db.query<{ at: unknown; from_node: string; to_node: string; generation: string | null; elapsed_ms: unknown }>(
    "select at, from_node, to_node, generation, elapsed_ms from failovers where tenant_id = $1 and status = 'moved' order by at desc, id desc limit 1",
    [tenantId],
  );
  const r = rows[0];
  return r === undefined ? null : { at: Number(r.at), from_node: r.from_node, to_node: r.to_node, generation: r.generation, elapsed_ms: Number(r.elapsed_ms) };
}
