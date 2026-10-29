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
 */
export const PINNED_WORKER: { version: string; sha256: Readonly<Record<string, string>> } = {
  version: "0.1.0",
  sha256: {
    "x86_64-unknown-linux-gnu": "ccfc6ec259e271c258269cae42dcb6d28c681384988ea71fa8d7a34749e5c234",
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

const pinnedFor = (target: string, pinned: Readonly<Record<string, string>>): string => pinned[target] ?? "(none: no released worker for this target)";

/** The downloaded or installed worker: its sha256 must be the pinned one for `target`. */
export function verifyPinned(path: string, target: string = targetTriple(), pinned: Readonly<Record<string, string>> = PINNED_WORKER.sha256): void {
  const expected = pinnedFor(target, pinned);
  const actual = fileSha256(path);
  if (actual !== expected) {
    throw new WorkerUnverifiedError(path, expected, actual, `it is not renox-worker ${PINNED_WORKER.version} for ${target}`, REDOWNLOAD);
  }
}

export interface ExternalOptions {
  target?: string;
  pinned?: Readonly<Record<string, string>>;
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
  const expected = pinnedFor(target, opts.pinned ?? PINNED_WORKER.sha256);
  const actual = fileSha256(path);
  if (actual === expected) return "pinned";
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
