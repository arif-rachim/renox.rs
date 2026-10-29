// The module part of `renox build` (#235; docs/contracts/artifact.md 1.1,
// "Modules"): for each renox.lock entry in lock (topological) order, the
// module's code entries, its routes under its mount, its migrations,
// policies, i18n catalogs and template sources, the tenant's overrides with
// their original hashes, the slot registry, and the manifest's `modules`
// field. Bundling and template compilation stay in build.ts, which calls
// this.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../hash.ts";
import { type Json, type JsonObject } from "../schema.ts";
import { discoverFunctions, discoverPages, type Route } from "../routes.ts";
import { type LockEntry, readLock } from "./lock.ts";
import { type Manifest as ModuleManifest, obj, readManifest, strings } from "./manifest.ts";
import { fetchTree } from "./resolve.ts";

/** One installed module, ready to build. */
export interface BuiltModule {
  lock: LockEntry;
  manifest: ModuleManifest;
  /** Absolute path of the module tree. */
  tree: string;
}

/** A module source file to bundle: its code id and its path in the tree. */
export interface ModuleEntry {
  module: string;
  tree: string;
  /** `modules/<name>/...` */
  id: string;
  /** Relative to the tree. */
  source: string;
}

/** A slot filler of the artifact (`artifact.md` 1.1, "Slots"). */
export interface SlotEntry {
  module: string;
  template: string;
  requires?: string;
}

export interface ModuleParts {
  modules: BuiltModule[];
  entries: ModuleEntry[];
  routes: Route[];
  /** Artifact path -> bytes: migrations, policies, i18n, overrides, overrides.json. */
  files: Map<string, Uint8Array>;
  /** `<module>/<file>` -> sha256 of module migrations (merged into checksums.json). */
  checksums: Record<string, string>;
  /** Template sources of the modules: `modules/<name>/(pages|partials)/...html`. */
  templates: Record<string, string>;
  /** The artifact's `slots`, in render order. */
  slots: Record<string, SlotEntry[]>;
  /** The manifest's `modules` field. */
  field: JsonObject[];
  /** Override drift: one warning per file, with a unified diff. */
  drift: OverrideDrift[];
  problems: string[];
}

export interface OverrideDrift {
  /** `<module>/<path>.html` */
  file: string;
  stored: string;
  current: string;
  diff: string;
}

const MIGRATION = /^(\d{3})_([a-z0-9_]{1,64})\.sql$/u;

function files(dir: string, rel = "", keep: (name: string) => boolean = () => true): string[] {
  if (!existsSync(join(dir, rel))) return [];
  const out: string[] = [];
  for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (d.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...files(dir, r, keep));
    else if (d.isFile() && keep(d.name)) out.push(r);
  }
  return out.sort();
}

/** `mount` + a module path: `/auth` + `/login` = `/auth/login`; mount `/` keeps it. */
export const mounted = (mount: string, path: string): string => (mount === "/" ? path : path === "/" ? mount : `${mount}${path}`);

/** The first file of `<tree>/<base>.(ts|tsx|js|mjs)`, relative to the tree. */
function sourceFile(tree: string, base: string): string | undefined {
  for (const ext of ["ts", "tsx", "js", "mjs"]) if (existsSync(join(tree, `${base}.${ext}`))) return `${base}.${ext}`;
  return undefined;
}

/**
 * A line diff of `a` and `b` in unified form (longest common subsequence;
 * fine for template-sized files).
 */
export function unifiedDiff(a: string, b: string, from: string, to: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const lines: string[] = [`--- ${from}`, `+++ ${to}`];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      lines.push(` ${x[i]}`);
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) lines.push(`+${y[j++]}`);
    else lines.push(`-${x[i++]}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The app's stored override index (`overrides.json` at the project root, same shape as the artifact's). */
interface OverridesIndex {
  version: 0;
  files: Record<string, { template: string; original_sha256: string }>;
}

function readStoredOverrides(project: string): OverridesIndex["files"] {
  const p = join(project, "overrides.json");
  if (!existsSync(p)) return {};
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as OverridesIndex).files ?? {};
  } catch {
    return {};
  }
}

/** The installed modules of the app (lock order) with their trees; `[]` without a lock. */
export function installedModules(project: string): { modules: BuiltModule[]; problems: string[] } {
  const { entries, problems } = readLock(project);
  const out: BuiltModule[] = [];
  const msgs = problems.map((p) => `${p.rule}: ${p.file}: ${p.message}`);
  for (const lock of entries ?? []) {
    const { tree } = fetchTree(project, lock.name, lock.source === "official" ? undefined : lock.source);
    const { manifest, problems: mp } = readManifest(tree, `${lock.name}/module.toml`);
    for (const p of mp) msgs.push(`${p.rule}: ${p.file}: ${p.message}`);
    if (manifest !== null) out.push({ lock, manifest, tree });
  }
  return { modules: out, problems: msgs };
}

/** Everything of the installed modules that goes into the artifact. */
export function moduleParts(project: string): ModuleParts {
  const enc = new TextEncoder();
  const { modules, problems } = installedModules(project);
  const parts: ModuleParts = { modules, entries: [], routes: [], files: new Map(), checksums: {}, templates: {}, slots: {}, field: [], drift: [], problems };
  const fillers: (SlotEntry & { slot: string; priority: number })[] = [];
  for (const { lock, manifest, tree } of modules) {
    const name = lock.name;
    const prefix = `modules/${name}`;
    // Code: functions/, pages/, services, hooks (artifact.md 1.1, V18).
    for (const f of discoverFunctions(tree)) {
      const id = `${prefix}/${f.id}`;
      parts.entries.push({ module: name, tree, id, source: f.source });
      for (const method of f.methods) parts.routes.push({ kind: "function", method, path: mounted(lock.mount, f.pattern), module: id, export: method });
    }
    for (const p of discoverPages(tree)) {
      const id = `${prefix}/${p.id}`;
      if (p.source) parts.entries.push({ module: name, tree, id, source: p.source });
      parts.routes.push({
        kind: "page",
        path: mounted(lock.mount, p.pattern),
        ...(p.source ? { module: id } : {}),
        ...(p.load ? { load: true as const } : {}),
        ...(p.actions.length ? { actions: p.actions } : {}),
        ...(p.html ? { template: id } : {}),
      });
    }
    for (const base of ["services", "hooks"]) {
      const source = sourceFile(tree, base);
      if (source !== undefined) parts.entries.push({ module: name, tree, id: `${prefix}/${base}`, source });
    }
    const exportsDoc = obj(manifest.doc.exports);
    if (Object.keys(obj(exportsDoc.services)).length && sourceFile(tree, "services") === undefined) {
      parts.problems.push(`V18: ${name} exports services but has no services.ts`);
    }
    // Templates: the module's pages/ and partials/ under its prefix.
    for (const root of ["pages", "partials"]) {
      for (const f of files(join(tree, root), "", (n) => n.endsWith(".html"))) parts.templates[`${prefix}/${root}/${f}`] = readFileSync(join(tree, root, f), "utf8");
    }
    // Migrations: migrations/<name>/ with checksums.
    const migs = files(join(tree, "migrations"), "", (n) => n.endsWith(".sql"));
    migs.forEach((m, i) => {
      const match = MIGRATION.exec(m);
      if (!match) return void parts.problems.push(`V11: ${name}/migrations/${m}: name must be NNN_name.sql`);
      if (Number(match[1]) !== i + 1) parts.problems.push(`V11: ${name}/migrations must be numbered 001, 002, ... without gaps`);
      const bytes = new Uint8Array(readFileSync(join(tree, "migrations", m)));
      parts.files.set(`migrations/${name}/${m}`, bytes);
      parts.checksums[`${name}/${m}`] = sha256Hex(bytes);
    });
    // Policies (carried, F5) and catalogs (`code/modules/<name>/i18n/`, read by the cell, #233).
    for (const p of files(join(tree, "policies"), "", (n) => n.endsWith(".cedar"))) {
      if (p.includes("/")) parts.problems.push(`V18: ${name}/policies/${p}: policies are policies/<name>.cedar`);
      else parts.files.set(`policies/${name}/${p}`, new Uint8Array(readFileSync(join(tree, "policies", p))));
    }
    for (const c of files(join(tree, "i18n"), "", (n) => n.endsWith(".json"))) {
      parts.files.set(`code/${prefix}/i18n/${c}`, new Uint8Array(readFileSync(join(tree, "i18n", c))));
    }
    // Slots: provider order is priority, then module name.
    for (const s of Array.isArray(manifest.doc.slots) ? (manifest.doc.slots as JsonObject[]) : []) {
      const template = `${prefix}/${String(s.template).replace(/\.html$/u, "")}`;
      fillers.push({
        slot: s.name as string,
        module: name,
        template,
        ...(typeof s.requires === "string" ? { requires: s.requires } : {}),
        priority: typeof s.priority === "number" ? s.priority : 100,
      });
    }
    parts.field.push({
      name,
      version: lock.version,
      hash: lock.hash,
      source: lock.source,
      mount: lock.mount,
      isolation: lock.isolation,
      dependencies: lock.dependencies,
      config: lock.config as JsonObject,
      permissions: permissionsJson(manifest.permissions),
      approved: permissionsJson(lock.approved),
      exports: {
        services: Object.keys(obj(exportsDoc.services)),
        events: Object.fromEntries(Object.entries(obj(exportsDoc.events)).map(([k, v]) => [k, (obj(v).payload ?? { type: "object" }) as Json])),
        hooks: Object.keys(obj(exportsDoc.hooks)),
        views: strings(exportsDoc.views),
      },
    });
  }
  fillers.sort((a, b) => a.priority - b.priority || a.module.localeCompare(b.module, "en"));
  for (const f of fillers) {
    (parts.slots[f.slot] ??= []).push({ module: f.module, template: f.template, ...(f.requires !== undefined ? { requires: f.requires } : {}) });
  }
  overrides(project, parts, enc);
  return parts;
}

const permissionsJson = (p: ModuleManifest["permissions"]): JsonObject => ({
  ...(p.tables !== undefined ? { tables: p.tables } : {}),
  network: p.network,
  secrets: p.secrets,
  slots: p.slots,
  hooks: p.hooks,
});

/**
 * The app's `overrides/<module>/(pages|partials)/...html`: copied into the
 * artifact with `overrides.json` (each original's sha256 at the installed
 * version). The app's own `overrides.json` stores the original hash the
 * override was made against: a different hash now is drift ("Template
 * override drifted", docs/23-failure-modes.md), reported with a diff of the
 * original against the override. A new override is recorded there.
 */
function overrides(project: string, parts: ModuleParts, enc: TextEncoder): void {
  const dir = join(project, "overrides");
  const listed = files(dir, "", (n) => n.endsWith(".html"));
  if (listed.length === 0) return;
  const stored = readStoredOverrides(project);
  const index: OverridesIndex = { version: 0, files: {} };
  for (const rel of listed) {
    const [name, ...restParts] = rel.split("/");
    const rest = restParts.join("/");
    const m = parts.modules.find((x) => x.lock.name === name);
    if (m === undefined) {
      parts.problems.push(`V20: overrides/${rel}: module "${name}" is not installed`);
      continue;
    }
    if (!/^(pages|partials)\//u.test(rest)) {
      parts.problems.push(`V20: overrides/${rel}: only templates under pages/ or partials/ can be overridden`);
      continue;
    }
    const originalPath = join(m.tree, rest);
    if (!existsSync(originalPath)) {
      parts.problems.push(`V20: overrides/${rel}: ${name} has no ${rest}`);
      continue;
    }
    const original = readFileSync(originalPath, "utf8");
    const current = sha256Hex(enc.encode(original));
    const template = `modules/${name}/${rest.replace(/\.html$/u, "")}`;
    index.files[rel] = { template, original_sha256: current };
    parts.files.set(`overrides/${rel}`, new Uint8Array(readFileSync(join(dir, rel))));
    const was = stored[rel]?.original_sha256;
    if (was !== undefined && was !== current) {
      const override = readFileSync(join(dir, rel), "utf8");
      parts.drift.push({
        file: rel,
        stored: was,
        current,
        diff: unifiedDiff(override, original, `overrides/${rel}`, `${name}@${m.lock.version} ${rest}`),
      });
    }
  }
  parts.files.set("overrides.json", enc.encode(`${JSON.stringify(index, null, 2)}\n`));
}

/** The app's stored override index after a build: new overrides recorded, drifted ones kept (to keep the warning until fixed). */
export function storedOverrides(project: string, built: Map<string, Uint8Array>): string | null {
  const idx = built.get("overrides.json");
  if (idx === undefined) return null;
  const now = (JSON.parse(new TextDecoder().decode(idx)) as OverridesIndex).files;
  const stored = readStoredOverrides(project);
  const out: OverridesIndex = { version: 0, files: {} };
  for (const [k, v] of Object.entries(now)) out.files[k] = stored[k] ?? v;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** One broken module contract (`docs/23-failure-modes.md`, "Module contract broken on upgrade"). */
export interface ContractProblem {
  rule: "MF7";
  file: string;
  line: number;
  message: string;
}

const CODE = /\.(ts|tsx|js|mjs)$/u;

const lineOf = (src: string, index: number): number => src.slice(0, index).split("\n").length;

/**
 * `renox check` (#235): what each module's code uses from other modules
 * against its manifest and its dependencies' installed manifests:
 *
 * - a `renox:modules` import names a module in `[dependencies]` (the app may
 *   import every installed module);
 * - every `<dep>.<service>(…)` call and `ctx.services.<dep>.<service>` is a
 *   service the installed `<dep>` exports, and is listed in `[imports].services`;
 * - every `<dep>__public_<id>_v<n>` in the code is a view the installed
 *   `<dep>` exports (a different version names both), from a dependency,
 *   listed in `[imports].views`.
 */
export function contractProblems(project: string, modules: BuiltModule[]): ContractProblem[] {
  const out: ContractProblem[] = [];
  const byName = new Map(modules.map((m) => [m.lock.name, m]));
  const servicesOf = (m: BuiltModule): string[] => Object.keys(obj(obj(m.manifest.doc.exports).services));
  const viewsOf = (m: BuiltModule): string[] => strings(obj(m.manifest.doc.exports).views);
  const scan = (owner: BuiltModule | null, dir: string, rel: string): void => {
    const src = readFileSync(join(dir, rel), "utf8");
    const file = owner ? `${owner.lock.name}/${rel}` : rel;
    const deps = owner ? new Set(owner.lock.dependencies) : new Set(byName.keys());
    const imports = owner ? obj(owner.manifest.doc.imports) : {};
    const importedServices = new Set(strings(imports.services));
    const importedViews = new Set(strings(imports.views));
    const who = owner ? owner.lock.name : "the app";
    const problem = (index: number, message: string) => out.push({ rule: "MF7", file, line: lineOf(src, index), message });
    // import { auth, billing as b } from "renox:modules"
    const bindings = new Map<string, string>();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']renox:modules["']/gu)) {
      for (const part of (m[1] as string).split(",")) {
        const [orig, alias] = part.trim().split(/\s+as\s+/u);
        if (!orig) continue;
        bindings.set((alias ?? orig).trim(), orig.trim());
        if (!deps.has(orig.trim()))
          problem(m.index, byName.has(orig.trim()) ? `${who} imports ${orig.trim()} from renox:modules, but ${orig.trim()} is not in its [dependencies]` : `${who} imports ${orig.trim()} from renox:modules, which is not installed`);
      }
    }
    const calls: [number, string, string][] = [];
    for (const [local, dep] of bindings) {
      for (const m of src.matchAll(new RegExp(`\\b${local}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "gu"))) calls.push([m.index, dep, m[1] as string]);
    }
    for (const m of src.matchAll(/\bservices\s*\.\s*([a-z][a-z0-9_]*)\s*\.\s*([A-Za-z_$][\w$]*)/gu)) {
      const dep = m[1] as string;
      if (!deps.has(dep)) problem(m.index, `${who} calls ${dep}.${m[2]}, but ${dep} is not in its [dependencies]`);
      calls.push([m.index, dep, m[2] as string]);
    }
    for (const [index, dep, svc] of calls) {
      const target = byName.get(dep);
      if (target === undefined || !deps.has(dep)) continue;
      if (!servicesOf(target).includes(svc)) problem(index, `${who} calls ${dep}.${svc}, which ${dep} ${target.lock.version} does not export`);
      else if (owner && !importedServices.has(`${dep}.${svc}`)) problem(index, `${who} calls ${dep}.${svc}, which is not in its [imports].services`);
    }
    for (const m of src.matchAll(/\b([a-z][a-z0-9_]*)__public_([a-z0-9_]+?)_v([1-9][0-9]*)\b/gu)) {
      const [view, dep, id] = [m[0], m[1] as string, m[2] as string];
      if (owner && dep === owner.lock.name) continue;
      const target = byName.get(dep);
      if (target === undefined) {
        problem(m.index, `${who} reads ${view}, but ${dep} is not installed`);
        continue;
      }
      if (!deps.has(dep)) {
        problem(m.index, `${who} reads ${view}, but ${dep} is not in its [dependencies]`);
        continue;
      }
      if (!viewsOf(target).includes(view)) {
        const other = viewsOf(target).find((v) => v.startsWith(`${dep}__public_${id}_v`));
        problem(m.index, other ? `${who} reads ${view}, but ${dep} ${target.lock.version} exports ${other} (version v${other.split("_v").pop()}, not v${m[3]})` : `${who} reads ${view}, which ${dep} ${target.lock.version} does not export`);
      } else if (owner && !importedViews.has(view)) problem(m.index, `${who} reads ${view}, which is not in its [imports].views`);
    }
  };
  for (const m of modules) for (const rel of files(m.tree, "", (n) => CODE.test(n) && !n.endsWith(".d.ts"))) {
    if (rel.startsWith("tests/") || rel.startsWith("node_modules/") || /\.(test|spec)\./u.test(rel)) continue;
    scan(m, m.tree, rel);
  }
  for (const root of ["functions", "pages", "lib"]) for (const rel of files(join(project, root), "", (n) => CODE.test(n) && !n.endsWith(".d.ts"))) scan(null, project, `${root}/${rel}`);
  return out;
}
