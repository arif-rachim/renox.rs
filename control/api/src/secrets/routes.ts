// Secrets API (docs/contracts/deploy-api.md section 9): PUT, DELETE, list
// (names only), bump, and the node's per-deployment bundle.

import type { Context, Hono } from "hono";
import { operation } from "../audit.ts";
import { nodeAuth, nodeId, tenantAuth, tenantId } from "../auth/middleware.ts";
import { requireApp } from "../apps/repo.ts";
import { check } from "../contract.ts";
import { ApiError, conflict, invalid, notFound } from "../errors.ts";
import { jsonBody, pathParam } from "../http.ts";
import { actorOf, type Deps, type Env } from "../context.ts";
import { deploymentView, requireDeployment, type DeploymentRow } from "../deployments/repo.ts";
import { routeService } from "../routes/service.ts";
import { entriesWhere, lockRoutes, upsertEntry } from "../routes/table.ts";
import { ownerOf } from "../workers/assign.ts";
import { healthyNodes } from "../workers/repo.ts";
import { EnvMasterKey, type KeyProvider } from "./crypto.ts";
import { deleteSecret, latestVersion, listSecrets, putSecret, valuesAt } from "./store.ts";

const providers = new WeakMap<Deps, KeyProvider>();

/** The key provider, or 503 when no master key is configured. */
function keysOf(deps: Deps): KeyProvider {
  let keys = providers.get(deps);
  if (keys === undefined) {
    if (deps.config.masterKey === null) throw new ApiError("RENOX_UNAVAILABLE", undefined, { retryAfter: 60 });
    keys = new EnvMasterKey(deps.config.masterKey);
    providers.set(deps, keys);
  }
  return keys;
}

function secretName(c: Context<Env>): string {
  const name = c.req.param("name");
  try {
    return check<string>("SecretName", name);
  } catch {
    throw invalid("name", "secret names match ^[A-Z][A-Z0-9_]{0,63}$");
  }
}

export function registerSecrets(app: Hono<Env>, deps: Deps): void {
  const { db } = deps;

  app.get("/v1/apps/:app/secrets", operation(deps, "listSecrets"), tenantAuth(deps, "secrets:read"), async (c) => {
    const name = (await requireApp(db, tenantId(c), pathParam(c, "app", "AppName"))).name;
    return c.json(await listSecrets(db, name));
  });

  app.put("/v1/apps/:app/secrets/:name", operation(deps, "putSecret"), tenantAuth(deps, "secrets:write"), async (c) => {
    const tenant = tenantId(c);
    const appName = (await requireApp(db, tenant, pathParam(c, "app", "AppName"))).name;
    const name = secretName(c);
    const keys = keysOf(deps);
    const { value } = await jsonBody<{ value: string }>(c, "PutSecretRequest");
    const version = await db.transaction((tx) => putSecret(tx, keys, tenant, appName, name, value, deps.now()));
    return c.json({ name, version });
  });

  app.delete("/v1/apps/:app/secrets/:name", operation(deps, "deleteSecret"), tenantAuth(deps, "secrets:write"), async (c) => {
    const tenant = tenantId(c);
    const appName = (await requireApp(db, tenant, pathParam(c, "app", "AppName"))).name;
    const name = secretName(c);
    const version = await db.transaction((tx) => deleteSecret(tx, appName, name));
    return c.json({ name, version });
  });

  app.post("/v1/apps/:app/secrets/bump", operation(deps, "bumpSecrets"), tenantAuth(deps, "secrets:write"), async (c) => {
    const tenant = tenantId(c);
    const appName = (await requireApp(db, tenant, pathParam(c, "app", "AppName"))).name;
    const now = deps.now();
    const hash = await db.transaction(async (tx) => {
      await lockRoutes(tx);
      const rows = await tx.query<{ hash: string }>("select hash from deployments where tenant_id = $1 and app = $2 and state = 'active' for update", [tenant, appName]);
      const active = rows[0];
      if (active === undefined) throw conflict("state", "there is no active deployment");
      const version = await latestVersion(tx, appName);
      await tx.query("update deployments set secrets_version = $1, updated_at = $2 where app = $3 and hash = $4", [version, now, appName, active.hash]);
      for (const e of await entriesWhere(tx, "app = $1 and deployment_hash = $2 and status = 'active'", [appName, active.hash])) {
        if (e.secrets_version === version) continue;
        const { version: _old, ...rest } = e;
        await upsertEntry(tx, { ...rest, secrets_version: version, updated_at: now });
      }
      return active.hash;
    });
    await routeService(deps).publisher.publish();
    return c.json(deploymentView(await requireDeployment(db, tenant, appName, hash)));
  });

  // The node's bundle: only for the node the tenant is assigned to, only for
  // an activating or active deployment, only the names its manifest declares.
  app.get("/v1/nodes/:node_id/secrets/:app/:hash", operation(deps, "fetchSecrets"), nodeAuth(deps), async (c) => {
    const node = nodeId(c);
    const appName = pathParam(c, "app", "AppName");
    const hash = pathParam(c, "hash", "Sha256");
    const version = Number(c.req.query("version"));
    if (!Number.isInteger(version) || version < 0) throw invalid("version", "must be a non-negative integer");
    const owners = await db.query<{ tenant_id: string }>("select tenant_id from apps where name = $1", [appName]);
    const tenant = owners[0]?.tenant_id;
    if (tenant === undefined) throw notFound();
    const d: DeploymentRow = await requireDeployment(db, tenant, appName, hash);
    const pinned = d.state === "active" || d.state === "activating" ? d.secrets_version : null;
    if (pinned === null || pinned !== version) throw notFound();
    if (ownerOf(tenant, await healthyNodes(db)) !== node) throw notFound();
    const declared = ((d.manifest?.permissions as { secrets?: string[] } | undefined)?.secrets ?? []).slice();
    const secrets = await valuesAt(db, keysOf(deps), tenant, appName, version, declared);
    deps.log.info("secret bundle served", { request_id: c.get("requestId"), actor: actorOf(c.get("principal")), app: appName, hash, version, names: Object.keys(secrets) });
    return c.json(
      { type: "secrets_bundle", schema_version: 0, tenant_id: tenant, app: appName, deployment_hash: hash, version, secrets },
      200,
      { "cache-control": "no-store" },
    );
  });
}
