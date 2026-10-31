// Takedowns (#123; deploy-api.md 0.5 section 22): suspending a tenant for an
// abuse ticket (an operator's `taken_down`, or Safe Browsing at once), the
// owner's email with the reason, and the takedown SLA: a phishing or malware
// ticket is due 4 hours after it is reported, and one still `open` or
// `reviewing` past that is logged as an error once (the alert), with
// `sla_breached_at` set on the ticket.

import { writeAudit } from "../audit.ts";
import type { Deps } from "../context.ts";
import type { Db } from "../db/db.ts";
import { ulid } from "../ids.ts";
import { onTenantState } from "../routes/activation.ts";

export const SLA_MS = 4 * 3_600_000;
/** The reporter's address is kept 90 days (section 22). */
export const REPORTER_KEPT_MS = 90 * 86_400_000;
/** Categories with the 4-hour takedown SLA. */
export const SLA_CATEGORIES = ["phishing", "malware"];

export const slaDue = (category: string, reportedAt: number): number | null => (SLA_CATEGORIES.includes(category) ? reportedAt + SLA_MS : null);

/**
 * Suspends (or reinstates) the tenant's routes; the same path as
 * suspendTenant. A tenant already in that state is left as it is, so a
 * second takedown keeps the neutral page's entries.
 */
export async function setTenantState(deps: Deps, tenantId: string, state: "suspended" | "active", now: number): Promise<void> {
  await deps.db.transaction(async (tx: Db) => {
    const [t] = await tx.query<{ state: string }>("select state from tenants where id = $1 for update", [tenantId]);
    if (t === undefined || t.state === state) return;
    await tx.query("update tenants set state = $1 where id = $2", [state, tenantId]);
    await onTenantState(deps, tx, tenantId, state, now);
  });
}

/** Emails the owner that the tenant was taken down, with the reason; a mail failure is logged only. */
export async function mailOwner(deps: Deps, tenantId: string, hostname: string, reason: string): Promise<void> {
  const r = await deps.db.query<{ email: string }>("select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.role = 'owner' limit 1", [tenantId]);
  const to = r[0]?.email;
  if (to === undefined) return;
  await deps.mailer
    .send({
      to,
      kind: "abuse_takedown",
      subject: "Your Renox tenant was taken down after an abuse report",
      text: `Tenant ${tenantId} was taken down because of ${hostname}: ${reason}\nIts sites answer the suspension page; your data, deployments and the dashboard stay. To appeal, or once the site is fixed, reply to abuse@renox.app with the hostname.`,
    })
    .catch(() => deps.log.warn("takedown email not sent", { tenant_id: tenantId }));
}

/**
 * Safe Browsing said unsafe (phishing or malware): a ticket is opened and the
 * tenant taken down at once, then reviewed. Nothing happens when the hostname
 * already has a ticket `open`, `reviewing` or `taken_down`; an open one is
 * moved to `taken_down`. Answers the ticket id.
 */
export async function takeDownAtOnce(deps: Deps, t: { hostname: string; tenantId: string; category: "phishing" | "malware"; threats: string[]; now: number; ticketId?: string }): Promise<string> {
  const reason = `Safe Browsing reports ${t.threats.join(", ")}; taken down at once, to be reviewed`;
  const existing = t.ticketId === undefined
    ? (await deps.db.query<{ id: string; state: string }>("select id, state from abuse_tickets where hostname = $1 and state in ('open', 'reviewing', 'taken_down') order by reported_at limit 1", [t.hostname]))[0]
    : { id: t.ticketId, state: "open" };
  if (existing !== undefined && existing.state !== "open") return existing.id;
  const id = existing?.id ?? `abt_${ulid(t.now)}`;
  if (existing === undefined)
    await deps.db.query(
      "insert into abuse_tickets (id, hostname, tenant_id, category, description, reporter_email, state, safe_browsing, reported_at, updated_at, sla_due_at) values ($1, $2, $3, $4, $5, null, 'open', 'unsafe', $6, $6, $7)",
      [id, t.hostname, t.tenantId, t.category, `Safe Browsing: ${t.threats.join(", ")}`, t.now, slaDue(t.category, t.now)],
    );
  await setTenantState(deps, t.tenantId, "suspended", t.now);
  await deps.db.query("update abuse_tickets set state = 'taken_down', safe_browsing = 'unsafe', reason = $2, updated_at = $3 where id = $1", [id, reason, t.now]);
  await writeAudit(deps.db, {
    at: t.now,
    tenantId: t.tenantId,
    actor: "platform",
    action: "setAbuseTicket",
    target: { ticket: id, hostname: t.hostname, from: "open", to: "taken_down", reason },
    status: 200,
    requestId: `req_${ulid(t.now)}`,
  });
  await mailOwner(deps, t.tenantId, t.hostname, reason);
  return id;
}

/**
 * Every minute: a phishing or malware ticket past its SLA and still `open` or
 * `reviewing` is logged as an error once; reporters' addresses older than 90
 * days are deleted. Answers the tickets that breached in this run.
 */
export async function sweepAbuse(deps: Deps, now = deps.now()): Promise<string[]> {
  const late = await deps.db.query<{ id: string; hostname: string; tenant_id: string | null; category: string; sla_due_at: unknown }>(
    "update abuse_tickets set sla_breached_at = $1 where sla_due_at <= $1 and sla_breached_at is null and state in ('open', 'reviewing') returning id, hostname, tenant_id, category, sla_due_at",
    [now],
  );
  for (const t of late)
    deps.log.error("abuse takedown SLA missed", { ticket: t.id, hostname: t.hostname, tenant_id: t.tenant_id ?? "", category: t.category, overdue_ms: now - Number(t.sla_due_at) });
  await deps.db.query("update abuse_tickets set reporter_email = null where reporter_email is not null and reported_at <= $1", [now - REPORTER_KEPT_MS]);
  return late.map((t) => t.id);
}
