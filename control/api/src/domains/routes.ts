// Domains API (docs/contracts/deploy-api.md section 10): add, list, read,
// detach, and the node's certificate bundle.

import type { Hono } from "hono";
import { operation } from "../audit.ts";
import { nodeAuth, tenantAuth } from "../auth/middleware.ts";
import { crossTenant, tenantDb } from "../tenancy/scope.ts";
import { requireApp } from "../apps/repo.ts";
import { assertTransition } from "../contract.ts";
import { ApiError, notFound } from "../errors.ts";
import { jsonBody, pathParam } from "../http.ts";
import { actorOf, type Deps, type Env } from "../context.ts";
import { deleteCertificate, loadCertificate } from "./certs.ts";
import { checkCustomHostname, domainView, domainViews, listDomains, requireDomain, toDomain, DOMAIN_COLUMNS } from "./repo.ts";
import { claimHostname, stopServing } from "./ownership.ts";
import { domainService } from "./service.ts";

export function registerDomains(app: Hono<Env>, deps: Deps): void {
  app.post("/v1/apps/:app/domains", operation(deps, "addDomain"), tenantAuth(deps, "domains:write"), async (c) => {
    const t = tenantDb(deps, c);
    const tenant = t.tenantId;
    const appName = (await requireApp(t, tenant, pathParam(c, "app", "AppName"))).name;
    const { hostname } = await jsonBody<{ hostname: string }>(c, "AddDomainRequest");
    checkCustomHostname(hostname, deps.config.platformDomain);
    c.set("auditTarget", { hostname });
    const row = await claimHostname(t, appName, hostname, deps.now());
    const [view] = await domainViews(t, tenant, [row]);
    return c.json(view, 201);
  });

  app.get("/v1/apps/:app/domains", operation(deps, "listDomains"), tenantAuth(deps, "apps:read"), async (c) => {
    const t = tenantDb(deps, c);
    const appName = (await requireApp(t, t.tenantId, pathParam(c, "app", "AppName"))).name;
    return c.json({ domains: await domainViews(t, t.tenantId, await listDomains(t, t.tenantId, appName)) });
  });

  app.get("/v1/apps/:app/domains/:hostname", operation(deps, "getDomain"), tenantAuth(deps, "apps:read"), async (c) => {
    const t = tenantDb(deps, c);
    const appName = (await requireApp(t, t.tenantId, pathParam(c, "app", "AppName"))).name;
    const d = await requireDomain(t, t.tenantId, appName, pathParam(c, "hostname", "Hostname"));
    const [view] = await domainViews(t, t.tenantId, [d]);
    return c.json(view);
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
    // Released: nobody may be served this certificate again.
    if (after.state === "released") await deleteCertificate(crossTenant(deps.db, "a certificate belongs to a hostname, whichever tenant held it"), hostname);
    // A released claim has no certificate any more.
    const [view] = after.state === "released" ? [domainView({ ...after, cert_state: "none" }, null)] : await domainViews(t, tenant, [after]);
    return c.json(view);
  });

  // The node's bundle: chain and key of a verified hostname. Every node
  // terminates TLS for every hostname, so any registered node may fetch it.
  app.get("/v1/nodes/:node_id/certificates/:hostname", operation(deps, "fetchCertificate"), nodeAuth(deps), async (c) => {
    const hostname = pathParam(c, "hostname", "Hostname");
    const keys = domainService(deps).keys;
    if (keys === null) throw new ApiError("RENOX_UNAVAILABLE", undefined, { retryAfter: 60 });
    const verified = await deps.db.query("select 1 from domains where hostname = $1 and state = 'verified'", [hostname]);
    if (verified.length === 0) throw notFound();
    const cert = await loadCertificate(deps.db, keys, hostname);
    if (cert === null) throw notFound();
    deps.log.info("certificate bundle served", { request_id: c.get("requestId"), actor: actorOf(c.get("principal")), hostname, version: cert.version });
    return c.json(
      { type: "certificate_bundle", schema_version: 0, hostname, version: cert.version, not_after: cert.not_after, chain_pem: cert.chain_pem, key_pem: cert.key_pem },
      200,
      { "cache-control": "no-store" },
    );
  });
}

