// Which branch the request works in, and the database fenced to it.
//
// A user works in one branch at a time: the active organisation (org module,
// `principal.attrs.org`) of the session. Each branch is one organisation
// (app__branches.org_id). The customers and sites of other branches are out of
// reach: every loader and action reads and writes them through `scopedDb`.
import type { DbStatements, Principal, Scope } from "@renoxium/sdk";

export type Branch = {
  id: string;
  org_id: string;
  name_en: string;
  name_ar: string;
  slug: string;
  emirate: string;
  area: string;
};

/** A request `Db` or a job / handler `TxDb`: both have `scoped`. */
export type Scopable = DbStatements & { scoped(scope: Scope): DbStatements };

interface BranchCtx {
  readonly principal: Principal | null;
  readonly db: Scopable;
}

/** The active organisation's branch row, or null (signed out, no organisation, or an organisation that is no branch). */
export async function branchOf(ctx: BranchCtx): Promise<Branch | null> {
  const orgId = ctx.principal?.attrs.org;
  if (typeof orgId !== "string" || orgId === "") return null;
  return ctx.db.queryOne<Branch>("select id, org_id, name_en, name_ar, slug, emirate, area from app__branches where org_id = ?", [orgId]);
}

/** The branch with this id: for scheduled jobs, which have no principal and so no active organisation. */
export async function findBranch(db: DbStatements, id: string): Promise<Branch | null> {
  return db.queryOne<Branch>("select id, org_id, name_en, name_ar, slug, emirate, area from app__branches where id = ?", [id]);
}

/**
 * `db` fenced to the branch with this id: app__customers and app__sites
 * statements get `branch_id = <branch>` added, and an insert must carry that
 * branch_id. `[authz.ownership]` names `branch_id` as the owner column, which
 * db.scoped compares to `user_id`: the branch id goes there. Requests, actions, jobs
 * and event handlers all have `db.scoped`. There is no unfenced fallback.
 */
export function branchDb(db: Scopable, branchId: string): DbStatements {
  return db.scoped({ user_id: branchId });
}

/** `db` fenced to `branch` (see `branchDb`). */
export function scopedDb(db: Scopable, branch: Branch): DbStatements {
  return branchDb(db, branch.id);
}

/** A request without a branch ends here: signed in people with no branch have nothing to see. */
export const noBranch = (): Response => new Response("No branch is active for this account.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
