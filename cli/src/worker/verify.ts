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
  version: "0.10.0",
  sha256: {
    "x86_64-unknown-linux-gnu": "5f6eb6a3314863d41e202f5f1c5b5a764fa0047b33e8c2d56c2983e9fcb37348",
    "aarch64-unknown-linux-gnu": "48f2835ddd1d1da56d00768667ac7556a80c87827907f881fe858a725710f58f",
    "x86_64-apple-darwin": "e2be89be2675e1b2706bd4f3340ece076903a8520ee6a847106446ca8116a0c9",
    "aarch64-apple-darwin": "9709cf78dab2b3c92ce937e2eda570cd591066d30c95bdbe859ef1980bd2fdd5",
    // The development worker for Windows (#531, #532): renox-worker-<version>-x86_64-pc-windows-msvc.exe.
    "x86_64-pc-windows-msvc": "50b4f6c54e447694fa6943095d3ebc7cfa25ecc52384f50e95ef25b0b47b7a18",
  },
  pdf: {
    "x86_64-unknown-linux-gnu": "1417fc4664fcf06770d15fb84cf92813f2cd8749f7afc1e3b5fc3ba0154fa101",
    "aarch64-unknown-linux-gnu": "a4f2b2a59747d3bcbf3b4dfc4a087479ce67fe224bcb2a6fa2cf9c9268686d30",
    "x86_64-apple-darwin": "49a3a1e7122e324f39f6ad6e12363413c52d74b5d36f91d9df6340959617732a",
    "aarch64-apple-darwin": "1affa97124122b9943aba1ab456da3a898299edafd182a155f4adfc521b31898",
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
