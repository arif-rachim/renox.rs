// The prebuilt renox-worker binary: `renox dev` runs it, and `renox build`
// calls `renox-worker transpile` for templates (#43).

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { EnvironmentError } from "../errors.ts";

/** Where `bun cli/scripts/fetch-worker.ts` puts the release build. */
const BIN_DIR = join(import.meta.dir, "..", "..", "bin");

export const DOWNLOAD_HINT = "run `bun cli/scripts/fetch-worker.ts` to download the release build, or set RENOX_WORKER_PATH to a renox-worker binary";

/** The worker binary: RENOX_WORKER_PATH, else <binDir>/<platform>-<arch>/renox-worker. Exit 3 when there is none. */
export function workerPath(env = process.env.RENOX_WORKER_PATH, binDir = BIN_DIR): string {
  if (env) {
    const p = resolve(env);
    if (!existsSync(p)) throw new EnvironmentError(`RENOX_WORKER_PATH is ${p}, which does not exist`, { hint: DOWNLOAD_HINT });
    return p;
  }
  const p = join(binDir, `${process.platform}-${process.arch}`, "renox-worker");
  if (existsSync(p)) return p;
  throw new EnvironmentError("no renox-worker binary: RENOX_WORKER_PATH is not set and none was downloaded", { hint: DOWNLOAD_HINT });
}
