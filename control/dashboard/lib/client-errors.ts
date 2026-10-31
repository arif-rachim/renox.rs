// Browser errors (docs/19-platform-wireframes.md 3.5; deploy-api.md section
// 11.1; #128): the rows the page shows for error groups, their frames with
// the original TypeScript position when a private sourcemap matched, the
// per-deployment sparkline, and the status action. Event text is untrusted
// (anyone can post to the client-events endpoint): everything here is plain
// strings that the templates escape.

import type { ActionContext } from "renox";

import type { ClientErrorEvent, ClientErrorFrame, ClientErrorGroup, ClientErrorStatus } from "./api.ts";
import { appParam, problem, refusal, signedIn } from "./guard.ts";
import { EN, trOf, type Tr } from "./i18n.ts";
import { ago, clock, round, shortHash } from "./view.ts";

export const STATUSES = ["open", "resolved", "ignored"] as const;
export const FINGERPRINT = /^[0-9a-f]{16}$/u;

export const SPARK = { width: 120, height: 24, gap: 1 } as const;

export interface SparkBar {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

/** One bar per deployment, oldest first (the API lists the newest first), scaled to the largest count. */
export function sparkline(deployments: ClientErrorGroup["deployments"]): SparkBar[] {
  const ordered = [...deployments].reverse().slice(-24);
  const max = Math.max(1, ...ordered.map((d) => d.count));
  const width = SPARK.width / Math.max(1, ordered.length);
  return ordered.map((d, i) => {
    const height = Math.max(1, Math.round((d.count / max) * (SPARK.height - 2) * 10) / 10);
    return { x: Math.round(i * width * 10) / 10, y: Math.round((SPARK.height - height) * 10) / 10, width: Math.max(1, Math.round((width - SPARK.gap) * 10) / 10), height, label: `${shortHash(d.deployment_hash)}: ${round(d.count)}` };
  });
}

/** `islands/cart.ts:57:12` when the frame was mapped, else the raw `file:line:column`. */
export function frameText(f: ClientErrorFrame): { text: string; mapped: boolean; raw: string; function: string } {
  const raw = `${f.file}:${f.line}:${f.column}`;
  const o = f.original;
  return { text: o === null ? raw : `${o.file}:${o.line}:${o.column}`, mapped: o !== null, raw, function: f.function ?? "(anonymous)" };
}

export function groupRow(g: ClientErrorGroup, app: string, now: number, tr: Tr = EN) {
  return {
    fingerprint: g.fingerprint,
    kind: g.kind,
    message: g.message,
    status: g.status,
    count: round(g.count),
    first: `${clock(g.first_seen)} UTC`,
    last: ago(g.last_seen, now, tr),
    regressed: g.regressed,
    url: `/apps/${app}/client-errors?fp=${g.fingerprint}`,
    top: g.top_frame === null ? null : frameText(g.top_frame),
    spark: sparkline(g.deployments),
    deployments: g.deployments.map((d) => ({ hash: shortHash(d.deployment_hash), full: d.deployment_hash, count: round(d.count) })),
    can_resolve: g.status !== "resolved",
    can_ignore: g.status !== "ignored",
    can_reopen: g.status !== "open",
  };
}

export function eventRow(e: ClientErrorEvent, app: string, now: number, tr: Tr = EN) {
  return {
    when: tr("dash.common.utc_ago", { at: clock(e.ts), ago: ago(e.ts, now, tr) }),
    message: e.message,
    url: e.url,
    browser: e.ua,
    deployment: shortHash(e.deployment_hash),
    request_id: e.request_id ?? "—",
    // The server lines and the trace of the same request (the Logs search matches request ids).
    request_url: e.request_id === null ? null : `/apps/${app}/logs?q=${encodeURIComponent(e.request_id)}&window=7d`,
    frames: e.frames.map(frameText),
  };
}

const bad = (ctx: ActionContext, code: string, key: string, status: number) => ({ notice: null, action_problem: refusal(ctx, code, key, status) });

export const clientErrorActions = {
  /** POST ?/status with `fingerprint` and `status` (`apps:write`; the API audits it). */
  async status(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const app = appParam(ctx.params.app);
    const fingerprint = String(ctx.form.get("fingerprint") ?? "");
    const status = String(ctx.form.get("status") ?? "");
    if (app === null) return bad(ctx, "RENOX_NOT_FOUND", "dash.problem.no_app", 404);
    if (!FINGERPRINT.test(fingerprint) || !(STATUSES as readonly string[]).includes(status)) return bad(ctx, "RENOX_VALIDATION", "dash.errors.no_group", 400);
    const r = await api.setClientErrorStatus(app, fingerprint, status as ClientErrorStatus);
    if (!r.ok) return { notice: null, action_problem: await problem(ctx, r) };
    return { notice: trOf(ctx)(status === "open" ? "dash.errors.reopened" : status === "resolved" ? "dash.errors.resolved_notice" : "dash.errors.ignored"), action_problem: null };
  },
};
