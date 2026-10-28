// Operator endpoints: tenants, their suspension, and node tokens. Until #113
// adds sign-up, a tenant and its first token are created here.

import type { Hono } from "hono";
import { operation } from "../audit.ts";
import { operatorAuth } from "../auth/middleware.ts";
import { createTenantToken, newTokenValue, sha256hex } from "../auth/tokens.ts";
import { conflict, notFound } from "../errors.ts";
import { jsonBody, pathParam } from "../http.ts";
import { num, type Db } from "../db/db.ts";
import type { Deps, Env } from "../context.ts";

const BOOTSTRAP_DAYS = 90;

export type TenantState = "active" | "suspended";

/**
 * Called in the transaction that changed a tenant's state (deployments and
 * routes hook in here). The returned function, if any, runs after the commit.
 */
export type TenantStateHook = (tx: Db, tenantId: string, state: TenantState, now: number) => Promise<(() => Promise<void>) | void>;

const hooks = new WeakMap<Deps, TenantStateHook[]>();

export function addTenantStateHook(deps: Deps, hook: TenantStateHook): void {
  hooks.set(deps, [...(hooks.get(deps) ?? []), hook]);
}

async function tenantView(db: Db, id: string): Promise<Record<string, unknown>> {
  const rows = await db.query<Record<string, unknown>>("select id, name, tier, state, created_at from tenants where id = $1", [id]);
  const r = rows[0];
  if (r === undefined) throw notFound();
  return { tenant_id: r.id, name: r.name, tier: r.tier, state: r.state, created_at: num(r.created_at) };
}

export function registerAdmin(app: Hono<Env>, deps: Deps): void {
  const { db } = deps;

  app.post("/v1/admin/tenants", operation(deps, "createTenant"), operatorAuth(deps), async (c) => {
    const body = await jsonBody<{ tenant_id: string; name: string; tier: string }>(c, "CreateTenantRequest");
    const now = deps.now();
    const result = await db.transaction(async (tx) => {
      const rows = await tx.query(
        "insert into tenants (id, name, tier, created_at) values ($1, $2, $3, $4) on conflict (id) do nothing returning id",
        [body.tenant_id, body.name, body.tier, now],
      );
      if (rows.length === 0) return null;
      const token = await createTenantToken(tx, body.tenant_id, "bootstrap", ["*"], BOOTSTRAP_DAYS, now);
      return { tenant: await tenantView(tx, body.tenant_id), token };
    });
    if (result === null) throw conflict("tenant_id", "not available");
    return c.json(result, 201);
  });

  const setState = (state: TenantState, action: string) =>
    app.post(`/v1/admin/tenants/:tenant_id/${state === "suspended" ? "suspend" : "reinstate"}`, operation(deps, action), operatorAuth(deps), async (c) => {
      const id = pathParam(c, "tenant_id", "TenantId");
      const now = deps.now();
      const after: (() => Promise<void>)[] = [];
      const view = await db.transaction(async (tx) => {
        const rows = await tx.query<{ state: string }>("select state from tenants where id = $1 for update", [id]);
        if (rows[0] === undefined) throw notFound();
        if (rows[0].state !== state) {
          await tx.query("update tenants set state = $1 where id = $2", [state, id]);
          for (const hook of hooks.get(deps) ?? []) {
            const then = await hook(tx, id, state, now);
            if (then !== undefined) after.push(then);
          }
        }
        return tenantView(tx, id);
      });
      for (const then of after) await then();
      return c.json(view);
    });
  setState("suspended", "suspendTenant");
  setState("active", "reinstateTenant");

  app.post("/v1/admin/nodes", operation(deps, "createNodeToken"), operatorAuth(deps), async (c) => {
    const { node_id } = await jsonBody<{ node_id: string }>(c, "CreateNodeRequest");
    const token = newTokenValue("node");
    const now = deps.now();
    const rows = await db.query(
      "insert into node_tokens (node_id, token_sha256, created_at) values ($1, $2, $3) on conflict (node_id) do nothing returning node_id",
      [node_id, sha256hex(token), now],
    );
    if (rows.length === 0) throw conflict("node_id", "not available");
    return c.json({ node_id, token, created_at: now }, 201);
  });
}
