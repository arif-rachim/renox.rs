// The audit row of every mutating request, whatever its outcome
// (deploy-api.md section 2), and of every refused credential (401 or 403) on
// any method (#113). The row holds who, what, which target, the status, and
// the client address; never a body, a secret value, a password, or a token.

import type { MiddlewareHandler } from "hono";
import { jsonb, type Db } from "./db/db.ts";
import { actorOf, tenantOf, type Deps, type Env, type Principal } from "./context.ts";
import { clientIp } from "./auth/ip.ts";

export interface AuditRow {
  at: number;
  tenantId: string | null;
  actor: string;
  action: string;
  target: Record<string, string>;
  status: number;
  requestId: string;
  ip?: string | null;
}

export async function writeAudit(db: Db, row: AuditRow): Promise<void> {
  await db.query(
    "insert into audit (at, tenant_id, actor, action, target, status, request_id, ip) values ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8)",
    [row.at, row.tenantId, row.actor, row.action, jsonb(row.target), row.status, row.requestId, row.ip ?? null],
  );
}

/** Names the operation; on POST, PUT, and DELETE, and on any 401 or 403, also writes the audit row after the handler. */
export function operation(deps: Deps, action: string): MiddlewareHandler<Env> {
  return async (c, next) => {
    c.set("action", action);
    await next();
    const refused = c.res.status === 401 || c.res.status === 403;
    if (!refused && !["POST", "PUT", "DELETE"].includes(c.req.method)) return;
    const principal: Principal | undefined = c.get("principal");
    const attempt = principal === undefined ? c.get("attempt") : undefined;
    const target = { ...(c.req.param() as Record<string, string>), ...c.get("auditTarget") };
    try {
      await writeAudit(deps.db, {
        at: deps.now(),
        tenantId: tenantOf(principal) ?? attempt?.tenantId ?? target.tenant_id ?? null,
        actor: c.get("auditActor") ?? attempt?.actor ?? actorOf(principal),
        action,
        target,
        status: c.res.status,
        requestId: c.get("requestId"),
        ip: clientIp(c),
      });
    } catch (e) {
      deps.log.error("audit write failed", { action, request_id: c.get("requestId"), error: String(e) });
    }
  };
}
