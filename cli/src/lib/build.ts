// `renox build`: project → artifact directory (docs/contracts/artifact.md,
// version 1 from F2 on, also for apps with no pages).
//
// - Routes from functions/ and pages/ (routes.ts); all function and page
//   modules are bundled in one Bun.build with code splitting, so npm and bare imports are vendored
//   into the artifact and nothing is resolved at runtime (code.format =
//   "esm-dir"). Code shared by several modules (zod, a project lib/) lands
//   once in code/chunks/, so an isolate evaluates each dependency once
//   (#143). TypeScript types are stripped.
// - Source maps are not part of the artifact: they would be loaded into
//   every isolate as module source text. They are written next to the
//   artifacts folder, in <out>/../sourcemaps/<hash>/, with project-relative
//   source paths (`renox deploy` uploads them privately, #128).
// - Templates (pages/**/*.html, partials/**/*.html, modules/, overrides/)
//   are transpiled by `renox-worker transpile` (templates-compile.ts) into
//   templates/<id>.jinja and manifest.templates with the fragment maps.
// - migrations/NNN_name.sql → migrations/app/ with checksums.json.
// - public/** → public/, indexed by public.json at the root (content hash,
//   size, type); public/manifest.json is an ordinary file in version 1.
// - Forbidden files of public/ (dotfiles except .well-known/, keys, .env,
//   databases, logs, symlinks, files over 5 MiB; @renox/artifact-validate,
//   #115) are left out and listed in `skipped`.
// - With `secrets`, the bundled sources and copied files are scanned for
//   secrets (secrets.ts); a finding fails the build.
// - manifest.json, then the content hash names the directory:
//   <out>/<hash>/. An existing directory with that name is reused
//   (artifacts are content-addressed and never overwritten).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { forbiddenReason } from "@renox/artifact-validate";

import { checkSecurity, type SecurityConfig } from "../check/security.ts";
import { location, ValidationError, type Where } from "../errors.ts";

import { hashFiles, sha256Hex } from "./hash.ts";
import { appAuthz, appPolicyFiles, type AuthzBlock, checkPolicies, GuardError, mergedActions, PolicyError, readGuard, v25Problems } from "./policies.ts";
import { moduleParts, type ModuleParts, type OverrideDrift, storedOverrides } from "./modules/build.ts";
import { readLock } from "./modules/lock.ts";
import { readProject, type ProjectConfig } from "./project.ts";
import { isTimeZone, parseSchedule } from "../../../sdk/src/jobs.ts";
import { toolInputSchema } from "../../../sdk/src/tools.ts";
import { type ArtifactRoute, discoverFunctions, discoverJobs, discoverPages, discoverRealtime, discoverTools, exportedString, type JobRoute, routeConflicts, routesOf, type Route, type ToolRoute } from "./routes.ts";
import { type CompiledTemplate, TemplateCache, templateFiles, templatesKey, transpile } from "./templates-compile.ts";
import { type Json, validate } from "./schema.ts";
import { schemas } from "./schemas.ts";
import { formatSecret, scanBundle, SECRET_HINT, type ProjectSecret } from "./secrets.ts";

/** The app does not build (exit 2). `problems` lists every one when there are several. */
export class BuildError extends ValidationError {
  constructor(
    message: string,
    readonly problems: string[] = [],
    where: Where = {},
  ) {
    super(problems.length ? `${message}:\n  ${problems.join("\n  ")}` : message, where);
  }
}

/** A bundler message as `file:line:col: message`, the path relative to the project. */
function bundlerProblem(project: string, log: BuildMessage | ResolveMessage): { where: Where; message: string } {
  const pos = log.position;
  const message = String(log.message ?? log);
  if (!pos?.file) return { where: {}, message };
  const abs = resolve(project, pos.file);
  const file = abs.startsWith(`${resolve(project)}/`) ? relative(project, abs).split("\\").join("/") : pos.file;
  return { where: { file, line: pos.line, column: pos.column }, message };
}

export interface Manifest {
  artifact: { version: 1 };
  app: { name: string; timezone: string };
  code: { format: "esm-dir"; entry: Record<string, string> };
  /** Artifact 1.2 (#265): each entry's static exports and whether it is evaluated at isolate creation. */
  entries?: Record<string, EntryInfo>;
  routes: ArtifactRoute[];
  templates?: Record<string, { kind: CompiledTemplate["kind"]; fragments?: CompiledTemplate["fragments"] }>;
  permissions: { network: string[]; secrets: string[] };
  limits?: ProjectConfig["limits"];
  security?: SecurityConfig;
  /** Artifact 1.1: the installed modules (`artifact.md` section 3, "Modules"). */
  modules?: JsonObjectLike[];
  slots?: ModuleParts["slots"];
  /** Artifact 1.3: the app's `renox.toml [authz]` (#283). */
  authz?: AuthzBlock;
  /** Artifact 1.3: the app's `renox.toml [realtime]` (`feeds`, #284). */
  realtime?: { feeds?: Record<string, string> };
}

type JsonObjectLike = Record<string, Json>;

/** A file of public/ that the build left out, and why. */
/** One `entries` record (`artifact.md` 1.2, "Entries"). */
export interface EntryInfo {
  exports: string[];
  eager?: boolean;
}

/**
 * The `entries` field (ops.md 1.4.0 section 11): the export names of each
 * bundled entry, read from its code, and `eager: false` for route modules,
 * which the runtime then evaluates on their first request. A module's
 * `services` and `hooks`, and the error page's module, stay eager.
 */
export function entriesOf(entry: Record<string, string>, code: ReadonlyMap<string, string>): Record<string, EntryInfo> {
  const scanner = new Bun.Transpiler({ loader: "js" });
  const out: Record<string, EntryInfo> = {};
  for (const [id, path] of Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const source = code.get(path);
    if (source === undefined) throw new BuildError(`${path}: no bundled module for code.entry ${id}`);
    const exports = [...new Set(scanner.scan(source).exports)].sort();
    // RENOX_BUILD_EAGER=1 keeps every entry eager (the 1.1 behaviour): the
    // baseline of B1's lazy-route comparison (#265), not a user setting.
    const eager = process.env.RENOX_BUILD_EAGER === "1" || /^modules\/[a-z][a-z0-9_]*\/(services|hooks)$/u.test(id) || /(^|\/)pages\/_error$/u.test(id);
    out[id] = eager ? { exports } : { exports, eager: false };
  }
  return out;
}

export interface Skipped {
  path: string;
  reason: string;
}

export interface BuildResult {
  hash: string;
  dir: string;
  /** Source maps of `code/`, outside the artifact. */
  mapsDir: string;
  manifest: Manifest;
  /** Compiled templates by id (empty without templates). */
  templates: Record<string, CompiledTemplate>;
  /** Hash of everything but the templates: `renox dev` swaps fragments when only templates changed. */
  codeHash: string;
  /** Bundled modules (rebuilt / taken from the cache). */
  rebuilt: number;
  cached: number;
  ms: number;
  /** Forbidden files of public/ left out of the artifact. */
  skipped: Skipped[];
  /** Secrets allowed by a `renox-allow-secret` marker (only with `secrets`). */
  allowedSecrets: ProjectSecret[];
  /** Overrides whose module original changed since they were made (warnings). */
  drift: OverrideDrift[];
}

/** Bundled code: `code/`-relative path → source, and the source maps the same way. */
interface Bundle {
  code: Map<string, string>;
  maps: Map<string, string>;
}

/**
 * Bundle cache for `renox dev`: the modules are bundled together (shared
 * chunks), so the cache holds one bundle, reused while no function source
 * changed.
 */
export class BuildCache {
  private entry: { key: string; bundle: Bundle } | undefined;
  /** Set when a non-entry file changed: every module may import it. */
  invalidateAll = false;
  /** The last template compile (an edit to a module does not re-run it). */
  readonly templates = new TemplateCache();

  get(key: string): Bundle | undefined {
    if (this.invalidateAll) return undefined;
    return this.entry?.key === key ? this.entry.bundle : undefined;
  }

  set(key: string, bundle: Bundle): void {
    this.entry = { key, bundle };
  }
}

/** V5: bytes under code/ (20 MiB). */
export const MAX_CODE_BYTES = 20 * 1024 * 1024;

const MIGRATION = /^(\d{3})_([a-z0-9_]{1,64})\.sql$/u;

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  pdf: "application/pdf",
  xml: "application/xml",
  wasm: "application/wasm",
};

export const contentType = (path: string): string =>
  CONTENT_TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/**
 * Files under `dir`, sorted. Without `skipped`, a symbolic link is an error
 * (V1); with it, symbolic links and forbidden files are left out and listed.
 */
function listFiles(dir: string, rel = "", skipped?: Skipped[]): string[] {
  if (!existsSync(join(dir, rel))) return [];
  const out: string[] = [];
  for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isSymbolicLink()) {
      if (skipped === undefined) throw new BuildError(`V1: symbolic link ${r} is not allowed in an artifact`);
      skipped.push({ path: r, reason: "a symbolic link" });
      continue;
    }
    if (skipped !== undefined) {
      // A directory is judged as the folder of a file inside it.
      const reason = forbiddenReason(d.isDirectory() ? `${r}/_` : r, { underPublic: true, size: d.isFile() ? statSync(join(dir, r)).size : 0 });
      if (reason !== null) {
        skipped.push({ path: d.isDirectory() ? `${r}/` : r, reason });
        continue;
      }
    }
    if (d.isDirectory()) out.push(...listFiles(dir, r, skipped));
    else if (d.isFile()) out.push(r);
  }
  return out.sort();
}

/** A module to bundle: its id (`functions/...`, `pages/...`) and source file. */
interface Entry {
  id: string;
  source: string;
}

async function bundle(project: string, functions: Entry[]): Promise<Bundle> {
  // Paths in comments and source maps are relative to the working
  // directory: build from the project so the artifact is reproducible.
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const r = await Bun.build({
      entrypoints: functions.map((f) => f.source),
      root: ".",
      target: "browser",
      format: "esm",
      splitting: true,
      sourcemap: "external",
      naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/chunk-[hash].[ext]" },
      // node: built-ins stay imports; the runtime offers the compute-only ones.
      // `renox:modules` is resolved by the runtime's loader (ops.md 1.3.0 section 15).
      external: ["node:*", "renox:*"],
      throw: false,
    });
    if (!r.success) {
      const errors = r.logs
        .filter((l) => l.level === "error")
        .map((l) => bundlerProblem(project, l as BuildMessage))
        .sort((a, b) => location(a.where).localeCompare(location(b.where), "en", { numeric: true }));
      const [first] = errors;
      if (errors.length === 1 && first) throw new BuildError(first.message, [], { ...first.where, hint: "fix the syntax error, then save again" });
      throw new BuildError(
        "functions/ does not build",
        errors.map((e) => `${location(e.where) ? `${location(e.where)}: ` : ""}${e.message}`),
        { hint: "fix the errors above, then save again" },
      );
    }
    const out: Bundle = { code: new Map(), maps: new Map() };
    for (const o of r.outputs) {
      const path = o.path.replace(/^\.\//u, "");
      if (o.kind === "sourcemap") out.maps.set(path, await o.text());
      else if (o.kind === "entry-point" || o.kind === "chunk") out.code.set(path, await o.text());
      else throw new BuildError(`unexpected bundler output ${path} (${o.kind})`);
    }
    for (const f of functions) {
      if (!out.code.has(`${f.id}.js`)) throw new BuildError(`${f.source}: no bundled module ${f.id}.js`);
    }
    return out;
  } finally {
    process.chdir(cwd);
  }
}

/** Build the artifact files in memory: path → bytes. */
export async function buildFiles(
  project: string,
  cache?: BuildCache,
): Promise<{
  files: Map<string, Uint8Array>;
  maps: Map<string, string>;
  manifest: Manifest;
  templates: Record<string, CompiledTemplate>;
  rebuilt: number;
  cached: number;
  skipped: Skipped[];
  drift: OverrideDrift[];
}> {
  const config = readProject(project);
  // Installed modules (renox.lock), in lock order; none without a lock.
  const lock = readLock(project).entries;
  const mods: ModuleParts | null = lock && lock.length ? moduleParts(project) : null;
  if (mods?.problems.length) throw new BuildError("installed modules do not build", mods.problems);
  const fns = discoverFunctions(project);
  const pages = discoverPages(project);
  // Artifact 1.3 (#284): realtime routes, tools and jobs.
  const realtime = discoverRealtime(project);
  const toolModules = discoverTools(project);
  const jobModules = discoverJobs(project);
  if (fns.length === 0 && pages.length === 0 && realtime.length === 0 && toolModules.length === 0 && jobModules.length === 0 && !mods?.routes.length)
    throw new BuildError("no routes: functions/ has no module exporting GET, POST, ... and pages/ has no page");
  const routes: Route[] = [...routesOf(fns, pages), ...realtime.map((r): Route => ({ kind: r.kind, path: r.pattern, module: r.id })), ...(mods?.routes ?? [])];
  // Artifact 1.3 (#283): each route module's `export const guard`, read
  // statically, into its route entry.
  const sourceOf = new Map<string, string>([
    ...fns.map((f): [string, string] => [f.id, join(project, f.source)]),
    ...realtime.map((r): [string, string] => [r.id, join(project, r.source)]),
    ...pages.flatMap((p): [string, string][] => (p.source ? [[p.id, join(project, p.source)]] : [])),
    ...(mods?.entries ?? []).map((e): [string, string] => [e.id, join(e.tree, e.source)]),
  ]);
  const guardProblems: string[] = [];
  const guards = new Map<string, ReturnType<typeof readGuard>>();
  for (const r of routes) {
    if (!r.module || guards.has(r.module)) continue;
    const file = sourceOf.get(r.module);
    if (file === undefined) continue;
    try {
      guards.set(r.module, readGuard(readFileSync(file, "utf8"), relative(project, file) || r.module));
    } catch (e) {
      // A syntax error is the bundler's to report, with its position.
      if (e instanceof GuardError) guardProblems.push(e.message);
    }
  }
  if (guardProblems.length) throw new BuildError("guard exports do not build", guardProblems);
  for (const r of routes) {
    const g = r.module ? guards.get(r.module) : null;
    if (g) r.guard = g;
  }
  const functions: Entry[] = [
    ...fns,
    ...pages.flatMap((p) => (p.source ? [{ id: p.id, source: p.source }] : [])),
    ...realtime.map((r) => ({ id: r.id, source: r.source })),
    ...toolModules,
    ...jobModules.map((j) => ({ id: j.id, source: j.source })),
  ];
  if (functions.length === 0 && !mods?.entries.length)
    throw new BuildError("no code: an artifact needs at least one module (artifact.md, code.entry)", [], {
      hint: "add a pages/*.ts loader or a functions/ module",
    });
  const conflicts = routeConflicts(routes).map(ownersOf);
  if (conflicts.length) throw new BuildError("route conflicts", conflicts);
  // V21 (ops.md section 19): /mcp and its resource metadata are the cell's on every app.
  const reserved = routes.filter((r) => RESERVED_PATHS.includes(r.path));
  if (reserved.length) throw new BuildError("reserved paths", reserved.map((r) => `V21: ${r.path} (${r.module ?? r.path}) is reserved for the App MCP endpoint`));
  const extra = await toolAndJobRoutes(project, toolModules, jobModules, mods);
  if (config.security) checkSecurity(config.security, routes);
  const enc = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  const entry: Record<string, string> = {};
  const key = sha256Hex(enc.encode(functions.map((f) => `${f.source}\0${sha256Hex(readFileSync(join(project, f.source)))}`).join("\n")));
  let bundled = cache?.get(key);
  const rebuilt = bundled ? 0 : functions.length;
  const cached = functions.length - rebuilt;
  if (!bundled) {
    bundled = functions.length ? await bundle(project, functions) : { code: new Map(), maps: new Map() };
    cache?.set(key, bundled);
  }
  if (cache) cache.invalidateAll = false;
  for (const f of functions) entry[f.id] = `${f.id}.js`;
  // Module code: one bundle per module tree, under code/modules/<name>/.
  for (const m of mods?.modules ?? []) {
    const own = (mods?.entries ?? []).filter((e) => e.module === m.lock.name);
    if (own.length === 0) continue;
    const local = own.map((e) => ({ id: e.id.slice(`modules/${m.lock.name}/`.length), source: e.source }));
    const b = await bundle(m.tree, local);
    for (const [p, code] of b.code) bundled.code.set(`modules/${m.lock.name}/${p}`, code);
    for (const [p, map] of b.maps) bundled.maps.set(`modules/${m.lock.name}/${p}`, map);
    for (const e of own) entry[e.id] = `${e.id}.js`;
  }

  // Templates: transpiled by the worker, only when the app has any.
  let sources = templateFiles(project);
  if (mods) {
    // With a lock, module templates come from the installed trees, not from
    // the app's modules/ folder (which may hold path: sources).
    sources = Object.fromEntries(Object.entries(sources).filter(([p]) => !p.startsWith("modules/")));
    Object.assign(sources, mods.templates);
  }
  const compilerSlots = mods
    ? Object.fromEntries(
        Object.entries(mods.slots).map(([k, v]) => [k, v.map((f) => ({ template: f.template, ...(f.requires ? { requires: f.requires } : {}) }))]),
      )
    : undefined;
  let templates: Record<string, CompiledTemplate> = {};
  if (Object.keys(sources).length) {
    const tkey = templatesKey({ ...sources, "\0slots": JSON.stringify(compilerSlots ?? {}) });
    const hit = cache?.templates.get(tkey);
    templates = hit ?? (await transpile(sources, undefined, compilerSlots));
    if (!hit) cache?.templates.set(tkey, templates);
  }
  const missing = pages.filter((p) => p.html && !templates[p.id]);
  if (missing.length) throw new BuildError("pages without a compiled template", missing.map((p) => `${p.html}: not compiled`));
  for (const [id, t] of Object.entries(templates)) files.set(`templates/${id}.jinja`, enc.encode(t.source));
  for (const [p, code] of bundled.code) files.set(`code/${p}`, enc.encode(code));
  let size = 0;
  for (const [p, b] of files) if (p.startsWith("code/")) size += b.length;
  if (size > MAX_CODE_BYTES) throw new BuildError(`V5: code/ is ${size} bytes, over the ${MAX_CODE_BYTES}-byte bundle limit`);

  // Migrations: each module's under migrations/<name>/, the app's own as module `app`.
  const migDir = join(project, "migrations");
  const migs = listFiles(migDir);
  for (const [p, b] of mods?.files ?? []) files.set(p, b);
  // The app's policies and schema (#283; artifact.md 1.3, `policies/`).
  for (const [p, b] of appPolicyFiles(project)) files.set(p, b);
  // The app's translation catalogs (`i18n/<locale>.json`, #233, #244):
  // `code/i18n/`, where the cell reads them; they override the modules'.
  for (const c of listFiles(join(project, "i18n")).filter((n) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*\.json$/u.test(n))) {
    files.set(`code/i18n/${c}`, new Uint8Array(readFileSync(join(project, "i18n", c))));
  }
  if (migs.length || Object.keys(mods?.checksums ?? {}).length) {
    const sums: Record<string, string> = { ...(mods?.checksums ?? {}) };
    const numbers: number[] = [];
    for (const m of migs) {
      const match = MIGRATION.exec(m);
      if (!match) throw new BuildError(`V11: migrations/${m}: name must be NNN_name.sql`);
      numbers.push(Number(match[1]));
      const bytes = new Uint8Array(readFileSync(join(migDir, m)));
      files.set(`migrations/app/${m}`, bytes);
      sums[`app/${m}`] = sha256Hex(bytes);
    }
    numbers.sort((a, b) => a - b);
    if (numbers.some((n, i) => n !== i + 1)) throw new BuildError("V11: migrations must be numbered 001, 002, ... without gaps");
    for (const k of Object.keys(sums).sort()) {
      const v = sums[k] as string;
      delete sums[k];
      sums[k] = v;
    }
    const checksums = { version: 0, files: sums };
    const errs = validate(schemas.migrationsChecksums, checksums as Json);
    if (errs.length) throw new BuildError("migrations/checksums.json", errs);
    files.set("migrations/checksums.json", enc.encode(`${JSON.stringify(checksums, null, 2)}\n`));
  }

  // Public files.
  const pubDir = join(project, "public");
  const skipped: Skipped[] = [];
  const pubs = listFiles(pubDir, "", skipped);
  for (const k of skipped) k.path = `public/${k.path}`;
  if (pubs.length) {
    const entries: Record<string, { sha256: string; size: number; content_type: string }> = {};
    for (const p of pubs) {
      const bytes = new Uint8Array(readFileSync(join(pubDir, p)));
      files.set(`public/${p}`, bytes);
      entries[`/${p}`] = { sha256: sha256Hex(bytes), size: bytes.length, content_type: contentType(p) };
    }
    const pm = { version: 0, files: entries };
    const errs = validate(schemas.publicManifest, pm as Json);
    if (errs.length) throw new BuildError("public.json", errs);
    files.set("public.json", enc.encode(`${JSON.stringify(pm, null, 2)}\n`));
  }

  // Authorization (#283; artifact.md 1.3): the app's and each module's
  // `[authz]` on the manifest, V25 here, V24 (the policies against the
  // merged schema) through the worker below.
  const authz = appAuthz(project);
  // (modules/build.ts puts a module's `[authz]` and `[realtime]` on its entry.)
  const moduleAuthz = (mods?.modules ?? []).map((m) => ({ name: m.lock.name, authz: (m.manifest.doc as { authz?: AuthzBlock }).authz }));
  const v25 = [...v25Problems(routes, authz, moduleAuthz), ...toolProblems(extra.tools, authz, moduleAuthz)];
  if (v25.length) throw new BuildError("authorization references do not resolve", v25);
  // V26 (#284): feed and ownership tables exist in their owner's migrations.
  const appRealtime = appRealtimeBlock(project);
  const v26 = v26Problems(files, authz, appRealtime, mods);
  if (v26.length) throw new BuildError("realtime feeds and owned tables do not resolve", v26);

  const manifestTemplates = Object.fromEntries(
    Object.entries(templates).map(([id, t]) => [id, t.fragments ? { kind: t.kind, fragments: t.fragments } : { kind: t.kind }]),
  );
  const manifest: Manifest = {
    artifact: { version: 1 },
    app: config.app,
    code: { format: "esm-dir", entry },
    entries: entriesOf(entry, bundled.code),
    routes: [...routes, ...extra.tools, ...extra.jobs],
    ...(Object.keys(manifestTemplates).length ? { templates: manifestTemplates } : {}),
    permissions: config.permissions,
    ...(config.limits ? { limits: config.limits } : {}),
    ...(config.security ? { security: config.security } : {}),
    ...(mods ? { modules: mods.field } : {}),
    ...(mods && Object.keys(mods.slots).length ? { slots: mods.slots } : {}),
    ...(authz ? { authz } : {}),
    ...(appRealtime ? { realtime: appRealtime } : {}),
  };
  const errs = validate(schemas.manifest, manifest as unknown as Json);
  if (errs.length) throw new BuildError("manifest.json does not validate", errs);
  files.set("manifest.json", enc.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  // V24: policies validate against the merged schema (the engine the cell builds).
  if ([...files.keys()].some((p) => p.startsWith("policies/")) || authz || moduleAuthz.some((m) => m.authz)) {
    const { errors: policyErrors } = await checkPolicies(files);
    if (policyErrors.length) throw new PolicyError(policyErrors);
  }
  return { files, maps: bundled.maps, manifest, templates, rebuilt, cached, skipped, drift: mods?.drift ?? [] };
}

/** Paths the cell serves on every app (ops.md section 19, V21). */
export const RESERVED_PATHS = ["/mcp", "/.well-known/oauth-protected-resource/mcp"];

/** `renox.toml [realtime]`, or undefined. */
function appRealtimeBlock(project: string): Manifest["realtime"] {
  const path = join(project, "renox.toml");
  if (!existsSync(path)) return undefined;
  return (Bun.TOML.parse(readFileSync(path, "utf8")) as { realtime?: Manifest["realtime"] }).realtime;
}

/**
 * The tool and job route entries (artifact.md 1.3; ops.md sections 19-20).
 * A tool module is imported to read its `tool(...)` (the input schema is
 * code); a module's `[[tools]]` entry must agree with its file. A job's
 * `schedule` and `tz` are read from the source and checked (V27).
 */
async function toolAndJobRoutes(
  project: string,
  toolModules: { id: string; source: string }[],
  jobModules: ReturnType<typeof discoverJobs>,
  mods: ModuleParts | null,
): Promise<{ tools: ToolRoute[]; jobs: JobRoute[] }> {
  const problems: string[] = [];
  const tools: ToolRoute[] = [];
  type Declared = { name: string; description: string; action: string; confirm: boolean };
  const declared: { id: string; file: string; shown: string; manifest?: Declared }[] = [
    ...toolModules.map((t) => ({ id: t.id, file: join(project, t.source), shown: t.source })),
    ...(mods?.tools ?? []).map((t) => ({ id: t.id, file: t.file, shown: t.id, manifest: { name: t.name, description: t.description, action: t.action, confirm: t.confirm } })),
  ];
  for (const t of declared) {
    let def: { name?: unknown; description?: unknown; action?: unknown; confirm?: unknown; input?: unknown };
    try {
      def = ((await import(`${t.file}?build=${Date.now()}`)) as { default?: typeof def }).default ?? {};
    } catch (e) {
      problems.push(`${t.shown}: the tool module cannot be evaluated at build time: ${(e as Error).message}`);
      continue;
    }
    if (typeof def.name !== "string" || typeof def.action !== "string" || typeof def.description !== "string") {
      problems.push(`${t.shown}: must default-export tool({ name, description, input, action, run })`);
      continue;
    }
    let input: Record<string, unknown>;
    try {
      input = toolInputSchema(def.input);
    } catch (e) {
      problems.push(`${t.shown}: ${(e as Error).message}`);
      continue;
    }
    const confirm = def.confirm === true;
    if (t.manifest) {
      const file: Declared = { name: def.name, description: def.description, action: def.action, confirm };
      for (const k of ["name", "description", "action", "confirm"] as const) {
        if (t.manifest[k] !== file[k]) problems.push(`${t.shown}: [[tools]] ${k} is ${JSON.stringify(t.manifest[k])} in module.toml but ${JSON.stringify(file[k])} in the file`);
      }
    }
    tools.push({ kind: "tool", name: def.name, module: t.id, description: def.description, input, action: def.action, ...(confirm ? { confirm } : {}) });
  }
  const jobs: JobRoute[] = [];
  const allJobs = [
    ...jobModules.map((j) => ({ id: j.id, shown: j.source, name: j.name, schedule: j.schedule, tz: j.tz })),
    ...(mods?.jobs ?? []).map((j) => {
      const code = readFileSync(j.file, "utf8");
      return { id: j.id, shown: j.id, name: j.name, schedule: exportedString(code, "schedule"), tz: exportedString(code, "tz") ?? undefined };
    }),
  ];
  for (const j of allJobs) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(j.name)) problems.push(`V27: ${j.shown}: a job name (the file stem) is ^[a-z][a-z0-9_-]{0,63}$`);
    if (j.schedule === null) {
      problems.push(`V27: ${j.shown}: export const schedule = "<minute hour day-of-month month day-of-week>" (a string literal)`);
      continue;
    }
    const parsed = parseSchedule(j.schedule);
    if (typeof parsed === "string") problems.push(`V27: ${j.shown}: schedule ${JSON.stringify(j.schedule)}: ${parsed}`);
    if (j.tz !== undefined && !isTimeZone(j.tz)) problems.push(`V27: ${j.shown}: tz ${JSON.stringify(j.tz)} is not an IANA time zone`);
    jobs.push({ kind: "job", name: j.name, module: j.id, schedule: j.schedule, ...(j.tz !== undefined ? { tz: j.tz } : {}) });
  }
  if (problems.length) throw new BuildError("tools and jobs do not build", problems);
  return { tools, jobs };
}

/** V25 for tools: names unique across the app and its modules, actions in the merged action set. */
function toolProblems(tools: ToolRoute[], app: AuthzBlock | undefined, modules: readonly { name: string; authz?: AuthzBlock }[]): string[] {
  const actions = mergedActions(app, modules);
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const t of tools) {
    const other = seen.get(t.name);
    if (other) out.push(`V25: tool name ${t.name} is used by ${other} and ${t.module}`);
    seen.set(t.name, t.module);
    if (!actions.has(t.action)) out.push(`V25: ${t.module}: tool action ${t.action} is not in the merged action set`);
  }
  return out;
}

/** The tables a set of migration files creates (`create table [if not exists] <name>`). */
function createdTables(sqls: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const sql of sqls) for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)/giu)) out.add((m[1] as string).toLowerCase());
  return out;
}

/**
 * V26 (artifact.md section 6): every `realtime.feeds` key and every
 * `ownership` table is a table of its owner's prefix that the owner's
 * migrations create; a feed's topic pattern is a topic whose `{column}`
 * placeholders are identifiers.
 */
function v26Problems(files: ReadonlyMap<string, Uint8Array>, app: AuthzBlock | undefined, appRealtime: Manifest["realtime"], mods: ModuleParts | null): string[] {
  const dec = new TextDecoder();
  const sqlsOf = (owner: string) => [...files].filter(([p]) => p.startsWith(`migrations/${owner}/`) && p.endsWith(".sql")).map(([, b]) => dec.decode(b));
  const owners: { name: string; feeds: Record<string, string>; owned: string[] }[] = [
    { name: "app", feeds: appRealtime?.feeds ?? {}, owned: Object.keys(app?.ownership ?? {}) },
    ...(mods?.modules ?? []).map((m) => {
      const doc = m.manifest.doc as { realtime?: { feeds?: Record<string, string> }; authz?: AuthzBlock };
      return { name: m.lock.name, feeds: doc.realtime?.feeds ?? {}, owned: Object.keys(doc.authz?.ownership ?? {}) };
    }),
  ];
  const out: string[] = [];
  for (const o of owners) {
    if (Object.keys(o.feeds).length === 0 && o.owned.length === 0) continue;
    const tables = createdTables(sqlsOf(o.name));
    const prefix = `${o.name}__`;
    for (const [table, pattern] of Object.entries(o.feeds)) {
      if (!table.startsWith(prefix)) out.push(`V26: ${o.name}: feed table ${table} is not under ${prefix}`);
      else if (!tables.has(table.toLowerCase())) out.push(`V26: ${o.name}: feed table ${table} is not created by its migrations`);
      const placeholders = [...pattern.matchAll(/\{([^}]*)\}/gu)].map((m) => m[1] as string);
      const shape = pattern.replace(/\{[^}]*\}/gu, "x");
      if (placeholders.some((p) => !/^[a-z_][a-z0-9_]*$/u.test(p)) || !shape.split(":").every((seg) => /^[A-Za-z0-9_.-]+$/u.test(seg)) || pattern.length > 256) {
        out.push(`V26: ${o.name}: feed topic ${JSON.stringify(pattern)} is not a topic with {column} placeholders`);
      }
    }
    for (const table of o.owned) {
      if (!tables.has(table.toLowerCase())) out.push(`V26: ${o.name}: owned table ${table} is not created by its migrations`);
    }
  }
  return out;
}

/** A route conflict naming the owners when a module is involved (V21: after mounting). */
function ownersOf(conflict: string): string {
  const ids = [...conflict.matchAll(/\(([^)]+)\)/gu)].map((m) => m[1] as string);
  const owner = (id: string): string => /^modules\/([a-z][a-z0-9_]*)\//u.exec(id)?.[1] ?? "app";
  const owners = ids.map(owner);
  if (!owners.some((o) => o !== "app")) return conflict;
  return `${conflict.replace(/^V8:/u, "V21:")} (${owners.map((o) => (o === "app" ? "the app" : `module ${o}`)).join(" and ")})`;
}

/** Fails with every unallowed secret of the bundle (file, line, pattern); returns the allowed ones. */
export function assertNoSecrets(maps: ReadonlyMap<string, string>, files: ReadonlyMap<string, Uint8Array>): ProjectSecret[] {
  const report = scanBundle(maps, files);
  if (report.findings.length === 0) return report.allowed;
  const first = report.findings[0] as ProjectSecret;
  const noReason = report.markersWithoutReason.map((m) => `${m.file}:${m.line}: renox-allow-secret needs a reason (renox-allow-secret: <why this is not a secret>)`);
  throw new BuildError(
    report.findings.length === 1 ? `secret in the bundle: ${formatSecret(first)}` : `${report.findings.length} secrets in the bundle`,
    report.findings.length === 1 ? noReason : [...report.findings.map(formatSecret), ...noReason],
    { file: first.file, line: first.line, column: first.column, hint: SECRET_HINT },
  );
}

/** `renox build`: write `<out>/<hash>/` and return its hash. */
export async function buildArtifact(project: string, out: string, cache?: BuildCache, options: { secrets?: boolean } = {}): Promise<BuildResult> {
  const t0 = performance.now();
  const { files, maps, manifest, templates, rebuilt, cached, skipped, drift } = await buildFiles(project, cache);
  const allowedSecrets = options.secrets === true ? assertNoSecrets(maps, files) : [];
  const hash = hashFiles(files);
  const rest = new Map([...files].filter(([p]) => !p.startsWith("templates/") && p !== "manifest.json"));
  rest.set("manifest.json", new TextEncoder().encode(JSON.stringify({ ...manifest, templates: undefined })));
  const codeHash = hashFiles(rest);
  const dir = join(out, hash);
  const mapsDir = join(out, "..", "sourcemaps", hash);
  if (!existsSync(mapsDir)) {
    const tmp = `${mapsDir}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const [p, text] of maps) {
      const target = join(tmp, p);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    renameSync(tmp, mapsDir);
  }
  if (!existsSync(dir)) {
    const tmp = join(out, `.tmp-${hash}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    for (const [p, bytes] of files) {
      const target = join(tmp, p);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    renameSync(tmp, dir);
  }
  // The override originals the app was made against (drift detection on the next upgrade).
  const stored = storedOverrides(project, files);
  if (stored !== null) {
    const path = join(project, "overrides.json");
    if (!existsSync(path) || readFileSync(path, "utf8") !== stored) writeFileSync(path, stored);
  }
  return { hash, dir, mapsDir, manifest, templates, codeHash, rebuilt, cached, ms: performance.now() - t0, skipped, allowedSecrets, drift };
}

/** The default artifact folder of a project. */
export const artifactsDir = (project: string): string => join(project, ".renox", "artifact");

/** Total bytes under `code/` (V5 reports it). */
export function codeBytes(dir: string): number {
  return listFiles(join(dir, "code")).reduce((n, f) => n + statSync(join(dir, "code", f)).size, 0);
}
