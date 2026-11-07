// The prebuilt renox-worker binary: `renox dev` runs it, and `renox build`
// calls `renox-worker transpile` for templates (#43).

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { assetName, fetchWorker, releaseUrl, TARGETS, WORKER_FILE, WORKER_VERSION } from "../../scripts/fetch-worker.ts";
import { EnvironmentError } from "../errors.ts";
import { PINNED_WORKER, verifyPinned } from "../worker/verify.ts";

/** Where `bun cli/scripts/fetch-worker.ts` puts the release build. */
const BIN_DIR = join(import.meta.dir, "..", "..", "bin");

/** Where install.sh puts the worker, and where `ensureWorker` downloads it to (#440, D30). */
export const CACHE_DIR = join(homedir(), ".renox", "bin");

export const DOWNLOAD_HINT = "run `bun cli/scripts/fetch-worker.ts` to download the release build, or set RENOX_WORKER_PATH to a renox-worker binary";

export { WORKER_FILE };

export const UNAVAILABLE = "RENOX_CLI_WORKER_UNAVAILABLE";

/** This platform has no renox-worker build, or none is pinned in this CLI (Windows arm64; Windows x64 is pinned from worker 0.4.0, #532): the command needs one (#441, #442). */
export class WorkerUnavailableError extends EnvironmentError {
  readonly code = UNAVAILABLE;
  constructor(readonly target: string) {
    super(`${UNAVAILABLE}: renox-worker has no build for ${target}; this command needs it`, {
      hint:
        target in TARGETS
          ? "a native worker is published but not yet pinned in this CLI (#442); set RENOX_WORKER_PATH to a renox-worker.exe you built or downloaded, or use WSL 2 (wsl --install -d Ubuntu). new, check and build of an app without .html pages or policies, login, deploy, logs, secrets and db work natively."
          : "Run renox inside WSL 2 (wsl --install -d Ubuntu); a native Windows worker is #442. new, check and build of an app without .html pages or policies, login, deploy, logs, secrets and db work natively.",
    });
  }
}

/** A compiled `renox` (install.sh) finds the worker installed beside it; `bun src/main.ts` does not. */
const besideCli = (): string | undefined =>
  basename(process.execPath).startsWith("renox") ? join(dirname(process.execPath), WORKER_FILE) : undefined;

/**
 * The worker binary: RENOX_WORKER_PATH (a worker you built, not verified),
 * else <binDir>/<platform>-<arch>/renox-worker or the one installed beside a
 * compiled `renox`, else the cache ~/.renox/bin (install.sh, `ensureWorker`),
 * which must have the pinned sha256 (#129) of the default
 * build or of the variant with `ctx.pdf` (`fetch-worker.ts --pdf`, #381). Exit 3 when
 * there is none or it does not verify.
 */
export function workerPath(
  env = process.env.RENOX_WORKER_PATH,
  binDir = BIN_DIR,
  pinned = PINNED_WORKER.sha256,
  installed = besideCli(),
  pdf = PINNED_WORKER.pdf,
  target = `${process.platform}-${process.arch}`,
  cacheDir = CACHE_DIR,
): string {
  if (env) {
    const p = resolve(env);
    if (!existsSync(p)) throw new EnvironmentError(`RENOX_WORKER_PATH is ${p}, which does not exist`, { hint: DOWNLOAD_HINT });
    return p;
  }
  // No build for the platform, or none pinned yet: a worker without a pinned sha256 would not verify (#531, F7-107).
  const triple = TARGETS[target];
  if (triple === undefined || pinned[triple] === undefined) throw new WorkerUnavailableError(target);
  for (const p of [join(binDir, `${process.platform}-${process.arch}`, WORKER_FILE), installed, join(cacheDir, WORKER_FILE)]) {
    if (p && existsSync(p)) {
      verifyPinned(p, undefined, pinned, pdf);
      return p;
    }
  }
  throw new EnvironmentError("no renox-worker binary: RENOX_WORKER_PATH is not set and none was downloaded", { hint: DOWNLOAD_HINT });
}

/** The message `workerPath` throws when there is no worker anywhere. */
const NO_WORKER = "no renox-worker binary";

export interface EnsureWorkerOptions {
  /** Where the worker is downloaded to; default ~/.renox/bin. */
  cacheDir?: string;
  /** The worker release to download; default WORKER_VERSION. */
  version?: string;
  log?: (line: string) => void;
  /** For tests: the lookup arguments of `workerPath`. */
  env?: string | undefined;
  binDir?: string;
  pinned?: Readonly<Record<string, string>>;
  pdf?: Readonly<Record<string, string>>;
  installed?: string | undefined;
}

/**
 * The worker for this CLI. Like `workerPath`, and when there is none anywhere
 * (a CLI installed from npm carries no worker, D30) it downloads the pinned
 * release into the cache, checks the asset's sha256, and then verifies the
 * binary against the pins again. An unsupported platform and a worker that
 * does not verify are not downloaded over: both are rethrown.
 */
export async function ensureWorker(opts: EnsureWorkerOptions = {}): Promise<string> {
  const cacheDir = opts.cacheDir ?? CACHE_DIR;
  const lookup = (): string =>
    workerPath(
      "env" in opts ? opts.env : process.env.RENOX_WORKER_PATH,
      opts.binDir ?? BIN_DIR,
      opts.pinned ?? PINNED_WORKER.sha256,
      "installed" in opts ? opts.installed : besideCli(),
      opts.pdf ?? PINNED_WORKER.pdf,
      undefined,
      cacheDir,
    );
  try {
    return lookup();
  } catch (e) {
    if (e instanceof WorkerUnavailableError || !(e instanceof EnvironmentError) || !e.message.startsWith(NO_WORKER)) throw e;
  }
  const version = opts.version ?? WORKER_VERSION;
  let path: string;
  try {
    path = await fetchWorker(version, cacheDir);
  } catch (e) {
    const url = releaseUrl(version, assetName(version));
    throw new EnvironmentError(`could not download renox-worker ${version}: ${(e as Error).message}`, {
      hint: `download it by hand: curl -fLO ${url} -O ${url}.sha256, check the sha256, put the file at ${join(cacheDir, WORKER_FILE)} (chmod +x), or set RENOX_WORKER_PATH to a renox-worker binary`,
    });
  }
  const mb = (statSync(path).size / 1048576).toFixed(1);
  (opts.log ?? ((l) => console.error(l)))(`renox: downloaded renox-worker ${version} for ${process.platform}-${process.arch} (${mb} MB, sha256 checked) -> ${path}`);
  return lookup();
}
