// Tenant -> node assignment (docs/contracts/deploy-api.md section 7):
// rendezvous hashing over the healthy nodes. The owner of tenant t is the
// node n with the largest sha256(t + "\n" + n) as lower-case hex, ties broken
// by the smaller node id. Removing a node moves only its own tenants.
//
// 0.3 (#257, FO2/FO4): a tenant that failover or an operator moved is pinned
// to the node it moved to (tenant_pins), for as long as that node is
// healthy; ownerFor() is the owner with pins, candidatesFor() the failover
// candidates in rendezvous order.

import { createHash } from "node:crypto";
import type { Db } from "../db/db.ts";

const score = (tenantId: string, nodeId: string): string => createHash("sha256").update(`${tenantId}\n${nodeId}`).digest("hex");

/** The owning node of `tenantId` among `nodes`, or null when there is none. */
export function ownerOf(tenantId: string, nodes: readonly string[]): string | null {
  return rendezvous(tenantId, nodes)[0] ?? null;
}

/** `nodes` in the tenant's rendezvous order, best first. */
export function rendezvous(tenantId: string, nodes: readonly string[]): string[] {
  return [...nodes].sort((a, b) => {
    const sa = score(tenantId, a);
    const sb = score(tenantId, b);
    return sa === sb ? (a < b ? -1 : 1) : sa > sb ? -1 : 1;
  });
}

/** The pin of a tenant, if any. */
export async function pinOf(db: Db, tenantId: string): Promise<string | null> {
  const rows = await db.query<{ node_id: string }>("select node_id from tenant_pins where tenant_id = $1", [tenantId]);
  return rows[0]?.node_id ?? null;
}

/** Pins `tenantId` to `nodeId` (a failover or an operator move). */
export async function pinTenant(db: Db, tenantId: string, nodeId: string, reason: string, now: number): Promise<void> {
  await db.query(
    `insert into tenant_pins (tenant_id, node_id, reason, pinned_at) values ($1, $2, $3, $4)
     on conflict (tenant_id) do update set node_id = excluded.node_id, reason = excluded.reason, pinned_at = excluded.pinned_at`,
    [tenantId, nodeId, reason, now],
  );
}

/** The owner of `tenantId` among the healthy `nodes`: its pin when healthy, else rendezvous. */
export async function ownerFor(db: Db, tenantId: string, nodes: readonly string[]): Promise<string | null> {
  const pin = await pinOf(db, tenantId);
  if (pin !== null && nodes.includes(pin)) return pin;
  return ownerOf(tenantId, nodes);
}

/** FO2: healthy nodes with capacity (cells < max_cells), in rendezvous order, without `exclude`. */
export async function candidatesFor(db: Db, tenantId: string, exclude: readonly string[]): Promise<string[]> {
  const rows = await db.query<{ node_id: string }>("select node_id from workers where healthy and cells < max_cells order by node_id");
  return rendezvous(
    tenantId,
    rows.map((r) => r.node_id).filter((n) => !exclude.includes(n)),
  );
}
