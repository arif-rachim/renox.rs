// The repository wrapper of #113 (docs/24-threat-model.md E, the IDOR row):
// every statement a tenant request runs goes through `withTenant(db,
// principal)`, which takes the tenant id from the authenticated principal and
// refuses a statement that is not bound to it.
//
// A statement is bound when it touches only platform tables (the route table,
// workers, audit), or when it binds `$1` to the principal's tenant through
// `tenant_id = $1` (`id = $1` on `tenants`), or, for an insert, puts the
// principal's tenant in its `tenant_id` column. This is a guard against a
// forgotten filter, not a SQL parser: statements are written in this
// repository, never built from input (src/db/db.ts).
//
// The few statements that must look across tenants (an artifact shared by
// hash) go through `crossTenant(db, reason)`; a test lists every call site.
//
// `guardDb` is the test harness: during a tenant request, a statement on the
// raw database that did not come through one of these wrappers is reported.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Db, Row } from "../db/db.ts";
import { ApiError } from "../errors.ts";
import type { Principal } from "../context.ts";

/** Tables shared by all tenants, read and written by the platform on a tenant's behalf. */
// deploy-api.md 0.5 section 19: the module registry is one catalog for every tenant (#324).
export const PLATFORM_TABLES = new Set(["route_entries", "route_changes", "workers", "audit", "registry_publishers", "registry_keys", "registry_versions"]);

interface Scope {
  tenantId: string;
  /** True while a statement runs through withTenant or crossTenant. */
  scoped: boolean;
}

/** Set by the tenant middleware for the rest of the request. */
export const requestScope = new AsyncLocalStorage<Scope>();

export class TenantScopeError extends Error {}

/** Table names after from, join, into, and update. */
export function tablesOf(sql: string): string[] {
  return [...sql.matchAll(/\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)/giu)].map((m) => (m[1] as string).toLowerCase());
}

const platformOnly = (tables: string[]): boolean => tables.every((t) => PLATFORM_TABLES.has(t));

/** The `$n` placed in the `tenant_id` column of an insert, or null. */
function insertTenantParam(sql: string): number | null {
  const m = /^\s*insert\s+into\s+[a-z_][a-z0-9_]*\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)/iu.exec(sql);
  if (m === null) return null;
  const cols = (m[1] as string).split(",").map((s) => s.trim());
  const vals = (m[2] as string).split(",").map((s) => s.trim());
  const i = cols.indexOf("tenant_id");
  const v = i === -1 ? undefined : /^\$([0-9]+)$/u.exec(vals[i] ?? "");
  return v === undefined || v === null ? null : Number(v[1]);
}

/** Throws TenantScopeError unless the statement is bound to `tenantId`. */
export function checkTenantQuery(sql: string, params: readonly unknown[], tenantId: string): void {
  const tables = tablesOf(sql);
  if (platformOnly(tables)) return;
  if (/^\s*insert\b/iu.test(sql)) {
    const n = insertTenantParam(sql);
    if (n !== null && params[n - 1] === tenantId) return;
  } else {
    const tenantsOnly = tables.every((t) => t === "tenants" || PLATFORM_TABLES.has(t));
    const bound = tenantsOnly ? /(?:^|[^a-z0-9_])(?:[a-z_]+\.)?id\s*=\s*\$1(?![0-9])/iu : /(?:^|[^a-z0-9_.])(?:[a-z_]+\.)?tenant_id\s*=\s*\$1(?![0-9])/iu;
    if (bound.test(sql) && params[0] === tenantId) return;
  }
  throw new TenantScopeError(`statement not bound to the principal's tenant: ${sql.replace(/\s+/gu, " ").slice(0, 200)}`);
}

const INNER = Symbol("inner");

/** A Db whose statements are checked against one tenant. */
export interface TenantDb extends Db {
  readonly tenantId: string;
  readonly [INNER]: Db;
}

function marked<T>(fn: () => Promise<T>): Promise<T> {
  const s = requestScope.getStore();
  return s === undefined ? fn() : requestScope.run({ ...s, scoped: true }, fn);
}

function wrapTenant(inner: Db, tenantId: string): TenantDb {
  return {
    tenantId,
    [INNER]: inner,
    async query<T extends Row = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      checkTenantQuery(sql, params, tenantId);
      return marked(() => inner.query<T>(sql, params));
    },
    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return inner.transaction((tx) => fn(wrapTenant(tx, tenantId)));
    },
    exec: () => Promise.reject(new TenantScopeError("exec is not available to tenant requests")),
    listen: () => Promise.reject(new TenantScopeError("listen is not available to tenant requests")),
    close: () => Promise.reject(new TenantScopeError("close is not available to tenant requests")),
  };
}

/** The database as the principal's tenant. 401 for any other principal. */
export function withTenant(db: Db, principal: Principal | undefined): TenantDb {
  if (principal?.kind !== "tenant") throw new ApiError("RENOX_UNAUTHENTICATED");
  return wrapTenant(db, principal.tenantId);
}

const isTenantDb = (db: Db): db is TenantDb => INNER in db;

/**
 * The raw database for a statement that must look across tenants. `reason`
 * documents the call site; tests/tenancy.test.ts lists every one.
 */
export function crossTenant(db: Db, reason: string): Db {
  if (reason.length === 0) throw new Error("crossTenant needs a reason");
  const inner = isTenantDb(db) ? db[INNER] : db;
  return {
    query: (sql, params) => marked(() => inner.query(sql, params)),
    transaction: (fn) => inner.transaction((tx) => fn(crossTenant(tx, reason))),
    exec: (sql) => inner.exec(sql),
    listen: (channel, onPayload) => inner.listen(channel, onPayload),
    close: () => inner.close(),
  };
}

/** The test harness: reports statements a tenant request ran on the raw database. */
export function guardDb(db: Db, onViolation: (sql: string) => void): Db {
  const check = (sql: string): void => {
    const s = requestScope.getStore();
    if (s !== undefined && !s.scoped && !platformOnly(tablesOf(sql))) onViolation(sql);
  };
  return {
    query(sql, params) {
      check(sql);
      return db.query(sql, params);
    },
    transaction: (fn) => db.transaction((tx) => fn(guardDb(tx, onViolation))),
    exec(sql) {
      check(sql);
      return db.exec(sql);
    },
    listen: (channel, onPayload) => db.listen(channel, onPayload),
    close: () => db.close(),
  };
}

/** withTenant for a route handler: the request's principal on the API's database. */
export const tenantDb = (deps: { db: Db }, c: { get(key: "principal"): Principal | undefined }): TenantDb => withTenant(deps.db, c.get("principal"));
