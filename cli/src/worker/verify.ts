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
  version: "0.7.1",
  sha256: {
    "x86_64-unknown-linux-gnu": "1453a8d19c2d48125e60c6d5d488deb7670d1f4d8c66272c03846eba11d7774c",
    "aarch64-unknown-linux-gnu": "a9f91cfc11684bfcc277f8b7d10af2ecad27e57aa5fe7183bf85e3f53abd732a",
    "x86_64-apple-darwin": "eb86aa3e7e2ebe4e5a4d07377b89689081ba0fe5d03c27e298f88b8af9e7b47e",
    "aarch64-apple-darwin": "aeb975b1790a66660c12feda3fa889651ea937a9472acab769f60927b0b96e07",
    // The development worker for Windows (#531, #532): renox-worker-<version>-x86_64-pc-windows-msvc.exe.
    "x86_64-pc-windows-msvc": "b3b93471fc7049f46a982f0f13c15ce7386522e4df4af987699c1e1fad0a4276",
  },
  pdf: {
    "x86_64-unknown-linux-gnu": "d5cc6f3daa835456144b777bbce079539aa82360081ee2741737b272eb6f4630",
    "aarch64-unknown-linux-gnu": "b4dc1ea08dc0fb68c7070efdd39f732ebf2803afdad548a3fefc55e6d5ae446e",
    "x86_64-apple-darwin": "564eaabc25c1be9ec50652568b1c8c03000542d76dfd37f2207713f2c50bc1ac",
    "aarch64-apple-darwin": "ff87c515fa77d1d81cd95bbd687ec44e73962c657c99dfe21256a9a9efd83129",
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
