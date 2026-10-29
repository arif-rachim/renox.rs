// The export check of `renox check` (#265; ops.md 1.4.0 section 11, step
// 5): with lazy route modules the runtime no longer evaluates every module
// at isolate creation, so a handler that is missing or is not a function
// has to be caught before deploy. Each problem names the file and the
// export:
// - a function route's method export, and a page's `load`, must be functions;
// - every service of a module's `[exports.services]` must be a function
//   export of its `services.ts`.
// Nothing is run: the source is transpiled and its declarations are read.
// An export whose value cannot be told from its declaration (`export const
// GET = wrap(handler)`) passes; the runtime checks it again on first use.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { installedModules } from "../lib/modules/build.ts";
import { discoverFunctions, discoverPages } from "../lib/routes.ts";

export interface ExportProblem {
  file: string;
  name: string;
  message: string;
}

const tsTranspiler = new Bun.Transpiler({ loader: "ts", trimUnusedImports: false });
const scanner = new Bun.Transpiler({ loader: "js" });

const escape = (s: string): string => s.replace(/[$]/gu, "\\$");

/**
 * What `name` is in the module `source`: `"missing"` when it is not
 * exported, `"value"` when its declaration is plainly not a function (a
 * literal, an object or array literal, `new …`), `"function"` or
 * `"unknown"` otherwise.
 */
export function exportKind(source: string, name: string): "missing" | "value" | "function" | "unknown" {
  let js: string;
  try {
    js = tsTranspiler.transformSync(source);
  } catch {
    return "unknown";
  }
  if (!scanner.scan(js).exports.includes(name)) return "missing";
  // The local binding behind the export: `export { local as name }`, or the name itself.
  let local = name;
  for (const m of js.matchAll(/export\s*\{([^}]*)\}/gu)) {
    for (const part of (m[1] as string).split(",")) {
      const [orig, alias] = part.trim().split(/\s+as\s+/u);
      if ((alias ?? orig)?.trim() === name && orig) local = orig.trim();
    }
  }
  const id = escape(local);
  if (new RegExp(`(?:^|[\\s;}])(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${id}\\s*\\(`, "u").test(js)) return "function";
  if (new RegExp(`(?:^|[\\s;}])(?:export\\s+)?class\\s+${id}\\b`, "u").test(js)) return "function";
  const decl = new RegExp(`(?:^|[\\s;}])(?:export\\s+)?(?:const|let|var)\\s+${id}\\s*=\\s*([^\\n]{0,40})`, "u").exec(js);
  if (decl === null) return "unknown";
  const init = (decl[1] as string).trimStart();
  if (/^(?:async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)/u.test(init)) return "function";
  if (/^(?:[-+]?[0-9]|["'`{[]|true\b|false\b|null\b|undefined\b|new\s)/u.test(init)) return "value";
  return "unknown";
}

function check(file: string, source: string, name: string, what: string, out: ExportProblem[]): void {
  const kind = exportKind(source, name);
  if (kind === "missing") out.push({ file, name, message: `${file}: ${what} \`${name}\` is not exported` });
  else if (kind === "value") out.push({ file, name, message: `${file}: ${what} \`${name}\` is exported but is not a function` });
}

function moduleSource(tree: string, base: string): string | undefined {
  return [".ts", ".js", ".mjs"].map((ext) => `${base}${ext}`).find((f) => existsSync(join(tree, f)));
}

/** Every export problem of the app and its installed modules. */
export function exportProblems(project: string): ExportProblem[] {
  const out: ExportProblem[] = [];
  for (const f of discoverFunctions(project)) {
    const source = readFileSync(join(project, f.source), "utf8");
    for (const m of f.methods) check(f.source, source, m, "the route handler", out);
  }
  for (const p of discoverPages(project)) {
    if (p.source === undefined || !p.load) continue;
    check(p.source, readFileSync(join(project, p.source), "utf8"), "load", "the page loader", out);
  }
  if (existsSync(join(project, "renox.lock"))) {
    for (const { lock, manifest, tree } of installedModules(project).modules) {
      const exportsDoc = (manifest.doc.exports ?? {}) as { services?: Record<string, unknown> };
      const services = Object.keys(exportsDoc.services ?? {});
      const file = moduleSource(tree, "services");
      if (services.length === 0 || file === undefined) continue;
      const source = readFileSync(join(tree, file), "utf8");
      for (const s of services) check(`${lock.name}/${file}`, source, s, "the service", out);
    }
  }
  return out;
}
