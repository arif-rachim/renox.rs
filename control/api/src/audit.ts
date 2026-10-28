// The audit row of every mutating request, whatever its outcome
// (deploy-api.md section 2). The row holds who, what, which target, and the
// status; never a body, a secret value, or a token.

import type { MiddlewareHandler } from "hono";
import { jsonb, type Db } from "./db/db.ts";
import { actorOf, tenantOf, type Deps, type Env, type Principal } from "./context.ts";

export interface AuditRow {
  at: number;
  tenantId: string | null;
  actor: string;
  action: string;
  target: Record<string, string>;
  status: number;
  requestId: string;
}

export async function writeAudit(db: Db, row: AuditRow): Promise<void> {
  await db.query(
    "insert into audit (at, tenant_id, actor, action, target, status, request_id) values ($1, $2, $3, $4, $5::jsonb, $6, $7)",
    [row.at, row.tenantId, row.actor, row.action, jsonb(row.target), row.status, row.requestId],
  );
}

/** Names the operation; on POST, PUT, and DELETE also writes the audit row after the handler. */
export function operation(deps: Deps, action: string): MiddlewareHandler<Env> {
  return async (c, next) => {
    c.set("action", action);
    await next();
    if (!["POST", "PUT", "DELETE"].includes(c.req.method)) return;
    const principal: Principal | undefined = c.get("principal");
    const target = c.req.param() as Record<string, string>;
    try {
      await writeAudit(deps.db, {
        at: deps.now(),
        tenantId: tenantOf(principal) ?? target.tenant_id ?? null,
        actor: actorOf(principal),
        action,
        target,
        status: c.res.status,
        requestId: c.get("requestId"),
      });
    } catch (e) {
      deps.log.error("audit write failed", { action, request_id: c.get("requestId"), error: String(e) });
    }
  };
}
