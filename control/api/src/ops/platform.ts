// The platform tenant (#396): the tenant that runs the platform's own apps,
// `control/dashboard` as `dashboard` and `www/` as `www`. It is created by an
// ordinary sign-up, so it starts as a new free tenant; this operator call
// marks it. Then, and only for that tenant:
//
// - reserved app names (src/apps/slugs.ts, `reserved_slugs()`) can be taken
//   (the trigger of migrations/0028_platform_tenant.sql);
// - the new-tenant restrictions of deploy-api.md 0.5 section 21
//   (`reduced_quotas`, `no_custom_domain`) do not apply
//   (newTenantRestrictions in src/tenants/erasure.ts).
//
// `POST /v1/ops/tenants/{tenant_id}/platform {platform, reason}` needs an
// operator token with `ops:write`, like the tier change, and is audited
// (`setTenantPlatform`, with the operator and the reason). At most one tenant
// holds the flag (409 otherwise). Clearing it takes nothing away that exists:
// apps with reserved names stay, but no new one can be created. Not in
// deploy-api.yaml: an operator-only endpoint documented in
// control/api/README.md.
//
// docs/24-threat-model.md section E, "Operator console abuse" (reason and
// audit row on every operator action); section C, "Custom domain takeover"
// and "Shared-domain reputation" (no tenant but the platform's gains a
// reserved name).

import type { Context, Hono } from "hono";
import { operation } from "../audit.ts";
import { check } from "../contract.ts";
import type { Deps, Env } from "../context.ts";
import { ApiError, conflict, invalid, notFound } from "../errors.ts";
import { JSON_LIMIT, pathParam, readBody } from "../http.ts";
import { ulid } from "../ids.ts";
import { accountRef, operatorOf, opsAuth } from "./auth.ts";

async function objectBody(c: Context<Env>): Promise<Record<string, unknown>> {
  if (!/^application\/json(;|$)/u.test(c.req.header("content-type") ?? "")) throw invalid("content-type", "must be application/json");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(c, JSON_LIMIT)));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw invalid("body", "not valid UTF-8 JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid("body", "must be a JSON object");
  return value as Record<string, unknown>;
}

/** `{platform: boolean, reason: OperatorReason}` and nothing else. */
function platformRequest(body: Record<string, unknown>): { platform: boolean; reason: string } {
  for (const key of Object.keys(body)) if (key !== "platform" && key !== "reason") throw invalid(key, "unknown property");
  let reason: string;
  try {
    reason = check<string>("OperatorReason", body.reason);
  } catch {
    throw invalid("reason", "10 to 500 characters");
  }
  if (typeof body.platform !== "boolean") throw invalid("platform", "must be a boolean");
  return { platform: body.platform, reason };
}

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: unknown; errno?: unknown };
  return err.code === "23505" || err.errno === "23505";
};

export function registerPlatformTenant(app: Hono<Env>, deps: Deps): void {
  app.post("/v1/ops/tenants/:tenant_id/platform", operation(deps, "setTenantPlatform"), opsAuth(deps), async (c) => {
    const tenantId = pathParam(c, "tenant_id", "TenantId");
    // The reason is checked first, so even a refused request has it in its audit row.
    const body = platformRequest(await objectBody(c));
    const auditId = `aud_${ulid()}`;
    c.set("auditTarget", { ...c.get("auditTarget"), audit_id: auditId, operator: accountRef(operatorOf(c)), platform: String(body.platform), reason: body.reason });
    const rows = await deps.db.query<{ platform: boolean }>("select platform from tenants where id = $1", [tenantId]);
    const current = rows[0];
    if (current === undefined) throw notFound();
    if (current.platform === body.platform) {
      c.set("auditTarget", { ...c.get("auditTarget"), result: "unchanged" });
      return c.json({ tenant_id: tenantId, action: "setTenantPlatform", changed: false, platform: body.platform, audit_id: auditId });
    }
    try {
      await deps.db.query("update tenants set platform = $2 where id = $1", [tenantId, body.platform]);
    } catch (e) {
      // tenants_one_platform: another tenant already holds the flag.
      if (isUniqueViolation(e)) {
        c.set("auditTarget", { ...c.get("auditTarget"), result: "refused" });
        throw conflict("platform", "another tenant is the platform tenant");
      }
      throw e;
    }
    c.set("auditTarget", { ...c.get("auditTarget"), result: "changed" });
    deps.log.info("platform tenant changed", { tenant_id: tenantId, platform: body.platform, operator: operatorOf(c) });
    return c.json({ tenant_id: tenantId, action: "setTenantPlatform", changed: true, platform: body.platform, audit_id: auditId });
  });
}
