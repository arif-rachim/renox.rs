// Break-glass impersonation (#310; deploy-api.md 0.4 section 17;
// docs/24-threat-model.md G "Operator reads tenant data";
// ops/security/access-review.md). An operator with a token holding
// `ops:impersonate` (granted by nothing else, not even the bootstrap token)
// and a reason gets a read-only tenant token for 60 minutes. Every start and
// end is an audit row with the reason; the tenant owner is emailed at both;
// every request made with the token is audited as the operator's
// (src/auth/middleware.ts); `getOpsTenant` lists the active ones first.

import type { Hono } from "hono";
import { operation, writeAudit } from "../audit.ts";
import { createTenantToken } from "../auth/tokens.ts";
import type { MailKind } from "../auth/mailer.ts";
import type { Deps, Env } from "../context.ts";
import { num, type Db } from "../db/db.ts";
import { conflict, notFound } from "../errors.ts";
import { jsonBody, pathParam } from "../http.ts";
import { ulid } from "../ids.ts";
import { accountRef, operatorOf, opsAuth } from "./auth.ts";

/** deploy-api.md 0.4 section 17: the time box, not extended. */
export const TIME_BOX_MS = 3_600_000;
export const READ_SCOPES = ["apps:read", "logs:read", "secrets:read"] as const;
/** The name prefix of an impersonation's tenant token (the middleware looks these up). */
export const TOKEN_PREFIX = "break-glass ";

export interface Impersonation {
  impersonation_id: string;
  tenant_id: string;
  operator: string;
  reason: string;
  scopes: string[];
  started_at: number;
  expires_at: number;
  ended_at: number | null;
}

type Row = {
  id: string;
  tenant_id: string;
  operator: string;
  reason: string;
  scopes: string[] | string;
  token_id: string;
  audit_id: string;
  started_at: unknown;
  expires_at: unknown;
  ended_at: unknown;
} & Record<string, unknown>;

const view = (r: Row): Impersonation => ({
  impersonation_id: r.id,
  tenant_id: r.tenant_id,
  operator: accountRef(r.operator),
  reason: r.reason,
  scopes: typeof r.scopes === "string" ? (JSON.parse(r.scopes) as string[]) : r.scopes,
  started_at: num(r.started_at),
  expires_at: num(r.expires_at),
  ended_at: r.ended_at === null ? null : num(r.ended_at),
});

/** Active impersonations of `tenantId`, newest first, for getOpsTenant's actions. */
export async function activeImpersonations(db: Db, tenantId: string, now: number): Promise<(Impersonation & { audit_id: string })[]> {
  const rows = await db.query<Row>(
    "select * from impersonations where tenant_id = $1 and ended_at is null and expires_at > $2 order by started_at desc",
    [tenantId, now],
  );
  return rows.map((r) => ({ ...view(r), audit_id: r.audit_id }));
}

/** The impersonation behind a tenant token, for the audit actor (src/auth/middleware.ts). */
export async function impersonationOfToken(db: Db, tokenId: string): Promise<{ id: string; operator: string } | null> {
  const rows = await db.query<{ id: string; operator: string }>("select id, operator from impersonations where token_id = $1", [tokenId]);
  const r = rows[0];
  return r === undefined ? null : { id: r.id, operator: accountRef(r.operator) };
}

async function mailOwner(deps: Deps, tenantId: string, kind: MailKind, subject: string, text: string): Promise<void> {
  const owners = await deps.db.query<{ email: string }>(
    "select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.role = 'owner'",
    [tenantId],
  );
  for (const o of owners) {
    // A failed email never blocks the action; it is logged and the next sweep does not resend.
    await deps.mailer.send({ to: o.email, kind, subject, text }).catch(() => deps.log.warn("break-glass email not sent", { tenant_id: tenantId, kind }));
  }
}

async function end(deps: Deps, r: Row, by: "operator" | "timeout", actor: string, now: number): Promise<Impersonation> {
  await deps.db.transaction(async (tx) => {
    await tx.query("update impersonations set ended_at = $2, ended_by = $3 where id = $1 and ended_at is null", [r.id, now, by]);
    await tx.query("update tokens set revoked_at = $3 where tenant_id = $1 and id = $2 and revoked_at is null", [r.tenant_id, r.token_id, now]);
  });
  const requests = await deps.db.query<{ n: unknown }>("select count(*) as n from audit where tenant_id = $1 and actor = $2", [r.tenant_id, `operator:${accountRef(r.operator)}/${r.id}`]);
  if (by === "timeout") {
    await writeAudit(deps.db, { at: now, tenantId: r.tenant_id, actor, action: "endImpersonation", target: { tenant_id: r.tenant_id, impersonation_id: r.id, ended_by: by }, status: 200, requestId: `breakglass-${r.id}` });
  }
  await mailOwner(
    deps,
    r.tenant_id,
    "breakglass_ended",
    `Renox support access to ${r.tenant_id} ended`,
    `The operator access to ${r.tenant_id} (${r.id}) ended (${by === "timeout" ? "the 60-minute limit" : "ended by the operator"}). Requests made: ${num(requests[0]?.n ?? 0)}.`,
  );
  return { ...view(r), ended_at: now };
}

/** Ends every impersonation past its time box (called with the health sweep). */
export async function endExpiredImpersonations(deps: Deps): Promise<number> {
  const now = deps.now();
  const rows = await deps.db.query<Row>("select * from impersonations where ended_at is null and expires_at <= $1", [now]);
  for (const r of rows) await end(deps, r, "timeout", "platform", now);
  return rows.length;
}

export function registerBreakGlass(app: Hono<Env>, deps: Deps): void {
  app.post("/v1/ops/tenants/:tenant_id/impersonate", operation(deps, "impersonateTenant"), opsAuth(deps, "ops:impersonate"), async (c) => {
    const tenantId = pathParam(c, "tenant_id", "TenantId");
    const body = await jsonBody<{ reason: string; scopes?: string[] }>(c, "ImpersonateRequest");
    const tenants = await deps.db.query("select 1 from tenants where id = $1", [tenantId]);
    if (tenants.length === 0) throw notFound();
    const operator = operatorOf(c);
    const now = deps.now();
    const scopes = body.scopes ?? [...READ_SCOPES];
    const id = `imp_${ulid(now)}`;
    const auditId = `aud_${ulid(now)}`;
    const created = await deps.db.transaction(async (tx) => {
      const active = await tx.query("select 1 from impersonations where tenant_id = $1 and operator = $2 and ended_at is null and expires_at > $3", [tenantId, operator, now]);
      if (active.length > 0) return null;
      const token = await createTenantToken(tx, tenantId, `${TOKEN_PREFIX}${id}`, scopes, 1, now);
      await tx.query("update tokens set expires_at = $3 where tenant_id = $1 and id = $2", [tenantId, token.id, now + TIME_BOX_MS]);
      await tx.query(
        "insert into impersonations (id, tenant_id, operator, reason, scopes, token_id, audit_id, started_at, expires_at) values ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8, $9)",
        [id, tenantId, operator, body.reason, JSON.stringify(scopes), token.id, auditId, now, now + TIME_BOX_MS],
      );
      return token;
    });
    if (created === null) throw conflict("impersonation", "this operator already has an active impersonation of the tenant");
    c.set("auditTarget", { tenant_id: tenantId, operator: accountRef(operator), reason: body.reason, impersonation_id: id, expires_at: String(now + TIME_BOX_MS), audit_id: auditId, result: "active" });
    await mailOwner(
      deps,
      tenantId,
      "breakglass_started",
      `Renox support is accessing ${tenantId}`,
      `An operator (${accountRef(operator)}) opened read-only access to ${tenantId} until ${new Date(now + TIME_BOX_MS).toISOString()}. Reason: ${body.reason}`,
    );
    return c.json(
      { impersonation_id: id, tenant_id: tenantId, operator: accountRef(operator), reason: body.reason, scopes, started_at: now, expires_at: now + TIME_BOX_MS, ended_at: null, token: created.token },
      201,
    );
  });

  app.delete("/v1/ops/tenants/:tenant_id/impersonate/:impersonation_id", operation(deps, "endImpersonation"), opsAuth(deps, "ops:impersonate"), async (c) => {
    const tenantId = pathParam(c, "tenant_id", "TenantId");
    const id = c.req.param("impersonation_id");
    const rows = await deps.db.query<Row>("select * from impersonations where id = $1 and tenant_id = $2", [id, tenantId]);
    const r = rows[0];
    if (r === undefined) throw notFound();
    c.set("auditTarget", { tenant_id: tenantId, impersonation_id: id, ended_by: "operator", operator: accountRef(operatorOf(c)) });
    if (r.ended_at !== null) return c.json(view(r));
    return c.json(await end(deps, r, "operator", accountRef(operatorOf(c)), deps.now()));
  });
}
