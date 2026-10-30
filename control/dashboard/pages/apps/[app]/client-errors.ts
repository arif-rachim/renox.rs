// GET /apps/:app/client-errors[?status=open|resolved|ignored|all][&deployment=<sha256>][&fp=<16 hex>]:
// the app's browser errors grouped by fingerprint (docs/19-platform-wireframes.md
// 3.5, `source: client`), with first/last seen, count per deployment, the
// original TypeScript position when a private sourcemap matched, and the
// client-event quota warning (80 % of the daily cap). With `fp`, the group's
// last events and their frames. POST ?/status: lib/client-errors.ts.
import type { LoaderContext } from "renox";

import { apiBase } from "../../../lib/api.ts";
import { clientErrorActions, eventRow, FINGERPRINT, groupRow, SPARK, STATUSES } from "../../../lib/client-errors.ts";
import { appParam, hashParam, notFound, problem, signedIn } from "../../../lib/guard.ts";
import { round } from "../../../lib/view.ts";

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const name = appParam(ctx.params.app);
  if (name === null) return notFound();
  const raw = ctx.url.searchParams.get("status");
  const status = (STATUSES as readonly string[]).includes(raw ?? "") ? (raw as (typeof STATUSES)[number]) : raw === "all" ? "all" : "open";
  const deployment = hashParam(ctx.url.searchParams.get("deployment"));
  const fpRaw = ctx.url.searchParams.get("fp");
  const fp = fpRaw !== null && FINGERPRINT.test(fpRaw) ? fpRaw : null;
  const now = Date.now();
  const base = {
    signed_in: true, impersonation: api.impersonation,
    api_host: new URL(apiBase(ctx.secrets)).host,
    app: name,
    section: "client-errors",
    notice: null,
    action_problem: null,
    status,
    statuses: ["open", "resolved", "ignored", "all"],
    deployment,
    spark: SPARK,
    quota: null as { used: string; cap: string; warning: boolean } | null,
  };
  const [list, one, usage] = await Promise.all([
    api.clientErrors(name, { ...(status === "all" ? {} : { status }), ...(deployment === null ? {} : { deployment }) }),
    fp === null ? null : api.clientError(name, fp),
    api.usage(name, now - 3_600_000, now),
  ]);
  if (!list.ok) return { ...base, problem: await problem(ctx, list), groups: [], detail: null, detail_problem: null };
  // The quota warning is a courtesy: a usage failure does not hide the errors.
  const q = usage.ok ? usage.value.client_events : undefined;
  const quota = q === undefined ? null : { used: round(q.used_today), cap: round(q.daily_cap), warning: q.warning };
  let detail = null;
  let detailProblem = null;
  if (one !== null) {
    if (!one.ok) detailProblem = await problem(ctx, one);
    else detail = { group: groupRow(one.value.group, name, now), events: one.value.events.map((e) => eventRow(e, name, now)) };
  }
  return { ...base, quota, problem: null, groups: list.value.groups.map((g) => groupRow(g, name, now)), detail, detail_problem: detailProblem };
}

export const actions = { status: clientErrorActions.status };
