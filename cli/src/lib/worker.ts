// The prebuilt renox-worker binary: `renox dev` runs it, and `renox build`
// calls `renox-worker transpile` for templates (#43).

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { EnvironmentError } from "../errors.ts";
import { PINNED_WORKER, verifyPinned } from "../worker/verify.ts";

/** Where `bun cli/scripts/fetch-worker.ts` puts the release build. */
const BIN_DIR = join(import.meta.dir, "..", "..", "bin");

export const DOWNLOAD_HINT = "run `bun cli/scripts/fetch-worker.ts` to download the release build, or set RENOX_WORKER_PATH to a renox-worker binary";

/** A compiled `renox` (install.sh) finds the worker installed beside it; `bun src/main.ts` does not. */
const besideCli = (): string | undefined =>
  basename(process.execPath).startsWith("renox") ? join(dirname(process.execPath), "renox-worker") : undefined;

/**
 * The worker binary: RENOX_WORKER_PATH (a worker you built, not verified),
 * else <binDir>/<platform>-<arch>/renox-worker or the one installed beside a
 * compiled `renox`, which must have the pinned sha256 (#129). Exit 3 when
 * there is none or it does not verify.
 */
export function workerPath(env = process.env.RENOX_WORKER_PATH, binDir = BIN_DIR, pinned = PINNED_WORKER.sha256, installed = besideCli()): string {
  if (env) {
    const p = resolve(env);
    if (!existsSync(p)) throw new EnvironmentError(`RENOX_WORKER_PATH is ${p}, which does not exist`, { hint: DOWNLOAD_HINT });
    return p;
  }
  for (const p of [join(binDir, `${process.platform}-${process.arch}`, "renox-worker"), installed]) {
    if (p && existsSync(p)) {
      verifyPinned(p, undefined, pinned);
      return p;
    }
  }
  throw new EnvironmentError("no renox-worker binary: RENOX_WORKER_PATH is not set and none was downloaded", { hint: DOWNLOAD_HINT });
}
