// GET /apps/new, POST /apps/new: the first app from a starter template
// (docs/19-platform-wireframes.md 3.2; deploy-api.md 0.5 section 21,
// `createAppFromTemplate`; #326). The API creates the app, uploads the
// template's artifact and activates it; the page then shows the URL and the
// CLI commands to work on it locally.
import type { ActionContext, LoaderContext } from "renox";

import { platformDomain } from "../../lib/api.ts";
import { frame, problem, signedIn } from "../../lib/guard.ts";
import { trOf, type Tr } from "../../lib/i18n.ts";

/** deploy-api.yaml `createAppFromTemplate` `template`; what each one is comes from `dash.new.about_<id>`. */
export const TEMPLATES = [
  { id: "shop", name: "Shop" },
  { id: "hello", name: "Blank" },
  { id: "booking", name: "Booking" },
  { id: "invoices", name: "Invoices" },
] as const;

const templates = (tr: Tr) => TEMPLATES.map((t) => ({ ...t, about: tr(`dash.new.about_${t.id}`) }));
const NAME = /^[a-z][a-z0-9-]{0,49}$/u;

const quiet = { created: null as null | { app: string; url: string; hash: string; template: string }, form_error: null as string | null, action_problem: null as unknown, name: "", template: "shop" };

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  return { ...frame(ctx, api, "apps"), platform_domain: platformDomain(ctx.secrets), templates: templates(trOf(ctx)), ...quiet };
}

export const actions = {
  async create(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const name = String(ctx.form.get("name") ?? "").trim();
    const template = String(ctx.form.get("template") ?? "");
    const tr = trOf(ctx);
    const base = { ...quiet, platform_domain: platformDomain(ctx.secrets) };
    if (!NAME.test(name)) return { ...base, name, template, form_error: tr("dash.apps.err_name") };
    if (!TEMPLATES.some((t) => t.id === template)) return { ...base, name, form_error: tr("dash.new.err_template") };
    const r = await api.createAppFromTemplate(name, template);
    if (!r.ok) {
      const p = await problem(ctx, r);
      const why = r.status === 409 && JSON.stringify(r.details).includes("not available") ? tr("dash.new.err_unavailable") : r.status === 409 ? tr("dash.new.err_taken") : r.status === 503 ? tr("dash.new.err_busy") : null;
      return why === null ? { ...base, name, template, action_problem: p } : { ...base, name, template, form_error: why };
    }
    return { ...base, created: r.value };
  },
};
