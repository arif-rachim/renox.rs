// The status poll of verified and detached domains (#114, #419; deploy-api.md
// 0.6 section 10; docs/05-tenant-lifecycle.md "Custom domains and DNS"). The
// custom hostname is read from Cloudflare every hour. `active` is a match.
// `moved`, `deleted`, `blocked` (and the pending forms of the last two) or
// "not found" is a miss: the customer's CNAME no longer reaches us, or the
// hostname is gone. A verified domain is detached (serving stops, the owners
// are emailed, an audit row is written) only after DETACH_MISSES consecutive
// misses spread over at least DETACH_GRACE_MS; a miss below that threshold
// re-checks after MISS_RECHECK_MS and a match resets the count. One negative
// answer never detaches (the lesson of #398, kept for the poll). An API error,
// a timeout or any other status is unknown: it is not a miss, changes nothing
// and is retried within the hour. A domain detached for misses is read every
// hour, and `active` moves it back to `verified` (serving resumes, audited).
// The owner's `POST …/domains` on their own detached claim forces a read at
// the next tick (ownership.ts, claimHostname).

import type { Deps } from "../context.ts";
import { num, type Db } from "../db/db.ts";
import type { CustomHostname } from "./cloudflare.ts";
import { auditJob, resumeServing, stopServing } from "./ownership.ts";
import { DOMAIN_COLUMNS, jobDb, recordHostname, toDomain, type DomainRow } from "./repo.ts";
import { domainService } from "./service.ts";

/** How often a verified domain's custom hostname is read. */
export const REVERIFY_MS = 3_600_000;
/** How often a domain detached by misses, or one whose read failed, is read again. */
export const RECHECK_MS = 3_600_000;
/** Consecutive misses before a verified domain is detached (#398). */
export const DETACH_MISSES = 3;
/** The misses must span at least this long: first miss to the detaching one. */
export const DETACH_GRACE_MS = 30 * 60_000;
/** After a miss that does not detach, the hostname is read again this soon. */
export const MISS_RECHECK_MS = 15 * 60_000;

/** Statuses that mean the hostname is served by us. */
const ACTIVE = new Set(["active", "active_redeploying"]);
/** Statuses that mean it is not, and will not be without the customer acting. */
const NEGATIVE = new Set(["moved", "deleted", "blocked", "pending_deletion", "pending_blocked"]);

export type Verdict = "match" | "miss" | "unknown";

/** A Cloudflare answer as the poll reads it (null: the custom hostname does not exist). */
export function verdictOf(h: CustomHostname | null): Verdict {
  if (h === null) return "miss";
  if (ACTIVE.has(h.status)) return "match";
  return NEGATIVE.has(h.status) ? "miss" : "unknown";
}

/**
 * Reads the custom hostname. `answer` is undefined when Cloudflare did not
 * answer (an error, a timeout, no configuration): unknown, never a miss.
 */
export async function readHostname(deps: Deps, d: DomainRow, now: number): Promise<{ verdict: Verdict; answer?: CustomHostname | null }> {
  const cf = domainService(deps).cloudflare;
  if (cf === null || d.cf_hostname_id === null) return { verdict: "unknown" };
  let answer: CustomHostname | null;
  try {
    answer = await cf.get(d.cf_hostname_id);
  } catch (e) {
    deps.log.warn("cloudflare custom hostname read failed", { domain: d.id, error: e instanceof Error ? e.message : String(e) });
    return { verdict: "unknown" };
  }
  if (answer !== null) await recordHostname(deps, jobDb(deps), d, answer, now);
  else await jobDb(deps).query("update domains set cf_status = 'deleted', cf_checked_at = $2, last_checked_at = $2 where id = $1", [d.id, now]);
  return { verdict: verdictOf(answer), answer };
}

async function notifyOwners(deps: Deps, db: Db, d: DomainRow, status: string): Promise<void> {
  const owners = await db.query<{ email: string }>(
    "select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.role in ('owner', 'admin') order by u.email",
    [d.tenant_id],
  );
  for (const { email } of owners) {
    try {
      await deps.mailer.send({
        to: email,
        kind: "domain_detached",
        subject: `${d.hostname} is no longer served by Renoxium`,
        text: `Cloudflare reports ${d.hostname} as "${status}": its CNAME no longer points at our edge, so ${d.hostname} (app ${d.app}, tenant ${d.tenant_id}) is no longer served.\n\nPoint it at the CNAME target shown in the dashboard again within 30 days and the domain is served again within the hour. After 30 days the hostname is released and anyone can claim it.`,
      });
    } catch (e) {
      deps.log.error("mail send failed", { kind: "domain_detached", error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** verified -> detached because Cloudflare keeps reporting it is not ours any more. */
export async function detachUnverified(deps: Deps, d: DomainRow, now: number, status: string): Promise<void> {
  const db = jobDb(deps);
  const rows = await db.query(
    "update domains set state = 'detached', detach_reason = 'unverified', detached_at = $2, next_check_at = $3, cf_misses = 0, cf_first_miss_at = null where id = $1 and state = 'verified' returning id",
    [d.id, now, now + RECHECK_MS],
  );
  if (rows.length === 0) return;
  deps.log.warn("domain detached: custom hostname not active", { domain: d.id, tenant_id: d.tenant_id, hostname: d.hostname, status });
  await stopServing(deps, d.hostname);
  await auditJob(deps, d, "detachDomain", { reason: `cloudflare status ${status}` });
  await notifyOwners(deps, db, d, status);
}

/** detached (unverified) -> verified because the custom hostname is active again. */
async function reattach(deps: Deps, d: DomainRow, now: number): Promise<void> {
  const rows = await jobDb(deps).query(
    `update domains set state = 'verified', detach_reason = null, detached_at = null, verified_at = coalesce(verified_at, $2),
       next_check_at = $3, cf_misses = 0, cf_first_miss_at = null where id = $1 and state = 'detached' and detach_reason = 'unverified' returning id`,
    [d.id, now, now + REVERIFY_MS],
  );
  if (rows.length === 0) return;
  deps.log.info("domain verified again", { domain: d.id, tenant_id: d.tenant_id, hostname: d.hostname });
  await resumeServing(deps, d.hostname);
  await auditJob(deps, d, "reverifyDomain", { reason: "cloudflare status active" });
}

/**
 * A miss of a verified domain. Detached when this miss is the DETACH_MISSES-th
 * in a row and the run spans DETACH_GRACE_MS; otherwise counted and read again
 * after MISS_RECHECK_MS. Returns whether the domain was detached.
 */
export async function recordMiss(deps: Deps, d: DomainRow, now: number, status: string): Promise<boolean> {
  const db = jobDb(deps);
  const rows = await db.query<{ cf_misses: unknown; cf_first_miss_at: unknown }>(
    "update domains set cf_misses = cf_misses + 1, cf_first_miss_at = coalesce(cf_first_miss_at, $2) where id = $1 and state = 'verified' returning cf_misses, cf_first_miss_at",
    [d.id, now],
  );
  const row = rows[0];
  if (row === undefined) return false;
  const misses = num(row.cf_misses);
  const since = num(row.cf_first_miss_at);
  if (misses >= DETACH_MISSES && now - since >= DETACH_GRACE_MS) {
    await detachUnverified(deps, d, now, status);
    return true;
  }
  const next = Math.max(now + MISS_RECHECK_MS, misses + 1 >= DETACH_MISSES ? since + DETACH_GRACE_MS : 0);
  await db.query("update domains set next_check_at = $2 where id = $1 and state = 'verified'", [d.id, next]);
  deps.log.warn("domain custom hostname not active", { domain: d.id, tenant_id: d.tenant_id, hostname: d.hostname, status, misses, of: DETACH_MISSES });
  return false;
}

/** Moves next_check_at only if nobody else did; true when this caller owns the read. */
export async function claim(db: Db, d: DomainRow, next: number): Promise<boolean> {
  return (await db.query("update domains set next_check_at = $3 where id = $1 and next_check_at = $2 returning id", [d.id, d.next_check_at, next])).length > 0;
}

/** The tick step: due reads of verified domains and of domains detached for misses. */
export async function reverify(deps: Deps, now: number): Promise<void> {
  const db = jobDb(deps);
  const verified = (await db.query(`select ${DOMAIN_COLUMNS} from domains where state = 'verified' and next_check_at <= $1 order by next_check_at limit 100`, [now])).map(toDomain);
  for (const d of verified) {
    if (!(await claim(db, d, now + REVERIFY_MS))) continue;
    const { verdict, answer } = await readHostname(deps, d, now);
    if (verdict === "match") await db.query("update domains set cf_misses = 0, cf_first_miss_at = null where id = $1 and state = 'verified'", [d.id]);
    else if (verdict === "miss") await recordMiss(deps, d, now, answer?.status ?? "deleted");
    else await db.query("update domains set next_check_at = $2 where id = $1 and state = 'verified'", [d.id, now + RECHECK_MS]);
  }
  const detached = (
    await db.query(`select ${DOMAIN_COLUMNS} from domains where state = 'detached' and detach_reason = 'unverified' and next_check_at <= $1 order by next_check_at limit 100`, [now])
  ).map(toDomain);
  for (const d of detached) {
    if (!(await claim(db, d, now + RECHECK_MS))) continue;
    if ((await readHostname(deps, d, now)).verdict === "match") await reattach(deps, d, now);
  }
}
