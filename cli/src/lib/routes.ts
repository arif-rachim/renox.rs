// Route discovery from functions/ (docs/07-app-model.md, "Routing rules";
// docs/contracts/artifact.md section 3, "Route objects") and the V8
// conflict rule.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

export class RouteError extends Error {}

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
    } else {
      throw new RouteError(`${relNoExt}: segment ${JSON.stringify(seg)} is not a valid route segment`);
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

/** Discover every function module under `<project>/functions`. */
export function discoverFunctions(project: string): FunctionModule[] {
  const base = join(project, "functions");
  const out: FunctionModule[] = [];
  for (const rel of walk(base)) {
    const relNoExt = rel.replace(/\.(ts|js|mjs)$/u, "");
    const methods = exportedMethods(readFileSync(join(base, rel), "utf8"));
    if (methods.length === 0) continue;
    out.push({ id: `functions/${relNoExt}`, source: `functions/${rel}`, pattern: patternFor(relNoExt), methods });
  }
  const ids = new Set<string>();
  for (const f of out) {
    if (ids.has(f.id)) throw new RouteError(`${f.id}: two files map to the same module (for example a.ts and a.js)`);
    ids.add(f.id);
  }
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
