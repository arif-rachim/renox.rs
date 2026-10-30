// GET /apps/new, POST /apps/new: the first app from a starter template
// (docs/19-platform-wireframes.md 3.2; deploy-api.md 0.5 section 21,
// `createAppFromTemplate`; #326). The API creates the app, uploads the
// template's artifact and activates it; the page then shows the URL and the
// CLI commands to work on it locally.
import type { ActionContext, LoaderContext } from "renox";

import { apiBase } from "../../lib/api.ts";
import { problem, signedIn } from "../../lib/guard.ts";

/** deploy-api.yaml `createAppFromTemplate` `template`, with what each one is. */
export const TEMPLATES = [
  { id: "shop", name: "Shop", about: "Products, a cart and checkout, server-rendered pages" },
  { id: "hello", name: "Blank", about: "One function: GET /api/hello" },
  { id: "booking", name: "Booking", about: "Services, staff and slots (coming with the booking module)" },
  { id: "invoices", name: "Invoices", about: "FTA tax invoices (coming with the tax module)" },
] as const;
const NAME = /^[a-z][a-z0-9-]{0,49}$/u;

const quiet = { created: null as null | { app: string; url: string; hash: string; template: string }, form_error: null as string | null, action_problem: null as unknown, name: "", template: "shop" };

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  return { signed_in: true, impersonation: api.impersonation, api_host: new URL(apiBase(ctx.secrets)).host, templates: TEMPLATES, ...quiet };
}

export const actions = {
  async create(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const name = String(ctx.form.get("name") ?? "").trim();
    const template = String(ctx.form.get("template") ?? "");
    if (!NAME.test(name)) return { ...quiet, name, template, form_error: "A name is 1 to 50 lower-case letters, digits and dashes, starting with a letter." };
    if (!TEMPLATES.some((t) => t.id === template)) return { ...quiet, name, form_error: "Choose a template." };
    const r = await api.createAppFromTemplate(name, template);
    if (!r.ok) {
      const p = await problem(ctx, r);
      const why = r.status === 409 && JSON.stringify(r.details).includes("not available") ? "This template is not available yet; choose another." : r.status === 409 ? "That name is taken; choose another." : r.status === 503 ? "No server can take the app right now; try again in a minute." : null;
      return why === null ? { ...quiet, name, template, action_problem: p } : { ...quiet, name, template, form_error: why };
    }
    return { ...quiet, created: r.value };
  },
};
