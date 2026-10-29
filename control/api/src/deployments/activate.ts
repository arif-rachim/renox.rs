// Activation steps 3-7 (docs/contracts/deploy-api.md section 6, #96): the
// preparer that sends `prepare` to the owning node and waits for its
// prepare_result, so a migration that fails, a cell that does not load, or a
// probe that fails never moves the route pointer. The pointer switch, the
// state transitions and the audit rows are in routes/activation.ts.

import type { Hono } from "hono";
import type { Deps, Env } from "../context.ts";
import { prepareBroker, PREPARE_DEADLINE_MS, type PrepareMessage } from "../nodes/prepare_results.ts";
import { routeService, type PrepareRequest, type PrepareResult } from "../routes/service.ts";
import { withTenant } from "../tenancy/scope.ts";

/** deploy-api.md section 6, "Probe": the probe request's timeout. */
export const PROBE_TIMEOUT_MS = 10_000;

/** `$defs/prepare.probe.path`. */
const PROBE_PATH = /^\/([A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*)?$/u;

type Route = { kind?: string; method?: string; path?: string };

/**
 * The probe path of a manifest: `/` when a GET route matches `/`; otherwise
 * the first GET route in manifest order whose pattern has no parameter or
 * catch-all; null when there is none (only cell creation is checked).
 * Page routes answer GET.
 */
export function probePath(manifest: Record<string, unknown> | null): string | null {
  const routes = Array.isArray(manifest?.routes) ? (manifest.routes as Route[]) : [];
  const gets = routes.filter((r) => typeof r.path === "string" && (r.kind === "page" || r.method === "GET")).map((r) => r.path as string);
  if (gets.includes("/")) return "/";
  return gets.find((p) => !p.includes(":") && !p.includes("*") && PROBE_PATH.test(p)) ?? null;
}

/** The preparer of section 6: `prepare` on the owning node's stream, its answer, or a timeout. */
export function nodePreparer(deps: Deps): (request: PrepareRequest) => Promise<PrepareResult> {
  const broker = prepareBroker(deps);
  return async (request) => {
    // Scoped to the activation's own tenant (the principal of the request that started it).
    const db = withTenant(deps.db, { kind: "tenant", via: "token", tenantId: request.tenantId, tokenId: "activation", scopes: [], userId: null, role: null });
    const rows = await db.query<{ manifest: Record<string, unknown> | null }>(
      "select manifest from deployments where tenant_id = $1 and app = $2 and hash = $3",
      [request.tenantId, request.app, request.hash],
    );
    const path = probePath(rows[0]?.manifest ?? null);
    const message: PrepareMessage = {
      type: "prepare",
      schema_version: 0,
      activation_id: broker.newId(),
      tenant_id: request.tenantId,
      app: request.app,
      deployment_hash: request.hash,
      tier: request.tier,
      secrets_version: request.secretsVersion,
      probe: path === null ? null : { path, timeout_ms: PROBE_TIMEOUT_MS },
      deadline_ms: PREPARE_DEADLINE_MS,
    };
    const result = await broker.request(request.nodeId, message);
    deps.log.info("prepare answered", { activation_id: message.activation_id, app: request.app, hash: request.hash, node_id: request.nodeId, ok: result.ok });
    return result.ok ? { ok: true } : result;
  };
}

/** Installs the node preparer in place of the accept-at-once default of #53. */
export function registerActivation(_app: Hono<Env>, deps: Deps): void {
  routeService(deps).prepare = nodePreparer(deps);
}
