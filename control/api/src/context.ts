import type { Config } from "./config.ts";
import type { Db } from "./db/db.ts";
import type { Logger } from "./log.ts";
import type { ObjectStore } from "./storage/object-store.ts";

/** Who is calling, from the token (deploy-api.md section 2). Never from the request. */
export type Principal =
  | { kind: "tenant"; tenantId: string; tokenId: string; scopes: string[] }
  | { kind: "node"; nodeId: string }
  | { kind: "operator" };

export interface Deps {
  db: Db;
  store: ObjectStore;
  config: Config;
  log: Logger;
  /** Unix milliseconds; replaced in tests. */
  now: () => number;
}

export type Env = {
  Variables: {
    requestId: string;
    principal: Principal | undefined;
    /** The operationId, for the audit row and the access log. */
    action: string | undefined;
  };
};

export const actorOf = (p: Principal | undefined): string =>
  p === undefined ? "anonymous" : p.kind === "tenant" ? `token:${p.tokenId}` : p.kind === "node" ? `node:${p.nodeId}` : "operator";

export const tenantOf = (p: Principal | undefined): string | null => (p?.kind === "tenant" ? p.tenantId : null);
