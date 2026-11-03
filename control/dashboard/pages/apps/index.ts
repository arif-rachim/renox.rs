// GET /apps: the overview (docs/19-platform-wireframes.md, 3.1 Org
// overview; #427): the tenant's name as the hero word, a card row of stats
// from real data only (apps live, requests today, storage used), and a card
// per app. POST ?/create: a new app (3.2), `apps:write`.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import type { Api, App } from "../../lib/api.ts";
import { getBackups } from "../../lib/database.ts";
import { frame, problem, signedIn } from "../../lib/guard.ts";
import { trOf } from "../../lib/i18n.ts";
import { bytes, round, shortHash } from "../../lib/view.ts";

/** How many apps the stats are summed over: one usage and one backups call each. */
const STATS_APPS = 20;

export interface Stats {
  apps_live: string;
  requests_today: string;
  storage: string;
}

/** The stats of the card row: real numbers, or "—" where a call failed. Whole numbers, as the dot face asks. */
export async function stats(api: Api, apps: App[], now: number): Promise<Stats> {
  const live = apps.filter((a) => a.active_deployment !== null).length;
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const some = apps.slice(0, STATS_APPS);
  const [usages, backups] = await Promise.all([Promise.all(some.map((a) => api.usage(a.name, dayStart, now))), Promise.all(some.map((a) => getBackups(api, a.name)))]);
  const sum = <T,>(rs: ({ ok: true; value: T } | { ok: false })[], f: (v: T) => number): number | null => {
    if (rs.some((r) => !r.ok)) return null;
    return rs.reduce((n, r) => n + (r.ok ? f(r.value) : 0), 0);
  };
  const requests = sum(usages, (u) => u.total.requests);
  const storage = sum(backups, (b) => b.db.size_bytes);
  return {
    apps_live: String(live),
    requests_today: requests === null ? "—" : round(requests),
    storage: storage === null ? "—" : bytes(storage).replace(/\.\d+/u, ""),
  };
}

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const base = { ...frame(ctx, api, "apps"), apps: [] as unknown[], tenant_id: null as string | null, stats: null as Stats | null, problem: null as unknown, created: null, create_error: null };
  const r = await api.listApps();
  if (!r.ok) return { ...base, problem: await problem(ctx, r) };
  const tr = trOf(ctx);
  return {
    ...base,
    tenant_id: r.value.apps[0]?.tenant_id ?? null,
    stats: await stats(api, r.value.apps, Date.now()),
    apps: r.value.apps.map((a) => ({
      name: a.name,
      live: a.active_deployment !== null,
      status: tr(a.active_deployment === null ? "dash.state.no_live" : "dash.state.active"),
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
    if (!/^[a-z][a-z0-9-]{0,49}$/u.test(name)) return { created: null, create_error: trOf(ctx)("dash.apps.err_name") };
    const r = await api.createApp(name);
    if (!r.ok) {
      const p = await problem(ctx, r);
      return { created: null, create_error: p.details[0] ?? p.message };
    }
    return { created: name, create_error: null };
  },
};
