// GET /apps/:app/database: size, quota, WAL, replication status and lag, the
// restore points, and the export (docs/19-platform-wireframes.md 3.8;
// lib/database.ts; #258).
// POST ?/export: answers the signed URL as a download link; the browser
// fetches the file from it, the dashboard never proxies the bytes.
// POST ?/restore (generation, at, name): restores the database as of `at`
// (UTC) into a new app and links to it; the form asks for a confirmation.
import type { ActionContext, LoaderContext } from "renox";

import { apiBase } from "../../../lib/api.ts";
import { databaseView, exportBackup, getBackups, parseLocal, restoreBackup } from "../../../lib/database.ts";
import { appParam, notFound, problem, signedIn } from "../../../lib/guard.ts";
import { bytes, clock } from "../../../lib/view.ts";

const APP_NAME = /^[a-z][a-z0-9-]{0,49}$/u;
const quiet = { notice: null, form_error: null, action_problem: null, download: null, restored: null };

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const name = appParam(ctx.params.app);
  if (name === null) return notFound();
  const base = { signed_in: true, impersonation: api.impersonation, api_host: new URL(apiBase(ctx.secrets)).host, app: name, section: "database", ...quiet };
  const r = await getBackups(api, name);
  if (!r.ok) return { ...base, problem: await problem(ctx, r), view: null };
  return { ...base, problem: null, view: databaseView(r.value, Date.now()) };
}

const formError = (message: string) => ({ ...quiet, form_error: message });

export const actions = {
  async export(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const app = appParam(ctx.params.app);
    if (app === null) return notFound();
    const r = await exportBackup(api, app);
    if (!r.ok) return { ...quiet, action_problem: await problem(ctx, r) };
    const e = r.value;
    return {
      ...quiet,
      download: { url: e.url, file: `${app}-${new Date(e.created_at).toISOString().slice(0, 19).replace(/[-:]/gu, "")}.db`, size: bytes(e.size_bytes), sha256: e.sha256, expires: `${clock(e.expires_at).slice(0, 16)} UTC` },
    };
  },

  async restore(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const app = appParam(ctx.params.app);
    if (app === null) return notFound();
    const at = parseLocal(String(ctx.form.get("at") ?? ""));
    const target = String(ctx.form.get("name") ?? "").trim();
    if (at === null) return formError("Pick a restore time (UTC).");
    if (!APP_NAME.test(target)) return formError("The new app's name is lower-case letters, digits and -, starting with a letter (at most 50).");
    if (target === app) return formError("The restore goes into a new app; pick another name.");
    const r = await restoreBackup(api, app, at, target);
    if (!r.ok) return { ...quiet, action_problem: await problem(ctx, r) };
    const n = r.value.app.name;
    return {
      ...quiet,
      notice: `Restored ${app} as of ${clock(r.value.restored_to ?? at).slice(0, 19)} UTC into ${n} (deployment ${r.value.deployment.state}).`,
      restored: { name: n, href: `/apps/${n}` },
    };
  },
};
