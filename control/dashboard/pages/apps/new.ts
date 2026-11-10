// GET /apps/new, POST /apps/new: the first app from a starter template
// (docs/19-platform-wireframes.md 3.2; deploy-api.md 0.5 section 21,
// `createAppFromTemplate`; #326). The API creates the app, uploads the
// template's artifact and activates it; the page then shows the URL and the
// CLI commands to work on it locally.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { platformDomain } from "../../lib/api.ts";
import { frame, problem, signedIn } from "../../lib/guard.ts";
import { trOf, type Tr } from "../../lib/i18n.ts";
import { INSTALL_URL } from "../../lib/install.ts";

/**
 * The starters offered here (#447): only those the API can create
 * (deploy-api.yaml `createAppFromTemplate` `template`) **and** `renox new
 * --template` can write, because the page then tells the user to run that
 * command. Today that is `hello`; `shop`, `booking` and `invoices` come back
 * when the CLI has them (tests/copy.test.ts compares the lists). What each
 * one is comes from `dash.new.about_<id>`.
 */
export const TEMPLATES = [{ id: "hello", name: "Hello" }] as const;

/**
 * home-services with its setup (#689): the company, branches, services and
 * first people in one form. It is its own form, not a radio of `TEMPLATES`:
 * the API reads more fields for it and calls the app's /api/setup.
 */
export const HOME_SERVICES = { id: "home-services", name: "Home services" } as const;
export const EMIRATES = ["abu_dhabi", "dubai", "sharjah", "ajman", "umm_al_quwain", "ras_al_khaimah", "fujairah"] as const;
const emirates = EMIRATES.map((id) => ({ id, name: id.split("_").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ") }));

/** Lines of `text`, trimmed, without empty ones; each split at its commas. */
const rows = (text: string): string[][] => text.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l !== "").map((l) => l.split(",").map((c) => c.trim()));

/**
 * The form's setup object for the API, or the message key of what is wrong.
 * The API validates every limit again (deploy-api.md section 21).
 */
export function setupFromForm(form: { get(name: string): unknown }): { setup: unknown } | { error: string } {
  const field = (n: string): string => String(form.get(n) ?? "").trim();
  const emirate = field("company_emirate");
  const price = (s: string | undefined): number => (s !== undefined && /^[0-9]+(\.[0-9]{1,2})?$/u.test(s) ? Number(s) : Number.NaN);
  const branches = rows(field("branches")).map(([name, e]) => ({ name: name ?? "", emirate: e === undefined || e === "" ? emirate : e }));
  const services = rows(field("services")).map(([name, p]) => ({ name: name ?? "", price_aed: price(p) }));
  if (services.some((s) => Number.isNaN(s.price_aed))) return { error: "dash.new.hs_err_services" };
  const people = rows(field("people")).map(([email, role]) => ({ email: email ?? "", role: role ?? "" }));
  const trn = field("company_trn");
  return { setup: { company: { name: field("company_name"), ...(trn === "" ? {} : { trn }), phone: field("company_phone"), emirate }, branches, services, people } };
}

const templates = (tr: Tr) => TEMPLATES.map((t) => ({ ...t, about: tr(`dash.new.about_${t.id}`) }));
const NAME = /^[a-z][a-z0-9-]{0,49}$/u;

const quiet = {
  created: null as null | { app: string; url: string; hash: string; template: string; invited?: { email: string; role?: string }[] },
  form_error: null as string | null,
  action_problem: null as unknown,
  name: "",
  template: "hello",
  /** The app that exists although its setup did not complete (RENOX_SETUP_FAILED). */
  partial: null as null | { app: string; url: string },
  hs: {} as Record<string, string>,
};

const homeServices = (tr: Tr) => ({ ...HOME_SERVICES, about: tr("dash.new.about_home_services") });

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  return { ...frame(ctx, api, "apps"), platform_domain: platformDomain(ctx.secrets), templates: templates(trOf(ctx)), home_services: homeServices(trOf(ctx)), emirates, install_url: INSTALL_URL, ...quiet };
}

export const actions = {
  async create(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const name = String(ctx.form.get("name") ?? "").trim();
    const template = String(ctx.form.get("template") ?? "");
    const tr = trOf(ctx);
    const base = { ...quiet, platform_domain: platformDomain(ctx.secrets), install_url: INSTALL_URL };
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

  /** home-services with the company's own setup (#689). */
  async create_home_services(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const name = String(ctx.form.get("name") ?? "").trim();
    const tr = trOf(ctx);
    const hs = Object.fromEntries(["company_name", "company_trn", "company_phone", "company_emirate", "branches", "services", "people"].map((k) => [k, String(ctx.form.get(k) ?? "")]));
    const base = { ...quiet, platform_domain: platformDomain(ctx.secrets), install_url: INSTALL_URL, home_services: homeServices(tr), emirates, name, hs };
    if (!NAME.test(name)) return { ...base, form_error: tr("dash.apps.err_name") };
    const parsed = setupFromForm(ctx.form);
    if ("error" in parsed) return { ...base, form_error: tr(parsed.error) };
    const r = await api.createAppFromTemplate(name, HOME_SERVICES.id, parsed.setup);
    if (!r.ok) {
      if (r.status === 502 && r.code === "RENOX_SETUP_FAILED") return { ...base, form_error: tr("dash.new.hs_err_setup_failed"), partial: { app: name, url: `https://${name}.${platformDomain(ctx.secrets)}` } };
      const p = await problem(ctx, r);
      const why = r.status === 409 && JSON.stringify(r.details).includes("not available") ? tr("dash.new.err_unavailable") : r.status === 409 ? tr("dash.new.err_taken") : r.status === 503 ? tr("dash.new.err_busy") : null;
      return why === null ? { ...base, action_problem: p } : { ...base, form_error: why };
    }
    return { ...base, created: { ...r.value, invited: r.value.setup?.invited ?? [] } };
  },
};
