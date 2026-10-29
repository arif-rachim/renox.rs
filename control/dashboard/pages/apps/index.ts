// GET /apps: the tenant's apps (docs/19-platform-wireframes.md, 3.1 Org
// overview). POST ?/create: a new app (3.2), `apps:write`.
import type { ActionContext, LoaderContext } from "renox";

import { apiBase } from "../../lib/api.ts";
import { problem, signedIn } from "../../lib/guard.ts";
import { shortHash } from "../../lib/view.ts";

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const base = { signed_in: true, api_host: new URL(apiBase(ctx.secrets)).host, apps: [] as unknown[], tenant_id: null as string | null, problem: null as unknown, created: null, create_error: null };
  const r = await api.listApps();
  if (!r.ok) return { ...base, problem: await problem(ctx, r) };
  return {
    ...base,
    tenant_id: r.value.apps[0]?.tenant_id ?? null,
    apps: r.value.apps.map((a) => ({
      name: a.name,
      live: a.active_deployment !== null,
      status: a.active_deployment === null ? "○ no live deployment" : "● live",
      version: shortHash(a.active_deployment),
      hostnames: a.hostnames.join(", "),
      url: a.hostnames[0] === undefined ? null : `https://${a.hostnames[0]}/`,
    })),
  };
}

export const actions = {
  async create(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const name = String(ctx.form.get("name") ?? "").trim();
    if (!/^[a-z][a-z0-9-]{0,49}$/u.test(name)) return { created: null, create_error: "A name is 1 to 50 lower-case letters, digits and dashes, starting with a letter." };
    const r = await api.createApp(name);
    if (!r.ok) {
      const p = await problem(ctx, r);
      return { created: null, create_error: p.details[0] ?? p.message };
    }
    return { created: name, create_error: null };
  },
};
