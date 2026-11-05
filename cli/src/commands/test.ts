// renox test [pattern...] [--seed <file.sql>]...: build the app with a
// test-only service route, then run `bun test` with `@renoxium/sdk/test` preloaded.
//
// #448: the tests run under the real `bun` on PATH, never under
// `process.execPath`: in a compiled CLI that is `renox` itself, and
// `renox test` spawning `renox test` looped without end. A nested `renox
// test` (RENOX_TEST_DEPTH set) refuses to start. The harness the SDK loads
// (RENOX_TEST_HARNESS) must be a file `bun` can import: from source it is
// src/lib/test-harness.ts; a compiled CLI writes its bundled copy
// (lib/embedded.ts) to .renox/test/harness.js.
// Each test file that calls `app()` gets the same prebuilt renox-worker as
// `renox dev` on a fresh temporary tenant file (migrations applied, then
// seeds/*.sql and the --seed files). Exit codes per the CLI contract: 0
// when every test passed, 2 when a test failed, 3 without a worker.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { EnvironmentError, EXIT } from "../errors.ts";
import { EMBEDDED, type Embedded } from "../lib/embedded.ts";
import { officialModulesDir } from "../lib/modules/official.ts";
import { evaluatePolicies, prepare } from "../lib/test-harness.ts";
import { workerPath } from "../lib/worker.ts";

const HARNESS = resolve(import.meta.dir, "../lib/test-harness.ts");
const PRELOAD = resolve(import.meta.dir, "../../../sdk/src/test.ts");

export const BUN_HINT = "install Bun 1.4 or newer (curl -fsSL https://bun.sh/install | bash) and make sure `bun` is on PATH";

/** The `bun` that runs the tests: on PATH, and never this process's own executable (a compiled `renox`). */
export function bunBinary(which: (cmd: string) => string | null = Bun.which, self = process.execPath): string {
  const bun = which("bun");
  if (bun === null) throw new EnvironmentError("renox test runs your tests with Bun, and `bun` is not on PATH", { hint: BUN_HINT });
  if (resolve(bun) === resolve(self) && !/(^|[/\\])bun(\.exe)?$/u.test(self)) throw new EnvironmentError(`\`bun\` on PATH is this renox binary (${bun})`, { hint: BUN_HINT });
  return bun;
}

/** Refuses a `renox test` started from inside the tests of another one (RENOX_TEST_DEPTH). */
export function refuseNested(env: Record<string, string | undefined> = process.env): void {
  if (env.RENOX_TEST_DEPTH !== undefined) {
    throw new EnvironmentError("renox test was started from inside another renox test run; refusing to run tests recursively", { hint: "do not call `renox test` from a test file" });
  }
}

/** The harness file `bun test` imports: the source file, or the bundle a compiled CLI carries, written next to the spec. */
export function harnessFile(dir: string, embedded: Embedded | null = EMBEDDED): string {
  if (embedded === null) return HARNESS;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "harness.js");
  writeFileSync(file, embedded.harness);
  return file;
}

export async function runTests(project: string, args: string[], output: "inherit" | "pipe" = "inherit"): Promise<{ code: number; out: string }> {
  refuseNested();
  const bun = bunBinary();
  const seeds: string[] = [];
  const patterns: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--seed") seeds.push(args[++i] as string);
    else patterns.push(a); // patterns, and -u / --update-snapshots for bun test
  }
  const spec = await prepare(project, seeds, workerPath());
  // Policy test cases (#283; docs/11-authorization.md, `renox test`): every
  // `policies/tests/*.json` case through the engine the cell builds.
  const outcomes = await evaluatePolicies(spec, project);
  let policyOut = "";
  for (const o of outcomes) {
    const who = `${o.case.principal.type}::${o.case.principal.id}${o.case.principal.roles?.length ? ` (${o.case.principal.roles.join(", ")})` : ""}`;
    const line = `${o.ok ? "(pass)" : "(fail)"} policy ${o.file}: ${o.case.description ?? `${who} ${o.case.action}`} -> ${o.result.allow ? "allow" : "deny"}${o.ok ? "" : ` (expected ${o.case.expected}, ${o.result.reason})`}\n`;
    policyOut += line;
    if (output === "inherit") process.stderr.write(line);
  }
  const policiesFailed = outcomes.some((o) => !o.ok);
  // Next to the artifact: for a module, in its temporary test app, never in
  // the module tree (its hash covers every file, manifest.md MF12).
  const specFile = join(spec.project, ".renox", "test", "spec.json");
  await Bun.write(specFile, JSON.stringify(spec));
  const harness = harnessFile(join(spec.project, ".renox", "test"));
  // The SDK preload exists only in this repository; an app's tests import @renoxium/sdk/test themselves.
  const preload = EMBEDDED === null && existsSync(PRELOAD) ? ["--preload", PRELOAD] : [];
  const p = Bun.spawn([bun, "test", ...preload, ...patterns], {
    cwd: project,
    stdin: "ignore",
    stdout: output,
    stderr: output,
    env: {
      ...process.env,
      RENOX_TEST_SPEC: specFile,
      RENOX_TEST_HARNESS: harness,
      RENOX_TEST_PROJECT: project,
      RENOX_WORKER_PATH: spec.worker,
      RENOX_OFFICIAL_MODULES: officialModulesDir(),
      RENOX_TEST_DEPTH: "1",
    },
  });
  const [code, out, err] = await Promise.all([
    p.exited,
    output === "pipe" ? new Response(p.stdout as ReadableStream).text() : Promise.resolve(""),
    output === "pipe" ? new Response(p.stderr as ReadableStream).text() : Promise.resolve(""),
  ]);
  return { code: code === 0 && !policiesFailed ? EXIT.OK : EXIT.VALIDATION, out: `${policyOut}${out}${err}` };
}

export async function run(args: string[]): Promise<number> {
  const flags = new Set(["--seed", "-u", "--update-snapshots"]);
  if (args.some((a, i) => a.startsWith("-") && !flags.has(a) && args[i - 1] !== "--seed") || args.at(-1) === "--seed") {
    console.error("usage: renox test [pattern...] [--seed <file.sql>]... [-u]");
    return EXIT.USER;
  }
  return (await runTests(process.cwd(), args)).code;
}
