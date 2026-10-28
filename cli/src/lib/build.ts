// `renox build`: project → artifact directory (docs/contracts/artifact.md).
//
// - Routes from functions/ (routes.ts); all function modules are bundled in
//   one Bun.build with code splitting, so npm and bare imports are vendored
//   into the artifact and nothing is resolved at runtime (code.format =
//   "esm-dir"). Code shared by several modules (zod, a project lib/) lands
//   once in code/chunks/, so an isolate evaluates each dependency once
//   (#143). TypeScript types are stripped.
// - Source maps are not part of the artifact: they would be loaded into
//   every isolate as module source text. They are written next to the
//   artifacts folder, in <out>/../sourcemaps/<hash>/, with project-relative
//   source paths (`renox deploy` uploads them privately, #128).
// - migrations/NNN_name.sql → migrations/app/ with checksums.json.
// - public/** → public/ with manifest.json (content hash, size, type).
// - manifest.json, then the content hash names the directory:
//   <out>/<hash>/. An existing directory with that name is reused
//   (artifacts are content-addressed and never overwritten).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { hashFiles, sha256Hex } from "./hash.ts";
import { readProject, type ProjectConfig } from "./project.ts";
import { discoverFunctions, routeConflicts, routesOf, type FunctionModule, type Route } from "./routes.ts";
import { type Json, validate } from "./schema.ts";
import { schemas } from "./schemas.ts";

export class BuildError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(problems.length ? `${message}:\n  ${problems.join("\n  ")}` : message);
  }
}

export interface Manifest {
  artifact: { version: 0 };
  app: { name: string; timezone: string };
  code: { format: "esm-dir"; entry: Record<string, string> };
  routes: Route[];
  permissions: { network: string[]; secrets: string[] };
  limits?: ProjectConfig["limits"];
}

export interface BuildResult {
  hash: string;
  dir: string;
  /** Source maps of `code/`, outside the artifact. */
  mapsDir: string;
  manifest: Manifest;
  /** Bundled modules (rebuilt / taken from the cache). */
  rebuilt: number;
  cached: number;
  ms: number;
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

function listFiles(dir: string, rel = ""): string[] {
  if (!existsSync(join(dir, rel))) return [];
  const out: string[] = [];
  for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isSymbolicLink()) throw new BuildError(`V1: symbolic link ${r} is not allowed in an artifact`);
    if (d.isDirectory()) out.push(...listFiles(dir, r));
    else if (d.isFile()) out.push(r);
  }
  return out.sort();
}

async function bundle(project: string, functions: FunctionModule[]): Promise<Bundle> {
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
      throw new BuildError(
        "functions/ does not build",
        r.logs.map((l) => String(l.message ?? l)),
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
): Promise<{ files: Map<string, Uint8Array>; maps: Map<string, string>; manifest: Manifest; rebuilt: number; cached: number }> {
  const config = readProject(project);
  const functions = discoverFunctions(project);
  if (functions.length === 0) throw new BuildError("no routes: functions/ has no module exporting GET, POST, ...");
  const routes = routesOf(functions);
  const conflicts = routeConflicts(routes);
  if (conflicts.length) throw new BuildError("route conflicts", conflicts);
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
  const pubs = listFiles(pubDir);
  if (pubs.length) {
    const entries: Record<string, { sha256: string; size: number; content_type: string }> = {};
    for (const p of pubs) {
      if (p === "manifest.json") throw new BuildError("public/manifest.json is reserved in artifact version 0");
      const bytes = new Uint8Array(readFileSync(join(pubDir, p)));
      files.set(`public/${p}`, bytes);
      entries[`/${p}`] = { sha256: sha256Hex(bytes), size: bytes.length, content_type: contentType(p) };
    }
    const pm = { version: 0, files: entries };
    const errs = validate(schemas.publicManifest, pm as Json);
    if (errs.length) throw new BuildError("public/manifest.json", errs);
    files.set("public/manifest.json", enc.encode(`${JSON.stringify(pm, null, 2)}\n`));
  }

  const manifest: Manifest = {
    artifact: { version: 0 },
    app: config.app,
    code: { format: "esm-dir", entry },
    routes,
    permissions: config.permissions,
    ...(config.limits ? { limits: config.limits } : {}),
  };
  const errs = validate(schemas.manifest, manifest as unknown as Json);
  if (errs.length) throw new BuildError("manifest.json does not validate", errs);
  files.set("manifest.json", enc.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  return { files, maps: bundled.maps, manifest, rebuilt, cached };
}

/** `renox build`: write `<out>/<hash>/` and return its hash. */
export async function buildArtifact(project: string, out: string, cache?: BuildCache): Promise<BuildResult> {
  const t0 = performance.now();
  const { files, maps, manifest, rebuilt, cached } = await buildFiles(project, cache);
  const hash = hashFiles(files);
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
  return { hash, dir, mapsDir, manifest, rebuilt, cached, ms: performance.now() - t0 };
}

/** The default artifact folder of a project. */
export const artifactsDir = (project: string): string => join(project, ".renox", "artifact");

/** Total bytes under `code/` (V5 reports it). */
export function codeBytes(dir: string): number {
  return listFiles(join(dir, "code")).reduce((n, f) => n + statSync(join(dir, "code", f)).size, 0);
}
