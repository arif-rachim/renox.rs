// `renox build`: project → artifact directory (docs/contracts/artifact.md).
//
// - Routes from functions/ (routes.ts); each function module is bundled on
//   its own with Bun.build, so npm and bare imports are vendored into the
//   module and nothing is resolved at runtime (code.format = "esm-dir").
//   TypeScript types are stripped; source maps are inline (esm-dir allows
//   only .js/.mjs/.json files), with project-relative source paths.
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
  manifest: Manifest;
  /** Bundled modules (rebuilt / taken from the cache). */
  rebuilt: number;
  cached: number;
  ms: number;
}

/** Per-module bundle cache for `renox dev`: a module is rebuilt when its source changed. */
export class BuildCache {
  private readonly bundles = new Map<string, { key: string; code: string }>();
  /** Set when a non-entry file changed: every module may import it. */
  invalidateAll = false;

  get(id: string, key: string): string | undefined {
    if (this.invalidateAll) return undefined;
    const e = this.bundles.get(id);
    return e && e.key === key ? e.code : undefined;
  }

  set(id: string, key: string, code: string): void {
    this.bundles.set(id, { key, code });
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

async function bundle(project: string, f: FunctionModule): Promise<string> {
  // Paths in comments and source maps are relative to the working
  // directory: build from the project so the artifact is reproducible.
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const r = await Bun.build({
      entrypoints: [f.source],
      target: "browser",
      format: "esm",
      sourcemap: "inline",
      // node: built-ins stay imports; the runtime offers the compute-only ones.
      external: ["node:*"],
      throw: false,
    });
    if (!r.success) {
      throw new BuildError(
        `${f.source} does not build`,
        r.logs.map((l) => String(l.message ?? l)),
      );
    }
    const out = r.outputs.find((o) => o.kind === "entry-point");
    if (!out || r.outputs.length !== 1) throw new BuildError(`${f.source}: expected one output file`);
    return await out.text();
  } finally {
    process.chdir(cwd);
  }
}

/** Build the artifact files in memory: path → bytes. */
export async function buildFiles(
  project: string,
  cache?: BuildCache,
): Promise<{ files: Map<string, Uint8Array>; manifest: Manifest; rebuilt: number; cached: number }> {
  const config = readProject(project);
  const functions = discoverFunctions(project);
  if (functions.length === 0) throw new BuildError("no routes: functions/ has no module exporting GET, POST, ...");
  const routes = routesOf(functions);
  const conflicts = routeConflicts(routes);
  if (conflicts.length) throw new BuildError("route conflicts", conflicts);
  const enc = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  const entry: Record<string, string> = {};
  let rebuilt = 0;
  let cached = 0;
  for (const f of functions) {
    const key = sha256Hex(readFileSync(join(project, f.source)));
    let code = cache?.get(f.id, key);
    if (code === undefined) {
      code = await bundle(project, f);
      cache?.set(f.id, key, code);
      rebuilt++;
    } else {
      cached++;
    }
    const out = `${f.id}.js`;
    entry[f.id] = out;
    files.set(`code/${out}`, enc.encode(code));
  }
  if (cache) cache.invalidateAll = false;
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
  return { files, manifest, rebuilt, cached };
}

/** `renox build`: write `<out>/<hash>/` and return its hash. */
export async function buildArtifact(project: string, out: string, cache?: BuildCache): Promise<BuildResult> {
  const t0 = performance.now();
  const { files, manifest, rebuilt, cached } = await buildFiles(project, cache);
  const hash = hashFiles(files);
  const dir = join(out, hash);
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
  return { hash, dir, manifest, rebuilt, cached, ms: performance.now() - t0 };
}

/** The default artifact folder of a project. */
export const artifactsDir = (project: string): string => join(project, ".renox", "artifact");

/** Total bytes under `code/` (V5 reports it). */
export function codeBytes(dir: string): number {
  return listFiles(join(dir, "code")).reduce((n, f) => n + statSync(join(dir, "code", f)).size, 0);
}
