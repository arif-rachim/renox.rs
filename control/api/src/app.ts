// The control API (docs/contracts/deploy-api.md): one Hono app, with the
// request id, access log and error handling shared by every route module.

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
import { registerNodeArtifacts } from "./nodes/artifacts.ts";
import { registerPrepareResults } from "./nodes/prepare_results.ts";
import { registerActivation } from "./deployments/activate.ts";
import { registerAccounts } from "./auth/accounts.ts";
import { registerTeam } from "./tenancy/team.ts";

export type RouteModule = (app: Hono<Env>, deps: Deps) => void;

export function createApp(deps: Deps, modules: RouteModule[] = []): Hono<Env> {
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

  for (const register of [registerHealth, registerApps, registerTokens, registerAdmin, registerDeployments, registerRoutes, registerWorkers, registerSecrets, registerIngest, registerLogIngest, registerNodeArtifacts, registerPrepareResults, registerActivation, registerAccounts, registerTeam, ...modules]) register(app, deps);
  return app;
}
