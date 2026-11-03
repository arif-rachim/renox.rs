// Domains API (docs/contracts/deploy-api.md 0.6 section 10): add, list,
// read, detach. Custom hostnames live at Cloudflare for SaaS (#419); nodes
// get no certificate.

import type { Hono } from "hono";
import { operation } from "../audit.ts";
import { tenantAuth } from "../auth/middleware.ts";
import { tenantDb } from "../tenancy/scope.ts";
import { requireApp } from "../apps/repo.ts";
import { assertTransition } from "../contract.ts";
import { conflict } from "../errors.ts";
import { num } from "../db/db.ts";
import { newTenantRestrictions } from "../tenants/erasure.ts";
import { jsonBody, pathParam } from "../http.ts";
import type { Deps, Env } from "../context.ts";
import { checkCustomHostname, domainView, listDomains, requireDomain, toDomain, DOMAIN_COLUMNS } from "./repo.ts";
import { claimHostname, deleteHostname, stopServing } from "./ownership.ts";
import { cnameTarget, requireCloudflare } from "./service.ts";

export function registerDomains(app: Hono<Env>, deps: Deps): void {
  app.post("/v1/apps/:app/domains", operation(deps, "addDomain"), tenantAuth(deps, "domains:write"), async (c) => {
    const t = tenantDb(deps, c);
    const tenant = t.tenantId;
    const appName = (await requireApp(t, tenant, pathParam(c, "app", "AppName"))).name;
    const { hostname } = await jsonBody<{ hostname: string }>(c, "AddDomainRequest");
    checkCustomHostname(hostname, deps.config.platformDomain);
    c.set("auditTarget", { hostname });
    // deploy-api.md 0.5 section 21 (#123): a new tenant has no custom domain
    // until a payment method is confirmed or 7 days pass without a flag.
    const created = (await t.query<{ created_at: unknown }>("select created_at from tenants where id = $1", [tenant]))[0]?.created_at;
    if ((await newTenantRestrictions(t, tenant, num(created), deps.now())).includes("no_custom_domain")) throw conflict("tenant", "no_custom_domain");
    // 503 before anything is claimed when Cloudflare for SaaS is not configured.
    requireCloudflare(deps);
    const row = await claimHostname(deps, t, appName, hostname, deps.now());
    return c.json(domainView(row, cnameTarget(deps)), 201);
  });

  app.get("/v1/apps/:app/domains", operation(deps, "listDomains"), tenantAuth(deps, "apps:read"), async (c) => {
    const t = tenantDb(deps, c);
    const appName = (await requireApp(t, t.tenantId, pathParam(c, "app", "AppName"))).name;
    const target = cnameTarget(deps);
    return c.json({ domains: (await listDomains(t, t.tenantId, appName)).map((d) => domainView(d, target)) });
  });

  app.get("/v1/apps/:app/domains/:hostname", operation(deps, "getDomain"), tenantAuth(deps, "apps:read"), async (c) => {
    const t = tenantDb(deps, c);
    const appName = (await requireApp(t, t.tenantId, pathParam(c, "app", "AppName"))).name;
    const d = await requireDomain(t, t.tenantId, appName, pathParam(c, "hostname", "Hostname"));
    return c.json(domainView(d, cnameTarget(deps)));
  });

  // verified -> detached (still owned for 30 days, ownership.ts), pending
  // and detached -> released (the owner lets it go). Serving stops at once.
  app.delete("/v1/apps/:app/domains/:hostname", operation(deps, "removeDomain"), tenantAuth(deps, "domains:write"), async (c) => {
    const t = tenantDb(deps, c);
    const tenant = t.tenantId;
    const appName = (await requireApp(t, tenant, pathParam(c, "app", "AppName"))).name;
    const hostname = pathParam(c, "hostname", "Hostname");
    const now = deps.now();
    const { before, after } = await t.transaction(async (tx) => {
      const d = await requireDomain(tx, tenant, appName, hostname, true);
      const next = d.state === "verified" ? "detached" : "released";
      assertTransition("domain", d.state, next);
      // detached: owned for HOLD_MS more (ownership.ts); released: claimable at once.
      const rows = await tx.query(
        `update domains set state = $3, detached_at = case when $3 = 'detached' then $4::bigint else detached_at end, detach_reason = case when $3 = 'detached' then 'removed' else detach_reason end,
           released_at = case when $3 = 'released' then $4::bigint else released_at end, last_checked_at = coalesce(last_checked_at, $4::bigint)
         where tenant_id = $1 and id = $2 returning ${DOMAIN_COLUMNS}`,
        [tenant, d.id, next, now],
      );
      return { before: d, after: toDomain(rows[0] as Record<string, unknown>) };
    });
    if (before.state === "verified") await stopServing(deps, hostname);
    // Released: the custom hostname is deleted at Cloudflare (retried by the job on failure).
    if (after.state === "released") await deleteHostname(deps, after);
    return c.json(domainView(after, cnameTarget(deps)));
  });
}
