// GET /ops/tenants/:tenant: the operator console for one tenant
// (docs/19-platform-wireframes.md section 5; lib/ops.ts; #259). 403 unless
// the `OPS_CONSOLE` secret is `operators`.
// POST ?/tier (tier), ?/node (node_id), ?/microvm: each with `reason` and the
// operator's token, which is used for that one API call and never kept.
// POST ?/status: the status panel (#296) from `getOpsTenant` (deploy-api.md
// 0.3.1 section 17) with the operator's token, kept no longer either.
import type { ActionContext, LoaderContext } from "renox";

import { Api, apiBase, type OpsTenant } from "../../../lib/api.ts";
import { notFound, signedIn } from "../../../lib/guard.ts";
import { forbidden, formProblem, NODE_ID, OPS_TOKEN, opsEnabled, opsProblem, REASON_MAX, REASON_MIN, run, stateView, TENANT_ID, type Action } from "../../../lib/ops.ts";
import { ago, clock, round } from "../../../lib/view.ts";

const tenantParam = (raw: string | string[] | undefined): string | null => (typeof raw === "string" && TENANT_ID.test(raw) ? raw : null);
const quiet = { form_error: null, action_problem: null, state: null, status: null };

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
    actions: t.actions.map((a) => ({ at: clock(a.at), action: a.action, result: a.result, operator: a.operator, reason: a.reason, audit_id: a.audit_id })),
  };
}

export async function load(ctx: LoaderContext) {
  if (!opsEnabled(ctx.secrets)) return forbidden();
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const tenant = tenantParam(ctx.params.tenant);
  if (tenant === null) return notFound();
  return { signed_in: true, api_host: new URL(apiBase(ctx.secrets)).host, tenant, reason_min: REASON_MIN, reason_max: REASON_MAX, ...quiet };
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
