// GET /ops/tenants/:tenant: the operator console for one tenant
// (docs/19-platform-wireframes.md section 5; lib/ops.ts; #259). 403 unless
// the `OPS_CONSOLE` secret is `operators`.
// POST ?/tier (tier), ?/node (node_id), ?/microvm: each with `reason` and the
// operator's token, which is used for that one API call and never kept.
// POST ?/status: the status panel (#296) from `getOpsTenant` (deploy-api.md
// 0.3.1 section 17) with the operator's token, kept no longer either.
// POST ?/impersonate (reason, token with `ops:impersonate`; #310, 0.4
// section 17): break-glass. The API answers a read-only tenant token for 60
// minutes, once; this session signs in with it (replacing the operator's own
// dashboard sign-in) and every page shows the banner until the time box,
// ?/end, or the sign-out. POST ?/end (impersonation_id, token) ends it.
import type { ActionContext, LoaderContext } from "renox";

import { Api, apiBase, type OpsTenant } from "../../../lib/api.ts";
import { notFound, signedIn } from "../../../lib/guard.ts";
import { endImpersonation, forbidden, formProblem, IMPERSONATION_ID, impersonate, NODE_ID, OPS_TOKEN, opsEnabled, opsProblem, REASON_MAX, REASON_MIN, run, stateView, TENANT_ID, type Action } from "../../../lib/ops.ts";
import { signIn, signOut } from "../../../lib/session.ts";
import { ago, clock, round } from "../../../lib/view.ts";

const tenantParam = (raw: string | string[] | undefined): string | null => (typeof raw === "string" && TENANT_ID.test(raw) ? raw : null);
const quiet = { form_error: null, action_problem: null, state: null, status: null, notice: null as string | null };

/** The status panel: finished strings for the template (no function calls there). */
export function statusView(t: OpsTenant, now: number) {
  return {
    name: t.name,
    tier: t.tier,
    state: t.state,
    process: t.process,
    node: t.node_id ?? "none (no route entry)",
    pinned: t.pinned_node ?? "—",
    moving: t.moving ? `yes, since ${clock(t.moving_since ?? now)} (requests answer 503)` : "no",
    microvm: t.microvm_at === null ? "—" : clock(t.microvm_at),
    replication: t.replication.map((r) => ({
      database: r.database,
      state: r.replication === "none" ? "not replicated" : r.state,
      replica: r.replica === null ? "—" : r.replica.region === undefined ? r.replica.kind : `${r.replica.kind} (${r.replica.region})`,
      lag: r.lag_seconds === null ? "—" : `${round(r.lag_seconds)} s`,
      last_sync: ago(r.last_sync_at, now),
      reported: ago(r.reported_at, now),
      stale: r.stale,
    })),
    actions: t.actions.map((a) => ({
      at: clock(a.at),
      action: a.action,
      result: a.result,
      operator: a.operator,
      reason: a.reason,
      audit_id: a.audit_id,
      // #310: an active break-glass can be ended from here.
      active_impersonation: a.action === "impersonateTenant" && a.result === "active" && typeof a.impersonation_id === "string" ? a.impersonation_id : null,
      expires: typeof a.expires_at === "number" ? clock(a.expires_at) : null,
    })),
  };
}

export async function load(ctx: LoaderContext) {
  if (!opsEnabled(ctx.secrets)) return forbidden();
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const tenant = tenantParam(ctx.params.tenant);
  if (tenant === null) return notFound();
  return { signed_in: true, impersonation: api.impersonation, api_host: new URL(apiBase(ctx.secrets)).host, tenant, reason_min: REASON_MIN, reason_max: REASON_MAX, ...quiet };
}

async function act(ctx: ActionContext, action: Action | null) {
  if (!opsEnabled(ctx.secrets)) return forbidden();
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const tenant = tenantParam(ctx.params.tenant);
  if (tenant === null) return notFound();
  const token = String(ctx.form.get("token") ?? "").trim();
  const reason = String(ctx.form.get("reason") ?? "").trim();
  const why = formProblem(token, reason, action);
  if (why !== null || action === null) return { ...quiet, form_error: why };
  const r = await run(ctx.fetch, ctx.secrets, token, tenant, reason, action);
  if (!r.ok) return { ...quiet, action_problem: opsProblem(r) };
  return { ...quiet, state: stateView(r.value) };
}

export const actions = {
  tier(ctx: ActionContext) {
    const tier = String(ctx.form.get("tier") ?? "");
    return act(ctx, tier === "free" || tier === "paid" ? { kind: "tier", tier } : null);
  },
  node(ctx: ActionContext) {
    const node = String(ctx.form.get("node_id") ?? "").trim();
    return act(ctx, NODE_ID.test(node) ? { kind: "node", node_id: node } : null);
  },
  microvm(ctx: ActionContext) {
    return act(ctx, { kind: "microvm" });
  },
  async impersonate(ctx: ActionContext) {
    if (!opsEnabled(ctx.secrets)) return forbidden();
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const tenant = tenantParam(ctx.params.tenant);
    if (tenant === null) return notFound();
    const token = String(ctx.form.get("token") ?? "").trim();
    const reason = String(ctx.form.get("reason") ?? "").trim();
    const why = formProblem(token, reason, { kind: "microvm" });
    if (why !== null) return { ...quiet, form_error: why };
    const r = await impersonate(ctx.fetch, ctx.secrets, token, tenant, reason);
    if (!r.ok) return { ...quiet, action_problem: opsProblem(r) };
    const imp = r.value;
    if (typeof imp.token !== "string") return { ...quiet, form_error: "The control API answered no token." };
    await signIn(ctx.db, ctx.secrets, ctx.session.id, imp.token, Date.now());
    await ctx.db.execute(
      "insert into app__impersonations (session_id, impersonation_id, tenant_id, expires_at) values (?, ?, ?, ?) on conflict (session_id) do update set impersonation_id = excluded.impersonation_id, tenant_id = excluded.tenant_id, expires_at = excluded.expires_at",
      [ctx.session.id, imp.impersonation_id, imp.tenant_id, imp.expires_at],
    );
    return new Response(null, { status: 303, headers: { location: "/apps", "cache-control": "no-store" } });
  },
  async end(ctx: ActionContext) {
    if (!opsEnabled(ctx.secrets)) return forbidden();
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const tenant = tenantParam(ctx.params.tenant);
    if (tenant === null) return notFound();
    const token = String(ctx.form.get("token") ?? "").trim();
    const id = String(ctx.form.get("impersonation_id") ?? "").trim();
    if (!OPS_TOKEN.test(token)) return { ...quiet, form_error: "Paste your operator token (renox_op_ followed by 32 letters and digits)." };
    if (!IMPERSONATION_ID.test(id)) return { ...quiet, form_error: "No such impersonation." };
    const r = await endImpersonation(ctx.fetch, ctx.secrets, token, tenant, id);
    if (!r.ok) return { ...quiet, action_problem: opsProblem(r) };
    // This session's own break-glass ends with it.
    if (api.impersonation?.impersonation_id === id) {
      await signOut(ctx.db, ctx.session.id);
      return new Response(null, { status: 303, headers: { location: "/signin", "cache-control": "no-store" } });
    }
    return { ...quiet, notice: `Impersonation ${id} ended.` };
  },
  async status(ctx: ActionContext) {
    if (!opsEnabled(ctx.secrets)) return forbidden();
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const tenant = tenantParam(ctx.params.tenant);
    if (tenant === null) return notFound();
    const token = String(ctx.form.get("token") ?? "").trim();
    if (!OPS_TOKEN.test(token)) return { ...quiet, form_error: "Paste your operator token (renox_op_ followed by 32 letters and digits)." };
    const r = await new Api(ctx.fetch, token, apiBase(ctx.secrets)).getOpsTenant(tenant);
    if (!r.ok) return { ...quiet, action_problem: opsProblem(r) };
    return { ...quiet, status: statusView(r.value, Date.now()) };
  },
};
