// GET /apps/:app/secrets: secret names and update times, never values
// (docs/19-platform-wireframes.md, 3.9; `secrets:read` lists names only).
// POST ?/set (name, value) and ?/remove (name): `secrets:write`. A value
// passes through this action once, on its way to the API, and is never
// logged, stored, or rendered back; a new value is used from the next
// deploy or rollback (deploy-api.md section 9).
import type { ActionContext, LoaderContext } from "renox";

import { apiBase } from "../../../lib/api.ts";
import { appParam, notFound, problem, signedIn } from "../../../lib/guard.ts";
import { trOf } from "../../../lib/i18n.ts";
import { ago } from "../../../lib/view.ts";

/** deploy-api.yaml `SecretName`. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const name = appParam(ctx.params.app);
  if (name === null) return notFound();
  const now = Date.now();
  const base = { signed_in: true, impersonation: api.impersonation, api_host: new URL(apiBase(ctx.secrets)).host, app: name, section: "secrets", notice: null, form_error: null, action_problem: null };
  const r = await api.listSecrets(name);
  if (!r.ok) return { ...base, problem: await problem(ctx, r), version: null, secrets: [] };
  return {
    ...base,
    problem: null,
    version: r.value.version,
    secrets: r.value.secrets.map((s) => ({ name: s.name, updated: ago(s.updated_at, now, trOf(ctx)) })),
  };
}

const formError = (message: string) => ({ notice: null, form_error: message, action_problem: null });

export const actions = {
  async set(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const app = appParam(ctx.params.app);
    if (app === null) return notFound();
    const name = String(ctx.form.get("name") ?? "").trim();
    const raw = ctx.form.get("value");
    const value = typeof raw === "string" ? raw : "";
    const tr = trOf(ctx);
    if (!SECRET_NAME.test(name)) return formError(tr("dash.secrets.err_name"));
    // ops.md section 3: at least 8 characters and 8 bytes, at most 64 KiB.
    if (value.length < 8 || new TextEncoder().encode(value).length < 8 || value.length > 65_536) return formError(tr("dash.secrets.err_value"));
    const r = await api.putSecret(app, name, value);
    if (!r.ok) return { notice: null, form_error: null, action_problem: await problem(ctx, r) };
    return { notice: tr("dash.secrets.saved", { name, version: r.value.version }), form_error: null, action_problem: null };
  },

  async remove(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const app = appParam(ctx.params.app);
    if (app === null) return notFound();
    const name = String(ctx.form.get("name") ?? "");
    if (!SECRET_NAME.test(name)) return formError(trOf(ctx)("dash.secrets.err_none"));
    const r = await api.deleteSecret(app, name);
    if (!r.ok) return { notice: null, form_error: null, action_problem: await problem(ctx, r) };
    return { notice: trOf(ctx)("dash.secrets.deleted", { name, version: r.value.version }), form_error: null, action_problem: null };
  },
};
