// Static reading of a `hooks.ts` (artifact 1.9, #640; ADR D32): the keys of
// `export const hooks = { ... }` (the hook names the file fills) and of
// `export const on = { ... }` (the event names it handles), read without
// running the code, so the broker can route a hook run or an event without
// evaluating the module.
//
// A small scanner, not a parser: it understands comments, strings, template
// literals (with nested `${}`) and regex literals, which is what skipping a
// handler body needs. A key is an identifier, a string literal, a number, or
// a method shorthand of either (`async "x.y"(ctx, e) {}`). A computed key, a
// spread, an `export const hooks = someVariable`, a re-export or an
// `export *` cannot be read: the result says why.

import { WORKER_VERSION } from "../../scripts/fetch-worker.ts";
import { stripCommentsAndStrings } from "./modules/build.ts";
import { compareVersions, parseVersion } from "./modules/semver.ts";

/**
 * The first `renox-worker` release that evaluates lazy module entries
 * (artifact 1.9, ops.md 1.14.0, #640). A worker before it refuses them
 * (V23), and an `EntryInfo` with `hooks` or `on` too.
 */
export const LAZY_MODULES_WORKER = "0.8.0";

/**
 * Whether `renox build` writes a module's `services` and `hooks` entries,
 * and the app's `hooks` entry, lazy with their recorded names (#640): only
 * once the pinned worker evaluates them, so a CLI never builds an artifact
 * its own worker refuses. `RENOX_BUILD_LAZY_MODULES=1` (or `0`) overrides
 * it, for the tests against a worker built from source.
 */
export function lazyModuleEntries(pinned: string = WORKER_VERSION): boolean {
  const env = process.env.RENOX_BUILD_LAZY_MODULES;
  if (env === "1") return true;
  if (env === "0") return false;
  const have = parseVersion(pinned);
  const need = parseVersion(LAZY_MODULES_WORKER);
  return have !== null && need !== null && compareVersions(have, need) >= 0;
}

export interface HookKeys {
  hooks: string[];
  on: string[];
}

export type HookKeysResult = { ok: true; keys: HookKeys } | { ok: false; problem: string };

const IDENT_START = /[A-Za-z_$]/u;
const IDENT = /[A-Za-z0-9_$]/u;
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

class Unreadable extends Error {}

/** Index after the trivia (whitespace and comments) starting at `i`. */
function skipTrivia(src: string, i: number): number {
  for (;;) {
    const c = src[i];
    if (c !== undefined && /\s/u.test(c)) i++;
    else if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else return i;
  }
}

/** Index after the string literal that starts at `i`. */
function skipString(src: string, i: number): number {
  const q = src[i];
  let k = i + 1;
  while (k < src.length && src[k] !== q) {
    if (src[k] === "\n") throw new Unreadable("an unterminated string");
    k += src[k] === "\\" ? 2 : 1;
  }
  return k + 1;
}

/** Index after the template literal that starts at `i`. */
function skipTemplate(src: string, i: number): number {
  let k = i + 1;
  while (k < src.length) {
    const c = src[k];
    if (c === "\\") k += 2;
    else if (c === "`") return k + 1;
    else if (c === "$" && src[k + 1] === "{") k = skipBalanced(src, k + 2);
    else k++;
  }
  throw new Unreadable("an unterminated template literal");
}

/** Index after the regex literal that starts at `i`. */
function skipRegex(src: string, i: number): number {
  let k = i + 1;
  let cls = false;
  while (k < src.length) {
    const c = src[k];
    if (c === "\n") throw new Unreadable("an unterminated regular expression");
    if (c === "\\") k += 2;
    else {
      if (c === "[") cls = true;
      else if (c === "]") cls = false;
      else if (c === "/" && !cls) {
        k++;
        while (k < src.length && IDENT.test(src[k] as string)) k++;
        return k;
      }
      k++;
    }
  }
  throw new Unreadable("an unterminated regular expression");
}

/**
 * From `i`, just inside an opening bracket (or `${`), the index after the
 * bracket that closes it. With `stopAtComma`, instead the index of the first
 * `,` or closing bracket at depth 0 (the end of one property value).
 */
function skipBalanced(src: string, i: number, stopAtComma = false): number {
  let depth = stopAtComma ? 0 : 1;
  // The last significant character (or word), to tell a regex from a division.
  let prev = "";
  let k = i;
  while (k < src.length) {
    k = skipTrivia(src, k);
    const c = src[k];
    if (c === undefined) break;
    if (c === '"' || c === "'") {
      k = skipString(src, k);
      prev = '"';
    } else if (c === "`") {
      k = skipTemplate(src, k);
      prev = '"';
    } else if (c === "/") {
      if (prev === "" || /^[(,=:[!&|?{};~+\-*%<>^]$/u.test(prev) || REGEX_AFTER_WORD.has(prev)) {
        k = skipRegex(src, k);
        prev = '"';
      } else {
        k++;
        prev = "/";
      }
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
      k++;
      prev = c;
    } else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return k;
      depth--;
      k++;
      if (depth === 0 && !stopAtComma) return k;
      prev = c;
    } else if (c === "," && depth === 0 && stopAtComma) {
      return k;
    } else if (IDENT.test(c)) {
      let e = k;
      while (e < src.length && IDENT.test(src[e] as string)) e++;
      prev = src.slice(k, e);
      k = e;
    } else {
      k++;
      prev = c;
    }
  }
  throw new Unreadable("an unbalanced bracket");
}

const UNESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };

/** The value of the string literal `lit` (with its quotes). */
function stringValue(lit: string): string {
  return lit.slice(1, -1).replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/gu, (_, e: string) => {
    if (e[0] === "u" && e.length > 1) return String.fromCodePoint(Number.parseInt(e.startsWith("u{") ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === "x" && e.length > 1) return String.fromCharCode(Number.parseInt(e.slice(1), 16));
    return UNESCAPES[e] ?? e;
  });
}

/** The keys of the object literal whose `{` is at `open`. */
function objectKeys(src: string, open: number, what: string): string[] {
  const keys: string[] = [];
  let i = open + 1;
  for (;;) {
    i = skipTrivia(src, i);
    const c = src[i];
    if (c === undefined) throw new Unreadable(`${what} is not closed`);
    if (c === "}") return keys;
    if (c === ",") {
      i++;
      continue;
    }
    if (c === "." && src.startsWith("...", i)) throw new Unreadable(`${what} spreads another object (...)`);
    // Modifiers (`async`, `get`, `set`, `*`) before the key of a method.
    let key: string | undefined;
    for (;;) {
      i = skipTrivia(src, i);
      const k = src[i];
      if (k === "*") {
        i++;
        continue;
      }
      if (k === "[") throw new Unreadable(`${what} has a computed key ([...])`);
      if (k === '"' || k === "'") {
        const end = skipString(src, i);
        key = stringValue(src.slice(i, end));
        i = end;
      } else if (k !== undefined && /[0-9]/u.test(k)) {
        let e = i;
        while (e < src.length && /[0-9A-Za-z_.]/u.test(src[e] as string)) e++;
        key = String(Number(src.slice(i, e)));
        i = e;
      } else if (k !== undefined && IDENT_START.test(k)) {
        let e = i;
        while (e < src.length && IDENT.test(src[e] as string)) e++;
        key = src.slice(i, e);
        i = e;
        const after = src[skipTrivia(src, i)];
        if ((key === "async" || key === "get" || key === "set") && after !== undefined && !/[:(,}]/u.test(after)) {
          key = undefined;
          continue;
        }
      } else throw new Unreadable(`${what} has a key that is not an identifier or a string`);
      break;
    }
    if (key === undefined) throw new Unreadable(`${what} has a key that cannot be read`);
    keys.push(key);
    i = skipTrivia(src, i);
    // `key: value`, `key(args) { body }`, or `key,` (shorthand); skip to the next comma at depth 0.
    i = skipBalanced(src, i, true);
    if (src[i] === ")" || src[i] === "]") throw new Unreadable(`${what} is not balanced`);
  }
}

/** The keys of `export const <name> = { ... }` in `src`; `[]` when there is no such export. */
function exportKeys(src: string, code: string, name: "hooks" | "on"): string[] {
  const what = `\`export const ${name}\``;
  const decl = new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${name}\\b`, "u").exec(code);
  const other = [
    new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function\\*?|class)\\s+${name}\\b`, "u"),
    new RegExp(`\\bexport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, "u"),
  ].find((r) => r.test(code));
  if (decl === null && other !== undefined) throw new Unreadable(`\`${name}\` is exported other than as \`export const ${name} = { ... }\``);
  if (decl === null) return [];
  let i = decl.index + decl[0].length;
  // An optional type annotation, up to the `=`.
  const eq = code.indexOf("=", i);
  const nl = code.indexOf(";", i);
  if (eq < 0 || (nl >= 0 && nl < eq)) throw new Unreadable(`${what} has no initializer`);
  i = skipTrivia(src, eq + 1);
  if (src[i] !== "{") throw new Unreadable(`${what} is not an object literal ({ ... })`);
  return objectKeys(src, i, what);
}

/** The hook names and event names a `hooks.ts` source fills and handles, sorted. */
export function readHookKeys(src: string): HookKeysResult {
  const code = stripCommentsAndStrings(src);
  try {
    if (/\bexport\s*\*/u.test(code)) throw new Unreadable("`export *` hides what is exported");
    const keys: HookKeys = { hooks: exportKeys(src, code, "hooks"), on: exportKeys(src, code, "on") };
    const sort = (a: string[]): string[] => [...new Set(a)].sort();
    return { ok: true, keys: { hooks: sort(keys.hooks), on: sort(keys.on) } };
  } catch (e) {
    if (e instanceof Unreadable) return { ok: false, problem: e.message };
    throw e;
  }
}

/** The error for a `hooks.ts` whose keys cannot be read (V23): `module` is its module's name, absent for the app's. */
export function unreadableMessage(problem: string, module?: string): string {
  const who = module === undefined ? "the app's hooks.ts" : `the hooks.ts of ${module}`;
  return `V23: ${who} has hook or event names that cannot be read statically (${problem}); use literal keys in \`export const hooks = { ... }\` and \`export const on = { ... }\`${module === undefined ? "" : ", or set [module] eager = true in module.toml"}`;
}

/** The error for a module whose `hooks.ts` fills a hook its lock does not approve (V23). */
export function unapprovedHookMessage(module: string, hook: string): string {
  return `V23: ${module} fills the hook "${hook}", which is not in its approved permissions.hooks (renox.lock)`;
}
