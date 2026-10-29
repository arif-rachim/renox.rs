// Node health, failover and tenant reassignment (deploy-api.md sections 7
// and 16), and the removal of drained route entries (section 8). sweep()
// runs every few seconds in main.ts; tests call it with their own clock.
//
// 0.3 (#257): a node that becomes unhealthy has its tenants moved by
// failover() (FO1-FO6: restore on the new node before the route entries
// change), not by a bare reassign; reassign() still moves tenants when a node
// joins or returns, and leaves pinned tenants on their pin.

import type { Db } from "../db/db.ts";
import type { Deps } from "../context.ts";
import { DRAIN_MS } from "../routes/activation.ts";
import { routeService } from "../routes/service.ts";
import { entriesWhere, lockRoutes, removeEntry, upsertEntry } from "../routes/table.ts";
import { ownerFor } from "./assign.ts";
import { failover, type MoveResult } from "./failover.ts";
import { healthyNodes, UNHEALTHY_AFTER_MS } from "./repo.ts";

/** Moves every tenant whose owner changed to its new owner; returns how many entries moved. */
export async function reassign(tx: Db, now: number): Promise<number> {
  const nodes = await healthyNodes(tx);
  if (nodes.length === 0) return 0;
  let moved = 0;
  const owners = new Map<string, string>();
  for (const e of await entriesWhere(tx, "true", [])) {
    let owner = owners.get(e.tenant_id);
    if (owner === undefined) {
      owner = (await ownerFor(tx, e.tenant_id, nodes)) as string;
      owners.set(e.tenant_id, owner);
    }
    if (e.node_id === owner) continue;
    // Entries on an unhealthy node are failover's (FO3: restore first).
    if (!nodes.includes(e.node_id)) continue;
    const { version: _old, ...rest } = e;
    await upsertEntry(tx, { ...rest, node_id: owner, updated_at: now });
    moved++;
  }
  return moved;
}

export interface SweepResult {
  unhealthy: string[];
  moved: number;
  drained: number;
  failovers: MoveResult[];
}

export async function sweep(deps: Deps, now = deps.now()): Promise<SweepResult> {
  const result = await deps.db.transaction(async (tx) => {
    await lockRoutes(tx);
    const unhealthy = (
      await tx.query<{ node_id: string }>("update workers set healthy = false where healthy and last_heartbeat_at < $1 returning node_id", [
        now - UNHEALTHY_AFTER_MS,
      ])
    ).map((r) => r.node_id);
    let drained = 0;
    for (const e of await entriesWhere(tx, "status = 'draining' and updated_at < $1", [now - DRAIN_MS])) {
      if ((await removeEntry(tx, e.hostname, e.deployment_hash, now)) !== null) drained++;
    }
    return { unhealthy, drained };
  });
  if (result.unhealthy.length > 0) deps.log.warn("nodes unhealthy", { nodes: result.unhealthy });
  if (result.drained > 0) await routeService(deps).publisher.publish();
  // FO1: the detection is this sweep; the moves run outside the route lock,
  // each restore with its own deadline.
  const moves = result.unhealthy.length > 0 ? await failover(deps, result.unhealthy, now) : [];
  return {
    unhealthy: result.unhealthy,
    moved: moves.filter((m) => m.status === "moved").length,
    drained: result.drained,
    failovers: moves,
  };
}
