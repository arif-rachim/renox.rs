// The control API (docs/contracts/deploy-api.md): one Hono app, with the
// request id, access log and error handling shared by every route module.
// main.ts serves it twice, as two surfaces on two listeners (ADR D23, #218):
// the public one never routes the node-facing paths, the node one serves
// only them.

import { Hono } from "hono";
import { ApiError, errorBody } from "./errors.ts";
import { ulid } from "./ids.ts";
import { actorOf, type Deps, type Env } from "./context.ts";
import { registerHealth } from "./health.ts";
import { registerApps } from "./apps/routes.ts";
import { registerTokens } from "./tokens/routes.ts";
import { registerAdmin } from "./tenants/routes.ts";
import { registerDeployments } from "./deployments/routes.ts";
import { registerRoutes } from "./routes/routes.ts";
import { registerWorkers } from "./workers/routes.ts";
import { registerSecrets } from "./secrets/routes.ts";
import { registerIngest } from "./ingest/routes.ts";
import { registerLogIngest } from "./ingest/logs.ts";
import { registerLogStream } from "./logs/stream.ts";
import { registerClientErrors } from "./logs/client-events.ts";
import { registerNodeArtifacts } from "./nodes/artifacts.ts";
import { registerPrepareResults } from "./nodes/prepare_results.ts";
import { registerActivation } from "./deployments/activate.ts";
import { registerAccounts } from "./auth/accounts.ts";
import { registerTeam } from "./tenancy/team.ts";
import { registerDomains } from "./domains/routes.ts";
import { registerMcp } from "./mcp/server.ts";
import { registerBackupActions, registerBackups } from "./tenants/backups.ts";
import { registerOps } from "./ops/tenants.ts";

export type RouteModule = (app: Hono<Env>, deps: Deps) => void;

/**
 * Which requests an app answers. `public`: everything except the node-facing
 * paths, for the internet and the public edge. `node`: the node-facing paths
 * and `/v1/healthz`, for the listener only nodes reach (the address in their
 * `[control] url` and `fetch_blocked_addresses`). `combined`: both, for
 * in-process tests only; main.ts never serves it.
 */
export type Surface = "public" | "node" | "combined";

/**
 * The node-facing paths (`renox_node_` tokens: route tables, secret bundles,
 * artifacts, certificates, meter and log ingestion). Compared on the path the
 * router matches, lower-cased and with repeated slashes collapsed, so no
 * spelling of a node path reaches a handler on the public surface.
 */
export function isNodePath(path: string): boolean {
  const p = path.toLowerCase().replace(/\/{2,}/gu, "/");
  return ["/v1/nodes", "/v1/ingest"].some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

function served(surface: Surface, path: string): boolean {
  if (surface === "combined") return true;
  if (surface === "public") return !isNodePath(path);
  return isNodePath(path) || path === "/v1/healthz";
}

export function createApp(deps: Deps, modules: RouteModule[] = [], surface: Surface = "combined"): Hono<Env> {
  const app = new Hono<Env>();

  app.use(async (c, next) => {
    const requestId = ulid(deps.now());
    const started = performance.now();
    c.set("requestId", requestId);
    await next();
    c.res.headers.set("x-renox-request-id", requestId);
    deps.log.info("request", {
      request_id: requestId,
      method: c.req.method,
      route: c.req.routePath,
      action: c.get("action") ?? null,
      status: c.res.status,
      actor: actorOf(c.get("principal")),
      ms: Math.round((performance.now() - started) * 1000) / 1000,
    });
  });

  app.onError((err, c) => {
    const requestId = c.get("requestId");
    if (err instanceof ApiError) {
      const res = c.json(errorBody(err.code, requestId, err.details, err.extra.deployment), err.status as 400);
      if (err.code === "RENOX_UNAUTHENTICATED") res.headers.set("www-authenticate", 'Bearer realm="renox"');
      if (err.extra.retryAfter !== undefined) res.headers.set("retry-after", String(err.extra.retryAfter));
      return res;
    }
    // The operator log gets the message; the response gets only the fixed text.
    deps.log.error("unhandled error", { request_id: requestId, error: err instanceof Error ? err.message : String(err) });
    return c.json(errorBody("RENOX_INTERNAL", requestId), 500);
  });

  app.notFound((c) => c.json(errorBody("RENOX_NOT_FOUND", c.get("requestId")), 404));

  // Registered before every route, so a path of the other surface is 404
  // before any handler or auth middleware runs (docs/24-threat-model.md B,
  // node-facing control-plane endpoints).
  app.use(async (c, next) => {
    if (!served(surface, c.req.path)) return c.json(errorBody("RENOX_NOT_FOUND", c.get("requestId")), 404);
    await next();
  });

  for (const register of [registerHealth, registerApps, registerTokens, registerAdmin, registerDeployments, registerRoutes, registerWorkers, registerSecrets, registerIngest, registerLogIngest, registerLogStream, registerClientErrors, registerNodeArtifacts, registerPrepareResults, registerActivation, registerAccounts, registerTeam, registerDomains, registerMcp, registerBackups, registerBackupActions, registerOps, ...modules]) register(app, deps);
  return app;
}
