// Re-verification of domain ownership (#114; deploy-api.md section 10;
// docs/05-tenant-lifecycle.md "Custom domains and DNS", Security): the TXT
// record must stay in place. It is re-checked every 7 days and before every
// certificate order. A missing record moves the domain `verified` ->
// `detached` (serving stops, the owners are emailed, an audit row is
// written); while detached for that reason it is checked every hour, and a
// match moves it back to `verified` (serving resumes, audited). A failed
// lookup is not a missing record: it is retried within the hour and changes
// nothing.

import type { Deps } from "../context.ts";
import type { Db } from "../db/db.ts";
import { txtMatches } from "./dns.ts";
import { auditJob, resumeServing, stopServing } from "./ownership.ts";
import { DOMAIN_COLUMNS, jobDb, toDomain, type DomainRow } from "./repo.ts";
import { domainService } from "./service.ts";

/** How often a verified domain's TXT record is re-checked. */
export const REVERIFY_MS = 7 * 86_400_000;
/** How often a domain detached by a failed check, or a failed lookup, is checked again. */
export const RECHECK_MS = 3_600_000;

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
    "update domains set state = 'detached', detach_reason = 'unverified', detached_at = $2, next_txt_check_at = $3, last_checked_at = $2 where id = $1 and state = 'verified' returning id",
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
       next_txt_check_at = $3, last_checked_at = $2, next_check_at = $2 where id = $1 and state = 'detached' and detach_reason = 'unverified' returning id`,
    [d.id, now, now + REVERIFY_MS],
  );
  if (rows.length === 0) return;
  deps.log.info("domain verified again", { domain: d.id, tenant_id: d.tenant_id, hostname: d.hostname });
  await resumeServing(deps, d.hostname);
  await auditJob(deps, d, "reverifyDomain", { reason: "txt record found" });
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
    if (found === true) await db.query("update domains set txt_checked_at = $2, last_checked_at = $2 where id = $1", [d.id, now]);
    else if (found === false) await detachUnverified(deps, d, now);
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

/** Before every certificate order: true only when the record is there; a missing record detaches the domain. */
export async function txtBeforeOrder(deps: Deps, d: DomainRow, now: number): Promise<boolean> {
  const found = await txtState(deps, d);
  if (found === true) await jobDb(deps).query("update domains set txt_checked_at = $2 where id = $1", [d.id, now]);
  if (found === false) await detachUnverified(deps, d, now);
  return found === true;
}
