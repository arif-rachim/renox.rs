// Where the official modules are (#448; manifest.md Open 1: the repository's
// modules/ is the catalog shipped with the CLI).
//
// - From source: the repository's modules/.
// - A compiled `renox`: the copy embedded in the binary (lib/embedded.ts),
//   extracted once into $XDG_CACHE_HOME/renox/modules/<digest>/ (default
//   ~/.cache) and checked against its digest before each use, so a changed or
//   half-written copy is never resolved; it is extracted again instead.
// - RENOX_OFFICIAL_MODULES: set by `renox test` for the test process, which
//   runs the bundled harness under `bun` and must resolve the same modules.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { EMBEDDED, type Embedded } from "../embedded.ts";
import { readTree } from "../hash.ts";

/** The repository's modules/ (from source). */
export const REPO_MODULES = resolve(import.meta.dir, "../../../../modules");

/** sha256 over each file's path and content, in path order: the cache directory's name. */
export function modulesDigest(files: ReadonlyMap<string, Uint8Array>): string {
  const h = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path) as Uint8Array;
    h.update(`${path}\0${data.length}\0`);
    h.update(data);
  }
  return h.digest("hex");
}

const cacheRoot = (env: Record<string, string | undefined>): string => join(env.XDG_CACHE_HOME ?? join(env.HOME ?? homedir(), ".cache"), "renox", "modules");

/** The embedded modules on disk under `root`, extracted (atomically) when missing or not matching the digest. */
export function extractModules(e: Embedded, root = cacheRoot(process.env)): string {
  const dir = join(root, e.modulesDigest.slice(0, 16));
  if (existsSync(join(dir, ".digest")) && readFileSync(join(dir, ".digest"), "utf8") === e.modulesDigest && modulesDigest(withoutMarker(readTree(dir))) === e.modulesDigest) return dir;
  mkdirSync(root, { recursive: true });
  const tmp = mkdtempSync(join(root, ".extract-"));
  for (const [path, b64] of Object.entries(e.modules)) {
    const file = join(tmp, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(b64, "base64"));
  }
  if (modulesDigest(readTree(tmp)) !== e.modulesDigest) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error("the official modules embedded in this renox binary do not match their digest; reinstall the CLI");
  }
  writeFileSync(join(tmp, ".digest"), e.modulesDigest);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return dir;
}

function withoutMarker(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  files.delete(".digest");
  return files;
}

/** The directory holding the official modules (one folder per catalog name). */
export function officialModulesDir(env: Record<string, string | undefined> = process.env, embedded: Embedded | null = EMBEDDED): string {
  if (env.RENOX_OFFICIAL_MODULES) return env.RENOX_OFFICIAL_MODULES;
  if (embedded !== null) return extractModules(embedded, cacheRoot(env));
  return REPO_MODULES;
}
