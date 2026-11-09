// The app's own slot fillers and hooks (artifact 1.8, #630):
//
// - `appSlotProblems`: each `renox.toml [[slots]]` template is a partial that
//   exists in the app, and its `requires` is in the merged action set
//   (`manifest.md` MF9 for the app). Errors, thrown by the build.
// - `unrenderedSlots`: a slot name no installed module (nor the app) renders
//   with `<r-slot name="…">`. A warning: a module may be added later.
// - `unknownEventHandlers`: `hooks.ts` handles `on["x.y"]` for a module `x`
//   that is not installed. A warning; `app.*` events are the app's own.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Finding } from "../lib/lint.ts";
import { stripCommentsAndStrings } from "../lib/modules/build.ts";
import type { AppSlot } from "../lib/project.ts";

/** Errors (one line each, naming renox.toml's `[[slots]]`) for the app's fillers. */
export function appSlotProblems(project: string, slots: readonly AppSlot[], actions: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const s of slots) {
    const at = `renox.toml: [[slots]] "${s.name}"`;
    if (!existsSync(join(project, s.template))) out.push(`${at}: template ${s.template} does not exist in the app (a filler is a partial: partials/<x>.html)`);
    if (s.requires !== undefined && !actions.has(s.requires)) out.push(`${at}: requires "${s.requires}" is not in [authz] actions`);
  }
  return out;
}

const walk = (dir: string, rel = ""): string[] => {
  if (!existsSync(join(dir, rel))) return [];
  const out: string[] = [];
  for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...walk(dir, r));
    else if (d.isFile() && d.name.endsWith(".html")) out.push(r);
  }
  return out;
};

/** The slot names rendered by the templates under `pages/` and `partials/` of each tree. */
function renderedSlots(trees: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const tree of trees) {
    for (const root of ["pages", "partials"]) {
      for (const f of walk(tree, root)) {
        for (const m of readFileSync(join(tree, f), "utf8").matchAll(/<r-slot\b[^>]*?\bname\s*=\s*["']([^"']+)["']/gu)) names.add(m[1] as string);
      }
    }
  }
  return names;
}

/** One warning per `[[slots]]` whose slot no installed module's templates (nor the app's) render. */
export function unrenderedSlots(project: string, slots: readonly AppSlot[], moduleTrees: readonly string[]): Finding[] {
  if (slots.length === 0) return [];
  const rendered = renderedSlots([project, ...moduleTrees]);
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const s of slots) {
    if (rendered.has(s.name) || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({ file: "renox.toml", line: lineOfSlot(project, s.name), column: 1, rule: "unrendered-slot", severity: "warning", message: `no installed module renders slot ${s.name}; the filler ${s.template} shows nowhere until one does` });
  }
  return out;
}

function lineOfSlot(project: string, name: string): number {
  try {
    const lines = readFileSync(join(project, "renox.toml"), "utf8").split("\n");
    const i = lines.findIndex((l) => new RegExp(`^\\s*name\\s*=\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}["']`, "u").test(l));
    return i >= 0 ? i + 1 : 1;
  } catch {
    return 1;
  }
}

/** The keys of `export const on = { "x.y": …, … }` in `src`, with their offsets. */
export function handledEvents(src: string): { name: string; index: number }[] {
  const code = stripCommentsAndStrings(src);
  const m = /\bexport\s+const\s+on\b[^=\n]*=\s*\{/u.exec(code);
  if (m === null) return [];
  const start = m.index + m[0].length;
  let depth = 1;
  let end = start;
  while (end < code.length && depth > 0) {
    const c = code[end];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    end++;
  }
  // Keys sit at depth 1 of the object; strings are blanked in `code`, so walk it and read the key text from `src`.
  const out: { name: string; index: number }[] = [];
  let d = 0;
  for (let i = start; i < end - 1; i++) {
    const c = code[i];
    if (c === "{" || c === "[" || c === "(") d++;
    else if (c === "}" || c === "]" || c === ")") d--;
    else if (d === 0 && (src[i] === '"' || src[i] === "'") && code[i] === " ") {
      const close = src.indexOf(src[i] as string, i + 1);
      if (close < 0) break;
      if (/^\s*:/u.test(code.slice(close + 1, close + 40))) out.push({ name: src.slice(i + 1, close), index: i });
      i = close;
    }
  }
  return out;
}

/** Warnings for the app's `hooks.ts`: a handled event of a module that is not installed. */
export function unknownEventHandlers(file: string, src: string, installed: ReadonlySet<string>): Finding[] {
  const out: Finding[] = [];
  for (const h of handledEvents(src)) {
    const module = h.name.split(".")[0] as string;
    if (module === "app" || installed.has(module)) continue;
    out.push({
      file,
      line: src.slice(0, h.index).split("\n").length,
      column: 1,
      rule: "app-hooks",
      severity: "warning",
      message: `hooks.ts handles "${h.name}", but the module ${module} is not installed; the handler never runs (renox add ${module})`,
    });
  }
  return out;
}
