// The builders fixture app (tests/fixtures/builders-app) under `renox dev`
// on the real worker, for tests/{kysely,drizzle}.test.ts. Needs
// RENOX_WORKER_PATH (cli/tests/worker-env.ts); the tests skip without it.

import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startDev } from "../../cli/src/commands/dev.ts";
import { testWorker } from "../../cli/tests/worker-env.ts";

export const worker = testWorker();

let started: Promise<{ base: string; dir: string; stop: () => Promise<void> }> | undefined;

/** One dev server for a test file's tests; the next file after `stop` gets a fresh one. */
export function buildersApp(): Promise<{ base: string; dir: string; stop: () => Promise<void> }> {
  started ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-builders-"));
    cpSync(join(import.meta.dir, "fixtures", "builders-app"), dir, { recursive: true });
    const root = resolve(import.meta.dir, "../..");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    cpSync(join(root, "sdk"), join(dir, "node_modules", "renox"), { recursive: true, dereference: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/tests/") });
    for (const dep of ["kysely", "drizzle-orm"]) cpSync(join(root, "sdk", "node_modules", dep), join(dir, "node_modules", dep), { recursive: true, dereference: true });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const dev = await startDev({ project: dir, port, log: () => {} });
    return {
      base: `http://localhost:${port}`,
      dir,
      stop: async () => {
        started = undefined;
        await dev.stop();
      },
    };
  })();
  return started;
}
