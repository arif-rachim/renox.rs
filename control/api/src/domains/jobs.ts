// The domain job (deploy-api.md 0.6 section 10; docs/05-tenant-lifecycle.md
// "Custom domains and DNS"; #419, ADR D25). main.ts runs `tick` every few
// seconds; tests call it with their own clock. One tick:
//
// 1. pending domains whose read is due: the Cloudflare custom hostname is
//    read; `active` (Cloudflare's ownership TXT found, the CNAME reaching the
//    fallback origin) moves the domain to verified (served from then on);
// 2. ownership (#114, reverify.ts and ownership.ts): verified domains whose
//    custom hostname keeps answering moved, deleted or blocked are detached,
//    detached ones that are active again are verified again, and detached
//    claims older than 30 days are released (their custom hostname deleted);
// 3. claims without a custom hostname (rows from before migration 0029, or a
//    hostname Cloudflare lost while pending) get one;
// 4. the route entries of every custom hostname are re-mirrored.
//
// Rows are claimed with a conditional update before any slow step, so two
// API instances never read the same domain at once. Certificates are
// Cloudflare's: nothing is ordered, stored or sent to nodes.

import type { Deps } from "../context.ts";
import type { Db } from "../db/db.ts";
import { CloudflareError } from "./cloudflare.ts";
import { DOMAIN_COLUMNS, jobDb, recordHostname, syncRoutes, toDomain, type DomainRow } from "./repo.ts";
import { releaseExpired } from "./ownership.ts";
import { claim, readHostname, REVERIFY_MS, reverify } from "./reverify.ts";
import { domainService } from "./service.ts";

/** How often a pending domain's custom hostname is read. */
export const PENDING_POLL_MS = 60_000;

async function due(db: Db, now: number): Promise<DomainRow[]> {
  const rows = await db.query(`select ${DOMAIN_COLUMNS} from domains where state = 'pending' and next_check_at <= $1 order by next_check_at limit 100`, [now]);
  return rows.map(toDomain);
}

async function checkPending(deps: Deps, db: Db, d: DomainRow, now: number): Promise<boolean> {
  if (!(await claim(db, d, now + PENDING_POLL_MS))) return false;
  const { verdict, answer } = await readHostname(deps, d, now);
  // Lost at Cloudflare while pending: step 3 creates it again.
  if (answer === null) await db.query("update domains set cf_hostname_id = null where id = $1 and state = 'pending'", [d.id]);
  if (verdict !== "match") return false;
  const verified = await db.query(
    "update domains set state = 'verified', verified_at = $2, last_checked_at = $2, next_check_at = $3, cf_misses = 0, cf_first_miss_at = null where id = $1 and state = 'pending' returning id",
    [d.id, now, now + REVERIFY_MS],
  );
  if (verified.length > 0) {
    deps.log.info("domain verified", { domain: d.id, tenant_id: d.tenant_id, app: d.app });
    // 0.12 (#826): the app's email `app_url` follows its verified domains.
    await syncRoutes(deps, [d.hostname], [d]);
  }
  return verified.length > 0;
}

/** Claims that are not released and have no custom hostname get one. */
async function ensureHostnames(deps: Deps, db: Db, now: number): Promise<void> {
  const cf = domainService(deps).cloudflare;
  if (cf === null) return;
  const rows = (
    await db.query(
      `select ${DOMAIN_COLUMNS} from domains where state <> 'released' and cf_hostname_id is null and coalesce(cf_checked_at, 0) <= $1 order by created_at limit 20`,
      [now - PENDING_POLL_MS],
    )
  ).map(toDomain);
  for (const d of rows) {
    // At most one attempt per poll interval and instance; cf_checked_at is the claim.
    const claimed = await db.query("update domains set cf_checked_at = $3 where id = $1 and cf_checked_at is not distinct from $2 returning id", [d.id, d.cf_checked_at, now]);
    if (claimed.length === 0) continue;
    try {
      await recordHostname(deps, db, d, await cf.create(d.hostname), now);
    } catch (e) {
      deps.log.warn("cloudflare custom hostname not created", { domain: d.id, error: e instanceof CloudflareError ? e.message : String(e) });
    }
  }
}

export interface TickResult {
  verified: number;
}

export async function tick(deps: Deps, now = deps.now()): Promise<TickResult> {
  const db = jobDb(deps);
  let verified = 0;
  for (const d of await due(db, now)) if (d.cf_hostname_id !== null && (await checkPending(deps, db, d, now))) verified++;
  await reverify(deps, now);
  await releaseExpired(deps, now);
  await ensureHostnames(deps, db, now);
  await syncRoutes(deps);
  return { verified };
}

/** main.ts: the job every `everyMs`. */
export function startDomainJobs(deps: Deps, everyMs = 5_000): void {
  if (domainService(deps).cloudflare === null) deps.log.warn("CONTROL_CF_API_TOKEN, CONTROL_CF_ZONE_ID or CONTROL_CF_FALLBACK_ORIGIN is not set: custom domains are not available (addDomain answers 503)");
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
