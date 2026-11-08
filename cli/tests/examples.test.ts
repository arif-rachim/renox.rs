// The reference apps under examples/ (home-services, #555): each builds, passes
// `renox check` (the type check included) and `renox test` with its seed, in a
// copy with the SDK linked as `bun install` would. Needs a worker: without
// RENOX_WORKER_PATH the tests are skipped (CI sets it, `make ts-test`).
import { describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { check } from "../src/commands/check.ts";
import { runTests } from "../src/commands/test.ts";
import { buildArtifact } from "../src/lib/build.ts";

const REPO = join(import.meta.dir, "../..");
const worker = process.env.RENOX_WORKER_PATH;

if (!worker) console.log("examples.test.ts: RENOX_WORKER_PATH is not set; the example apps are not built or tested.");

/** An example app: its folder under examples/, the seed `renox test` loads, the passing tests it prints. */
const EXAMPLES: { name: string; seed: string; passing: number }[] = [{ name: "home-services", seed: "seeds/001_demo.sql", passing: 111 }];

const SKIP = /(^|\/)(node_modules|\.renox)(\/|$)/u;

/** A copy of the example with what `bun install` would put in node_modules: the SDK, TypeScript and the Bun types. */
function installed(name: string): string {
  const src = join(REPO, "examples", name);
  // The same depth as in the repository: tsconfig.json extends ../../tsconfig.base.json.
  const root = mkdtempSync(join(tmpdir(), `renox-example-${name}-`));
  copyFileSync(join(REPO, "tsconfig.base.json"), join(root, "tsconfig.base.json"));
  const dir = join(root, "examples", name);
  cpSync(src, dir, { recursive: true, filter: (p) => !SKIP.test(relative(src, p)) });
  mkdirSync(join(dir, "node_modules/@renoxium"), { recursive: true });
  symlinkSync(join(REPO, "sdk"), join(dir, "node_modules/@renoxium/sdk"));
  for (const pkg of ["typescript", "bun-types"]) symlinkSync(join(REPO, "node_modules", pkg), join(dir, "node_modules", pkg));
  return dir;
}

describe.skipIf(!worker)("every example builds, checks and passes renox test", () => {
  for (const ex of EXAMPLES) {
    test(
      ex.name,
      async () => {
        const dir = installed(ex.name);
        await buildArtifact(dir, mkdtempSync(join(tmpdir(), "renox-example-build-")));
        const report = await check(dir, { types: "include" });
        expect(report.errors.map((e) => e.message)).toEqual([]);
        expect(report.findings).toEqual([]);
        const r = await runTests(dir, ["--seed", ex.seed], "pipe");
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain(` ${ex.passing} pass`);
        expect(r.out).toContain(" 0 fail");
      },
      180_000,
    );
  }
});
