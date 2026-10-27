// Download the prebuilt renox-worker for this platform from GitHub Releases
// into cli/bin/<platform>-<arch>/renox-worker, which `renox dev` uses when
// RENOX_WORKER_PATH is not set.
//
//   bun cli/scripts/fetch-worker.ts <version>        e.g. 0.1.0
//
// Release assets (produced by the CI release job, #36):
//   renox-worker-<platform>-<arch>          the binary
//   renox-worker-<platform>-<arch>.sha256   its SHA-256 (hex, optionally followed by the file name)
// The download is refused unless its SHA-256 matches. Signature
// verification of the release (sigstore) is #109 / #129.

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../src/lib/hash.ts";

const REPO = process.env.RENOX_RELEASE_REPO ?? "arif-rachim/renox.rs";

export const assetName = (platform = process.platform, arch = process.arch): string => `renox-worker-${platform}-${arch}`;

export const releaseUrl = (version: string, asset: string): string =>
  `https://github.com/${REPO}/releases/download/v${version}/${asset}`;

/** The hex digest from a `.sha256` file (`<hex>` or `<hex>  <name>`). */
export function parseSha256File(text: string): string {
  const hex = text.trim().split(/\s+/u)[0] ?? "";
  if (!/^[0-9a-f]{64}$/u.test(hex)) throw new Error("the .sha256 asset does not hold a SHA-256 digest");
  return hex;
}

async function get(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`GET ${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function fetchWorker(version: string): Promise<string> {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error(`invalid version ${version}`);
  const asset = assetName();
  const [binary, sum] = await Promise.all([get(releaseUrl(version, asset)), get(releaseUrl(version, `${asset}.sha256`))]);
  const expected = parseSha256File(new TextDecoder().decode(sum));
  const actual = sha256Hex(binary);
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  const dir = join(import.meta.dir, "..", "bin", `${process.platform}-${process.arch}`);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.renox-worker.${process.pid}`);
  writeFileSync(tmp, binary);
  chmodSync(tmp, 0o755);
  const target = join(dir, "renox-worker");
  renameSync(tmp, target);
  return target;
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: bun cli/scripts/fetch-worker.ts <version>");
    process.exit(2);
  }
  try {
    console.log(`renox-worker ${version} -> ${await fetchWorker(version)}`);
  } catch (e) {
    console.error(`fetch-worker: ${(e as Error).message}`);
    process.exit(1);
  }
}
