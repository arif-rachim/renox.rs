// GET /ops/tenants/:tenant: the operator console for one tenant
// (docs/19-platform-wireframes.md section 5; lib/ops.ts; #259). 403 unless
// the `OPS_CONSOLE` secret is `operators`.
// POST ?/tier (tier), ?/node (node_id), ?/microvm: each with `reason` and the
// operator's token, which is used for that one API call and never kept.
import type { ActionContext, LoaderContext } from "renox";

import { apiBase } from "../../../lib/api.ts";
import { notFound, signedIn } from "../../../lib/guard.ts";
import { forbidden, formProblem, NODE_ID, opsEnabled, opsProblem, REASON_MAX, REASON_MIN, run, stateView, TENANT_ID, type Action } from "../../../lib/ops.ts";

const tenantParam = (raw: string | string[] | undefined): string | null => (typeof raw === "string" && TENANT_ID.test(raw) ? raw : null);
const quiet = { form_error: null, action_problem: null, state: null };

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
};
