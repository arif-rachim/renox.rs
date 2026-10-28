// Download the prebuilt renox-worker for this platform from GitHub Releases
// into cli/bin/<platform>-<arch>/renox-worker, which `renox dev` uses when
// RENOX_WORKER_PATH is not set.
//
//   bun cli/scripts/fetch-worker.ts [<version>]      default: WORKER_VERSION
//
// Release assets (.github/workflows/release-worker.yml, #154), on the release
// tagged worker-v<version>:
//   renox-worker-<version>-<target>          the binary (packaged: runs without a cargo registry)
//   renox-worker-<version>-<target>.sha256   its SHA-256 (hex, optionally followed by the file name)
// <target> is the Rust target triple (targetTriple below). The download is
// refused unless its SHA-256 matches. Signature verification of the release
// (sigstore) is #129.
//
// RENOX_RELEASE_BASE replaces https://github.com/<repo>/releases/download
// (same layout: <base>/worker-v<version>/<asset>), for a mirror or the
// release workflow's own smoke test.

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../src/lib/hash.ts";

/** The worker release this CLI is tested against. */
export const WORKER_VERSION = "0.1.0";

const REPO = process.env.RENOX_RELEASE_REPO ?? "arif-rachim/renox.rs";

const TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
};

/** The Rust target triple of a Node platform and arch. */
export function targetTriple(platform: string = process.platform, arch: string = process.arch): string {
  const t = TARGETS[`${platform}-${arch}`];
  if (!t) throw new Error(`no renox-worker build for ${platform}-${arch}`);
  return t;
}

export const assetName = (version: string, platform: string = process.platform, arch: string = process.arch): string =>
  `renox-worker-${version}-${targetTriple(platform, arch)}`;

export const releaseUrl = (version: string, asset: string, base = process.env.RENOX_RELEASE_BASE): string =>
  `${base ?? `https://github.com/${REPO}/releases/download`}/worker-v${version}/${asset}`;

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

/** Download, verify, and install the worker; returns its path. */
export async function fetchWorker(
  version: string = WORKER_VERSION,
  dir: string = join(import.meta.dir, "..", "bin", `${process.platform}-${process.arch}`),
): Promise<string> {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error(`invalid version ${version}`);
  const asset = assetName(version);
  const [binary, sum] = await Promise.all([get(releaseUrl(version, asset)), get(releaseUrl(version, `${asset}.sha256`))]);
  const expected = parseSha256File(new TextDecoder().decode(sum));
  const actual = sha256Hex(binary);
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.renox-worker.${process.pid}`);
  writeFileSync(tmp, binary);
  chmodSync(tmp, 0o755);
  const target = join(dir, "renox-worker");
  renameSync(tmp, target);
  return target;
}

if (import.meta.main) {
  const version = process.argv[2] ?? WORKER_VERSION;
  try {
    console.log(`renox-worker ${version} -> ${await fetchWorker(version)}`);
  } catch (e) {
    console.error(`fetch-worker: ${(e as Error).message}`);
    process.exit(1);
  }
}
