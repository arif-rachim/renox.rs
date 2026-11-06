// The prebuilt renox-worker binary: `renox dev` runs it, and `renox build`
// calls `renox-worker transpile` for templates (#43).

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { TARGETS } from "../../scripts/fetch-worker.ts";
import { EnvironmentError } from "../errors.ts";
import { PINNED_WORKER, verifyPinned } from "../worker/verify.ts";

/** Where `bun cli/scripts/fetch-worker.ts` puts the release build. */
const BIN_DIR = join(import.meta.dir, "..", "..", "bin");

export const DOWNLOAD_HINT = "run `bun cli/scripts/fetch-worker.ts` to download the release build, or set RENOX_WORKER_PATH to a renox-worker binary";

/** The worker binary's file name on this platform. */
export const WORKER_FILE = process.platform === "win32" ? "renox-worker.exe" : "renox-worker";

export const UNAVAILABLE = "RENOX_CLI_WORKER_UNAVAILABLE";

/** This platform has no renox-worker build (Windows today): the command needs one (#441, #442). */
export class WorkerUnavailableError extends EnvironmentError {
  readonly code = UNAVAILABLE;
  constructor(readonly target: string) {
    super(`${UNAVAILABLE}: renox-worker has no build for ${target}; this command needs it`, {
      hint: "Run renox inside WSL 2 (wsl --install -d Ubuntu); a native Windows worker is #442. new, check and build of an app without .html pages or policies, login, deploy, logs, secrets and db work natively.",
    });
  }
}

/** A compiled `renox` (install.sh) finds the worker installed beside it; `bun src/main.ts` does not. */
const besideCli = (): string | undefined =>
  basename(process.execPath).startsWith("renox") ? join(dirname(process.execPath), WORKER_FILE) : undefined;

/**
 * The worker binary: RENOX_WORKER_PATH (a worker you built, not verified),
 * else <binDir>/<platform>-<arch>/renox-worker or the one installed beside a
 * compiled `renox`, which must have the pinned sha256 (#129) of the default
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
): string {
  if (env) {
    const p = resolve(env);
    if (!existsSync(p)) throw new EnvironmentError(`RENOX_WORKER_PATH is ${p}, which does not exist`, { hint: DOWNLOAD_HINT });
    return p;
  }
  if (!(target in TARGETS)) throw new WorkerUnavailableError(target);
  for (const p of [join(binDir, `${process.platform}-${process.arch}`, WORKER_FILE), installed]) {
    if (p && existsSync(p)) {
      verifyPinned(p, undefined, pinned, pdf);
      return p;
    }
  }
  throw new EnvironmentError("no renox-worker binary: RENOX_WORKER_PATH is not set and none was downloaded", { hint: DOWNLOAD_HINT });
}
