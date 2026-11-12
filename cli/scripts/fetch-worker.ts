// Download the prebuilt renox-worker for this platform from GitHub Releases
// into cli/bin/<platform>-<arch>/renox-worker, which `renox dev` uses when
// RENOX_WORKER_PATH is not set.
//
//   bun cli/scripts/fetch-worker.ts [--pdf] [<version>]      default: WORKER_VERSION
//
// --pdf fetches the variant with the PDF engine (`ctx.pdf`, #381) instead of
// the default build, which answers `ctx.pdf.render` with RENOX_INTERNAL,
// reason `pdf_unavailable`. Both install as renox-worker; the CLI accepts
// either pinned hash (cli/src/worker/verify.ts).
//
// Release assets (.github/workflows/release-worker.yml, #154), on the release
// tagged worker-v<version>:
//   renox-worker-<version>-<target>[.exe]    the binary (packaged: runs without a cargo registry)
//   renox-worker-<version>-<target>.sha256   its SHA-256 (hex, optionally followed by the file name)
//   renox-worker-<version>-<target>-pdf.gz         the variant with `ctx.pdf`, gzip-compressed
//   renox-worker-<version>-<target>-pdf.gz.sha256  the SHA-256 of the .gz
// The pdf binary is about 134 MiB, over the 128 MiB that cosign verifies
// (COSIGN_MAX_ATTACHMENT_SIZE); the signed asset is the .gz (#381).
// <target> is the Rust target triple (targetTriple below). The download is
// refused unless its SHA-256 matches. Signature verification of the release
// (sigstore) is #129.
//
// RENOX_RELEASE_BASE replaces https://github.com/<repo>/releases/download
// (same layout: <base>/worker-v<version>/<asset>), for a mirror or the
// release workflow's own smoke test.

import { gunzipSync } from "node:zlib";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../src/lib/hash.ts";

/** The worker release this CLI is tested against. */
export const WORKER_VERSION = "0.9.0";

const REPO = process.env.RENOX_RELEASE_REPO ?? "arif-rachim/renox.rs";

export const TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  // #531: development worker only (isolates, no supervisor or sandbox); no pdf build.
  "win32-x64": "x86_64-pc-windows-msvc",
};

/** The worker binary's file name on this platform; fetch-worker.ts and src/lib/worker.ts share it. */
export const WORKER_FILE = process.platform === "win32" ? "renox-worker.exe" : "renox-worker";

/** The Rust target triple of a Node platform and arch. */
export function targetTriple(platform: string = process.platform, arch: string = process.arch): string {
  const t = TARGETS[`${platform}-${arch}`];
  if (!t) throw new Error(`no renox-worker build for ${platform}-${arch}`);
  return t;
}

/** The default build, or the one with the PDF engine behind `ctx.pdf` (#381). */
export type WorkerVariant = "default" | "pdf";

/** The release asset of a worker build; the pdf variant is published gzip-compressed. */
export const assetName = (
  version: string,
  platform: string = process.platform,
  arch: string = process.arch,
  variant: WorkerVariant = "default",
): string =>
  `renox-worker-${version}-${targetTriple(platform, arch)}${variant === "pdf" ? "-pdf.gz" : platform === "win32" ? ".exe" : ""}`;

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
  variant: WorkerVariant = "default",
): Promise<string> {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error(`invalid version ${version}`);
  if (variant === "pdf" && process.platform === "win32") throw new Error(`no pdf renox-worker build for win32-${process.arch}`);
  const asset = assetName(version, process.platform, process.arch, variant);
  const [download, sum] = await Promise.all([get(releaseUrl(version, asset)), get(releaseUrl(version, `${asset}.sha256`))]);
  const expected = parseSha256File(new TextDecoder().decode(sum));
  const actual = sha256Hex(download);
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  // Decompressed only after the .gz verified; the CLI checks the binary's own
  // pinned sha256 before it runs it.
  let binary: Uint8Array = download;
  if (variant === "pdf") {
    try {
      binary = gunzipSync(download);
    } catch {
      throw new Error(`${asset} is not a gzip file`);
    }
  }
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.renox-worker.${process.pid}`);
  writeFileSync(tmp, binary);
  if (process.platform !== "win32") chmodSync(tmp, 0o755);
  const target = join(dir, WORKER_FILE);
  renameSync(tmp, target);
  return target;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const variant: WorkerVariant = args.includes("--pdf") ? "pdf" : "default";
  const version = args.find((a) => a !== "--pdf") ?? WORKER_VERSION;
  try {
    const path = await fetchWorker(version, undefined, variant);
    console.log(`renox-worker ${version}${variant === "pdf" ? " (pdf)" : ""} -> ${path}`);
  } catch (e) {
    console.error(`fetch-worker: ${(e as Error).message}`);
    process.exit(1);
  }
}
