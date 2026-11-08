// GET /apps/:app/settings: the tenant that owns the app, its state, and
// its erasure record (#308; deploy-api.md 0.4 section 3, `getTenant`). An
// erasure is a person's decision: the contract refuses `deleteTenant` to
// every token, the dashboard's included (D23: the dashboard signs in with a
// token), so the page says how the owner starts one from a signed-in API
// session and then shows its progress here, through the tombstone.
//
// POST ?/delete_app (#536; deploy-api.md 0.7 section 3, `deleteApp`): owners
// and admins (the caller's `permissions` on `getTenant` hold `apps:delete`)
// see "Delete this app"; the name typed again must be the app's. On success
// the browser goes to /apps, where the app is listed as restorable for 7 days.
import { redirect, type ActionContext, type LoaderContext } from "@renoxium/sdk";

import { appParam, frame, notFound, problem, signedIn } from "../../../lib/guard.ts";
import { trOf } from "../../../lib/i18n.ts";
import { clock } from "../../../lib/view.ts";

/** The erasure's states, as catalog keys (`dash.settings.erasure_<state>`). */
const STATES = ["pending", "erasing", "done", "failed"] as const;

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const name = appParam(ctx.params.app);
  if (name === null) return notFound();
  const base = { ...frame(ctx, api, "apps"), app: name, section: "settings", can_delete: false, delete_error: null, delete_problem: null };
  const app = await api.getApp(name);
  if (!app.ok) return { ...base, problem: await problem(ctx, app), tenant: null, erasure: null };
  const t = await api.getTenant(app.value.tenant_id);
  if (!t.ok) return { ...base, problem: await problem(ctx, t), tenant: null, erasure: null };
  const e = t.value.erasure;
  return {
    ...base,
    // 0.7: only a caller holding `apps:delete` sees the section; the API checks it again.
    can_delete: t.value.permissions?.includes("apps:delete") === true && t.value.state === "active" && e === null,
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

export const actions = {
  /** `deleteApp`: the typed name must be the app's; then /apps, where it shows as restorable. */
  async delete_app(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const name = appParam(ctx.params.app);
    if (name === null) return notFound();
    const typed = String(ctx.form.get("confirm") ?? "").trim();
    if (typed !== name) return { delete_error: trOf(ctx)("dash.settings.app_delete_mismatch"), delete_problem: null };
    const r = await api.deleteApp(name);
    if (!r.ok) return { delete_error: null, delete_problem: await problem(ctx, r) };
    return redirect.safe("/apps", { fallback: "/apps" });
  },
};
