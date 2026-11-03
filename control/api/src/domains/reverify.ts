// Re-verification of domain ownership (#114; deploy-api.md section 10;
// docs/05-tenant-lifecycle.md "Custom domains and DNS", Security): the TXT
// record must stay in place. It is re-checked every 7 days and before every
// certificate order. A missing record moves the domain `verified` ->
// `detached` (serving stops, the owners are emailed, an audit row is
// written), but only after DETACH_MISSES consecutive misses spread over at
// least DETACH_GRACE_MS (#398): one negative answer is often a resolver's
// negative cache of an NXDOMAIN from before the record existed. A miss below
// that threshold re-checks after MISS_RECHECK_MS; a match resets the count.
// While detached for that reason the domain is checked every hour, and a
// match moves it back to `verified` (serving resumes, audited). A failed
// lookup is not a missing record: it is retried within the hour and changes
// nothing. The owner's `POST …/domains` on their own detached claim forces a
// check at the next tick (ownership.ts, claimHostname).

import type { Deps } from "../context.ts";
import { num, type Db } from "../db/db.ts";
import { txtMatches } from "./dns.ts";
import { auditJob, resumeServing, stopServing } from "./ownership.ts";
import { DOMAIN_COLUMNS, jobDb, toDomain, type DomainRow } from "./repo.ts";
import { domainService } from "./service.ts";

/** How often a verified domain's TXT record is re-checked. */
export const REVERIFY_MS = 7 * 86_400_000;
/** How often a domain detached by a failed check, or a failed lookup, is checked again. */
export const RECHECK_MS = 3_600_000;
/** Consecutive TXT misses before a verified domain is detached (#398). */
export const DETACH_MISSES = 3;
/** The misses must span at least this long: first miss to the detaching one. */
export const DETACH_GRACE_MS = 30 * 60_000;
/** After a miss that does not detach, the record is checked again this soon. */
export const MISS_RECHECK_MS = 15 * 60_000;
/** The pre-order check is skipped when the record was seen (or verified) this recently. */
export const FRESH_TXT_MS = 15 * 60_000;

/** true: the record is there; false: it is not; null: the lookup failed. */
async function txtState(deps: Deps, d: DomainRow): Promise<boolean | null> {
  try {
    return await txtMatches(domainService(deps).resolver, d.hostname, d.verify_token);
  } catch (e) {
    deps.log.warn("domain TXT lookup failed", { domain: d.id, error: String(e) });
    return null;
  }
}

async function notifyOwners(deps: Deps, db: Db, d: DomainRow): Promise<void> {
  const owners = await db.query<{ email: string }>(
    "select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.role in ('owner', 'admin') order by u.email",
    [d.tenant_id],
  );
  for (const { email } of owners) {
    try {
      await deps.mailer.send({
        to: email,
        kind: "domain_detached",
        subject: `${d.hostname} is no longer served by Renox`,
        text: `The TXT record _renox-verify.${d.hostname} = ${d.verify_token} was not found, so ${d.hostname} (app ${d.app}, tenant ${d.tenant_id}) is no longer served.\n\nPut the record back within 30 days and the domain is served again within the hour. After 30 days the hostname is released and anyone can claim it.`,
      });
    } catch (e) {
      deps.log.error("mail send failed", { kind: "domain_detached", error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** verified -> detached because the record is gone. */
export async function detachUnverified(deps: Deps, d: DomainRow, now: number): Promise<void> {
  const db = jobDb(deps);
  const rows = await db.query(
    "update domains set state = 'detached', detach_reason = 'unverified', detached_at = $2, next_txt_check_at = $3, last_checked_at = $2, txt_misses = 0, txt_first_miss_at = null where id = $1 and state = 'verified' returning id",
    [d.id, now, now + RECHECK_MS],
  );
  if (rows.length === 0) return;
  deps.log.warn("domain detached: TXT record missing", { domain: d.id, tenant_id: d.tenant_id, hostname: d.hostname });
  await stopServing(deps, d.hostname);
  await auditJob(deps, d, "detachDomain", { reason: "txt record missing" });
  await notifyOwners(deps, db, d);
}

/** detached (unverified) -> verified because the record is back. */
async function reattach(deps: Deps, d: DomainRow, now: number): Promise<void> {
  const rows = await jobDb(deps).query(
    `update domains set state = 'verified', detach_reason = null, detached_at = null, verified_at = coalesce(verified_at, $2), txt_checked_at = $2,
       next_txt_check_at = $3, last_checked_at = $2, next_check_at = $2, txt_misses = 0, txt_first_miss_at = null where id = $1 and state = 'detached' and detach_reason = 'unverified' returning id`,
    [d.id, now, now + REVERIFY_MS],
  );
  if (rows.length === 0) return;
  deps.log.info("domain verified again", { domain: d.id, tenant_id: d.tenant_id, hostname: d.hostname });
  await resumeServing(deps, d.hostname);
  await auditJob(deps, d, "reverifyDomain", { reason: "txt record found" });
}

/** The record is there: the miss run, if any, ends. */
async function recordMatch(deps: Deps, d: DomainRow, now: number): Promise<void> {
  await jobDb(deps).query("update domains set txt_checked_at = $2, last_checked_at = $2, txt_misses = 0, txt_first_miss_at = null where id = $1 and state = 'verified'", [d.id, now]);
}

/**
 * The record was not found. The domain is detached when this miss is the
 * DETACH_MISSES-th in a row and the run spans DETACH_GRACE_MS; otherwise the
 * miss is counted and the record checked again after MISS_RECHECK_MS.
 * Returns whether the domain was detached.
 */
export async function recordMiss(deps: Deps, d: DomainRow, now: number): Promise<boolean> {
  const db = jobDb(deps);
  const rows = await db.query<{ txt_misses: unknown; txt_first_miss_at: unknown }>(
    `update domains set txt_misses = txt_misses + 1, txt_first_miss_at = coalesce(txt_first_miss_at, $2), last_checked_at = $2
     where id = $1 and state = 'verified' returning txt_misses, txt_first_miss_at`,
    [d.id, now],
  );
  const row = rows[0];
  if (row === undefined) return false;
  const misses = num(row.txt_misses);
  const since = num(row.txt_first_miss_at);
  if (misses >= DETACH_MISSES && now - since >= DETACH_GRACE_MS) {
    await detachUnverified(deps, d, now);
    return true;
  }
  const next = Math.max(now + MISS_RECHECK_MS, misses + 1 >= DETACH_MISSES ? since + DETACH_GRACE_MS : 0);
  await db.query("update domains set next_txt_check_at = least(coalesce(next_txt_check_at, $2), $2) where id = $1 and state = 'verified'", [d.id, next]);
  deps.log.warn("domain TXT record not found", { domain: d.id, tenant_id: d.tenant_id, hostname: d.hostname, misses, of: DETACH_MISSES });
  return false;
}

/** Moves next_txt_check_at only if nobody else did. */
async function claim(db: Db, d: DomainRow, next: number): Promise<boolean> {
  return (await db.query("update domains set next_txt_check_at = $3 where id = $1 and next_txt_check_at is not distinct from $2 returning id", [d.id, d.next_txt_check_at, next])).length > 0;
}

/** The tick step: due re-checks of verified domains and of domains detached for a missing record. */
export async function reverify(deps: Deps, now: number): Promise<void> {
  const db = jobDb(deps);
  const verified = (
    await db.query(
      `select ${DOMAIN_COLUMNS} from domains where state = 'verified' and coalesce(next_txt_check_at, verified_at + $2) <= $1 order by verified_at limit 100`,
      [now, REVERIFY_MS],
    )
  ).map(toDomain);
  for (const d of verified) {
    if (!(await claim(db, d, now + REVERIFY_MS))) continue;
    const found = await txtState(deps, d);
    if (found === true) await recordMatch(deps, d, now);
    else if (found === false) await recordMiss(deps, d, now);
    else await db.query("update domains set next_txt_check_at = $2 where id = $1", [d.id, now + RECHECK_MS]);
  }
  const detached = (
    await db.query(`select ${DOMAIN_COLUMNS} from domains where state = 'detached' and detach_reason = 'unverified' and next_txt_check_at <= $1 order by next_txt_check_at limit 100`, [now])
  ).map(toDomain);
  for (const d of detached) {
    if (!(await claim(db, d, now + RECHECK_MS))) continue;
    if ((await txtState(deps, d)) === true) await reattach(deps, d, now);
    else await db.query("update domains set last_checked_at = $2 where id = $1", [d.id, now]);
  }
}

/**
 * Before every certificate order: true when the record is there, or was seen
 * (or verified) less than FRESH_TXT_MS ago, which skips the lookup (#398:
 * the order follows verification by one tick). A miss counts towards
 * detaching (recordMiss) and blocks this order only.
 */
export async function txtBeforeOrder(deps: Deps, d: DomainRow, now: number): Promise<boolean> {
  const seen = Math.max(d.txt_checked_at ?? 0, d.verified_at ?? 0);
  if (d.txt_misses === 0 && now - seen < FRESH_TXT_MS) return true;
  const found = await txtState(deps, d);
  if (found === true) await recordMatch(deps, d, now);
  if (found === false) await recordMiss(deps, d, now);
  return found === true;
}
