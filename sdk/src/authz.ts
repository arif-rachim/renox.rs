// Authorization helpers (#283; docs/contracts/ops.md section 17,
// docs/11-authorization.md). The `Authz` surface itself is on `ctx.authz`
// (ctx.ts); these are the typed pieces a module writes around it.

import type { Guard, ResourceRef } from "./ctx.ts";
import type { Db, Scope } from "./db.ts";
import { ForbiddenError, isRenoxError } from "./errors.ts";

/** An action name `<resource>.<verb>` (manifest.md `[authz].actions`). */
export type ActionName = `${string}.${string}`;

/** What `ctx.db.scoped(scope)` returns: a `Db` whose owned tables carry the scope's owner predicate. */
export type ScopedDb = Db;

/**
 * Types the `guard` export of a page, function, ws or sse module and returns
 * it unchanged. `renox build` reads it into the route entry; the cell
 * evaluates it before the loader or handler (and on fragment requests).
 * `resource.id` is a literal or `":<param>"`, a parameter of the route.
 *
 * ```ts
 * export const guard = defineGuard({ action: "invoice.read", resource: { type: "Invoice", id: ":id" } });
 * ```
 */
export function defineGuard<const G extends Guard & { action: ActionName }>(guard: G): G {
  if (typeof guard?.action !== "string" || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u.test(guard.action)) {
    throw new TypeError(`defineGuard: action must be <resource>.<verb>, got ${JSON.stringify(guard?.action)}`);
  }
  const r = guard.resource;
  if (r !== undefined && (typeof r.type !== "string" || typeof r.id !== "string" || r.id.length === 0)) {
    throw new TypeError("defineGuard: resource is { type, id } with id a literal or \":<param>\"");
  }
  return guard;
}

/** A resource reference for `authz.require` / `can`: a row with its entity type. */
export function resource<T extends Readonly<Record<string, unknown>> & { readonly id: string | number }>(type: string, row: T): ResourceRef & Omit<T, "id" | "type"> {
  return { ...row, type, id: String(row.id) } as ResourceRef & Omit<T, "id" | "type">;
}

/** Whether `e` is the `RENOX_FORBIDDEN` of a deny (`authz.require`, `realtime.subscribe`). */
export function isForbidden(e: unknown): e is ForbiddenError {
  return e instanceof ForbiddenError || (isRenoxError(e) && e.code === "RENOX_FORBIDDEN");
}

/** The scope of the request's own user, for `ctx.db.scoped()`; throws when there is no user. */
export function userScope(principal: { readonly id: string; readonly kind: string } | null, extra: Omit<Scope, "user_id"> = {}): Scope {
  if (principal === null || principal.kind !== "user") {
    throw new ForbiddenError("A signed-in user is required.", { action: "db.scoped", resource: null, reason: "deny", policy: null });
  }
  return { ...extra, user_id: principal.id };
}
