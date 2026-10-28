// Route discovery from functions/ and pages/ (docs/07-app-model.md,
// "Routing rules" and "Pages"; docs/contracts/artifact.md section 3, "Route
// objects" and "Page routes") and the V8 conflict rule.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ValidationError, type Where } from "../errors.ts";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;
export type Method = (typeof METHODS)[number];

export interface FunctionRoute {
  kind: "function";
  method: Method;
  path: string;
  /** Module id, e.g. `functions/api/notes/[id]`. */
  module: string;
  export: Method;
}

/** A page route (artifact version 1): one of the three `.ts`/`.html` pair shapes. */
export interface PageRoute {
  kind: "page";
  path: string;
  /** Module id `pages/...` when the page has a `.ts` file. */
  module?: string;
  /** The module exports `load`. */
  load?: true;
  /** Keys of `export const actions`. */
  actions?: string[];
  /** Template id `pages/...` when the page has an `.html` file. */
  template?: string;
}

export type Route = FunctionRoute | PageRoute;

/** One page: its `.ts` and/or `.html` file. */
export interface PageModule {
  /** `pages/<path without extension>`: module id and template id. */
  id: string;
  /** The `.ts`/`.js`/`.mjs` file, relative to the project. */
  source?: string;
  /** The `.html` file, relative to the project. */
  html?: string;
  pattern: string;
  load: boolean;
  actions: string[];
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
function walk(dir: string, rel = "", keep: (name: string) => boolean = isSource): string[] {
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
    if (d.isDirectory()) out.push(...walk(dir, r, keep));
    else if (d.isFile() && keep(d.name)) out.push(r);
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

const ACTION_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

/**
 * The keys of `export const actions = { ... }` (types stripped first). Only
 * an object literal is understood: its top-level keys are the action names
 * (`name() {}`, `async name() {}`, `name: fn`, `"name": fn`). Anything else
 * is a RouteError: the CLI resolves actions at build time, so the worker
 * never guesses (artifact.md section 3).
 */
export function actionNames(code: string): string[] {
  const js = transpiler.transformSync(code);
  const m = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+actions\s*=\s*\{/u.exec(js);
  if (!m) throw new RouteError("export const actions must be an object literal of action functions");
  let i = m.index + m[0].length;
  const keys: string[] = [];
  let depth = 1;
  let expectKey = true;
  while (i < js.length && depth > 0) {
    const c = js[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      // A string: at depth 1 in key position it is a quoted key.
      let j = i + 1;
      while (j < js.length && js[j] !== c) j += js[j] === "\\" ? 2 : 1;
      if (depth === 1 && expectKey) {
        keys.push(js.slice(i + 1, j));
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === "/" && js[i + 1] === "/") {
      i = js.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && js[i + 1] === "*") {
      i = js.indexOf("*/", i) + 2;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === "," && depth === 1) expectKey = true;
    else if (depth === 1 && expectKey && /[A-Za-z_$]/u.test(c)) {
      const word = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(js.slice(i))?.[0] ?? "";
      const after = js.slice(i + word.length).trimStart();
      // `async name(`, `get name(`: a modifier, the key follows.
      if ((word === "async" || word === "get" || word === "set") && /^[A-Za-z_$"'*]/u.test(after)) {
        i += word.length;
        continue;
      }
      if (word.startsWith("...")) throw new RouteError("actions: a spread cannot be resolved at build time");
      keys.push(word);
      expectKey = false;
      i += word.length;
      continue;
    } else if (depth === 1 && c === "*") {
      i++;
      continue;
    } else if (depth === 1 && expectKey && c === ".") {
      throw new RouteError("actions: a spread (...) cannot be resolved at build time; list the actions in the literal");
    }
    i++;
  }
  for (const k of keys)
    if (!ACTION_NAME.test(k)) throw new RouteError(`action name ${JSON.stringify(k)} must match ${ACTION_NAME.source}`);
  const dup = keys.find((k, n) => keys.indexOf(k) !== n);
  if (dup) throw new RouteError(`action ${dup} is declared twice`);
  if (keys.length > 64) throw new RouteError(`${keys.length} actions; at most 64 per page`);
  return keys;
}

const isPageFile = (name: string): boolean => isSource(name) || /\.html$/u.test(name);

/**
 * Discover every page under `<project>/pages` (docs/07-app-model.md,
 * "Pages"): a `.ts` file, an `.html` file, or both, per path. Files and
 * folders starting with `_` (`_layouts/`, `_404.html`, `_error.html`) are
 * not routes. A `.ts`-only page must export `load` (it returns a Response).
 * `pages/_error.ts` is an error: the error page gets no loader (errors.md).
 */
export function discoverPages(project: string): PageModule[] {
  const base = join(project, "pages");
  const problems: { message: string; file: string; hint?: string }[] = [];
  for (const name of ["_error.ts", "_error.js", "_404.ts", "_404.js"]) {
    if (existsSync(join(base, name)))
      problems.push({ message: "error pages have no loader: they receive status, code, request_id, message only", file: `pages/${name}`, hint: "remove it; keep pages/" + name.replace(/\.(ts|js)$/u, ".html") });
  }
  const byId = new Map<string, PageModule>();
  for (const rel of walk(base, "", isPageFile)) {
    const relNoExt = rel.replace(/\.(ts|js|mjs|html)$/u, "");
    const file = `pages/${rel}`;
    let pattern: string;
    try {
      pattern = patternFor(relNoExt);
    } catch (e) {
      if (!(e instanceof RouteError)) throw e;
      problems.push({ message: e.message.replace(`${relNoExt}: `, ""), file, ...(e.hint ? { hint: e.hint } : {}) });
      continue;
    }
    const id = `pages/${relNoExt}`;
    const page = byId.get(id) ?? { id, pattern, load: false, actions: [] };
    byId.set(id, page);
    if (rel.endsWith(".html")) {
      page.html = file;
      continue;
    }
    if (page.source) {
      problems.push({ message: `is the same page as ${page.source}; keep one`, file });
      continue;
    }
    page.source = file;
    let code: string;
    try {
      code = readFileSync(join(base, rel), "utf8");
    } catch {
      continue;
    }
    let exports: string[];
    try {
      exports = transpiler.scan(code).exports;
    } catch {
      // A syntax error: the bundler reports it with its line and column.
      continue;
    }
    page.load = exports.includes("load");
    if (exports.includes("actions")) {
      try {
        page.actions = actionNames(code);
      } catch (e) {
        if (!(e instanceof RouteError)) throw e;
        problems.push({ message: e.message, file });
      }
    }
  }
  const pages = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const byPattern = new Map<string, PageModule>();
  for (const p of pages) {
    const where = p.source ?? p.html ?? p.id;
    if (p.source && !p.html && !p.load)
      problems.push({ message: "a page without an .html template must export load() returning a Response", file: where, hint: `add ${p.id}.html, or export load` });
    const other = byPattern.get(p.pattern);
    if (other) problems.push({ message: `maps to ${p.pattern}, as ${other.source ?? other.html} does; keep one`, file: where });
    byPattern.set(p.pattern, p);
  }
  if (problems.length === 1) {
    const [p] = problems as [(typeof problems)[number]];
    throw new RouteError(p.message, { file: p.file, ...(p.hint ? { hint: p.hint } : {}) });
  }
  if (problems.length > 1)
    throw new RouteError(
      `${problems.length} page file problems`,
      {},
      problems.map((p) => `${p.file}: ${p.message}`),
    );
  return pages;
}

export function routesOf(functions: FunctionModule[], pages: PageModule[] = []): Route[] {
  const routes: Route[] = [];
  for (const f of functions)
    for (const m of f.methods) routes.push({ kind: "function", method: m, path: f.pattern, module: f.id, export: m });
  for (const p of pages) {
    const r: PageRoute = { kind: "page", path: p.pattern };
    if (p.source) r.module = p.id;
    if (p.source && p.load) r.load = true;
    if (p.source && p.actions.length) r.actions = p.actions;
    if (p.html) r.template = p.id;
    routes.push(r);
  }
  return routes;
}

/** The methods a route answers: a page answers GET and HEAD, and POST with actions. */
export const methodsOf = (r: Route): Method[] =>
  r.kind === "function" ? [r.method] : r.actions?.length ? ["GET", "HEAD", "POST"] : ["GET", "HEAD"];

/** How a route is shown: `GET /api/x` or `PAGE /products/:id`. */
export const routeLabel = (r: Route): string => (r.kind === "function" ? `${r.method} ${r.path}` : `PAGE ${r.path}`);

/** V8 shape: static segments literally, parameter and catch-all names ignored. */
export const shapeOf = (pattern: string): string =>
  pattern
    .split("/")
    .slice(1)
    .map((s) => (s.startsWith(":") ? ":" : s.startsWith("*") ? "*" : `=${s}`))
    .join("/");

const sourceOf = (r: Route): string => r.module ?? (r.kind === "page" ? (r.template ?? r.path) : r.path);

/**
 * Route conflicts (V8): two routes that answer the same method with the same
 * shape. A page answers GET and HEAD (POST with actions), so it conflicts
 * with any page of the same shape and with a function of that shape for one
 * of those methods.
 */
export function routeConflicts(routes: Route[]): string[] {
  const seen = new Map<string, Route>();
  const out: string[] = [];
  for (const r of routes) {
    const reported = new Set<Route>();
    for (const m of methodsOf(r)) {
      const key = `${m} ${shapeOf(r.path)}`;
      const other = seen.get(key);
      if (!other) seen.set(key, r);
      else if (!reported.has(other)) {
        out.push(`V8: ${m} ${other.path} (${sourceOf(other)}) and ${r.path} (${sourceOf(r)}) conflict`);
        reported.add(other);
      }
    }
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
  return [...routes].sort((a, b) => rank(a.path).localeCompare(rank(b.path)) || routeLabel(a).localeCompare(routeLabel(b)));
}
