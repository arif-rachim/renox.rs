// GET /apps/:app: the app overview (docs/19-platform-wireframes.md, 3.3;
// #427): the finding, the app's real path as a diagram (hostname, edge, the
// cell with its isolate and SQLite, the live hash), the last 24 hours of
// usage as dot-matrix numbers, recent deployments with promote and rollback,
// the latest log lines in a console panel.
import type { LoaderContext } from "@renoxium/sdk";

import { deployActions } from "../../../lib/deploy-actions.ts";
import { appParam, frame, notFound, problem, signedIn } from "../../../lib/guard.ts";
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
    ...frame(ctx, api, "apps"),
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
  if (!app.ok) return { ...base, problem: await problem(ctx, app), info: null, finding: null, live_row: null, deployments: [], usage: null, logs: [], logs_problem: null, deployments_problem: null };
  const tr = trOf(ctx);
  const live = deployments.ok ? deployments.value.deployments.find((d) => d.state === "active") : undefined;
  const rows = deployments.ok ? deploymentRows(deployments.value.deployments, now, tr) : [];
  // The screen's finding (taste-skill app-screens 2.2): the errors of the last 24 hours, newest first,
  // read before anything else; a quiet line when there are none, nothing when the logs did not load.
  const errors = logs.ok ? logs.value.filter((l) => l.level === "error") : [];
  const latest = errors.at(-1);
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
    finding: !logs.ok
      ? null
      : latest === undefined
        ? { bad: false, text: tr("dash.overview.no_errors"), href: null }
        : {
            bad: true,
            text: tr("dash.overview.errors_24h", { n: errors.length, when: ago(latest.ts, now, tr), message: latest.message.slice(0, 160) }),
            href: `/apps/${name}/logs?level=error&window=24h`,
          },
    live_row: rows.find((r) => r.state === "active") ?? null,
    deployments: rows,
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
          .map((l) => ({ when: clock(l.ts).slice(11), level: l.level, level_class: l.level === "error" ? "bad" : l.level === "warn" ? "warn" : "quiet", request_id: l.request_id ?? "", message: l.message.slice(0, 300) }))
      : [],
    logs_problem: logs.ok ? null : await problem(ctx, logs),
  };
}

export const actions = { activate: deployActions.activate, rollback: deployActions.rollback };
