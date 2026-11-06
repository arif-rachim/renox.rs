// The TypeScript type check of `renox check` and `renox deploy` (#443).
//
// It runs the app's own compiler (node_modules/typescript, which `renox new`
// adds as a devDependency; looked up from the app upwards, as Node resolves
// it, so an app inside a workspace uses the workspace's) with a fixed argv
// and no shell:
//
//   bun node_modules/typescript/bin/tsc --noEmit -p tsconfig.json --pretty false
//
// and turns `file(line,col): error TSnnnn: message` into findings with
// `rule: "types"`, the TS code in the message, multi-line messages kept,
// paths relative to the app, files under node_modules/ dropped. Without
// typescript installed, or without tsconfig.json, it does not guess: one
// warning says the types were not checked, and the check still passes.
// `renox dev` never runs this (reloads stay fast); the editor does it there.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { Finding } from "../lib/lint.ts";
import { writeModuleTypes } from "../lib/types/generate.ts";

export const NO_TYPESCRIPT = "types not checked: add typescript (bun add -d typescript)";
export const NO_TSCONFIG = "types not checked: no tsconfig.json (renox new writes one; copy it from the template)";
export const NO_BUN = "types not checked: `bun` is not on PATH (install Bun 1.4 or newer)";

export interface TypeCheck {
  findings: Finding[];
  /** Why the types were not checked, or null when they were. */
  skipped: string | null;
  /** Wall time of the compiler, in ms (0 when skipped). */
  ms: number;
}

/** `file(line,col): error TS1234: message`, as tsc prints without --pretty. */
const LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/u;
/** A diagnostic with no file (a bad tsconfig.json, an unknown option). */
const GLOBAL = /^(error|warning) (TS\d+): (.*)$/u;

/** tsc's output as findings; `cwd` is where it ran (the app). */
export function parseTsc(output: string, cwd: string, project: string = cwd): Finding[] {
  const out: Finding[] = [];
  let last: Finding | null = null;
  for (const raw of output.replace(/\r\n?/gu, "\n").split("\n")) {
    const m = LINE.exec(raw);
    if (m) {
      const abs = isAbsolute(m[1] as string) ? (m[1] as string) : join(cwd, m[1] as string);
      const file = relative(project, abs).split("\\").join("/");
      // Dropped: dependencies, and installed module trees (outside the app, or fetched under .renox/modules/), which the generated module types pull in (#471) and whose own errors are not the app's.
      if (file.startsWith("node_modules/") || file.includes("/node_modules/") || file.startsWith("../") || file.startsWith(".renox/modules/")) {
        last = null;
        continue;
      }
      last = { file, line: Number(m[2]), column: Number(m[3]), rule: "types", severity: m[4] === "warning" ? "warning" : "error", message: `${m[5]}: ${m[6]}` };
      out.push(last);
      continue;
    }
    const g = GLOBAL.exec(raw);
    if (g) {
      last = { file: "tsconfig.json", line: 1, column: 1, rule: "types", severity: g[1] === "warning" ? "warning" : "error", message: `${g[2]}: ${g[3]}` };
      out.push(last);
      continue;
    }
    // A continuation line of the previous diagnostic (indented in tsc's output).
    if (last !== null && /^\s+\S/u.test(raw)) last.message += `\n${raw.trimEnd()}`;
  }
  return out;
}

/** node_modules/typescript/bin/tsc of the app, or of a folder above it (an app inside a workspace), as Node would resolve it; null when none. */
export function findTsc(project: string): string | null {
  for (let dir = resolve(project); ; dir = dirname(dir)) {
    const tsc = join(dir, "node_modules", "typescript", "bin", "tsc");
    if (existsSync(tsc)) return tsc;
    if (dirname(dir) === dir) return null;
  }
}

/** The type check of `project`, or why it was skipped. `bun` is the runtime that starts tsc's launcher. */
export function typeCheck(project: string, bun: string | null = Bun.which("bun")): TypeCheck {
  if (!existsSync(join(project, "tsconfig.json"))) return { findings: [], skipped: NO_TSCONFIG, ms: 0 };
  const tsc = findTsc(project);
  if (tsc === null) return { findings: [], skipped: NO_TYPESCRIPT, ms: 0 };
  if (bun === null) return { findings: [], skipped: NO_BUN, ms: 0 };
  // #471: the installed modules' types (`renox:modules`), which only `renox dev` wrote before.
  try {
    writeModuleTypes(project);
  } catch (e) {
    return { findings: [{ file: "renox.lock", line: 1, column: 1, rule: "types", severity: "error", message: `could not generate the module types: ${e instanceof Error ? e.message : String(e)}` }], skipped: null, ms: 0 };
  }
  const t0 = performance.now();
  const p = Bun.spawnSync([bun, tsc, "--noEmit", "-p", "tsconfig.json", "--pretty", "false"], {
    cwd: project,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const ms = Math.round(performance.now() - t0);
  const text = `${p.stdout.toString()}${p.stderr.toString()}`;
  const findings = parseTsc(text, project);
  // tsc exits 1 on errors we dropped (module trees); only an exit with no diagnostic line at all is a compiler failure.
  const diagnosed = text.replace(/\r\n?/gu, "\n").split("\n").some((l) => LINE.test(l) || GLOBAL.test(l));
  if (p.exitCode !== 0 && findings.length === 0 && !diagnosed) {
    findings.push({ file: "tsconfig.json", line: 1, column: 1, rule: "types", severity: "error", message: `the TypeScript compiler failed (exit ${p.exitCode}): ${text.trim().split("\n").slice(-5).join("\n") || "no output"}` });
  }
  return { findings, skipped: null, ms };
}
