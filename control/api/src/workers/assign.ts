// Tenant -> node assignment (docs/contracts/deploy-api.md section 7):
// rendezvous hashing over the healthy nodes. The owner of tenant t is the
// node n with the largest sha256(t + "\n" + n) as lower-case hex, ties broken
// by the smaller node id. Removing a node moves only its own tenants.

import { createHash } from "node:crypto";

const score = (tenantId: string, nodeId: string): string => createHash("sha256").update(`${tenantId}\n${nodeId}`).digest("hex");

/** The owning node of `tenantId` among `nodes`, or null when there is none. */
export function ownerOf(tenantId: string, nodes: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = "";
  for (const node of nodes) {
    const s = score(tenantId, node);
    if (best === null || s > bestScore || (s === bestScore && node < best)) {
      best = node;
      bestScore = s;
    }
  }
  return best;
}
