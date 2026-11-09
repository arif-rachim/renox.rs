// Dev-time warnings (#656; docs/07-app-model.md, "State rules"): after every
// successful build `renox dev` runs the `global-state` lint (the one
// `renox check` reports as an error) over the handler sources, prints one
// terminal line per finding, and serves the list at WARNINGS_PATH for the
// overlay's badge (overlay.ts). The runtime detects nothing (documented
// risk); this is the promised control.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { lintGlobalState } from "../lib/lint.ts";

export const WARNINGS_PATH = "/__renox/dev/warnings";

/** One handler write to global scope. */
export interface DevWarning {
  file: string;
  line: number;
  /** The written target: `globalThis.counter`, a module-level binding, `Object.assign(globalThis, ...)`. */
  name: string;
}

const DIRS = ["functions", "pages", "lib", "jobs"];

function walk(project: string, rel: string, out: string[]): void {
  for (const d of readdirSync(join(project, rel), { withFileTypes: true })) {
    const r = `${rel}/${d.name}`;
    if (d.isDirectory()) walk(project, r, out);
    else if (d.isFile() && /\.(ts|js|mjs)$/u.test(d.name) && !d.name.endsWith(".d.ts") && !/\.(test|spec)\.(ts|js|mjs)$/u.test(d.name)) out.push(r);
  }
}

/** The target a finding's message names. */
function nameOf(message: string): string {
  const m = /^module-level binding (\S+) assigned/u.exec(message) ?? /^(.+?) written inside/u.exec(message) ?? /^(Object\.\w+\(globalThis, \.\.\.\)) inside/u.exec(message);
  return m?.[1] ?? "globalThis";
}

/** Global-state findings in functions/, pages/, lib/, jobs/ and hooks.ts, ordered by file and line. */
export function devWarnings(project: string): DevWarning[] {
  const files: string[] = [];
  for (const d of DIRS) if (existsSync(join(project, d)) && statSync(join(project, d)).isDirectory()) walk(project, d, files);
  if (existsSync(join(project, "hooks.ts"))) files.push("hooks.ts");
  const out: DevWarning[] = [];
  for (const f of files.sort()) {
    let src: string;
    try {
      src = readFileSync(join(project, f), "utf8");
    } catch {
      continue;
    }
    for (const x of lintGlobalState(src, f)) out.push({ file: f, line: x.line, name: nameOf(x.message) });
  }
  return out;
}

/** The terminal line of one warning. */
export const warningLine = (w: DevWarning): string =>
  `warn: ${w.file}:${w.line} handler writes to global scope (${w.name}); state does not survive an isolate restart (docs/07)`;
