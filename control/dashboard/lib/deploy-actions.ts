// Activate (promote) and rollback, shared by the app overview and the
// deployments page (docs/19-platform-wireframes.md, 3.3 and 3.4). Both are
// the API's own operations (`deploy`): the dashboard adds no rule of its own,
// and the API writes the audit row. The action waits for the API's answer,
// which comes once the owning node has prepared the cell (deploy-api.md
// section 6), so the page shows the outcome, not a pending state.
import type { ActionContext } from "renox";

import { appParam, hashParam, problem, refusal, signedIn } from "./guard.ts";
import { trOf } from "./i18n.ts";
import { shortHash } from "./view.ts";

export const deployActions = {
  async activate(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const app = appParam(ctx.params.app);
    const hash = hashParam(ctx.form.get("hash"));
    if (app === null || hash === null) return { notice: null, action_problem: refusal(ctx, "RENOX_VALIDATION", "dash.problem.no_deployment", 400) };
    const r = await api.activate(app, hash);
    if (!r.ok) return { notice: null, action_problem: await problem(ctx, r) };
    return { notice: trOf(ctx)("dash.deploy.is_live", { short: shortHash(r.value.hash) }), action_problem: null };
  },

  async rollback(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const app = appParam(ctx.params.app);
    if (app === null) return { notice: null, action_problem: refusal(ctx, "RENOX_NOT_FOUND", "dash.problem.no_app", 404) };
    const r = await api.rollback(app);
    if (!r.ok) return { notice: null, action_problem: await problem(ctx, r) };
    return { notice: trOf(ctx)("dash.deploy.rolled_back", { short: shortHash(r.value.hash) }), action_problem: null };
  },
};
