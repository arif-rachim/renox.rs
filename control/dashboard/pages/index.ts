// GET /: the getting-started checklist until the tenant's first deploy
// (docs/19-platform-wireframes.md 3.1; #326), then the app list, which is
// the dashboard's home. The steps: create the first app (from a template),
// deploy it (`first_deploy_at` of `getTenant`, deploy-api.md 0.5 section 21).
import type { LoaderContext } from "renox";

import { apiBase } from "../lib/api.ts";
import { signedIn } from "../lib/guard.ts";
import { trOf } from "../lib/i18n.ts";

const home = (): Response => new Response(null, { status: 303, headers: { location: "/apps" } });

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const apps = await api.listApps();
  // Without the list the checklist cannot be judged: the app list page shows the problem.
  if (!apps.ok) return home();
  const first = apps.value.apps[0];
  if (first !== undefined) {
    const t = await api.getTenant(first.tenant_id);
    if (!t.ok || (t.value.first_deploy_at ?? null) !== null) return home();
  }
  const has = first !== undefined;
  const tr = trOf(ctx);
  return {
    signed_in: true,
    impersonation: api.impersonation,
    api_host: new URL(apiBase(ctx.secrets)).host,
    steps: [
      { done: true, text: tr("dash.home.step_verify"), href: null },
      { done: has, text: tr("dash.home.step_create"), href: has ? null : "/apps/new" },
      { done: false, text: has ? tr("dash.home.step_deploy_app", { app: first.name }) : tr("dash.home.step_deploy"), href: has ? `/apps/${first.name}/deployments` : null },
    ],
  };
}
