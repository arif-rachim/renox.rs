// GET /v1/nodes/{node_id}/artifacts/{hash} (fetchArtifact, deploy-api.md
// section 7 and the OpenAPI operation): the artifact tar of a deployment whose
// tenant this node serves. A 307 to a presigned GET when the store can presign,
// otherwise the tar itself. The node recomputes the hash and applies the T
// rules before loading, so the bytes are not trusted on either side.

import type { Hono } from "hono";
import { operation } from "../audit.ts";
import { nodeAuth, nodeId } from "../auth/middleware.ts";
import type { Deps, Env } from "../context.ts";
import { ApiError, notFound } from "../errors.ts";
import { pathParam } from "../http.ts";
import { ownerFor } from "../workers/assign.ts";
import { healthyNodes } from "../workers/repo.ts";

/** Lifetime of a presigned artifact URL (the OpenAPI description: 300 s). */
export const PRESIGN_SECONDS = 300;

/** Deployment states whose artifact a node may need: preparing, serving, draining or a rollback target, suspended. */
const FETCHABLE = ["activating", "active", "superseded", "suspended"];

export const artifactKey = (hash: string): string => `artifacts/${hash}.tar`;

/**
 * Whether `node` serves a deployment of `hash`: a route entry names the node,
 * or the node owns (section 7) a tenant with a fetchable deployment of it.
 * Null when no fetchable deployment of any tenant has the hash.
 */
export async function assigned(deps: Deps, node: string, hash: string): Promise<boolean | null> {
  // A node token is not bound to a tenant: these reads span tenants by design.
  const routed = await deps.db.query("select 1 from route_entries where deployment_hash = $1 and node_id = $2 limit 1", [hash, node]);
  if (routed.length > 0) return true;
  const tenants = await deps.db.query<{ tenant_id: string }>(
    "select distinct tenant_id from deployments where hash = $1 and state = any($2::text[])",
    [hash, FETCHABLE],
  );
  if (tenants.length === 0) return null;
  const nodes = await healthyNodes(deps.db);
  for (const t of tenants) if ((await ownerFor(deps.db, t.tenant_id, nodes)) === node) return true;
  return false;
}

export function registerNodeArtifacts(app: Hono<Env>, deps: Deps): void {
  app.get("/v1/nodes/:node_id/artifacts/:hash", operation(deps, "fetchArtifact"), nodeAuth(deps), async (c) => {
    const node = nodeId(c);
    const hash = pathParam(c, "hash", "Sha256");
    const ok = await assigned(deps, node, hash);
    if (ok === null) throw notFound();
    if (!ok) throw new ApiError("RENOX_TOKEN_SCOPE");
    const etag = `"${hash}"`;
    const key = artifactKey(hash);
    const url = deps.store.presign(key, PRESIGN_SECONDS);
    if (url !== null) return c.body(null, 307, { location: url, etag, "cache-control": "no-store" });
    const bytes = await deps.store.get(key);
    if (bytes === null) throw notFound();
    // Content-addressed: the hash is the entity tag, and an unchanged tar is never re-sent.
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, { etag });
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, { "content-type": "application/x-tar", etag, "content-length": String(bytes.byteLength) });
  });
}
