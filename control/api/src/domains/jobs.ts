// The domain job (deploy-api.md section 10; docs/05-tenant-lifecycle.md
// "Custom domains and DNS"). main.ts runs `tick` every few seconds; tests
// call it with their own clock. One tick:
//
// 1. pending domains whose check is due: the TXT record is looked up; a match
//    moves the domain to verified (served from then on);
// 2. verified domains whose check is due: whether the hostname still points
//    at the edge (`dns`: ok or not_pointing, the "stopped pointing" flag);
// 3. ownership (#114, reverify.ts and ownership.ts): verified domains whose
//    TXT record is gone are detached, detached ones whose record is back are
//    verified again, and detached claims older than 30 days are released;
// 4. the route entries of every custom hostname are re-mirrored;
// 5. certificates: a verified domain that points at the edge and has no
//    certificate, or one that expires within 30 days, gets an ACME order
//    after one more TXT check. Renewal is paused while the hostname does
//    not point at the edge, and a failed order is retried with backoff.
//
// Rows are claimed with a conditional update before any slow step, so two
// API instances never check or order the same domain at once.

import type { Deps } from "../context.ts";
import type { Db } from "../db/db.ts";
import { notAfterOf, storeCertificate } from "./certs.ts";
import { pointsAtEdge, txtMatches } from "./dns.ts";
import { DOMAIN_COLUMNS, jobDb, syncRoutes, toDomain, type DomainRow } from "./repo.ts";
import { releaseExpired } from "./ownership.ts";
import { reverify, txtBeforeOrder } from "./reverify.ts";
import { configureDomains, domainService, domainServiceFromEnv, listenCertificates, sendCertificateMessage } from "./service.ts";

/** How often a pending domain's TXT record is looked up. */
export const PENDING_POLL_MS = 60_000;
/** How often a verified domain's DNS is checked for pointing at the edge. */
export const DNS_CHECK_MS = 3_600_000;
/** Renewal starts this long before expiry. */
export const RENEW_BEFORE_MS = 30 * 86_400_000;
/** A certificate order that has not finished after this is tried again. */
export const ORDER_LEASE_MS = 10 * 60_000;
/** Retry after a failed order: 1 h, doubled per failure, at most 24 h (Let's Encrypt rate limits). */
export const retryAfterMs = (failures: number): number => Math.min(3_600_000 * 2 ** Math.max(0, failures - 1), 86_400_000);

async function due(db: Db, state: "pending" | "verified", now: number): Promise<DomainRow[]> {
  const rows = await db.query(`select ${DOMAIN_COLUMNS} from domains where state = $1 and next_check_at <= $2 order by next_check_at limit 100`, [state, now]);
  return rows.map(toDomain);
}

/** Moves next_check_at only if nobody else did; true when this caller owns the check. */
async function claim(db: Db, d: DomainRow, next: number): Promise<boolean> {
  return (await db.query("update domains set next_check_at = $3 where id = $1 and next_check_at = $2 returning id", [d.id, d.next_check_at, next])).length > 0;
}

async function checkPending(deps: Deps, db: Db, d: DomainRow, now: number): Promise<boolean> {
  if (!(await claim(db, d, now + PENDING_POLL_MS))) return false;
  const s = domainService(deps);
  let matched = false;
  try {
    matched = await txtMatches(s.resolver, d.hostname, d.verify_token);
  } catch (e) {
    deps.log.warn("domain TXT lookup failed", { domain: d.id, error: String(e) });
  }
  if (!matched) {
    await db.query("update domains set last_checked_at = $2 where id = $1", [d.id, now]);
    return false;
  }
  const verified = await db.query(
    "update domains set state = 'verified', verified_at = $2, last_checked_at = $2, next_check_at = $2 where id = $1 and state = 'pending' returning id",
    [d.id, now],
  );
  if (verified.length > 0) deps.log.info("domain verified", { domain: d.id, tenant_id: d.tenant_id, app: d.app });
  return verified.length > 0;
}

async function checkPointing(deps: Deps, db: Db, d: DomainRow, now: number): Promise<void> {
  if (!(await claim(db, d, now + DNS_CHECK_MS))) return;
  const s = domainService(deps);
  let points: boolean;
  try {
    points = await pointsAtEdge(s.resolver, d.hostname, s.edge);
  } catch (e) {
    // A failed lookup says nothing about where the name points.
    deps.log.warn("domain DNS lookup failed", { domain: d.id, error: String(e) });
    return;
  }
  const dns = points ? "ok" : d.dns === "pending" ? "pending" : "not_pointing";
  if (dns !== d.dns) deps.log.info(points ? "domain points at the edge" : "domain stopped pointing at the edge", { domain: d.id, tenant_id: d.tenant_id });
  await db.query("update domains set dns = $2 where id = $1 and state = 'verified'", [d.id, dns]);
}

/** Verified domains that point at the edge and need a certificate now. */
async function needingCertificates(db: Db, now: number): Promise<DomainRow[]> {
  const rows = await db.query(
    `select ${DOMAIN_COLUMNS.split(", ").map((c) => `d.${c}`).join(", ")} from domains d left join certificates c on c.hostname = d.hostname
     where d.state = 'verified' and d.dns = 'ok' and (d.cert_retry_at is null or d.cert_retry_at <= $1)
       and (c.hostname is null or c.not_after <= $2 or d.cert_state <> 'issued')
     order by d.verified_at limit 10`,
    [now, now + RENEW_BEFORE_MS],
  );
  return rows.map(toDomain);
}

async function order(deps: Deps, db: Db, d: DomainRow, now: number): Promise<void> {
  const s = domainService(deps);
  if (s.issuer === null || s.responder === null || s.keys === null) return;
  const claimed = await db.query(
    "update domains set cert_state = case when cert_state = 'issued' then 'issued' else 'issuing' end, cert_retry_at = $3 where id = $1 and state = 'verified' and coalesce(cert_retry_at, 0) = $2 returning id",
    [d.id, d.cert_retry_at ?? 0, now + ORDER_LEASE_MS],
  );
  if (claimed.length === 0) return;
  // deploy-api.md section 10: the TXT record is re-checked before every order (#114).
  if (!(await txtBeforeOrder(deps, d, now))) {
    await db.query("update domains set cert_retry_at = null, cert_state = case when cert_state = 'issuing' then 'none' else cert_state end where id = $1", [d.id]);
    return;
  }
  try {
    const issued = await s.issuer.issue(d.hostname, s.responder);
    const notAfter = notAfterOf(issued.chainPem);
    const at = deps.now();
    const version = await db.transaction(async (tx) => {
      const still = await tx.query("select 1 from domains where id = $1 and state = 'verified' for update", [d.id]);
      if (still.length === 0) return null;
      const v = await storeCertificate(tx, s.keys as NonNullable<typeof s.keys>, d.hostname, issued.chainPem, issued.keyPem, notAfter, at);
      await tx.query("update domains set cert_state = 'issued', cert_retry_at = null, cert_failures = 0 where id = $1", [d.id]);
      return v;
    });
    if (version === null) return;
    deps.log.info("certificate issued", { domain: d.id, hostname: d.hostname, version, not_after: notAfter });
    await sendCertificateMessage(deps, { type: "certificate_update", schema_version: 0, hostname: d.hostname, version, not_after: notAfter });
  } catch (e) {
    const failures = d.cert_failures + 1;
    deps.log.warn("certificate order failed", { domain: d.id, hostname: d.hostname, failures, error: e instanceof Error ? e.message : String(e) });
    await db.query(
      "update domains set cert_state = case when cert_state = 'issued' then 'issued' else 'failed' end, cert_failures = $2, cert_retry_at = $3 where id = $1",
      [d.id, failures, deps.now() + retryAfterMs(failures)],
    );
  }
}

export interface TickResult {
  verified: number;
}

export async function tick(deps: Deps, now = deps.now()): Promise<TickResult> {
  const db = jobDb(deps);
  let verified = 0;
  for (const d of await due(db, "pending", now)) if (await checkPending(deps, db, d, now)) verified++;
  for (const d of await due(db, "verified", now)) await checkPointing(deps, db, d, now);
  await reverify(deps, now);
  await releaseExpired(deps, now);
  await syncRoutes(deps);
  for (const d of await needingCertificates(db, now)) await order(deps, db, d, now);
  return { verified };
}

/** main.ts: the service from the environment, certificate messages from other instances, and the job every `everyMs`. */
export async function startDomainJobs(deps: Deps, everyMs = 5_000): Promise<void> {
  const s = configureDomains(deps, domainServiceFromEnv(deps));
  if (s.issuer === null) deps.log.warn("CONTROL_ACME_DIRECTORY_URL, CONTROL_ACME_CHALLENGE_DIR or CONTROL_MASTER_KEY is not set: custom domains get no certificates");
  await listenCertificates(deps);
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void tick(deps)
      .catch((e: unknown) => deps.log.error("domain job failed", { error: String(e) }))
      .finally(() => {
        running = false;
      });
  }, everyMs);
}
