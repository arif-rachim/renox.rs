// GET /account: the workspace the sign-in belongs to (#427): the tenant of
// `getTenant` (deploy-api.md section 3), the API the dashboard calls, and
// the way to the second factors and out.
import type { LoaderContext } from "@renoxium/sdk";

import { frame, problem, signedIn } from "../../lib/guard.ts";
import { trOf } from "../../lib/i18n.ts";
import { clock } from "../../lib/view.ts";

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const base = { ...frame(ctx, api, "account"), tenant_id: null as string | null, tenant: null as unknown, problem: null as unknown };
  const apps = await api.listApps();
  if (!apps.ok) return { ...base, problem: await problem(ctx, apps) };
  const id = apps.value.apps[0]?.tenant_id;
  if (id === undefined) return base;
  const t = await api.getTenant(id);
  if (!t.ok) return { ...base, tenant_id: id, problem: await problem(ctx, t) };
  const tr = trOf(ctx);
  return {
    ...base,
    tenant_id: id,
    tenant: {
      id: t.value.tenant_id,
      name: t.value.name,
      tier: t.value.tier,
      state: t.value.state,
      active: t.value.state === "active",
      created: tr("dash.common.utc_ago", { at: clock(t.value.created_at).slice(0, 16), ago: "" }).replace(/\s*\(\)$/u, ""),
      restrictions: (t.value.restrictions ?? []).join(", ") || null,
    },
  };
}
