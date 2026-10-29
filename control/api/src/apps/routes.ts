import type { Hono } from "hono";
import { operation } from "../audit.ts";
import { tenantAuth } from "../auth/middleware.ts";
import { tenantDb } from "../tenancy/scope.ts";
import { conflict } from "../errors.ts";
import { jsonBody, pathParam } from "../http.ts";
import { num } from "../db/db.ts";
import type { Deps, Env } from "../context.ts";
import { appViews, requireApp } from "./repo.ts";

export function registerApps(app: Hono<Env>, deps: Deps): void {
  app.post("/v1/apps", operation(deps, "createApp"), tenantAuth(deps, "apps:write"), async (c) => {
    const db = tenantDb(deps, c);
    const tenant = db.tenantId;
    const { name, staging = false } = await jsonBody<{ name: string; staging?: boolean }>(c, "CreateAppRequest");
    const now = deps.now();
    const created = await db.transaction(async (tx) => {
      // 0.3 (deploy-api.md section 3): a staging app gets a database of its own.
      const rows = await tx.query(
        "insert into apps (name, tenant_id, created_at, staging, database) values ($1, $2, $3, $4, $5) on conflict (name) do nothing returning name",
        [name, tenant, now, staging, staging ? `${tenant}.${name}` : null],
      );
      if (rows.length === 0) return false;
      await tx.query("insert into secret_sets (app, tenant_id, version) values ($1, $2, 0)", [name, tenant]);
      return true;
    });
    // The same answer whoever holds the name: no owner is revealed.
    if (!created) throw conflict("name", "not available");
    const [view] = await appViews(db, deps.config.platformDomain, [{ name, tenant_id: tenant, created_at: now }]);
    return c.json(view, 201);
  });

  app.get("/v1/apps", operation(deps, "listApps"), tenantAuth(deps, "apps:read"), async (c) => {
    const db = tenantDb(deps, c);
    const rows = await db.query<{ name: string; tenant_id: string; created_at: unknown }>(
      "select name, tenant_id, created_at from apps where tenant_id = $1 order by name",
      [db.tenantId],
    );
    const apps = await appViews(
      db,
      deps.config.platformDomain,
      rows.map((r) => ({ ...r, created_at: num(r.created_at) })),
    );
    return c.json({ apps });
  });

  app.get("/v1/apps/:app", operation(deps, "getApp"), tenantAuth(deps, "apps:read"), async (c) => {
    const db = tenantDb(deps, c);
    const row = await requireApp(db, db.tenantId, pathParam(c, "app", "AppName"));
    const [view] = await appViews(db, deps.config.platformDomain, [row]);
    return c.json(view);
  });
}
