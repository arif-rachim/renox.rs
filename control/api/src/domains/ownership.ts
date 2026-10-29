// Domain ownership (#114; docs/24-threat-model.md section C, "Custom domain
// takeover"; deploy-api.md section 10).
//
// A hostname is owned by at most one claim in any state but `released`
// (unique index `domains_one_owner`), so of two tenants racing for one
// hostname exactly one wins and the other gets 409 without the owner's
// name. A detached claim stays owned for 30 days, so a hostname whose CNAME
// still points at Renox after its tenant removed it cannot be taken over by
// another tenant in that window. Only its owner can claim it again (which
// re-verifies it) or release it at once.

import type { Deps } from "../context.ts";
import type { Db } from "../db/db.ts";
import { ulid } from "../ids.ts";
import { writeAudit } from "../audit.ts";
import { conflict } from "../errors.ts";
import { crossTenant } from "../tenancy/scope.ts";
import { deleteCertificate, loadCertificate, nextCertificateVersion, storeCertificate } from "./certs.ts";
import { DOMAIN_COLUMNS, jobDb, newDomainId, newVerifyToken, syncRoutes, toDomain, type DomainRow } from "./repo.ts";
import { domainService, sendCertificateMessage } from "./service.ts";

/** A detached claim is released this long after it was detached. */
export const HOLD_MS = 30 * 86_400_000;

/** Postgres unique_violation: SQLSTATE in `code` (PGlite) or `errno` (Bun's client). */
export const isUniqueViolation = (e: unknown): boolean => {
  const { code, errno } = e as { code?: unknown; errno?: unknown };
  return code === "23505" || errno === "23505";
};

/**
 * Claims `hostname` for the tenant's `app`. A new claim is pending. The
 * owner's own detached claim is taken back (moved to `app`) and re-verified
 * by the job; any other existing claim is 409.
 */
export async function claimHostname(tenantDb: Db & { tenantId: string }, app: string, hostname: string, now: number): Promise<DomainRow> {
  const tenant = tenantDb.tenantId;
  try {
    return await tenantDb.transaction(async (tx) => {
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
          `update domains set app = $3, detach_reason = 'unverified', next_txt_check_at = $4 where tenant_id = $1 and hostname = $2 and state = 'detached' returning ${DOMAIN_COLUMNS}`,
          [tenant, hostname, app, now],
        );
        return toDomain(rows[0] as Record<string, unknown>);
      }
      const rows = await tx.query(
        `insert into domains (id, hostname, tenant_id, app, state, verify_token, created_at, next_check_at) values ($1, $2, $3, $4, 'pending', $5, $6, $6) returning ${DOMAIN_COLUMNS}`,
        [newDomainId(now), hostname, tenant, app, newVerifyToken(), now],
      );
      return toDomain(rows[0] as Record<string, unknown>);
    });
  } catch (e) {
    // A concurrent claim committed between the check and the insert.
    if (isUniqueViolation(e)) throw conflict("hostname", "not available");
    throw e;
  }
}

/** Side effects of a domain leaving `verified`: its entries go, and nodes drop its certificate. */
export async function stopServing(deps: Deps, hostname: string): Promise<void> {
  await syncRoutes(deps, [hostname]);
  const db = crossTenant(deps.db, "a certificate belongs to a hostname, whichever tenant held it");
  const has = await db.query("select 1 from certificates where hostname = $1", [hostname]);
  if (has.length > 0) await sendCertificateMessage(deps, { type: "certificate_remove", schema_version: 0, hostname, version: await nextCertificateVersion(db) });
}

/**
 * Side effects of a domain becoming `verified` again: its entries come back,
 * and a stored certificate is announced again under a new version (newer
 * than the `certificate_remove` nodes saw), or ordered by the next tick.
 */
export async function resumeServing(deps: Deps, hostname: string): Promise<void> {
  await syncRoutes(deps, [hostname]);
  const keys = domainService(deps).keys;
  if (keys === null) return;
  const db = crossTenant(deps.db, "a certificate belongs to a hostname, whichever tenant held it");
  const cert = await loadCertificate(db, keys, hostname);
  if (cert === null || cert.not_after <= deps.now()) return;
  const version = await storeCertificate(db, keys, hostname, cert.chain_pem, cert.key_pem, cert.not_after, deps.now());
  await sendCertificateMessage(deps, { type: "certificate_update", schema_version: 0, hostname, version, not_after: cert.not_after });
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

/** Releases detached claims held for HOLD_MS; their certificates are deleted. */
export async function releaseExpired(deps: Deps, now: number): Promise<number> {
  const db = jobDb(deps);
  const rows = (
    await db.query(`update domains set state = 'released', released_at = $1 where state = 'detached' and detached_at <= $2 returning ${DOMAIN_COLUMNS}`, [now, now - HOLD_MS])
  ).map(toDomain);
  for (const d of rows) {
    await deleteCertificate(db, d.hostname);
    await auditJob(deps, d, "releaseDomain", { reason: "held 30 days" });
  }
  return rows.length;
}
