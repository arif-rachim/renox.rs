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
import { readProject, type ProjectConfig } from "./project.ts";
import { discoverFunctions, discoverPages, routeConflicts, routesOf, type Route } from "./routes.ts";
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
  routes: Route[];
  templates?: Record<string, { kind: CompiledTemplate["kind"]; fragments?: CompiledTemplate["fragments"] }>;
  permissions: { network: string[]; secrets: string[] };
  limits?: ProjectConfig["limits"];
  security?: SecurityConfig;
}

/** A file of public/ that the build left out, and why. */
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
      external: ["node:*"],
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
}> {
  const config = readProject(project);
  const fns = discoverFunctions(project);
  const pages = discoverPages(project);
  if (fns.length === 0 && pages.length === 0)
    throw new BuildError("no routes: functions/ has no module exporting GET, POST, ... and pages/ has no page");
  const routes = routesOf(fns, pages);
  const functions: Entry[] = [...fns, ...pages.flatMap((p) => (p.source ? [{ id: p.id, source: p.source }] : []))];
  if (functions.length === 0)
    throw new BuildError("no code: an artifact needs at least one module (artifact.md, code.entry)", [], {
      hint: "add a pages/*.ts loader or a functions/ module",
    });
  const conflicts = routeConflicts(routes);
  if (conflicts.length) throw new BuildError("route conflicts", conflicts);
  if (config.security) checkSecurity(config.security, routes);
  const enc = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  const entry: Record<string, string> = {};
  const key = sha256Hex(enc.encode(functions.map((f) => `${f.source}\0${sha256Hex(readFileSync(join(project, f.source)))}`).join("\n")));
  let bundled = cache?.get(key);
  const rebuilt = bundled ? 0 : functions.length;
  const cached = functions.length - rebuilt;
  if (!bundled) {
    bundled = await bundle(project, functions);
    cache?.set(key, bundled);
  }
  if (cache) cache.invalidateAll = false;
  for (const f of functions) entry[f.id] = `${f.id}.js`;

  // Templates: transpiled by the worker, only when the app has any.
  const sources = templateFiles(project);
  let templates: Record<string, CompiledTemplate> = {};
  if (Object.keys(sources).length) {
    const tkey = templatesKey(sources);
    const hit = cache?.templates.get(tkey);
    templates = hit ?? (await transpile(sources));
    if (!hit) cache?.templates.set(tkey, templates);
  }
  const missing = pages.filter((p) => p.html && !templates[p.id]);
  if (missing.length) throw new BuildError("pages without a compiled template", missing.map((p) => `${p.html}: not compiled`));
  for (const [id, t] of Object.entries(templates)) files.set(`templates/${id}.jinja`, enc.encode(t.source));
  for (const [p, code] of bundled.code) files.set(`code/${p}`, enc.encode(code));
  let size = 0;
  for (const [p, b] of files) if (p.startsWith("code/")) size += b.length;
  if (size > MAX_CODE_BYTES) throw new BuildError(`V5: code/ is ${size} bytes, over the ${MAX_CODE_BYTES}-byte bundle limit`);

  // Migrations: the app's own, module `app`.
  const migDir = join(project, "migrations");
  const migs = listFiles(migDir);
  if (migs.length) {
    const sums: Record<string, string> = {};
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

  const manifestTemplates = Object.fromEntries(
    Object.entries(templates).map(([id, t]) => [id, t.fragments ? { kind: t.kind, fragments: t.fragments } : { kind: t.kind }]),
  );
  const manifest: Manifest = {
    artifact: { version: 1 },
    app: config.app,
    code: { format: "esm-dir", entry },
    routes,
    ...(Object.keys(manifestTemplates).length ? { templates: manifestTemplates } : {}),
    permissions: config.permissions,
    ...(config.limits ? { limits: config.limits } : {}),
    ...(config.security ? { security: config.security } : {}),
  };
  const errs = validate(schemas.manifest, manifest as unknown as Json);
  if (errs.length) throw new BuildError("manifest.json does not validate", errs);
  files.set("manifest.json", enc.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  return { files, maps: bundled.maps, manifest, templates, rebuilt, cached, skipped };
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
  const { files, maps, manifest, templates, rebuilt, cached, skipped } = await buildFiles(project, cache);
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
  return { hash, dir, mapsDir, manifest, templates, codeHash, rebuilt, cached, ms: performance.now() - t0, skipped, allowedSecrets };
}

/** The default artifact folder of a project. */
export const artifactsDir = (project: string): string => join(project, ".renox", "artifact");

/** Total bytes under `code/` (V5 reports it). */
export function codeBytes(dir: string): number {
  return listFiles(join(dir, "code")).reduce((n, f) => n + statSync(join(dir, "code", f)).size, 0);
}
