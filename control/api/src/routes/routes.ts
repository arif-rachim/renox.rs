import type { Context, Hono } from "hono";
import { operation } from "../audit.ts";
import { tenantAuth, tenantId } from "../auth/middleware.ts";
import { requireApp } from "../apps/repo.ts";
import { deploymentView, type Actor } from "../deployments/repo.ts";
import { jsonBody, pathParam } from "../http.ts";
import { actorOf, type Deps, type Env } from "../context.ts";
import { addTenantStateHook } from "../tenants/routes.ts";
import { activate, onTenantState, rollback } from "./activation.ts";
import { routeService } from "./service.ts";

export function registerRoutes(app: Hono<Env>, deps: Deps): void {
  const actor = (c: Context<Env>): Actor => ({ actor: actorOf(c.get("principal")), requestId: c.get("requestId"), now: deps.now() });

  app.post("/v1/apps/:app/activate", operation(deps, "activateDeployment"), tenantAuth(deps, "deploy"), async (c) => {
    const tenant = tenantId(c);
    const name = (await requireApp(deps.db, tenant, pathParam(c, "app", "AppName"))).name;
    const { hash } = await jsonBody<{ hash: string }>(c, "ActivateRequest");
    return c.json(deploymentView(await activate(deps, tenant, name, hash, actor(c))));
  });

  app.post("/v1/apps/:app/rollback", operation(deps, "rollbackDeployment"), tenantAuth(deps, "deploy"), async (c) => {
    const tenant = tenantId(c);
    const name = (await requireApp(deps.db, tenant, pathParam(c, "app", "AppName"))).name;
    const { hash } = await jsonBody<{ hash?: string }>(c, "RollbackRequest", true);
    return c.json(deploymentView(await rollback(deps, tenant, name, hash, actor(c))));
  });

  addTenantStateHook(deps, async (tx, id, state, now) => {
    await onTenantState(deps, tx, id, state, now);
    return () => routeService(deps).publisher.publish();
  });
}
