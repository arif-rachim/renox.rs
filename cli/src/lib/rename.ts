// A rename that survives Windows. There, renaming a file or folder that was
// just written fails with EPERM, EACCES or EBUSY while another process (the
// virus scanner, the search indexer, the worker reading it) holds it open for
// a moment. Linux and macOS never fail this way.

import { existsSync, renameSync, rmSync } from "node:fs";

const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Waits `ms` without an event loop (the callers are synchronous). */
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Renames `from` to `to`, retrying a transient Windows lock for about 2 s.
 * With `contentAddressed`, `to` is named by the hash of its content: if it
 * exists when the rename fails, it holds the same bytes, so `from` is removed
 * and the call succeeds.
 */
export function renameRetry(from: string, to: string, opts: { contentAddressed?: boolean; attempts?: number } = {}): void {
  const attempts = opts.attempts ?? 10;
  for (let i = 1; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (opts.contentAddressed && existsSync(to)) {
        rmSync(from, { recursive: true, force: true });
        return;
      }
      if (!TRANSIENT.has(code) || i >= attempts) throw e;
      pause(Math.min(25 * 2 ** (i - 1), 400));
    }
  }
}
