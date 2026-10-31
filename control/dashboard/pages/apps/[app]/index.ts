// GET /apps/:app: the app overview (docs/19-platform-wireframes.md, 3.3):
// status, live version and hostnames, the last 24 hours of usage, recent
// deployments with promote and rollback, the latest log lines.
import type { LoaderContext } from "renox";

import { apiBase } from "../../../lib/api.ts";
import { deployActions } from "../../../lib/deploy-actions.ts";
import { appParam, notFound, problem, signedIn } from "../../../lib/guard.ts";
import { trOf } from "../../../lib/i18n.ts";
import { ago, bytes, clock, deploymentRows, round, shortHash } from "../../../lib/view.ts";

const DAY_MS = 24 * 3600 * 1000;

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const name = appParam(ctx.params.app);
  if (name === null) return notFound();
  const now = Date.now();
  const base = {
    signed_in: true, impersonation: api.impersonation,
    api_host: new URL(apiBase(ctx.secrets)).host,
    app: name,
    section: "overview",
    notice: null,
    action_problem: null,
  };
  const [app, deployments, usage, logs] = await Promise.all([
    api.getApp(name),
    api.listDeployments(name, 5),
    api.usage(name, now - DAY_MS, now),
    api.logs(name, { since: now - DAY_MS }),
  ]);
  if (!app.ok) return { ...base, problem: await problem(ctx, app), info: null, deployments: [], usage: null, logs: [], logs_problem: null, deployments_problem: null };
  const tr = trOf(ctx);
  const live = deployments.ok ? deployments.value.deployments.find((d) => d.state === "active") : undefined;
  return {
    ...base,
    problem: null,
    info: {
      live: app.value.active_deployment !== null,
      status: tr(app.value.active_deployment === null ? "dash.state.no_live" : "dash.state.active"),
      version: shortHash(app.value.active_deployment),
      deployed: live?.activated_at == null ? "—" : ago(live.activated_at, now, tr),
      hostnames: app.value.hostnames,
      url: app.value.hostnames[0] === undefined ? null : `https://${app.value.hostnames[0]}/`,
    },
    deployments: deployments.ok ? deploymentRows(deployments.value.deployments, now, tr) : [],
    deployments_problem: deployments.ok ? null : await problem(ctx, deployments),
    usage: usage.ok
      ? {
          requests: round(usage.value.total.requests),
          cpu: `${round(usage.value.total.cpu_ms)} ms`,
          egress: bytes(usage.value.total.egress_bytes),
          over: usage.value.quota.over.join(", "),
        }
      : null,
    logs: logs.ok
      ? logs.value
          .slice(-8)
          .reverse()
          .map((l) => ({ when: clock(l.ts).slice(11), level: l.level.toUpperCase(), request_id: l.request_id ?? "", message: l.message.slice(0, 300) }))
      : [],
    logs_problem: logs.ok ? null : await problem(ctx, logs),
  };
}

export const actions = { activate: deployActions.activate, rollback: deployActions.rollback };
