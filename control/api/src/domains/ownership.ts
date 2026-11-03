// Domain ownership (#114; docs/24-threat-model.md section C, "Custom domain
// takeover"; deploy-api.md 0.6 section 10).
//
// A hostname is owned by at most one claim in any state but `released`
// (unique index `domains_one_owner`), so of two tenants racing for one
// hostname exactly one wins and the other gets 409 without the owner's
// name. A detached claim stays owned for 30 days, so a hostname whose CNAME
// still points at Renoxium after its tenant removed it cannot be taken over
// by another tenant in that window. Only its owner can claim it again (which
// re-checks it) or release it at once. The claim's Cloudflare custom
// hostname (#419) lives as long as the claim: created with it, deleted when
// it is released.

import type { Deps } from "../context.ts";
import type { Db } from "../db/db.ts";
import { ulid } from "../ids.ts";
import { writeAudit } from "../audit.ts";
import { ApiError, conflict } from "../errors.ts";
import { crossTenant } from "../tenancy/scope.ts";
import { CloudflareError } from "./cloudflare.ts";
import { DOMAIN_COLUMNS, jobDb, newDomainId, recordHostname, syncRoutes, toDomain, type DomainRow } from "./repo.ts";
import { domainService, requireCloudflare } from "./service.ts";

/** A detached claim is released this long after it was detached. */
export const HOLD_MS = 30 * 86_400_000;

/** Postgres unique_violation: SQLSTATE in `code` (PGlite) or `errno` (Bun's client). */
export const isUniqueViolation = (e: unknown): boolean => {
  const { code, errno } = e as { code?: unknown; errno?: unknown };
  return code === "23505" || errno === "23505";
};

/**
 * Claims `hostname` for the tenant's `app` and creates its Cloudflare custom
 * hostname. A new claim is pending. The owner's own detached claim is taken
 * back (moved to `app`) and re-checked at the next tick; any other existing
 * claim is 409. Without a Cloudflare configuration nothing is claimed and the
 * answer is 503; when Cloudflare refuses or does not answer, a new claim is
 * withdrawn and the answer is 503 too.
 */
export async function claimHostname(deps: Deps, tenantDb: Db & { tenantId: string }, app: string, hostname: string, now: number): Promise<DomainRow> {
  const cf = requireCloudflare(deps);
  const tenant = tenantDb.tenantId;
  let row: DomainRow;
  let fresh = false;
  try {
    row = await tenantDb.transaction(async (tx) => {
      const held = await crossTenant(tx, "a hostname is claimed by at most one tenant").query<{ tenant_id: string; state: string }>(
        "select tenant_id, state from domains where hostname = $1 and state <> 'released' for update",
        [hostname],
      );
      const h = held[0];
      // The same answer whoever holds the hostname: no owner is revealed.
      if (h !== undefined && h.tenant_id !== tenant) throw conflict("hostname", "not available");
      if (h !== undefined && h.state !== "detached") throw conflict("hostname", "already added");
      if (h !== undefined) {
        const rows = await tx.query(
          `update domains set app = $3, detach_reason = 'unverified', next_check_at = $4 where tenant_id = $1 and hostname = $2 and state = 'detached' returning ${DOMAIN_COLUMNS}`,
          [tenant, hostname, app, now],
        );
        return toDomain(rows[0] as Record<string, unknown>);
      }
      fresh = true;
      const rows = await tx.query(
        `insert into domains (id, hostname, tenant_id, app, state, created_at, next_check_at) values ($1, $2, $3, $4, 'pending', $5, $5) returning ${DOMAIN_COLUMNS}`,
        [newDomainId(now), hostname, tenant, app, now],
      );
      return toDomain(rows[0] as Record<string, unknown>);
    });
  } catch (e) {
    // A concurrent claim committed between the check and the insert.
    if (isUniqueViolation(e)) throw conflict("hostname", "not available");
    throw e;
  }
  if (row.cf_hostname_id !== null) return row;
  try {
    const h = await cf.create(hostname);
    await recordHostname(deps, tenantDb, row, h, now);
    return { ...row, cf_hostname_id: h.id, cf_status: h.status, cf_ssl_status: h.ssl_status, cf_verification: h.verification, cf_checked_at: now, last_checked_at: now };
  } catch (e) {
    deps.log.warn("cloudflare custom hostname not created", { domain: row.id, tenant_id: tenant, error: e instanceof CloudflareError ? e.message : String(e) });
    if (fresh) await tenantDb.query("delete from domains where tenant_id = $1 and id = $2 and state = 'pending' and cf_hostname_id is null", [tenant, row.id]);
    throw new ApiError("RENOX_UNAVAILABLE", [{ field: "hostname", reason: "the custom hostname could not be created; try again later" }], { retryAfter: 60 });
  }
}

/** A domain leaving `verified`: its entries go. */
export async function stopServing(deps: Deps, hostname: string): Promise<void> {
  await syncRoutes(deps, [hostname]);
}

/** A domain becoming `verified` again: its entries come back. */
export async function resumeServing(deps: Deps, hostname: string): Promise<void> {
  await syncRoutes(deps, [hostname]);
}

/**
 * Deletes a released claim's custom hostname at Cloudflare. A failure is
 * logged and retried by the job (the row keeps its id until it succeeds).
 */
export async function deleteHostname(deps: Deps, d: Pick<DomainRow, "id" | "cf_hostname_id">): Promise<boolean> {
  const cf = domainService(deps).cloudflare;
  if (d.cf_hostname_id === null) return true;
  if (cf === null) return false;
  try {
    await cf.delete(d.cf_hostname_id);
  } catch (e) {
    deps.log.warn("cloudflare custom hostname not deleted", { domain: d.id, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
  await jobDb(deps).query("update domains set cf_hostname_id = null where id = $1 and state = 'released'", [d.id]);
  return true;
}

/** An audit row written by the domain job (no request; actor `domain-job`). */
export async function auditJob(deps: Deps, d: DomainRow, action: string, extra: Record<string, string> = {}): Promise<void> {
  await writeAudit(jobDb(deps), {
    at: deps.now(),
    tenantId: d.tenant_id,
    actor: "domain-job",
    action,
    target: { app: d.app, hostname: d.hostname, ...extra },
    status: 200,
    requestId: `job_${ulid(deps.now())}`,
  }).catch((e: unknown) => deps.log.error("audit write failed", { action, error: String(e) }));
}

/** Releases detached claims held for HOLD_MS; their custom hostnames are deleted at Cloudflare. */
export async function releaseExpired(deps: Deps, now: number): Promise<number> {
  const db = jobDb(deps);
  const rows = (
    await db.query(`update domains set state = 'released', released_at = $1 where state = 'detached' and detached_at <= $2 returning ${DOMAIN_COLUMNS}`, [now, now - HOLD_MS])
  ).map(toDomain);
  for (const d of rows) {
    await deleteHostname(deps, d);
    await auditJob(deps, d, "releaseDomain", { reason: "held 30 days" });
  }
  // Released claims whose custom hostname could not be deleted before.
  const left = (await db.query(`select ${DOMAIN_COLUMNS} from domains where state = 'released' and cf_hostname_id is not null limit 20`)).map(toDomain);
  for (const d of left) await deleteHostname(deps, d);
  return rows.length;
}
