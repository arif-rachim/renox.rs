// GET /apps/:app/domains: the app's custom domains with their state and, while
// one is pending, the records to create at the DNS provider: the CNAME to the
// platform's edge and the two TXT records (ownership, certificate validation).
// POST ?/add (hostname) and ?/remove (hostname): `domains:write` (owner and
// admin). Listing needs only `apps:read`. A hostname is served only once it is
// verified (deploy-api.md section 10, ADR D25); apex domains are not offered:
// the customer uses `www.` and redirects the bare domain at the registrar.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import type { Domain } from "../../../lib/api.ts";
import { appParam, frame, notFound, problem, signedIn } from "../../../lib/guard.ts";
import { trOf, type Tr } from "../../../lib/i18n.ts";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u;

/** The hostname lowercased when it is a DNS name of at least two labels, else null. The API checks the rest. */
export function hostnameOf(raw: unknown): string | null {
  const h = String(raw ?? "").trim().toLowerCase().replace(/\.$/u, "");
  const labels = h.split(".");
  return h.length <= 253 && labels.length >= 2 && labels.every((l) => LABEL.test(l)) ? h : null;
}

const STATES: Record<string, string> = { pending: "dash.domains.state_pending", verified: "dash.domains.state_verified", detached: "dash.domains.state_detached" };

/** One domain as the template shows it; the CNAME comes first, then Cloudflare's TXT records. */
export function view(d: Domain, tr: Tr) {
  const records = [
    { type: "CNAME", name: d.hostname, value: d.cname_target, purpose: tr("dash.domains.purpose_cname") },
    ...d.verification.map((v) => ({ type: v.type, name: v.name, value: v.value, purpose: tr(v.purpose === "ownership" ? "dash.domains.purpose_ownership" : "dash.domains.purpose_dcv") })),
  ];
  return {
    hostname: d.hostname,
    state: d.state,
    state_label: tr(STATES[d.state] ?? "dash.domains.state_pending"),
    status: d.status,
    ssl_status: d.ssl_status,
    pending: d.state === "pending",
    verified: d.state === "verified",
    detached: d.state === "detached",
    records,
  };
}

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const name = appParam(ctx.params.app);
  if (name === null) return notFound();
  const base = { ...frame(ctx, api, "apps"), app: name, section: "domains", notice: null, form_error: null, action_problem: null };
  const r = await api.listDomains(name);
  if (!r.ok) return { ...base, problem: await problem(ctx, r), domains: [] };
  const tr = trOf(ctx);
  return { ...base, problem: null, domains: r.value.domains.map((d) => view(d, tr)) };
}

const formError = (message: string) => ({ notice: null, form_error: message, action_problem: null });

export const actions = {
  async add(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const app = appParam(ctx.params.app);
    if (app === null) return notFound();
    const tr = trOf(ctx);
    const hostname = hostnameOf(ctx.form.get("hostname"));
    if (hostname === null) return formError(tr("dash.domains.err_hostname"));
    const r = await api.addDomain(app, hostname);
    if (!r.ok) return { notice: null, form_error: null, action_problem: await problem(ctx, r) };
    return { notice: tr("dash.domains.added", { hostname }), form_error: null, action_problem: null };
  },

  async remove(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const app = appParam(ctx.params.app);
    if (app === null) return notFound();
    const tr = trOf(ctx);
    const hostname = hostnameOf(ctx.form.get("hostname"));
    if (hostname === null) return formError(tr("dash.domains.err_hostname"));
    const r = await api.removeDomain(app, hostname);
    if (!r.ok) return { notice: null, form_error: null, action_problem: await problem(ctx, r) };
    return { notice: tr("dash.domains.removed", { hostname }), form_error: null, action_problem: null };
  },
};
