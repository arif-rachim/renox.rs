// `renox --version` (#431): the CLI's own version and the renox-worker
// release it pins, the one `renox dev` runs (production runs its own).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { WORKER_VERSION } from "../scripts/fetch-worker.ts";

const main = join(import.meta.dir, "../src/main.ts");
const cliVersion = (JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { version: string }).version;

test.each(["--version", "-V", "version"])("renox %s prints the CLI and the pinned worker version", (flag) => {
  const r = Bun.spawnSync(["bun", main, flag], { stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toBe(`renox ${cliVersion} (renox-worker ${WORKER_VERSION})\n`);
});
