// GET /apps/:app/deployments[?hash=<sha256>]: every deployment with its state
// and the actions it allows (docs/19-platform-wireframes.md, 3.4); with
// `hash`, that deployment's validation, permissions, and activation error.
// POST ?/activate and ?/rollback: lib/deploy-actions.ts.
import type { LoaderContext } from "renox";

import { apiBase } from "../../../lib/api.ts";
import { deployActions } from "../../../lib/deploy-actions.ts";
import { appParam, hashParam, notFound, problem, signedIn } from "../../../lib/guard.ts";
import { trOf } from "../../../lib/i18n.ts";
import { ago, bytes, clock, deploymentRows, stateLabel } from "../../../lib/view.ts";

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const name = appParam(ctx.params.app);
  if (name === null) return notFound();
  const selected = hashParam(ctx.url.searchParams.get("hash"));
  const now = Date.now();
  const tr = trOf(ctx);
  const base = { signed_in: true, impersonation: api.impersonation, api_host: new URL(apiBase(ctx.secrets)).host, app: name, section: "deployments", notice: null, action_problem: null };
  const [list, one, adv] = await Promise.all([
    api.listDeployments(name, 50),
    selected === null ? null : api.getDeployment(name, selected),
    selected === null ? null : api.getAdvisories(name, selected),
  ]);
  if (!list.ok) return { ...base, problem: await problem(ctx, list), deployments: [], detail: null, detail_problem: null };
  let detail = null;
  let detailProblem = null;
  if (one !== null) {
    if (!one.ok) detailProblem = await problem(ctx, one);
    else {
      const d = one.value;
      detail = {
        hash: d.hash,
        state: stateLabel(d.state, tr),
        uploaded: tr("dash.common.utc_ago", { at: clock(d.created_at), ago: ago(d.created_at, now, tr) }),
        activated: d.activated_at === null ? tr("dash.deployments.never") : `${clock(d.activated_at)} UTC`,
        size: bytes(d.size_bytes),
        network: d.permissions.network.join(", ") || tr("dash.common.none"),
        secrets: d.permissions.secrets.join(", ") || tr("dash.common.none"),
        secrets_version: d.secrets_version === null ? "—" : `v${d.secrets_version}`,
        violations: (d.violations ?? []).map((v) => `${v.rule}${v.path === undefined ? "" : ` ${v.path}`}: ${v.reason}`),
        // #123: the SBOM's advisories, a warning that never blocks; a failed lookup shows none.
        advisories: adv?.ok === true ? adv.value.items.map((a) => ({ id: a.id, package: `${a.package}@${a.version}`, severity: a.severity, summary: a.summary, fixed_in: a.fixed_in })) : [],
        last_error:
          d.last_error === null
            ? null
            : [d.last_error.stage, d.last_error.module, d.last_error.file, d.last_error.sqlite_error, d.last_error.http_status === undefined ? undefined : `HTTP ${d.last_error.http_status}`, d.last_error.reason]
                .filter((x) => x !== undefined)
                .join(" · "),
      };
    }
  }
  return { ...base, problem: null, deployments: deploymentRows(list.value.deployments, now, tr), detail, detail_problem: detailProblem };
}

export const actions = { activate: deployActions.activate, rollback: deployActions.rollback };
