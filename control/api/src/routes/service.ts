// The per-process route machinery shared by the route and worker modules: the
// hub of connected node streams, the publisher, and the activation preparer.

import type { Deps } from "../context.ts";
import { Hub } from "../workers/hub.ts";
import { Publisher } from "./publisher.ts";

export interface PrepareRequest {
  tenantId: string;
  app: string;
  hash: string;
  nodeId: string;
  tier: "free" | "paid";
  secretsVersion: number;
}

export type PrepareResult = { ok: true } | { ok: false; error: { stage: string; reason: string; [key: string]: string | number } };

/**
 * Activation step 3-4 (deploy-api.md section 6). The default accepts at once:
 * #53 implements the pointer switch; #96 replaces this with `prepare` sent to
 * the owning node (fetch, migrations, cell creation, probe).
 */
export type Preparer = (request: PrepareRequest) => Promise<PrepareResult>;

export interface RouteService {
  hub: Hub;
  publisher: Publisher;
  prepare: Preparer;
}

const services = new WeakMap<Deps, RouteService>();

export function routeService(deps: Deps): RouteService {
  let s = services.get(deps);
  if (s === undefined) {
    const hub = new Hub();
    s = { hub, publisher: new Publisher(deps.db, hub), prepare: async () => ({ ok: true }) };
    services.set(deps, s);
  }
  return s;
}
