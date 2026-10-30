// The SBOM of a build (#123; artifact.md 1.4, `sbom.cdx.json`, rule V29): the
// npm packages bundled into `code/`, as a CycloneDX 1.5 JSON document. A
// package counts when one of its files is a source of a bundled module's
// source map (so only what was bundled, not every installed dependency).
// Versions come from the package's own package.json, integrity from the
// nearest bun.lock. Sorted and without a timestamp, so the same build gives
// the same bytes (the artifact's content hash covers the file).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface SbomPackage {
  name: string;
  version: string;
  integrity: string | null;
}

/** The `node_modules/<name>/` (or `@scope/name`) of a bundled source path, or null. */
export function packageDirOf(source: string): string | null {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//u.exec(source.replaceAll("\\", "/"));
  return m === null ? null : (m[1] as string);
}

/** `name -> sha512 integrity` from a bun.lock (JSONC: trailing commas). */
export function lockIntegrity(lockText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of lockText.matchAll(/"([^"]+)": \["((?:@[^@"]+\/)?[^@"]+)@([^"]+)", [^\n]*?"(sha512-[A-Za-z0-9+/=]+)"\]/gu)) out.set(`${m[2]}@${m[3]}`, m[4] as string);
  return out;
}

function nearestLock(from: string): string | null {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(join(d, "bun.lock"))) return join(d, "bun.lock");
    if (dirname(d) === d) return null;
  }
}

/** The bundled packages of a build: `maps` are the bundle's source maps (path -> JSON text), resolved against `project`. */
export function bundledPackages(project: string, maps: ReadonlyMap<string, string>): SbomPackage[] {
  const dirs = new Set<string>();
  for (const [mapPath, text] of maps) {
    let sources: unknown = [];
    try {
      sources = (JSON.parse(text) as { sources?: unknown }).sources ?? [];
    } catch {
      continue;
    }
    for (const s of Array.isArray(sources) ? sources : []) {
      if (typeof s !== "string") continue;
      // The bundler's sources are relative to the project (the build's working directory).
      const dir = packageDirOf(resolve(project, s));
      if (dir !== null) dirs.add(dir);
    }
  }
  const lock = nearestLock(project);
  const integrity = lock === null ? new Map<string, string>() : lockIntegrity(readFileSync(lock, "utf8"));
  const out = new Map<string, SbomPackage>();
  for (const dir of dirs) {
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) continue;
    const p = JSON.parse(readFileSync(pj, "utf8")) as { name?: string; version?: string };
    if (typeof p.name !== "string" || typeof p.version !== "string") continue;
    out.set(`${p.name}@${p.version}`, { name: p.name, version: p.version, integrity: integrity.get(`${p.name}@${p.version}`) ?? null });
  }
  return [...out.values()].sort((a, b) => (a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1));
}

const purl = (p: SbomPackage): string => `pkg:npm/${p.name.startsWith("@") ? `%40${p.name.slice(1)}` : p.name}@${p.version}`;

/** The CycloneDX 1.5 document of `packages` for the app `app`. */
export function cyclonedx(app: string, packages: readonly SbomPackage[]): string {
  const doc = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: { component: { type: "application", name: app } },
    components: packages.map((p) => ({
      type: "library",
      name: p.name,
      version: p.version,
      purl: purl(p),
      ...(p.integrity === null ? {} : { hashes: [{ alg: "SHA-512", content: Buffer.from(p.integrity.slice("sha512-".length), "base64").toString("hex") }] }),
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
