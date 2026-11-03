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

import { num, numOrNull, type Db } from "../db/db.ts";
import { ulid } from "../ids.ts";
import { invalid, notFound } from "../errors.ts";
import type { Deps } from "../context.ts";
import { entriesWhere, lockRoutes, removeEntry, upsertEntry, type RouteEntry } from "../routes/table.ts";
import { routeService } from "../routes/service.ts";
import { crossTenant } from "../tenancy/scope.ts";
import type { CustomHostname, VerificationRecord } from "./cloudflare.ts";

export type DomainState = "pending" | "verified" | "detached" | "released";

export interface DomainRow {
  id: string;
  hostname: string;
  tenant_id: string;
  app: string;
  state: DomainState;
  created_at: number;
  verified_at: number | null;
  last_checked_at: number | null;
  /** When the job reads this row's custom hostname next. */
  next_check_at: number;
  detached_at: number | null;
  detach_reason: "removed" | "unverified" | null;
  /** The Cloudflare custom hostname (#419); null until it is created. */
  cf_hostname_id: string | null;
  cf_status: string;
  cf_ssl_status: string;
  cf_verification: VerificationRecord[];
  cf_checked_at: number | null;
  /** Consecutive negative answers for a verified domain (#398 rule). */
  cf_misses: number;
  cf_first_miss_at: number | null;
}

export const DOMAIN_COLUMNS =
  "id, hostname, tenant_id, app, state, created_at, verified_at, last_checked_at, next_check_at, detached_at, detach_reason, cf_hostname_id, cf_status, cf_ssl_status, cf_verification, cf_checked_at, cf_misses, cf_first_miss_at";

const records = (v: unknown): VerificationRecord[] => {
  const parsed = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(parsed) ? (parsed as VerificationRecord[]) : [];
};

export function toDomain(r: Record<string, unknown>): DomainRow {
  return {
    id: r.id as string,
    hostname: r.hostname as string,
    tenant_id: r.tenant_id as string,
    app: r.app as string,
    state: r.state as DomainState,
    created_at: num(r.created_at),
    verified_at: numOrNull(r.verified_at),
    last_checked_at: numOrNull(r.last_checked_at),
    next_check_at: num(r.next_check_at),
    detached_at: numOrNull(r.detached_at),
    detach_reason: (r.detach_reason ?? null) as DomainRow["detach_reason"],
    cf_hostname_id: (r.cf_hostname_id ?? null) as string | null,
    cf_status: (r.cf_status ?? "unknown") as string,
    cf_ssl_status: (r.cf_ssl_status ?? "unknown") as string,
    cf_verification: records(r.cf_verification),
    cf_checked_at: numOrNull(r.cf_checked_at),
    cf_misses: numOrNull(r.cf_misses) ?? 0,
    cf_first_miss_at: numOrNull(r.cf_first_miss_at),
  };
}

/**
 * Stores what Cloudflare reported for a row's custom hostname (bound to the
 * row's tenant). A released claim of the same hostname whose deletion at
 * Cloudflare failed gives its id up first: Cloudflare answered the new claim
 * with the same custom hostname.
 */
export async function recordHostname(deps: Deps, db: Db, d: Pick<DomainRow, "id" | "tenant_id">, h: CustomHostname, now: number): Promise<void> {
  await jobDb(deps).query("update domains set cf_hostname_id = null where cf_hostname_id = $1 and state = 'released'", [h.id]);
  await db.query(
    "update domains set cf_hostname_id = $3, cf_status = $4, cf_ssl_status = $5, cf_verification = $6::jsonb, cf_errors = $7::jsonb, cf_checked_at = $8, last_checked_at = $8 where tenant_id = $1 and id = $2",
    [d.tenant_id, d.id, h.id, h.status, h.ssl_status, JSON.stringify(h.verification), JSON.stringify(h.errors), now],
  );
}

/** The platform's view of domains, for the domain job: every tenant's rows. */
export const jobDb = (deps: Deps): Db => crossTenant(deps.db, "the domain job reads every tenant's custom hostnames at Cloudflare");

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

/** The `Domain` schema of the contract (deploy-api.md 0.6 section 10). */
export function domainView(d: DomainRow, cnameTarget: string): Record<string, unknown> {
  return {
    hostname: d.hostname,
    app: d.app,
    state: d.state,
    status: d.cf_status,
    ssl_status: d.cf_ssl_status,
    cname_target: cnameTarget,
    verification: d.cf_verification,
    created_at: d.created_at,
    verified_at: d.verified_at,
    last_checked_at: d.last_checked_at,
  };
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
