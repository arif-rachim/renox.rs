// Renames and removals that survive Windows. There, renaming or removing a
// file or folder fails with EPERM, EACCES or EBUSY while another process (the
// virus scanner, the search indexer, a worker that just exited) still holds
// it open for a moment. Linux and macOS never fail this way.

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

/**
 * Removes `path` recursively, retrying a transient Windows lock for about
 * 2 s. A temporary folder that still cannot be removed is left behind with a
 * warning instead of failing the caller: it is cleanup, not the work.
 */
export function removeRetry(path: string, opts: { attempts?: number; warn?: (line: string) => void } = {}): void {
  const attempts = opts.attempts ?? 10;
  for (let i = 1; ; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT.has(code)) throw e;
      if (i >= attempts) {
        (opts.warn ?? ((l) => process.stderr.write(`${l}
`)))(`renox: could not remove ${path} (${code}); it is left in the temporary folder`);
        return;
      }
      pause(Math.min(25 * 2 ** (i - 1), 400));
    }
  }
}
