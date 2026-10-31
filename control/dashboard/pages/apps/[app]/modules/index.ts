// GET /apps/:app/modules: installed modules with their versions and the
// upgrades the registry has, the disabled banner, and the registry cards
// (docs/19-platform-wireframes.md 3.7; deploy-api.md 0.5 section 19; #324).
// `?q=` searches the registry.
// POST ?/review (publisher, name, version): what the version asks for before
// anything is written. For an installed module it is the upgrade review with
// the four sections (permission changes, migrations, contract, templates
// that may touch the tenant's overrides); otherwise the permission review of
// an install. POST ?/install (publisher, name, version, hash): approves
// exactly the request that was reviewed. The page re-reads the version and
// refuses if its hash is not the reviewed one; the API refuses an approval
// that is not the version's own request (docs/24 section D, "Marketplace
// module unsigned or permission diff on upgrade").
import type { ActionContext, LoaderContext } from "renox";

import { apiBase, type AppModule, type ModulePermissions, type RegistryVersion } from "../../../../lib/api.ts";
import { appParam, notFound, problem, signedIn } from "../../../../lib/guard.ts";
import { EN, trOf, type Tr } from "../../../../lib/i18n.ts";
import { ago } from "../../../../lib/view.ts";

/** deploy-api.yaml `PublisherName`, `ModuleName`, `ModuleVersion`. */
export const PUBLISHER = /^[a-z0-9][a-z0-9-]{0,38}$/u;
export const MODULE = /^[a-z][a-z0-9_]{0,31}$/u;
export const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u;
const HASH = /^[0-9a-f]{64}$/u;

/** One line per thing a version asks for, for the template. */
export function permissionLines(p: ModulePermissions): string[] {
  return [
    ...(p.tables === undefined ? [] : [`tables ${p.tables}`]),
    ...p.network.map((n) => `network ${n}`),
    ...p.secrets.map((n) => `secret ${n}`),
    ...p.slots.map((n) => `slot ${n}`),
    ...p.hooks.map((n) => `hook ${n}`),
    ...(p.roles ?? []).map((n) => `role ${n}`),
  ];
}

const sourceOf = (v: { publisher: string; name: string }): string => `registry:${v.publisher}/${v.name}`;
const price = (v: RegistryVersion): string | null => (v.price === null ? null : `${v.price.amount} ${v.price.currency} / ${v.price.period}`);

/** Semver order, a prerelease before its release (the API's own order for "newest"). */
function newer(a: string, b: string): boolean {
  const key = (v: string): number[] => {
    const [core, pre] = v.split("-", 2) as [string, string | undefined];
    return [...core.split(".").map(Number), pre === undefined ? 1 : 0];
  };
  const [x, y] = [key(a), key(b)];
  for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** Finished rows for the template (it calls no functions). */
export function installedView(items: AppModule[], registry: RegistryVersion[], now: number, tr: Tr = EN) {
  return items.map((m) => {
    const latest = registry.find((r) => sourceOf(r) === m.source);
    const upgrade = latest !== undefined && newer(latest.version, m.version) ? latest.version : null;
    const [publisher, name] = m.source.replace(/^registry:/u, "").split("/") as [string, string];
    return {
      name: m.name,
      source: m.source,
      publisher,
      module: name,
      version: m.version,
      approved: permissionLines(m.approved),
      approved_at: ago(m.approved_at, now, tr),
      upgrade,
      status: m.disabled !== null ? tr("dash.modules.status_disabled", { reason: m.disabled.reason }) : upgrade !== null ? tr("dash.modules.status_upgrade", { version: upgrade }) : tr("dash.modules.status_current"),
      disabled: m.disabled !== null,
    };
  });
}

export function cardsView(items: RegistryVersion[]) {
  return items.map((v) => ({
    publisher: v.publisher,
    name: v.name,
    version: v.version,
    description: v.description ?? "",
    isolation: v.isolation,
    price: price(v),
    signed: v.key_id,
  }));
}

const quiet = { review: null, notice: null as string | null, form_error: null as string | null, action_problem: null };

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const app = appParam(ctx.params.app);
  if (app === null) return notFound();
  const q = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const base = { signed_in: true, impersonation: api.impersonation, api_host: new URL(apiBase(ctx.secrets)).host, app, section: "modules", q };
  const [installed, registry] = await Promise.all([api.listAppModules(app), api.listRegistry(q)]);
  if (!installed.ok) return { ...base, problem: await problem(ctx, installed), installed: [], disabled: null, cards: [] };
  // The upgrade check reads the whole registry, not the search result.
  const all = q === "" ? registry : await api.listRegistry();
  const latest = all.ok ? all.value.items : [];
  const rows = installedView(installed.value.items, latest, Date.now(), trOf(ctx));
  return {
    ...base,
    problem: registry.ok ? null : await problem(ctx, registry),
    installed: rows,
    // The banner's lines, or null (the template has no length test).
    disabled: rows.some((r) => r.disabled) ? rows.filter((r) => r.disabled).map((r) => `${r.name} ${r.version} (${r.status})`) : null,
    cards: registry.ok ? cardsView(registry.value.items) : [],
  };
}

function target(ctx: ActionContext): { publisher: string; name: string; version: string } | null {
  const publisher = String(ctx.form.get("publisher") ?? "");
  const name = String(ctx.form.get("name") ?? "");
  const version = String(ctx.form.get("version") ?? "");
  return PUBLISHER.test(publisher) && MODULE.test(name) && VERSION.test(version) ? { publisher, name, version } : null;
}

export const actions = {
  async review(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const app = appParam(ctx.params.app);
    if (app === null) return notFound();
    const t = target(ctx);
    if (t === null) return { ...quiet, form_error: trOf(ctx)("dash.modules.err_version") };
    const v = await api.getModuleVersion(t.publisher, t.name, t.version);
    if (!v.ok) return { ...quiet, action_problem: await problem(ctx, v) };
    if (v.value.disabled !== null) return { ...quiet, form_error: trOf(ctx)("dash.modules.err_disabled", { name: t.name, version: t.version, reason: v.value.disabled.reason }) };
    const installed = await api.listAppModules(app);
    if (!installed.ok) return { ...quiet, action_problem: await problem(ctx, installed) };
    const current = installed.value.items.find((m) => m.source === sourceOf(t));
    const review = {
      publisher: t.publisher,
      name: t.name,
      version: t.version,
      hash: v.value.hash,
      key_id: v.value.key_id,
      isolation: v.value.isolation,
      price: price(v.value),
      from: current?.version ?? null,
      // An install: everything the version asks for.
      asks: permissionLines(v.value.permissions),
      added: [] as string[],
      removed: [] as string[],
      migrations: [] as string[],
      migration_count: v.value.migrations,
      contract: null as string | null,
      templates: [] as string[],
      no_change: true,
    };
    if (current !== undefined && current.version !== t.version) {
      const d = await api.diffModule(t.publisher, t.name, current.version, t.version);
      if (!d.ok) return { ...quiet, action_problem: await problem(ctx, d) };
      const side = (s: typeof d.value.permissions.added): ModulePermissions => ({ ...(s.tables === null ? {} : { tables: s.tables }), network: s.network, secrets: s.secrets, slots: s.slots, hooks: s.hooks, roles: s.roles });
      review.added = permissionLines(side(d.value.permissions.added));
      review.removed = permissionLines(side(d.value.permissions.removed));
      review.migrations = d.value.migrations;
      review.contract = d.value.contract.ops_from === null && d.value.contract.ops_to === null ? null : `ops ${d.value.contract.ops_from ?? "?"} → ${d.value.contract.ops_to ?? "?"}`;
      review.templates = d.value.templates;
      review.no_change = review.added.length === 0 && review.removed.length === 0;
    }
    return { ...quiet, review };
  },

  async install(ctx: ActionContext) {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    const app = appParam(ctx.params.app);
    if (app === null) return notFound();
    const t = target(ctx);
    const hash = String(ctx.form.get("hash") ?? "");
    if (t === null || !HASH.test(hash)) return { ...quiet, form_error: trOf(ctx)("dash.modules.err_version") };
    const v = await api.getModuleVersion(t.publisher, t.name, t.version);
    if (!v.ok) return { ...quiet, action_problem: await problem(ctx, v) };
    // What is approved is what was reviewed: the same tree, its own request.
    if (v.value.hash !== hash) return { ...quiet, form_error: trOf(ctx)("dash.modules.err_changed") };
    const r = await api.installModule(app, { source: sourceOf(t), version: t.version, hash, approved: v.value.permissions });
    if (!r.ok) return { ...quiet, action_problem: await problem(ctx, r) };
    return {
      ...quiet,
      notice: trOf(ctx)("dash.modules.approved_notice", { name: t.name, version: t.version, app, source: sourceOf(t) }),
    };
  },
};
