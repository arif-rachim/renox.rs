import type { Config } from "./config.ts";
import type { Db } from "./db/db.ts";
import type { Logger } from "./log.ts";
import type { ObjectStore } from "./storage/object-store.ts";
import type { Mailer } from "./auth/mailer.ts";
import type { Role } from "./tenancy/roles.ts";

/**
 * Who is calling, from the token or the session cookie (deploy-api.md section
 * 2; #113). Never from the request. A tenant principal is bound to one tenant:
 * a token to the tenant that issued it, a session to the tenant the user
 * switched to. `role` is the user's role in that tenant (null for a token no
 * user created, such as the operator's bootstrap token).
 */
export type Principal =
  | { kind: "tenant"; via: "token"; tenantId: string; tokenId: string; scopes: string[]; userId: string | null; role: Role | null }
  | { kind: "tenant"; via: "session"; tenantId: string; sessionId: string; userId: string; role: Role }
  | { kind: "user"; userId: string; sessionId: string; tenantId: string | null }
  | { kind: "node"; nodeId: string }
  | { kind: "operator" };

export interface Deps {
  db: Db;
  store: ObjectStore;
  config: Config;
  log: Logger;
  mailer: Mailer;
  /** Unix milliseconds; replaced in tests. */
  now: () => number;
}

export type Env = {
  Variables: {
    requestId: string;
    principal: Principal | undefined;
    /** The operationId, for the audit row and the access log. */
    action: string | undefined;
    /** Who a refused credential belonged to, for the audit row of a 401. */
    attempt: { tenantId: string | null; actor: string } | undefined;
    /** Audit target fields a handler adds to the path parameters (never a secret). */
    auditTarget: Record<string, string> | undefined;
  };
};

export function actorOf(p: Principal | undefined): string {
  if (p === undefined) return "anonymous";
  switch (p.kind) {
    case "tenant":
      return p.via === "token" ? `token:${p.tokenId}` : `user:${p.userId}`;
    case "user":
      return `user:${p.userId}`;
    case "node":
      return `node:${p.nodeId}`;
    case "operator":
      return "operator";
  }
}

export const tenantOf = (p: Principal | undefined): string | null => (p?.kind === "tenant" || p?.kind === "user" ? p.tenantId : null);

/** The calling user, when the principal is a session or a token a user created. */
export const userOf = (p: Principal | undefined): string | null => (p?.kind === "tenant" || p?.kind === "user" ? p.userId : null);
