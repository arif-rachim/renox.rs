// Domain rows, the API view, and the route entries of verified domains
// (deploy-api.md sections 8 and 10).
//
// A verified custom domain serves what `<app>.<platform domain>` serves: its
// route entries mirror the app's platform hostname entries (same deployment,
// status, node, tier and secret version). The mirror is recomputed after
// every domain state change and by the domain job, so an activation or a
// rollback reaches the custom domains within one job interval. A hostname
// that is not verified has no entry, so every node answers 404 for it
// (docs/23-failure-modes.md, "Unverified custom domain").

import { randomBytes } from "node:crypto";
import { num, numOrNull, type Db } from "../db/db.ts";
import { base32, ulid } from "../ids.ts";
import { invalid, notFound } from "../errors.ts";
import type { Deps } from "../context.ts";
import { entriesWhere, lockRoutes, removeEntry, upsertEntry, type RouteEntry } from "../routes/table.ts";
import { routeService } from "../routes/service.ts";
import { crossTenant } from "../tenancy/scope.ts";
import { verifyName } from "./dns.ts";

export type DomainState = "pending" | "verified" | "detached" | "released";
export type DnsState = "pending" | "ok" | "not_pointing";
export type CertState = "none" | "issuing" | "issued" | "failed";

export interface DomainRow {
  id: string;
  hostname: string;
  tenant_id: string;
  app: string;
  state: DomainState;
  verify_token: string;
  dns: DnsState;
  cert_state: CertState;
  created_at: number;
  verified_at: number | null;
  last_checked_at: number | null;
  next_check_at: number;
  cert_retry_at: number | null;
  cert_failures: number;
  detached_at: number | null;
  detach_reason: "removed" | "unverified" | null;
  txt_checked_at: number | null;
  next_txt_check_at: number | null;
}

export const DOMAIN_COLUMNS =
  "id, hostname, tenant_id, app, state, verify_token, dns, cert_state, created_at, verified_at, last_checked_at, next_check_at, cert_retry_at, cert_failures, detached_at, detach_reason, txt_checked_at, next_txt_check_at";

export function toDomain(r: Record<string, unknown>): DomainRow {
  return {
    id: r.id as string,
    hostname: r.hostname as string,
    tenant_id: r.tenant_id as string,
    app: r.app as string,
    state: r.state as DomainState,
    verify_token: r.verify_token as string,
    dns: r.dns as DnsState,
    cert_state: r.cert_state as CertState,
    created_at: num(r.created_at),
    verified_at: numOrNull(r.verified_at),
    last_checked_at: numOrNull(r.last_checked_at),
    next_check_at: num(r.next_check_at),
    cert_retry_at: numOrNull(r.cert_retry_at),
    cert_failures: Number(r.cert_failures ?? 0),
    detached_at: numOrNull(r.detached_at),
    detach_reason: (r.detach_reason ?? null) as DomainRow["detach_reason"],
    txt_checked_at: numOrNull(r.txt_checked_at),
    next_txt_check_at: numOrNull(r.next_txt_check_at),
  };
}

/** The platform's view of domains, for the domain job: every tenant's rows. */
export const jobDb = (deps: Deps): Db => crossTenant(deps.db, "the domain job checks and orders for every tenant's domains");

/** `rnx-verify-` and 26 random base32 characters (130 bits). */
export const newVerifyToken = (): string => `rnx-verify-${base32(randomBytes(17)).slice(0, 26)}`;

export const newDomainId = (now: number): string => `dom_${ulid(now).toLowerCase()}`;

/** A hostname of the platform domain belongs to an app, never to a custom domain. */
export function checkCustomHostname(hostname: string, platformDomain: string): void {
  if (hostname === platformDomain || hostname.endsWith(`.${platformDomain}`)) {
    throw invalid("hostname", `hostnames under ${platformDomain} are not custom domains`);
  }
}

/** The tenant's claim of `hostname` in `app` that is not released, or 404. */
export async function requireDomain(db: Db, tenantId: string, app: string, hostname: string, forUpdate = false): Promise<DomainRow> {
  const rows = await db.query(
    `select ${DOMAIN_COLUMNS} from domains where tenant_id = $1 and app = $2 and hostname = $3 and state <> 'released'${forUpdate ? " for update" : ""}`,
    [tenantId, app, hostname],
  );
  if (rows[0] === undefined) throw notFound();
  return toDomain(rows[0]);
}

export async function listDomains(db: Db, tenantId: string, app: string): Promise<DomainRow[]> {
  const rows = await db.query(`select ${DOMAIN_COLUMNS} from domains where tenant_id = $1 and app = $2 and state <> 'released' order by hostname`, [tenantId, app]);
  return rows.map(toDomain);
}

/** The `Domain` schema of the contract. */
export function domainView(d: DomainRow, notAfter: number | null): Record<string, unknown> {
  return {
    hostname: d.hostname,
    app: d.app,
    state: d.state,
    verification: { record_type: "TXT", record_name: verifyName(d.hostname), record_value: d.verify_token },
    dns: d.dns,
    certificate: { state: d.cert_state, not_after: d.cert_state === "none" ? null : notAfter },
    created_at: d.created_at,
    verified_at: d.verified_at,
    last_checked_at: d.last_checked_at,
  };
}

/** Views of `rows` with their certificates' expiry (one tenant's rows only). */
export async function domainViews(db: Db, tenantId: string, rows: DomainRow[]): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  const certs = await db.query<{ hostname: string; not_after: unknown }>(
    "select c.hostname, c.not_after from certificates c join domains d on d.hostname = c.hostname where d.tenant_id = $1 and d.state <> 'released' and c.hostname = any($2::text[])",
    [tenantId, rows.map((r) => r.hostname)],
  );
  const notAfter = new Map(certs.map((c) => [c.hostname, num(c.not_after)]));
  return rows.map((r) => domainView(r, notAfter.get(r.hostname) ?? null));
}

const same = (a: RouteEntry, b: Omit<RouteEntry, "version" | "updated_at">): boolean =>
  a.tenant_id === b.tenant_id && a.app === b.app && a.status === b.status && a.tier === b.tier && a.node_id === b.node_id && a.secrets_version === b.secrets_version;

/**
 * Makes the route entries of `hostname` mirror the platform hostname of the
 * app that holds it verified, or removes them. Caller holds the route lock.
 * Returns true when an entry changed.
 */
export async function syncHostnameRoutes(tx: Db, platformDomain: string, hostname: string, now: number): Promise<boolean> {
  const owner = (
    await tx.query<{ app: string; tenant_id: string }>("select app, tenant_id from domains where hostname = $1 and state = 'verified' limit 1", [hostname])
  )[0];
  const desired =
    owner === undefined
      ? []
      : (await entriesWhere(tx, "hostname = $1 and tenant_id = $2", [`${owner.app}.${platformDomain}`, owner.tenant_id])).map(({ version: _v, updated_at: _u, ...e }) => ({ ...e, hostname }));
  const current = await entriesWhere(tx, "hostname = $1", [hostname]);
  let changed = false;
  for (const e of current) {
    if (!desired.some((d) => d.deployment_hash === e.deployment_hash)) changed = (await removeEntry(tx, hostname, e.deployment_hash, now)) !== null || changed;
  }
  // Draining first, so the one-active-per-hostname index never sees two.
  for (const d of [...desired].sort((a, b) => (a.status === b.status ? 0 : a.status === "draining" ? -1 : 1))) {
    const existing = current.find((e) => e.deployment_hash === d.deployment_hash);
    if (existing !== undefined && same(existing, d)) continue;
    await upsertEntry(tx, { ...d, updated_at: now });
    changed = true;
  }
  return changed;
}

/** Hostnames whose entries may need a change: every claimed hostname and every custom hostname in the route table. */
async function customHostnames(tx: Db, platformDomain: string): Promise<string[]> {
  const rows = await tx.query<{ hostname: string }>(
    `select hostname from domains where state <> 'released'
     union select hostname from route_entries where hostname <> $1 and right(hostname, $2) <> $3`,
    [platformDomain, platformDomain.length + 1, `.${platformDomain}`],
  );
  return rows.map((r) => r.hostname).sort();
}

/** Re-mirrors `hostnames` (all custom hostnames when omitted) and publishes the delta. */
export async function syncRoutes(deps: Deps, hostnames?: string[]): Promise<boolean> {
  const now = deps.now();
  const platform = deps.config.platformDomain;
  const db = crossTenant(deps.db, "a custom hostname mirrors the route entries of whichever tenant holds it verified");
  const changed = await db.transaction(async (tx) => {
    await lockRoutes(tx);
    let any = false;
    for (const h of hostnames ?? (await customHostnames(tx, platform))) any = (await syncHostnameRoutes(tx, platform, h, now)) || any;
    return any;
  });
  if (changed) await routeService(deps).publisher.publish();
  return changed;
}
