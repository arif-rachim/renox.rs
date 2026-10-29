// renox test [pattern...] [--seed <file.sql>]...: build the app with a
// test-only service route, then run `bun test` with `renox/test` preloaded.
// Each test file that calls `app()` gets the same prebuilt renox-worker as
// `renox dev` on a fresh temporary tenant file (migrations applied, then
// seeds/*.sql and the --seed files). Exit codes per the CLI contract: 0
// when every test passed, 2 when a test failed, 3 without a worker.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { EXIT } from "../errors.ts";
import { prepare } from "../lib/test-harness.ts";
import { workerPath } from "../lib/worker.ts";

const HARNESS = resolve(import.meta.dir, "../lib/test-harness.ts");
const PRELOAD = resolve(import.meta.dir, "../../../sdk/src/test.ts");

export async function runTests(project: string, args: string[], output: "inherit" | "pipe" = "inherit"): Promise<{ code: number; out: string }> {
  const seeds: string[] = [];
  const patterns: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--seed") seeds.push(args[++i] as string);
    else patterns.push(a); // patterns, and -u / --update-snapshots for bun test
  }
  const spec = await prepare(project, seeds, workerPath());
  // Next to the artifact: for a module, in its temporary test app, never in
  // the module tree (its hash covers every file, manifest.md MF12).
  const specFile = join(spec.project, ".renox", "test", "spec.json");
  await Bun.write(specFile, JSON.stringify(spec));
  const p = Bun.spawn([process.execPath, "test", ...(existsSync(PRELOAD) ? ["--preload", PRELOAD] : []), ...patterns], {
    cwd: project,
    stdin: "ignore",
    stdout: output,
    stderr: output,
    env: { ...process.env, RENOX_TEST_SPEC: specFile, RENOX_TEST_HARNESS: HARNESS, RENOX_TEST_PROJECT: project, RENOX_WORKER_PATH: spec.worker },
  });
  const [code, out, err] = await Promise.all([
    p.exited,
    output === "pipe" ? new Response(p.stdout as ReadableStream).text() : Promise.resolve(""),
    output === "pipe" ? new Response(p.stderr as ReadableStream).text() : Promise.resolve(""),
  ]);
  return { code: code === 0 ? EXIT.OK : EXIT.VALIDATION, out: `${out}${err}` };
}

export async function run(args: string[]): Promise<number> {
  const flags = new Set(["--seed", "-u", "--update-snapshots"]);
  if (args.some((a, i) => a.startsWith("-") && !flags.has(a) && args[i - 1] !== "--seed") || args.at(-1) === "--seed") {
    console.error("usage: renox test [pattern...] [--seed <file.sql>]... [-u]");
    return EXIT.USER;
  }
  return (await runTests(process.cwd(), args)).code;
}
