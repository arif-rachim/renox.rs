// GET /apps/:app/settings: the tenant that owns the app, its state, and
// its erasure record (#308; deploy-api.md 0.4 section 3, `getTenant`). An
// erasure is a person's decision: the contract refuses `deleteTenant` to
// every token, the dashboard's included (D23: the dashboard signs in with a
// token), so the page says how the owner starts one from a signed-in API
// session and then shows its progress here, through the tombstone.
import type { LoaderContext } from "renox";

import { apiBase } from "../../../lib/api.ts";
import { appParam, notFound, problem, signedIn } from "../../../lib/guard.ts";
import { trOf } from "../../../lib/i18n.ts";
import { clock } from "../../../lib/view.ts";

/** The erasure's states, as catalog keys (`dash.settings.erasure_<state>`). */
const STATES = ["pending", "erasing", "done", "failed"] as const;

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const name = appParam(ctx.params.app);
  if (name === null) return notFound();
  const base = { signed_in: true, impersonation: api.impersonation, api_host: new URL(apiBase(ctx.secrets)).host, app: name, section: "settings" };
  const app = await api.getApp(name);
  if (!app.ok) return { ...base, problem: await problem(ctx, app), tenant: null, erasure: null };
  const t = await api.getTenant(app.value.tenant_id);
  if (!t.ok) return { ...base, problem: await problem(ctx, t), tenant: null, erasure: null };
  const e = t.value.erasure;
  return {
    ...base,
    problem: null,
    tenant: { id: t.value.tenant_id, name: t.value.name, tier: t.value.tier, state: t.value.state, created: clock(t.value.created_at) },
    erasure:
      e === null
        ? null
        : {
            state: e.state,
            text: STATES.includes(e.state) ? trOf(ctx)(`dash.settings.erasure_${e.state}`) : e.state,
            requested: clock(e.requested_at),
            completed: e.completed_at === null ? null : clock(e.completed_at),
            replica_purged: e.replica_purged_at === null || e.replica_purged_at === undefined ? null : clock(e.replica_purged_at),
            failure: e.failure,
          },
  };
}
