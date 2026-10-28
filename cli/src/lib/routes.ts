// Route discovery from functions/ (docs/07-app-model.md, "Routing rules";
// docs/contracts/artifact.md section 3, "Route objects") and the V8
// conflict rule.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ValidationError, type Where } from "../errors.ts";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;
export type Method = (typeof METHODS)[number];

export interface Route {
  kind: "function";
  method: Method;
  path: string;
  /** Module id, e.g. `functions/api/notes/[id]`. */
  module: string;
  export: Method;
}

export interface FunctionModule {
  /** Module id (source path under the project without the extension). */
  id: string;
  /** Source file, relative to the project. */
  source: string;
  /** URL pattern. */
  pattern: string;
  methods: Method[];
}

/** Route file problems (exit 2); `problems` lists every one when there are several. */
export class RouteError extends ValidationError {
  constructor(
    message: string,
    where: Where = {},
    readonly problems: string[] = [],
  ) {
    super(problems.length ? `${message}:\n  ${problems.join("\n  ")}` : message, where);
  }
}

const SEGMENT_HINT = "a segment is [name] (parameter), [...name] (catch-all, last only), or a static name of letters, digits, and . _ ~ -; parameter names are lowercase";

const PARAM = /^\[([a-z_][a-z0-9_]{0,31})\]$/u;
const CATCH_ALL = /^\[\.\.\.([a-z_][a-z0-9_]{0,31})\]$/u;
const STATIC = /^[A-Za-z0-9._~-]+$/u;

/** The URL pattern of a function file path relative to `functions/` (without extension). */
export function patternFor(relNoExt: string): string {
  const parts = relNoExt.split("/");
  if (parts[parts.length - 1] === "index") parts.pop();
  const segs: string[] = [];
  const names = new Set<string>();
  parts.forEach((seg, i) => {
    let m: RegExpExecArray | null;
    if ((m = CATCH_ALL.exec(seg))) {
      if (i !== parts.length - 1) throw new RouteError(`${relNoExt}: a catch-all [...${m[1]}] must be the last segment`);
      segs.push(`*${m[1]}`);
      if (names.has(m[1] as string)) throw new RouteError(`${relNoExt}: parameter ${m[1]} repeats`);
      names.add(m[1] as string);
    } else if ((m = PARAM.exec(seg))) {
      if (names.has(m[1] as string)) throw new RouteError(`${relNoExt}: parameter ${m[1]} repeats`);
      names.add(m[1] as string);
      segs.push(`:${m[1]}`);
    } else if (STATIC.test(seg)) {
      segs.push(seg);
    } else if (/^\[\.{0,3}[A-Za-z_][A-Za-z0-9_]*\]$/u.test(seg)) {
      throw new RouteError(`${relNoExt}: parameter ${seg} must be lowercase (${seg.toLowerCase()})`, { hint: SEGMENT_HINT });
    } else if (seg.includes("[") || seg.includes("]")) {
      throw new RouteError(`${relNoExt}: segment ${JSON.stringify(seg)} has an unbalanced or misplaced bracket`, { hint: SEGMENT_HINT });
    } else if (/\s/u.test(seg)) {
      throw new RouteError(`${relNoExt}: segment ${JSON.stringify(seg)} contains a space`, { hint: SEGMENT_HINT });
    } else {
      throw new RouteError(`${relNoExt}: segment ${JSON.stringify(seg)} is not a valid route segment`, { hint: SEGMENT_HINT });
    }
  });
  return `/${segs.join("/")}`;
}

const isSource = (name: string): boolean =>
  /\.(ts|js|mjs)$/u.test(name) && !/\.d\.ts$/u.test(name) && !/\.(test|spec)\.(ts|js|mjs)$/u.test(name);

/** Files and folders starting with `_` are not routes. */
function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of entries) {
    if (d.name.startsWith("_") || d.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...walk(dir, r));
    else if (d.isFile() && isSource(d.name)) out.push(r);
  }
  return out.sort();
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** The HTTP method exports of a module. */
export function exportedMethods(code: string): Method[] {
  const { exports } = transpiler.scan(code);
  return METHODS.filter((m) => exports.includes(m));
}

/**
 * Discover every function module under `<project>/functions`. All route file
 * problems are collected into one RouteError: invalid names, two files for
 * one module (`a.ts`, `a.js`) or one URL (`a.ts`, `a/index.ts`), and paths
 * that differ only in case (one file on macOS and Windows).
 */
export function discoverFunctions(project: string): FunctionModule[] {
  const base = join(project, "functions");
  const out: FunctionModule[] = [];
  const problems: { message: string; file: string; hint?: string }[] = [];
  const files = walk(base);
  // Paths (files and folders) that differ only in case are one path on macOS and Windows.
  const folded = new Map<string, string>();
  for (const rel of files) {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const path = `functions/${parts.slice(0, i).join("/")}`;
      const seen = folded.get(path.toLowerCase());
      if (seen === undefined) folded.set(path.toLowerCase(), path);
      else if (seen !== path) {
        problems.push({
          message: `differs only in case from ${seen}: on a case-insensitive file system (macOS, Windows) they are one ${i === parts.length ? "file" : "folder"}`,
          file: path,
          hint: "rename one of them",
        });
        folded.set(path.toLowerCase(), path);
        break;
      }
    }
  }
  for (const rel of files) {
    const relNoExt = rel.replace(/\.(ts|js|mjs)$/u, "");
    const source = `functions/${rel}`;
    let pattern: string;
    try {
      pattern = patternFor(relNoExt);
    } catch (e) {
      if (!(e instanceof RouteError)) throw e;
      problems.push({ message: e.message.replace(`${relNoExt}: `, ""), file: source, ...(e.hint ? { hint: e.hint } : {}) });
      continue;
    }
    let methods: Method[];
    try {
      methods = exportedMethods(readFileSync(join(base, rel), "utf8"));
    } catch {
      // A syntax error: the bundler reports it with its line and column.
      methods = [...METHODS];
    }
    if (methods.length === 0) continue;
    out.push({ id: `functions/${relNoExt}`, source, pattern, methods });
  }
  const byId = new Map<string, FunctionModule>();
  const byPattern = new Map<string, FunctionModule>();
  for (const f of out) {
    const sameId = byId.get(f.id);
    const samePattern = byPattern.get(f.pattern);
    if (sameId) problems.push({ message: `is the same module as ${sameId.source}; keep one`, file: f.source });
    else if (samePattern) problems.push({ message: `maps to ${f.pattern}, as ${samePattern.source} does; keep one`, file: f.source });
    byId.set(f.id, f);
    byPattern.set(f.pattern, f);
  }
  if (problems.length === 1) {
    const [p] = problems as [(typeof problems)[number]];
    throw new RouteError(p.message, { file: p.file, ...(p.hint ? { hint: p.hint } : {}) });
  }
  if (problems.length > 1)
    throw new RouteError(
      `${problems.length} route file problems`,
      { hint: SEGMENT_HINT },
      problems.map((p) => `${p.file}: ${p.message}`),
    );
  return out;
}

export function routesOf(functions: FunctionModule[]): Route[] {
  const routes: Route[] = [];
  for (const f of functions)
    for (const m of f.methods) routes.push({ kind: "function", method: m, path: f.pattern, module: f.id, export: m });
  return routes;
}

/** V8 shape: static segments literally, parameter and catch-all names ignored. */
export const shapeOf = (pattern: string): string =>
  pattern
    .split("/")
    .slice(1)
    .map((s) => (s.startsWith(":") ? ":" : s.startsWith("*") ? "*" : `=${s}`))
    .join("/");

/** Route conflicts (V8): two routes with the same method and shape. */
export function routeConflicts(routes: Route[]): string[] {
  const seen = new Map<string, Route>();
  const out: string[] = [];
  for (const r of routes) {
    const key = `${r.method} ${shapeOf(r.path)}`;
    const other = seen.get(key);
    if (other) out.push(`V8: ${r.method} ${other.path} (${other.module}) and ${r.path} (${r.module}) conflict`);
    else seen.set(key, r);
  }
  return out;
}

/** Route matching precedence (static → parameter → catch-all), for `renox dev` output. */
export function sortRoutes(routes: Route[]): Route[] {
  const rank = (p: string): string =>
    p
      .split("/")
      .map((s) => (s.startsWith("*") ? "2" : s.startsWith(":") ? "1" : `0${s}`))
      .join("/");
  return [...routes].sort((a, b) => rank(a.path).localeCompare(rank(b.path)) || a.method.localeCompare(b.method));
}
