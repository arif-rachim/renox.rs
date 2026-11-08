// Operations that hold an app while they run (deploy-api.md 0.7 section 3,
// #536): a restore (section 14) reads the source app and creates the new
// one, an import swaps a staging app's file. While one runs, `deleteApp` and
// `restoreApp` (and #537's rename) answer 409 `RENOX_CONFLICT`, as does a
// move of the tenant (`tenants.moving_since`, section 17).
//
// The marks are kept in this API process: a restore or an import is one
// request, so the instance that serves it holds the mark for its duration.
// Two API instances behind one balancer each see their own requests only;
// the reference deployment runs one instance (D31).

import type { Deps } from "../context.ts";
import type { Db } from "../db/db.ts";
import { conflict } from "../errors.ts";

export type BusyReason = "restore in progress" | "import in progress";

const marks = new WeakMap<Deps, Map<string, BusyReason>>();

const key = (tenantId: string, app: string): string => `${tenantId}/${app}`;

function of(deps: Deps): Map<string, BusyReason> {
  let m = marks.get(deps);
  if (m === undefined) {
    m = new Map();
    marks.set(deps, m);
  }
  return m;
}

/** Runs `fn` with `apps` of `tenantId` marked busy for `reason`; the marks go when it settles. */
export async function holdingApps<T>(deps: Deps, tenantId: string, apps: string[], reason: BusyReason, fn: () => Promise<T>): Promise<T> {
  const m = of(deps);
  const mine = apps.filter((a) => !m.has(key(tenantId, a)));
  for (const a of mine) m.set(key(tenantId, a), reason);
  try {
    return await fn();
  } finally {
    for (const a of mine) m.delete(key(tenantId, a));
  }
}

/** Why `app` of `tenantId` cannot change now (a restore, an import, a move), or null. */
export async function appBusyReason(deps: Deps, db: Db, tenantId: string, app: string): Promise<string | null> {
  const held = of(deps).get(key(tenantId, app));
  if (held !== undefined) return held;
  const rows = await db.query<{ moving_since: unknown }>("select moving_since from tenants where id = $1", [tenantId]);
  return rows[0] !== undefined && rows[0].moving_since !== null ? "moving" : null;
}

/** 409 `RENOX_CONFLICT` with `details: [{ field: "app", reason }]` while the app is busy. */
export async function assertAppIdle(deps: Deps, db: Db, tenantId: string, app: string): Promise<void> {
  const reason = await appBusyReason(deps, db, tenantId, app);
  if (reason !== null) throw conflict("app", reason);
}
