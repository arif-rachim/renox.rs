// The reference apps under examples/ (home-services, #555): each builds, passes
// `renox check` (the type check included) and `renox test` with its seed, in a
// copy with the SDK linked as `bun install` would. Needs a worker: without
// RENOX_WORKER_PATH the tests are skipped (CI sets it, `make ts-test`).
// The template `renox new --template home-services` is generated from the
// example (examples/home-services/sync-template.ts, #566); the drift test below
// needs no worker and fails when the two differ.
import { describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, type Dirent, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { check } from "../src/commands/check.ts";
import { runTests } from "../src/commands/test.ts";
import { buildArtifact } from "../src/lib/build.ts";
import { filesModule, TEMPLATE_DIR, templateEntry, templateFiles } from "../../examples/home-services/sync-template.ts";

const REPO = join(import.meta.dir, "../..");
const worker = process.env.RENOX_WORKER_PATH;

if (!worker) console.log("examples.test.ts: RENOX_WORKER_PATH is not set; the example apps are not built or tested.");

/**
 * An example app: its folder under examples/, the seed `renox test` loads, the passing tests it prints on the
 * pinned worker, and the tests that only run from a given worker version (they are skipped, not passed, below it).
 */
const EXAMPLES: { name: string; seed: string; passing: number; fromWorker: { version: number[]; tests: number }[] }[] = [
  // tests/tools.test.ts: the audit page assertion of #683 runs from renox-worker 0.7.1 (WORKER_WITH_TOOL_AUDIT).
  { name: "home-services", seed: "seeds/001_demo.sql", passing: 734, fromWorker: [{ version: [0, 7, 1], tests: 1 }] },
];

/** The worker's version (`renox-worker --version`), or null when it cannot be read. */
function workerVersion(path: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/u.exec(Bun.spawnSync([path, "--version"]).stdout.toString());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const atLeast = (v: number[], min: number[]): boolean => {
  for (let i = 0; i < 3; i++) if ((v[i] ?? 0) !== (min[i] ?? 0)) return (v[i] ?? 0) > (min[i] ?? 0);
  return true;
};

/** The passing count to expect on this worker: the tests gated on a newer worker are skipped there. */
export function expectedPassing(ex: { passing: number; fromWorker: { version: number[]; tests: number }[] }, version: number[] | null): number {
  return ex.passing - ex.fromWorker.filter((g) => version === null || !atLeast(version, g.version)).reduce((n, g) => n + g.tests, 0);
}

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

test("the expected passing count follows the worker's version", () => {
  const ex = { passing: 270, fromWorker: [{ version: [0, 7, 1], tests: 1 }] };
  expect(expectedPassing(ex, [0, 7, 1])).toBe(270);
  expect(expectedPassing(ex, [0, 8, 0])).toBe(270);
  expect(expectedPassing(ex, [0, 7, 0])).toBe(269);
  expect(expectedPassing(ex, null)).toBe(269);
});

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
        expect(r.out).toContain(` ${expectedPassing(ex, workerVersion(worker as string))} pass`);
        expect(r.out).toContain(" 0 fail");
      },
      180_000,
    );
  }
});

test("cli/templates/home-services is examples/home-services: run `bun examples/home-services/sync-template.ts` after a change (#566)", () => {
  const want = templateFiles();
  const written = (readdirSync(TEMPLATE_DIR, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((d) => d.isFile())
    .map((d) => relative(TEMPLATE_DIR, join(d.parentPath, d.name)).split("\\").join("/"))
    .sort();
  expect(written).toEqual([...want.map((f) => templateEntry(f).file), "files.ts"].sort());
  for (const f of want) {
    const { file, content } = templateEntry(f);
    const path = join(TEMPLATE_DIR, file);
    expect(existsSync(path), file).toBe(true);
    expect(readFileSync(path, "utf8") === content, `${file} differs from examples/home-services/${f}`).toBe(true);
  }
  expect(readFileSync(join(TEMPLATE_DIR, "files.ts"), "utf8")).toBe(filesModule(want));
  // Nothing workspace-only reaches a new app.
  for (const f of ["package.json", "tsconfig.json", "bunfig.toml", "renox-modules.d.ts", "text-imports.d.ts", "sync-template.ts"]) expect(want).not.toContain(f);
  expect(want.some((f) => f.startsWith("tests/__snapshots__/") || f.startsWith("node_modules/") || f.startsWith(".renox/"))).toBe(false);
});
