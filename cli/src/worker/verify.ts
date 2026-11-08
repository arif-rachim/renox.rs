// Verification of the renox-worker binary before the CLI runs it (#129;
// docs/24-threat-model.md section F, "Tampered release"). `renox dev` runs
// our prebuilt worker on every developer's machine, so the CLI refuses a
// binary it cannot trace to a release built by this repository:
//
// - The downloaded or installed worker (cli/bin/<platform>-<arch>, or next to
//   a compiled `renox`) must have the sha256 pinned below for its target.
//   The hashes are part of the source, so `bun build --compile` bakes them
//   into the CLI; release-cli.yml refuses a release whose pins differ from
//   the pinned worker release.
// - `renox dev --worker <path>` accepts a binary with a pinned hash, or one
//   whose sigstore bundle (`<path>.sigstore.json`) and SLSA provenance
//   (`renox-worker-<version>.provenance.sigstore.json` beside it) verify with
//   `cosign` against release-worker.yml on a worker-v* tag of this repository.
//
// Anything else is RENOX_CLI_WORKER_UNVERIFIED (docs/contracts/errors.md),
// exit code 3, with the expected and actual sha256. RENOX_WORKER_PATH stays
// the unverified override for a worker built from source (cli/README.md).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { targetTriple } from "../../scripts/fetch-worker.ts";
import { EnvironmentError } from "../errors.ts";
import { sha256Hex } from "../lib/hash.ts";

export const CODE = "RENOX_CLI_WORKER_UNVERIFIED";

/**
 * The sha256 of each released binary of the pinned worker (WORKER_VERSION in
 * cli/scripts/fetch-worker.ts), from the release's `.sha256` assets. Bump
 * both together. A target without an entry has no released worker yet.
 *
 * `pdf` pins the variant with the PDF engine (#381): the sha256 of the
 * binary after `gunzip`, from the release's signed `SHA256SUMS.unpacked`
 * (the asset itself, `-pdf.gz`, is what `SHA256SUMS` lists). Linux and
 * macOS only: there is no pdf variant for Windows.
 */
export const PINNED_WORKER: {
  version: string;
  sha256: Readonly<Record<string, string>>;
  pdf: Readonly<Record<string, string>>;
} = {
  version: "0.5.0",
  sha256: {
    "x86_64-unknown-linux-gnu": "ce2402786755ca17cc6ee93a1e504e7f8e3b4f6b977816e38ed3d7214b8868e7",
    "aarch64-unknown-linux-gnu": "9aee4d6398f8eb531e4548407c2ed96bd985f5938fc2405abca1603bcd4721f6",
    "x86_64-apple-darwin": "8def0ce348d426300f8ce9595d63342e4189b8e07d6512a065bf98f1c314d9aa",
    "aarch64-apple-darwin": "66c235915fc68dddf8a816145028b7254a234142aae4a07ca4b1e247c8f41ec6",
    // The development worker for Windows (#531, #532): renox-worker-<version>-x86_64-pc-windows-msvc.exe.
    "x86_64-pc-windows-msvc": "efc4d353fba549c34604c10b82116603ab8cf24b99bcc8accbd02b152ffb391d",
  },
  pdf: {
    "x86_64-unknown-linux-gnu": "d5e075619caa1a79ce2a04074b87a84594d3ae4f5ea360bd49b1da9a7b62d71b",
    "aarch64-unknown-linux-gnu": "c1d07ab162d43be116f997a26808b04d1db33d3ef19bef0340f56af8dd5be06f",
    "x86_64-apple-darwin": "a5f776f755f58140189097a1326c396295639831b4ffcdaf55c12884a29079ba",
    "aarch64-apple-darwin": "174eea47c8681dd9e3103b7578df5b53b99816fc95c4e0357a29351e0f663fa7",
  },
};

export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The signing certificate identity of a worker release: release-worker.yml on a worker-v* tag of `repo`. */
export const workerIdentity = (repo = process.env.RENOX_RELEASE_REPO ?? "arif-rachim/renox.rs"): string =>
  `^https://github\\.com/${escape(repo)}/\\.github/workflows/release-worker\\.yml@refs/tags/worker-v`;

export class WorkerUnverifiedError extends EnvironmentError {
  readonly code = CODE;
  constructor(
    readonly path: string,
    readonly expected: string,
    readonly actual: string,
    why: string,
    hint: string,
  ) {
    super(`${CODE}: refusing to run ${path}: ${why} (expected sha256 ${expected}, actual ${actual})`, { hint });
  }
}

const REDOWNLOAD = "download the pinned worker again with `bun cli/scripts/fetch-worker.ts`, or reinstall with install.sh; never run a worker that does not verify";

/** sha256 of a file; the last result per path, size, and mtime is reused. */
const hashed = new Map<string, { key: string; hex: string }>();
export function fileSha256(path: string): string {
  const s = statSync(path);
  const key = `${s.size}:${s.mtimeMs}:${s.ino}`;
  const hit = hashed.get(path);
  if (hit?.key === key) return hit.hex;
  const hex = sha256Hex(readFileSync(path));
  hashed.set(path, { key, hex });
  return hex;
}

const pinnedFor = (target: string, pinned: Readonly<Record<string, string>>, pdf: Readonly<Record<string, string>> = {}): string => {
  const lean = pinned[target] ?? "(none: no released worker for this target)";
  return pdf[target] ? `${lean} or ${pdf[target]} (pdf)` : lean;
};

/**
 * Which pinned build `hex` is for `target`: the default one, the one with the
 * PDF engine, or none.
 */
export function pinnedVariant(
  hex: string,
  target: string = targetTriple(),
  pinned: Readonly<Record<string, string>> = PINNED_WORKER.sha256,
  pdf: Readonly<Record<string, string>> = PINNED_WORKER.pdf,
): "default" | "pdf" | undefined {
  if (pinned[target] === hex) return "default";
  if (pdf[target] === hex) return "pdf";
  return undefined;
}

/** The downloaded or installed worker: its sha256 must be a pinned one for `target` (the default build or the pdf variant). */
export function verifyPinned(
  path: string,
  target: string = targetTriple(),
  pinned: Readonly<Record<string, string>> = PINNED_WORKER.sha256,
  pdf: Readonly<Record<string, string>> = PINNED_WORKER.pdf,
): void {
  const expected = pinnedFor(target, pinned, pdf);
  const actual = fileSha256(path);
  if (!pinnedVariant(actual, target, pinned, pdf)) {
    throw new WorkerUnverifiedError(path, expected, actual, `it is not renox-worker ${PINNED_WORKER.version} for ${target}`, REDOWNLOAD);
  }
}

export interface ExternalOptions {
  target?: string;
  pinned?: Readonly<Record<string, string>>;
  /** The pins of the pdf variant (default PINNED_WORKER.pdf). */
  pdf?: Readonly<Record<string, string>>;
  /** The cosign binary (default `cosign` on PATH). */
  cosign?: string;
  /** The provenance bundle; default the one `*.provenance.sigstore.json` beside the binary. */
  provenance?: string;
}

/** A provenance bundle beside the binary, or undefined when there is none or more than one. */
function findProvenance(path: string): string | undefined {
  const dir = dirname(path);
  const found = readdirSync(dir).filter((f) => f.endsWith(".provenance.sigstore.json"));
  return found.length === 1 ? join(dir, found[0] as string) : undefined;
}

/**
 * `renox dev --worker <path>`: a pinned hash, or a sigstore signature and SLSA
 * provenance that `cosign` verifies against this repository's worker release
 * workflow. Returns how it verified.
 */
export function verifyExternal(path: string, opts: ExternalOptions = {}): "pinned" | "signed" {
  const target = opts.target ?? targetTriple();
  const pinned = opts.pinned ?? PINNED_WORKER.sha256;
  const pdf = opts.pdf ?? PINNED_WORKER.pdf;
  const expected = pinnedFor(target, pinned, pdf);
  const actual = fileSha256(path);
  // The pdf variant, unpacked from its signed .gz, is accepted by its pin only:
  // cosign cannot verify the 134 MiB binary itself (#381).
  if (pinnedVariant(actual, target, pinned, pdf)) return "pinned";
  const refuse = (why: string, hint: string): never => {
    throw new WorkerUnverifiedError(path, expected, actual, why, hint);
  };
  const SIGNED_HINT = `pass a renox-worker from a worker-v* release with its ${basename(path)}.sigstore.json and the release's .provenance.sigstore.json beside it`;
  const bundle = `${path}.sigstore.json`;
  if (!existsSync(bundle)) refuse(`it is not the pinned worker and has no signature (${bundle})`, SIGNED_HINT);
  const provenance = opts.provenance ?? findProvenance(path);
  if (!provenance || !existsSync(provenance)) refuse("it is not the pinned worker and has no single *.provenance.sigstore.json beside it", SIGNED_HINT);
  const identity = ["--certificate-identity-regexp", workerIdentity(), "--certificate-oidc-issuer", OIDC_ISSUER];
  const checks: [string, string[]][] = [
    ["signature", ["verify-blob", "--bundle", bundle, ...identity, path]],
    ["provenance", ["verify-blob-attestation", "--bundle", provenance as string, "--new-bundle-format", "--type", "slsaprovenance1", ...identity, path]],
  ];
  for (const [what, args] of checks) {
    let r: { exitCode: number | null; stderr: Uint8Array };
    try {
      r = Bun.spawnSync([opts.cosign ?? "cosign", ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    } catch {
      return refuse("cosign is not installed, so its signature cannot be checked", "install cosign (https://docs.sigstore.dev/cosign/system_config/installation/) and run again");
    }
    if (r.exitCode !== 0) {
      const last = new TextDecoder().decode(r.stderr).trim().split("\n").pop() ?? "";
      refuse(`its ${what} does not verify${last ? `: ${last}` : ""}`, SIGNED_HINT);
    }
  }
  return "signed";
}
