// The operator console (docs/19-platform-wireframes.md section 5;
// deploy-api.md 0.3 section 17; #259): change a tenant's tier, move it to a
// named node, or move it to a microVM.
//
// The dashboard is an ordinary tenant (ADR D23), so it never stores an
// operator token. The console is off unless this deployment of the dashboard
// sets the `OPS_CONSOLE` secret to `operators` (403 otherwise; a secret
// value has at least 8 characters). Each action takes the
// operator's `renox_op_` token in its form, passes it once to the API as the
// bearer, and drops it: it is never stored, logged, or rendered back. Whether
// the token holds `ops:write`, which only an account flagged `operator` can
// mint, is decided by the API. The control API has no read endpoint for
// operators in 0.3, so the page shows the state of the last action's answer.

import type { Fetch, Secrets } from "renox";

import { Api, apiBase, type ApiFailure, type Result } from "./api.ts";
import { EN, type Tr } from "./i18n.ts";
import { round } from "./view.ts";

export const OPS_SECRET = "OPS_CONSOLE";
export const OPS_TOKEN = /^renox_op_[a-z2-7]{32}$/u;
/** deploy-api.yaml `TenantId`, `NodeId`, `OperatorReason`. */
export const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
export const NODE_ID = /^[a-z0-9][a-z0-9_.-]{0,62}$/u;
export const REASON_MIN = 10;
export const REASON_MAX = 500;

export const opsEnabled = (secrets: Secrets): boolean => secrets[OPS_SECRET] === "operators";

export const forbidden = (): Response =>
  new Response("The operator console is not enabled on this dashboard.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** `OperatorActionResult`. */
export interface ActionResult {
  tenant_id: string;
  action: "setTenantTier" | "moveTenant";
  changed: boolean;
  tier: "free" | "paid";
  process: "shared" | "own";
  node_id: string;
  route_version: number;
  audit_id: string;
  hook_exit_code?: number;
}

export type Action = { kind: "tier"; tier: "free" | "paid" } | { kind: "node"; node_id: string } | { kind: "microvm" };

/** Why the form is refused before the API, or null. The token is never part of the message. */
export function formProblem(token: string, reason: string, action: Action | null, tr: Tr = EN): string | null {
  if (!OPS_TOKEN.test(token)) return tr("dash.ops.err_token");
  const n = [...reason].length;
  if (n < REASON_MIN || n > REASON_MAX) return tr("dash.ops.err_reason", { min: REASON_MIN, max: REASON_MAX });
  if (action === null) return tr("dash.ops.err_action");
  return null;
}

/** One operator action with the operator's token, used for this request only. */
export function run(fetch: Fetch, secrets: Secrets, token: string, tenant: string, reason: string, action: Action): Promise<Result<ActionResult>> {
  const api = new Api(fetch, token, apiBase(secrets));
  const path = `/v1/ops/tenants/${encodeURIComponent(tenant)}`;
  if (action.kind === "tier") return api.json("POST", `${path}/tier`, { tier: action.tier, reason });
  if (action.kind === "node") return api.json("POST", `${path}/move`, { target: "node", node_id: action.node_id, reason });
  return api.json("POST", `${path}/move`, { target: "microvm", reason });
}

/** What the page shows for a refused action (the dashboard sign-in is not touched: the token was the operator's). */
export function opsProblem(f: ApiFailure, tr: Tr = EN): { code: string; message: string; status: number; request_id: string | null; signed_out: false; details: string[] } {
  const message =
    f.status === 0
      ? tr("dash.problem.unreachable_short", { code: f.code })
      : f.status === 401
        ? tr("dash.ops.refused")
        : f.status === 403
          ? tr("dash.ops.no_write")
          : f.message;
  const details = f.details.flatMap((d) => {
    const o = (typeof d === "object" && d !== null ? d : {}) as Record<string, unknown>;
    return typeof o.field === "string" && typeof o.reason === "string" ? [`${o.field}: ${o.reason}`.slice(0, 600)] : [];
  });
  return { code: f.code, message, status: f.status, request_id: f.requestId, signed_out: false, details };
}

export interface StateView {
  tier: string;
  process: string;
  node: string;
  route_version: string;
  hook: string | null;
  audit_id: string;
  notice: string;
}

export function stateView(r: ActionResult, tr: Tr = EN): StateView {
  const what =
    r.action === "setTenantTier"
      ? r.changed
        ? tr("dash.ops.tier_set", { tier: r.tier, process: r.process })
        : tr("dash.ops.tier_same", { tier: r.tier })
      : r.hook_exit_code !== undefined
        ? r.hook_exit_code === 0
          ? tr("dash.ops.moved_microvm")
          : tr("dash.ops.hook_failed", { code: r.hook_exit_code, node: r.node_id })
        : tr("dash.ops.moved_node", { node: r.node_id });
  return {
    tier: r.tier,
    process: r.process,
    node: r.node_id,
    route_version: round(r.route_version),
    hook: r.hook_exit_code === undefined ? null : String(r.hook_exit_code),
    audit_id: r.audit_id,
    notice: what,
  };
}

/** deploy-api.yaml `Impersonation` (0.4 section 17): `token` is returned once. */
export interface Impersonation {
  impersonation_id: string;
  tenant_id: string;
  operator: string;
  reason: string;
  scopes: string[];
  started_at: number;
  expires_at: number;
  ended_at: number | null;
  token?: string;
}

/** `impersonateTenant` with the operator's `ops:impersonate` token, used for this one call. */
export function impersonate(fetch: Fetch, secrets: Secrets, token: string, tenant: string, reason: string): Promise<Result<Impersonation>> {
  return new Api(fetch, token, apiBase(secrets)).json("POST", `/v1/ops/tenants/${encodeURIComponent(tenant)}/impersonate`, { reason });
}

/** `endImpersonation`. */
export function endImpersonation(fetch: Fetch, secrets: Secrets, token: string, tenant: string, id: string): Promise<Result<Impersonation>> {
  return new Api(fetch, token, apiBase(secrets)).json("DELETE", `/v1/ops/tenants/${encodeURIComponent(tenant)}/impersonate/${encodeURIComponent(id)}`);
}

export const IMPERSONATION_ID = /^imp_[0-9A-HJKMNP-TV-Z]{26}$/u;
