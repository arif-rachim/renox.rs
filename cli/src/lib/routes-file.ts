// The route table file of `mode = "local"` (artifact.md section 5, version 0):
// the entries `renox dev` and `renox export` hand to renox-worker.

import { writeFileSync } from "node:fs";

import { renameRetry } from "./rename.ts";

/** One entry of the local route table file (the gateway's `RouteEntry`, which refuses unknown fields). */
export interface RouteEntry {
  hostname: string;
  tenant_id: string;
  deployment_hash: string;
  status: "active";
  updated_at: number;
}

/** One active entry per hostname, all for the same tenant and deployment. */
export function routeEntries(opts: { hostnames: string[]; tenantId: string; hash: string }): RouteEntry[] {
  const now = Date.now();
  return opts.hostnames.map((hostname) => ({ hostname, tenant_id: opts.tenantId, deployment_hash: opts.hash, status: "active", updated_at: now }));
}

/** Replaces the route table atomically (write, then rename): a reader sees the old or the new table. */
export function writeRoutesFile(path: string, entries: RouteEntry[]): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 0, entries }, null, 2)}\n`);
  renameRetry(tmp, path);
}
