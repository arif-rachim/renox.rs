// GET /usage: the last 24 hours of every app of the tenant (#427): requests,
// CPU and egress per app from `usage` (deploy-api.md section 12), and their
// totals as dot-matrix numbers. The per-hour view is each app's own page.
import type { LoaderContext } from "@renoxium/sdk";

import { frame, problem, signedIn } from "../lib/guard.ts";
import { bytes, round } from "../lib/view.ts";

const DAY_MS = 24 * 3600 * 1000;
/** How many apps are read: one usage call each. */
const MAX_APPS = 50;

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const base = { ...frame(ctx, api, "usage"), apps: [] as unknown[], totals: null as unknown, problem: null as unknown };
  const list = await api.listApps();
  if (!list.ok) return { ...base, problem: await problem(ctx, list) };
  const now = Date.now();
  const usages = await Promise.all(list.value.apps.slice(0, MAX_APPS).map(async (a) => ({ app: a.name, usage: await api.usage(a.name, now - DAY_MS, now) })));
  const failed = usages.find((u) => !u.usage.ok);
  if (failed !== undefined && !failed.usage.ok) return { ...base, problem: await problem(ctx, failed.usage) };
  const rows = usages.map((u) => ({ name: u.app, total: u.usage.ok ? u.usage.value.total : { requests: 0, cpu_ms: 0, egress_bytes: 0 } }));
  const sum = (f: (t: (typeof rows)[number]["total"]) => number) => rows.reduce((n, r) => n + f(r.total), 0);
  return {
    ...base,
    tenant_id: list.value.apps[0]?.tenant_id ?? null,
    apps: rows.map((r) => ({ name: r.name, requests: round(r.total.requests), cpu: `${round(r.total.cpu_ms)} ms`, egress: bytes(r.total.egress_bytes) })),
    totals: { requests: round(sum((t) => t.requests)), cpu: `${round(Math.round(sum((t) => t.cpu_ms) / 1000))} s`, egress: bytes(sum((t) => t.egress_bytes)).replace(/\.\d+/u, "") },
  };
}
