// GET /ops/nodes/:node: one worker node in the operator console
// (docs/19-platform-wireframes.md section 5; #460). 403 unless the
// `OPS_CONSOLE` secret is `operators`.
// POST ?/status (token with `ops:read`): `getNode` (deploy-api.md 0.4 and
// 0.6.2 section 7) with the operator's token, used for that one call and
// never kept. Shows the node's health and capacity, and its process
// isolation: with `[process]` off, the paid tenants it runs in the shared
// process (`process_isolation.own_ignored`), each linked to its tenant page.
// A node that never reported it is "unknown", never "on".
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { Api, apiBase, type NodeDetail } from "../../../lib/api.ts";
import { frame, notFound, signedIn } from "../../../lib/guard.ts";
import { forbidden, NODE_ID, OPS_TOKEN, opsEnabled, opsProblem } from "../../../lib/ops.ts";
import { EN, trOf, type Tr } from "../../../lib/i18n.ts";
import { ago } from "../../../lib/view.ts";

const nodeParam = (raw: string | string[] | undefined): string | null => (typeof raw === "string" && NODE_ID.test(raw) ? raw : null);
const quiet = { form_error: null as string | null, action_problem: null, node_view: null };

/** The node panel: finished strings for the template (no function calls there). */
export function nodeView(n: NodeDetail, now: number, tr: Tr = EN) {
  const iso = n.process_isolation ?? null;
  return {
    region: n.region,
    worker_version: n.worker_version,
    healthy: n.healthy ? tr("dash.ops.yes") : tr("dash.ops.no"),
    last_heartbeat: ago(n.last_heartbeat_at, now, tr),
    cells: `${n.cells} / ${n.max_cells}`,
    route_version: n.route_version,
    isolation: tr(iso === null ? "dash.ops.isolation_unknown" : iso.enabled ? "dash.ops.isolation_on" : "dash.ops.isolation_off"),
    // Only a node that reported `enabled: false` has a list to show.
    reported_off: iso !== null && !iso.enabled,
    ignored: (iso?.own_ignored ?? []).map((t) => ({ tenant: t, href: `/ops/tenants/${encodeURIComponent(t)}` })),
  };
}

export async function load(ctx: LoaderContext) {
  if (!opsEnabled(ctx.secrets)) return forbidden();
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const node = nodeParam(ctx.params.node);
  if (node === null) return notFound();
  return { ...frame(ctx, api, "ops"), node, ...quiet };
}

export const actions = {
  async status(ctx: ActionContext) {
    if (!opsEnabled(ctx.secrets)) return forbidden();
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const node = nodeParam(ctx.params.node);
    if (node === null) return notFound();
    const token = String(ctx.form.get("token") ?? "").trim();
    const tr = trOf(ctx);
    if (!OPS_TOKEN.test(token)) return { ...quiet, form_error: tr("dash.ops.err_token") };
    const r = await new Api(ctx.fetch, token, apiBase(ctx.secrets)).getNode(node);
    if (!r.ok) return { ...quiet, action_problem: opsProblem(r, tr) };
    return { ...quiet, node_view: nodeView(r.value, Date.now(), tr) };
  },
};
