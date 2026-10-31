// GET /ops/registry: the registry moderation page of the operator console
// (docs/19-platform-wireframes.md section 5; deploy-api.md 0.5 section 19;
// #324). 403 unless the `OPS_CONSOLE` secret is `operators`.
// POST ?/disable (hash, reason, token) and ?/enable (hash, reason, token):
// `disableModuleVersion` with the operator's token, used for that one call
// and never kept. Disabling marks every installation of the tree, refuses
// its downloads, and emails each tenant owner; the dashboard banner of the
// Modules page shows it (docs/24 section D, "Marketplace module unsigned or
// permission diff on upgrade").
import type { ActionContext, LoaderContext } from "renox";

import { Api, apiBase, type Result } from "../../../lib/api.ts";
import { signedIn } from "../../../lib/guard.ts";
import { forbidden, OPS_TOKEN, opsEnabled, opsProblem, REASON_MAX, REASON_MIN } from "../../../lib/ops.ts";
import { EN, trOf, type Tr } from "../../../lib/i18n.ts";
import { clock } from "../../../lib/view.ts";

const HASH = /^[0-9a-f]{64}$/u;
const quiet = { form_error: null as string | null, action_problem: null, result: null };

export async function load(ctx: LoaderContext) {
  if (!opsEnabled(ctx.secrets)) return forbidden();
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  return { signed_in: true, impersonation: api.impersonation, api_host: new URL(apiBase(ctx.secrets)).host, reason_min: REASON_MIN, reason_max: REASON_MAX, ...quiet };
}

/** Why the form is refused before the API, or null. The token is never part of the message. */
export function moderationProblem(token: string, hash: string, reason: string, tr: Tr = EN): string | null {
  if (!OPS_TOKEN.test(token)) return tr("dash.ops.err_token");
  if (!HASH.test(hash)) return tr("dash.ops.err_hash");
  const n = [...reason].length;
  if (n < REASON_MIN || n > REASON_MAX) return tr("dash.ops.err_reason_owners", { min: REASON_MIN, max: REASON_MAX });
  return null;
}

async function moderate(ctx: ActionContext, enabled: boolean) {
  if (!opsEnabled(ctx.secrets)) return forbidden();
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const token = String(ctx.form.get("token") ?? "").trim();
  const hash = String(ctx.form.get("hash") ?? "").trim();
  const reason = String(ctx.form.get("reason") ?? "").trim();
  const tr = trOf(ctx);
  const why = moderationProblem(token, hash, reason, tr);
  if (why !== null) return { ...quiet, form_error: why };
  const r: Result<{ hash: string; disabled_at: number | null; tenants_notified: number }> = await new Api(ctx.fetch, token, apiBase(ctx.secrets)).json("POST", "/v1/registry/disable", { hash, reason, enabled });
  if (!r.ok) return { ...quiet, action_problem: opsProblem(r, tr) };
  return {
    ...quiet,
    result: {
      hash: r.value.hash,
      notice:
        r.value.disabled_at === null
          ? tr("dash.ops.enabled_again")
          : tr("dash.ops.disabled_notice", { at: clock(r.value.disabled_at), n: r.value.tenants_notified }),
    },
  };
}

export const actions = {
  disable: (ctx: ActionContext) => moderate(ctx, false),
  enable: (ctx: ActionContext) => moderate(ctx, true),
};
