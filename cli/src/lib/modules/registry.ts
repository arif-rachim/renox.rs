// Registry modules (manifest.md 1.2, section 5; deploy-api.md 0.5 section
// 19; #323): `source = "registry:<publisher>/<name>"`. `renox add` and
// `renox install` download the version into `.renox/modules/<name>/registry/<version>/`,
// recompute the tree hash, and verify `module.sig` (MF15) before anything
// reads the tree; the resolver then reads the cache only.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { extractTar } from "@renox/artifact-validate";

import { apiRequest, type Io } from "../../commands/login.ts";
import { type ModuleSig, SIG_FILE, signedTreeHash, verifySig } from "../sign.ts";
import { compareVersions, parseVersion } from "./semver.ts";

const compare = (a: string, b: string): number => compareVersions(parseVersion(a) ?? [0, 0, 0, []], parseVersion(b) ?? [0, 0, 0, []]);

export const REGISTRY = /^registry:([a-z0-9][a-z0-9-]{0,38})\/([a-z][a-z0-9_]{0,31})$/u;

export const registryDir = (project: string, name: string): string => join(project, ".renox", "modules", name, "registry");

/** The module.sig of a tree, verified against the tree (MF15); a reason when it is not. */
export function checkTree(tree: string, publisher: string, name: string): { sig: ModuleSig } | { problem: string } {
  const path = join(tree, SIG_FILE);
  if (!existsSync(path)) return { problem: `${name}: module.sig is missing` };
  let sig: ModuleSig;
  try {
    sig = JSON.parse(readFileSync(path, "utf8")) as ModuleSig;
  } catch {
    return { problem: `${name}: module.sig is not JSON` };
  }
  if (sig.publisher !== publisher || sig.name !== name) return { problem: `${name}: module.sig names ${sig.publisher}/${sig.name}` };
  if (!verifySig(sig, signedTreeHash(tree))) return { problem: `${name}: the signature does not verify over the tree` };
  return { sig };
}

/** The newest cached and verified version of a registry module, or a problem. */
export function cachedTree(project: string, source: string): { tree: string; sig: ModuleSig } {
  const m = REGISTRY.exec(source);
  if (m === null) throw new Error(`not a registry source: ${source}`);
  const [, publisher, name] = m as unknown as [string, string, string];
  const dir = registryDir(project, name);
  const versions = existsSync(dir) ? readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+/u.test(v)).sort(compare).reverse() : [];
  if (versions.length === 0) throw new Error(`${source} is not downloaded; run renox add or renox install`);
  const tree = join(dir, versions[0] as string);
  const checked = checkTree(tree, publisher, name);
  if ("problem" in checked) throw new Error(`MF15: ${checked.problem}`);
  return { tree, sig: checked.sig };
}

/** Downloads `version` of a registry module into the cache and verifies it. */
export async function download(io: Io, project: string, source: string, version: string): Promise<{ tree: string; sig: ModuleSig }> {
  const m = REGISTRY.exec(source);
  if (m === null) throw new Error(`not a registry source: ${source}`);
  const [, publisher, name] = m as unknown as [string, string, string];
  const meta = await apiRequest(io, "GET", `/v1/registry/${publisher}/${name}/${version}`);
  if (!meta.ok) throw new Error(`the registry answered ${meta.status} for ${publisher}/${name}@${version}`);
  const info = (await meta.json()) as { hash: string; key_id: string; disabled: unknown };
  if (info.disabled !== null && info.disabled !== undefined) throw new Error(`${publisher}/${name}@${version} is disabled`);
  const res = await apiRequest(io, "GET", `/v1/registry/${publisher}/${name}/${version}/tree`);
  if (!res.ok) throw new Error(`the registry answered ${res.status} for the tree of ${publisher}/${name}@${version}`);
  const files = await extractTar(new Uint8Array(await res.arrayBuffer()), { gzip: false });
  const tree = join(registryDir(project, name), version);
  const tmp = `${tree}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  for (const [p, bytes] of files) {
    mkdirSync(dirname(join(tmp, p)), { recursive: true });
    writeFileSync(join(tmp, p), bytes);
  }
  const checked = checkTree(tmp, publisher, name);
  if ("problem" in checked || checked.sig.key_id !== info.key_id || checked.sig.hash !== info.hash) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`MF15: ${"problem" in checked ? checked.problem : `${name}: the tree does not match what the registry lists`}`);
  }
  rmSync(tree, { recursive: true, force: true });
  renameSync(tmp, tree);
  return { tree, sig: checked.sig };
}
