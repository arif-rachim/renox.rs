// `renox check` source lints (docs/12-developer-experience.md, "renox
// check"): SQL built by interpolation or concatenation, literal fetch URLs
// whose host is not declared in permissions.network, and handlers that write
// to global scope (docs/16-risks.md, "Global state leaking between requests"),
// redirects to a target taken from the request (docs/24-threat-model.md,
// "Open redirect via `next`/`return_to`"), and request bodies used without
// validation (docs/24-threat-model.md A, "Input validation").
//
// A small tokenizer, not a parser: it understands comments, strings, and
// template literals (with nested `${}`), which is what the rules need. The
// global-state rule adds brace scopes on top (see lintGlobalState).

export interface Finding {
  file: string;
  line: number;
  column: number;
  /** `secret` and `forbidden-file` come from the bundle-hygiene rules (#115, secrets.ts and build.ts); `public-sourcemap` from check/no-public-sourcemaps.ts (#128). */
  rule: "sql-interpolation" | "fetch-undeclared-host" | "global-state" | "no-unsafe-redirect" | "secret" | "forbidden-file" | "public-sourcemap" | "override-drift" | "unvalidated-body";
  severity: "error" | "warning";
  message: string;
}

type TokenType = "ident" | "punct" | "string" | "template" | "number" | "other";
interface Token {
  type: TokenType;
  text: string;
  start: number;
}

const IDENT_START = /[A-Za-z_$]/u;
const IDENT = /[A-Za-z0-9_$]/u;

/** End index (exclusive) of the template literal starting at `i` (a backtick). */
function scanTemplate(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") return j + 1;
    if (c === "$" && src[j + 1] === "{") {
      j = scanBalanced(src, j + 2);
      continue;
    }
    j++;
  }
  return j;
}

/** End index after the `}` that closes an expression starting at `i`. */
function scanBalanced(src: string, i: number): number {
  let depth = 1;
  let j = i;
  while (j < src.length && depth > 0) {
    const c = src[j] as string;
    if (c === "'" || c === '"') j = scanString(src, j);
    else if (c === "`") j = scanTemplate(src, j);
    else if (c === "/" && src[j + 1] === "/") j = src.indexOf("\n", j) < 0 ? src.length : src.indexOf("\n", j);
    else if (c === "/" && src[j + 1] === "*") j = src.indexOf("*/", j + 2) < 0 ? src.length : src.indexOf("*/", j + 2) + 2;
    else {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      j++;
    }
  }
  return j;
}

function scanString(src: string, i: number): number {
  const q = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== q && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
  return j + 1;
}

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/u.test(c)) {
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? src.length : e;
    } else if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? src.length : e + 2;
    } else if (c === "'" || c === '"') {
      const e = scanString(src, i);
      out.push({ type: "string", text: src.slice(i, e), start: i });
      i = e;
    } else if (c === "`") {
      const e = scanTemplate(src, i);
      out.push({ type: "template", text: src.slice(i, e), start: i });
      i = e;
    } else if (IDENT_START.test(c)) {
      let e = i + 1;
      while (e < src.length && IDENT.test(src[e] as string)) e++;
      out.push({ type: "ident", text: src.slice(i, e), start: i });
      i = e;
    } else if (/[0-9]/u.test(c)) {
      let e = i + 1;
      while (e < src.length && /[0-9A-Za-z_.]/u.test(src[e] as string)) e++;
      out.push({ type: "number", text: src.slice(i, e), start: i });
      i = e;
    } else {
      out.push({ type: "punct", text: c, start: i });
      i++;
    }
  }
  return out;
}

function position(src: string, index: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let k = 0; k < index; k++)
    if (src.charCodeAt(k) === 10) {
      line++;
      last = k;
    }
  return { line, column: index - last };
}

/** Tokens of the first argument of the call whose `(` is at `open`. */
function firstArgument(tokens: Token[], open: number): Token[] {
  const arg: Token[] = [];
  let depth = 0;
  for (let k = open + 1; k < tokens.length; k++) {
    const t = tokens[k] as Token;
    if (t.type === "punct") {
      if ("([{".includes(t.text)) depth++;
      else if (")]}".includes(t.text)) {
        if (depth === 0) break;
        depth--;
      } else if (t.text === "," && depth === 0) break;
    }
    arg.push(t);
  }
  return arg;
}

const SQL_METHODS = new Set(["query", "queryOne", "execute"]);
const RECEIVERS = new Set(["db", "tx"]);

/** `db.query(\`... ${x}\`)`, `db.query("..." + x)`, and `.concat(` as the SQL argument. */
export function lintSql(src: string, file: string): Finding[] {
  const tokens = tokenize(src);
  const out: Finding[] = [];
  for (let k = 0; k + 3 < tokens.length; k++) {
    const [recv, dot, name, open] = [tokens[k], tokens[k + 1], tokens[k + 2], tokens[k + 3]] as Token[];
    if (
      recv?.type !== "ident" ||
      !RECEIVERS.has(recv.text) ||
      dot?.text !== "." ||
      name?.type !== "ident" ||
      !SQL_METHODS.has(name.text) ||
      open?.text !== "("
    )
      continue;
    const arg = firstArgument(tokens, k + 3);
    const interpolated = arg.some((t) => t.type === "template" && t.text.includes("${"));
    // `+` joining only string literals is a constant; any other operand
    // (a variable, a call, an interpolated template) builds SQL from data.
    const literal = (t: Token): boolean =>
      t.type === "string" || (t.type === "template" && !t.text.includes("${")) || (t.type === "punct" && "+()".includes(t.text));
    const concatenated =
      (arg.some((t) => t.type === "punct" && t.text === "+") && !arg.every(literal)) ||
      arg.some((t, i) => t.type === "ident" && t.text === "concat" && arg[i - 1]?.text === ".");
    if (interpolated || concatenated) {
      const { line, column } = position(src, name.start);
      out.push({
        file,
        line,
        column,
        rule: "sql-interpolation",
        severity: "error",
        message: `${recv.text}.${name.text}(): SQL built with ${interpolated ? "template interpolation" : "string concatenation"}; pass values as ? parameters`,
      });
    }
  }
  return out;
}

/** Host part of a network allowlist entry, with its scheme. */
function parseAllow(entry: string): { scheme: "http" | "https"; host: string } {
  const scheme = entry.startsWith("http://") ? "http" : "https";
  const host = entry.replace(/^https?:\/\//u, "").replace(/:\d+$/u, "").toLowerCase();
  return { scheme, host };
}

function allowed(url: URL, allow: string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  const scheme = url.protocol === "http:" ? "http" : "https";
  return allow.map(parseAllow).some((a) => {
    if (scheme === "http" && a.scheme !== "http") return false;
    if (a.host.startsWith("*.")) return host.endsWith(a.host.slice(1)) && host !== a.host.slice(2);
    return host === a.host;
  });
}

/** Literal `fetch("https://…")` to a host not in permissions.network (warning). */
export function lintFetch(src: string, file: string, allow: string[]): Finding[] {
  const tokens = tokenize(src);
  const out: Finding[] = [];
  for (let k = 0; k + 2 < tokens.length; k++) {
    const [name, open, arg] = [tokens[k], tokens[k + 1], tokens[k + 2]] as Token[];
    if (name?.type !== "ident" || name.text !== "fetch" || open?.text !== "(") continue;
    if (tokens[k - 1]?.text === "." && tokens[k - 2]?.text !== "ctx") continue;
    if (!arg || (arg.type !== "string" && arg.type !== "template")) continue;
    if (arg.type === "template" && arg.text.includes("${")) continue;
    let url: URL;
    try {
      url = new URL(arg.text.slice(1, -1));
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (!allowed(url, allow)) {
      const { line, column } = position(src, name.start);
      out.push({
        file,
        line,
        column,
        rule: "fetch-undeclared-host",
        severity: "warning",
        message: `fetch to ${url.protocol}//${url.host} is not declared in [permissions] network; it will be refused at runtime`,
      });
    }
  }
  return out;
}

const ASSIGN_OPS = ["**=", "<<=", ">>>=", ">>=", "&&=", "||=", "??=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "="];
const CONTROL = new Set(["if", "while", "for", "switch", "with"]);
const DECL = new Set(["let", "const", "var"]);
/** Marks an intentional module-level cache on the line or the line above. */
export const ALLOW_GLOBAL = "renox-allow-global";

interface Scope {
  fn: boolean;
  names: Set<string>;
}

/** `true` when tokens[a] ends exactly where tokens[b] starts. */
const adjacent = (tokens: Token[], a: number, b: number): boolean => {
  const x = tokens[a];
  const y = tokens[b];
  return !!x && !!y && x.start + x.text.length === y.start;
};

/** The punctuation run starting at `k` (adjacent single-character tokens). */
function punctRun(tokens: Token[], k: number): string {
  let run = "";
  for (let j = k; tokens[j]?.type === "punct" && (j === k || adjacent(tokens, j - 1, j)); j++) run += tokens[j]?.text;
  return run;
}

/** The write operator at `k` (`=`, `+=`, ..., `++`, `--`), or null for a read or a comparison. */
function writeOp(tokens: Token[], k: number): string | null {
  const run = punctRun(tokens, k);
  if (run.startsWith("++") || run.startsWith("--")) return run.slice(0, 2);
  for (const op of ASSIGN_OPS) {
    if (!run.startsWith(op)) continue;
    if (op === "=" && (run[1] === "=" || run[1] === ">")) return null;
    return op;
  }
  return null;
}

/** Identifiers in tokens[a..b) that a parameter list or pattern binds (types and defaults over-included). */
function bindingNames(tokens: Token[], a: number, b: number): string[] {
  const out: string[] = [];
  for (let j = a; j < b; j++) {
    const t = tokens[j] as Token;
    if (t.type === "ident" && tokens[j - 1]?.text !== ".") out.push(t.text);
  }
  return out;
}

/**
 * Names declared by the `let`/`const`/`var` at `k`: `let a = 1, b`, and the
 * identifiers of a destructuring pattern. Stops at `;`, or at a line break
 * outside brackets that is not followed or preceded by a comma.
 */
function declaredNames(src: string, tokens: Token[], k: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let expectName = true;
  for (let j = k + 1; j < tokens.length; j++) {
    const t = tokens[j] as Token;
    const prev = tokens[j - 1] as Token;
    if (depth === 0 && j > k + 1 && t.text !== "," && prev.text !== "," && src.slice(prev.start, t.start).includes("\n")) break;
    if (t.type === "punct") {
      if (t.text === ";" && depth === 0) break;
      if ("([{".includes(t.text)) {
        if (expectName && depth === 0 && (t.text === "{" || t.text === "[")) {
          // A destructuring pattern: every identifier in it.
          let d = 0;
          let e = j;
          for (; e < tokens.length; e++) {
            const x = tokens[e]?.text ?? "";
            if ("([{".includes(x)) d++;
            else if (")]}".includes(x) && --d === 0) break;
          }
          out.push(...bindingNames(tokens, j + 1, e));
          j = e;
          expectName = false;
          continue;
        }
        depth++;
      } else if (")]}".includes(t.text)) {
        if (depth === 0) break;
        depth--;
      } else if (t.text === "," && depth === 0) expectName = true;
      continue;
    }
    if (expectName && depth === 0 && t.type === "ident") {
      out.push(t.text);
      expectName = false;
    }
  }
  return out;
}

/**
 * `global-state` (error): a function body that writes to state shared by every
 * request of the deployment (docs/07-app-model.md, "State rules"):
 *
 * - `globalThis.x = ...`, `globalThis["x"] = ...`, `globalThis.x.y += ...`,
 *   `globalThis.n++`, and `Object.assign(globalThis, ...)` /
 *   `Object.defineProperty(globalThis, ...)`;
 * - an assignment (`=`, compound, `++`, `--`) to a module-level `let` or
 *   `var` binding, unless a parameter or a local declaration of the same name
 *   shadows it.
 *
 * Module top-level code (initialisation) is not flagged. Writes inside a
 * shared object (`cache.set(k, v)`, `counts[k] = 1` on a `const`) are not
 * caught: that needs type information. A line carrying (or following a line
 * carrying) `// renox-allow-global` is an intentional cache and is skipped.
 */
export function lintGlobalState(src: string, file: string): Finding[] {
  const tokens = tokenize(src);
  const lines = src.split("\n");
  const out: Finding[] = [];
  const topLevel = new Set<string>();
  const stack: Scope[] = [{ fn: false, names: new Set() }];
  const parens: number[] = [];
  /** `)` index → its `(` index. */
  const openOf = new Map<number, number>();
  /** Index of the last `)` seen. */
  let lastClose: number | undefined;
  let parenDepth = 0;

  const inFunction = (): boolean => stack.some((s) => s.fn);
  const shadowed = (name: string): boolean => stack.slice(1).some((s) => s.names.has(name));
  const report = (at: Token, message: string): void => {
    const { line, column } = position(src, at.start);
    if (lines[line - 1]?.includes(ALLOW_GLOBAL) || lines[line - 2]?.includes(ALLOW_GLOBAL)) return;
    out.push({ file, line, column, rule: "global-state", severity: "error", message });
  };
  const advice = "module state is shared by every request of the deployment; pass per-request data through ctx, or mark an intentional cache with // renox-allow-global";

  /** The scope a `{` at `k` opens: a function body (with its parameters) or a block. */
  const openScope = (k: number): Scope => {
    const prev = tokens[k - 1];
    // `=> {`: arrow body; parameters are the paren group or the single identifier before `=>`.
    if (prev?.text === ">" && tokens[k - 2]?.text === "=" && adjacent(tokens, k - 2, k - 1)) {
      const before = k - 3;
      const close = lastClose !== undefined && lastClose <= before ? lastClose : undefined;
      if (close !== undefined) {
        // `(a, b): T => {`: the group closes before an optional return type.
        const between = tokens.slice(close + 1, before + 1);
        if (between.length === 0 || (between[0]?.text === ":" && !between.some((t) => t.text === ";" || t.text === "=")))
          return { fn: true, names: new Set(bindingNames(tokens, (openOf.get(close) as number) + 1, close)) };
      }
      if (tokens[before]?.type === "ident") return { fn: true, names: new Set([tokens[before]?.text as string]) };
      return { fn: true, names: new Set() };
    }
    // `name(params) {`, `function name(params): T {`, `catch (e) {`, `if (...) {`.
    const close = lastClose;
    if (close === undefined) return { fn: false, names: new Set() };
    const between = tokens.slice(close + 1, k);
    const typed = between[0]?.text === ":" && !between.some((t) => t.text === ";" || t.text === "=" || t.text === "{" || t.text === "}");
    if (between.length > 0 && !typed) return { fn: false, names: new Set() };
    const open = openOf.get(close) as number;
    const keyword = tokens[open - 1]?.text ?? "";
    const params = new Set(bindingNames(tokens, open + 1, close));
    if (CONTROL.has(keyword)) return { fn: false, names: new Set() };
    if (keyword === "catch") return { fn: false, names: params };
    return { fn: true, names: params };
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k] as Token;
    if (t.type === "punct") {
      if (t.text === "(") {
        parens.push(k);
        parenDepth++;
      } else if (t.text === ")") {
        const open = parens.pop();
        if (open !== undefined) openOf.set(k, open);
        lastClose = k;
        parenDepth = Math.max(0, parenDepth - 1);
      } else if (t.text === "{") stack.push(openScope(k));
      else if (t.text === "}" && stack.length > 1) stack.pop();
      continue;
    }
    if (t.type !== "ident") continue;
    const prev = tokens[k - 1];
    if (DECL.has(t.text) && prev?.text !== ".") {
      const names = declaredNames(src, tokens, k);
      const scope = stack[stack.length - 1] as Scope;
      for (const n of names) scope.names.add(n);
      if (stack.length === 1 && parenDepth === 0 && t.text !== "const") for (const n of names) topLevel.add(n);
      continue;
    }
    if ((t.text === "function" || t.text === "class") && tokens[k + 1]?.type === "ident" && stack.length > 1)
      (stack[stack.length - 1] as Scope).names.add(tokens[k + 1]?.text as string);
    if (!inFunction() || prev?.text === ".") continue;

    if (t.text === "globalThis") {
      // Object.assign(globalThis, ...), Object.defineProperty(globalThis, ...).
      const callee = tokens[k - 2]?.text;
      if (prev?.text === "(" && tokens[k - 3]?.text === "." && tokens[k - 4]?.text === "Object" && /^define|^assign$/u.test(callee ?? "")) {
        report(t, `Object.${callee}(globalThis, ...) inside a function: ${advice}`);
        continue;
      }
      // Member chain: .x, ["x"], .x.y ...
      let j = k + 1;
      let target = "globalThis";
      for (;;) {
        if (tokens[j]?.text === "." && tokens[j + 1]?.type === "ident") {
          target += `.${tokens[j + 1]?.text}`;
          j += 2;
        } else if (tokens[j]?.text === "[") {
          let d = 0;
          const s0 = j;
          for (; j < tokens.length; j++) {
            if (tokens[j]?.text === "[") d++;
            else if (tokens[j]?.text === "]" && --d === 0) break;
          }
          target += src.slice((tokens[s0] as Token).start, (tokens[j] as Token).start + 1);
          j++;
        } else break;
      }
      if (j > k + 1 && writeOp(tokens, j)) report(t, `${target} written inside a function: ${advice}`);
      continue;
    }

    if (!topLevel.has(t.text) || shadowed(t.text)) continue;
    const prefix = prev?.type === "punct" && (prev.text === "+" || prev.text === "-") && tokens[k - 2]?.text === prev.text && adjacent(tokens, k - 2, k - 1);
    if (writeOp(tokens, k + 1) || prefix) report(t, `module-level binding ${t.text} assigned inside a function: ${advice}`);
  }
  return out;
}

/** Names whose value comes from the request: query, form, route params, headers, body. */
const REQUEST_INPUT = new Set(["searchParams", "form", "formData", "params", "query", "headers", "body", "json", "cookies", "referer", "referrer"]);
/** Calls that make a redirect target safe (`renox` SDK, sdk/src/redirect.ts). */
const REDIRECT_SANITIZERS = new Set(["safeRedirectTarget"]);

/** Tokens of the expression starting at `a`: up to `,` `;` or a closing bracket at depth 0, or a line break that ends the statement. */
function expressionAt(src: string, tokens: Token[], a: number, stopAtComma: boolean): Token[] {
  const out: Token[] = [];
  let depth = 0;
  for (let j = a; j < tokens.length; j++) {
    const t = tokens[j] as Token;
    const prev = tokens[j - 1];
    if (depth === 0 && j > a && prev && src.slice(prev.start + prev.text.length, t.start).includes("\n")) {
      const cont = t.type === "punct" && ".?:+-*/|&".includes(t.text);
      const prevCont = prev.type === "punct" && "=(,?:+-*/|&".includes(prev.text);
      if (!cont && !prevCont) break;
    }
    if (t.type === "punct") {
      if ("([{".includes(t.text)) depth++;
      else if (")]}".includes(t.text)) {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (t.text === ";" || (stopAtComma && t.text === ","))) break;
    }
    out.push(t);
  }
  return out;
}

const sanitized = (expr: Token[]): boolean =>
  expr.some((t, i) => t.type === "ident" && (REDIRECT_SANITIZERS.has(t.text) || (t.text === "safe" && expr[i - 1]?.text === "." && expr[i - 2]?.text === "redirect")));

/**
 * `no-unsafe-redirect` (error): a redirect whose target comes from the
 * request (`url.searchParams`, `form`, `params`, `headers`, the body, or a
 * variable assigned from one of them) without `redirect.safe()` or
 * `safeRedirectTarget()`: `Response.redirect(next)`, a `location` header in
 * a `Response` init, and `headers.set("location", next)`. Taint is followed
 * through `const`/`let`/`var` declarations in the same file, not through
 * function calls or object properties.
 */
export function lintRedirect(src: string, file: string): Finding[] {
  const tokens = tokenize(src);
  const tainted = new Set<string>();
  const taintedName = (name: string): boolean => REQUEST_INPUT.has(name) || tainted.has(name);
  // A template is tainted when an interpolation reads request input, unless
  // it starts with a fixed path of the app (`/items/${id}` stays on the app).
  const taintedTemplate = (text: string): boolean =>
    !/^`\/[^/\\$]/u.test(text) && [...text.matchAll(/\$\{([^}]*)\}/gu)].some((m) => (m[1] ?? "").match(/[A-Za-z_$][\w$]*/gu)?.some(taintedName));
  const isTainted = (expr: Token[]): boolean =>
    !sanitized(expr) &&
    expr.some(
      (t, i) =>
        (t.type === "ident" && (REQUEST_INPUT.has(t.text) || (tainted.has(t.text) && expr[i - 1]?.text !== "."))) ||
        (t.type === "template" && taintedTemplate(t.text)),
    );
  // Declarations, in source order: `const next = url.searchParams.get("next")`.
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k] as Token;
    if (t.type !== "ident" || !DECL.has(t.text) || tokens[k - 1]?.text === ".") continue;
    let eq = k + 1;
    let depth = 0;
    for (; eq < tokens.length; eq++) {
      const x = tokens[eq]?.text ?? "";
      if ("([{".includes(x)) depth++;
      else if (")]}".includes(x)) depth--;
      else if (depth === 0 && (x === ";" || x === "=")) break;
    }
    if (tokens[eq]?.text !== "=" || tokens[eq + 1]?.text === "=" || tokens[eq + 1]?.text === ">") continue;
    if (isTainted(expressionAt(src, tokens, eq + 1, false))) for (const n of declaredNames(src, tokens, k)) tainted.add(n);
  }
  const out: Finding[] = [];
  const report = (at: Token, what: string): void => {
    const { line, column } = position(src, at.start);
    out.push({
      file,
      line,
      column,
      rule: "no-unsafe-redirect",
      severity: "error",
      message: `${what} with a target taken from the request: an open redirect; use redirect.safe(target, { allow }) from "renox"`,
    });
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k] as Token;
    // Response.redirect(<target>)
    if (t.text === "Response" && tokens[k + 1]?.text === "." && tokens[k + 2]?.text === "redirect" && tokens[k + 3]?.text === "(") {
      if (isTainted(firstArgument(tokens, k + 3))) report(t, "Response.redirect()");
      continue;
    }
    // { location: <target> } / { "Location": <target> }
    const key = t.type === "string" ? t.text.slice(1, -1) : t.type === "ident" ? t.text : "";
    if (key.toLowerCase() === "location" && tokens[k + 1]?.text === ":" && (tokens[k - 1]?.text === "{" || tokens[k - 1]?.text === ",")) {
      if (isTainted(expressionAt(src, tokens, k + 2, true))) report(t, "a Location header");
      continue;
    }
    // headers.set("location", <target>) / .append(...)
    if ((t.text === "set" || t.text === "append") && tokens[k - 1]?.text === "." && tokens[k + 1]?.text === "(") {
      const name = tokens[k + 2];
      if (name?.type === "string" && name.text.slice(1, -1).toLowerCase() === "location" && tokens[k + 3]?.text === ",") {
        if (isTainted(expressionAt(src, tokens, k + 4, true))) report(t, `${t.text}("location")`);
      }
    }
  }
  return out;
}

/** Calls that validate a value: `validate(schema, value)` from "renox" (sdk/src/validate.ts) or a schema's own parse. */
const BODY_VALIDATORS = new Set(["validate", "parse", "safeParse", "parseAsync", "safeParseAsync", "assert", "is"]);
/** Names a handler's request goes by: `req` (ctx.req, destructured) and `request`. */
const REQUEST_NAMES = new Set(["req", "request"]);

/** Every token index inside the argument list of a call to a validator. */
function validatedSpans(tokens: Token[]): Set<number> {
  const out = new Set<number>();
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k] as Token;
    if (t.type !== "ident" || !BODY_VALIDATORS.has(t.text) || tokens[k + 1]?.text !== "(") continue;
    let depth = 0;
    for (let j = k + 1; j < tokens.length; j++) {
      const x = tokens[j] as Token;
      if (x.type === "punct" && "([{".includes(x.text)) depth++;
      else if (x.type === "punct" && ")]}".includes(x.text) && --depth === 0) break;
      out.add(j);
    }
  }
  return out;
}

/**
 * `unvalidated-body` (warning in F4/F5): a handler that reads the request
 * body with `req.json()` or `req.formData()` (also `request.…`, `ctx.req.…`)
 * and uses the value without passing it to `validate(schema, value)` from
 * "renox" or a schema's `parse`/`safeParse`. The body read inside a
 * validator call (`validate(schema, await req.json())`) is validated; a
 * body assigned to a name is validated when that name is later an argument
 * of a validator in the same file. `validate(schema, req)` reads no body
 * here and is never flagged.
 */
export function lintBody(src: string, file: string): Finding[] {
  const tokens = tokenize(src);
  const inside = validatedSpans(tokens);
  const out: Finding[] = [];
  for (let k = 2; k < tokens.length; k++) {
    const t = tokens[k] as Token;
    if (t.type !== "ident" || (t.text !== "json" && t.text !== "formData")) continue;
    if (tokens[k - 1]?.text !== "." || tokens[k + 1]?.text !== "(" || tokens[k + 2]?.text !== ")") continue;
    const recv = tokens[k - 2] as Token;
    if (recv.type !== "ident" || !REQUEST_NAMES.has(recv.text)) continue;
    if (inside.has(k)) continue;
    // `const body = await req.json()`: the names this statement declares.
    let names: string[] = [];
    let depth = 0;
    for (let j = k - 3; j >= 0; j--) {
      const x = tokens[j] as Token;
      if (x.type === "punct") {
        if (")]}".includes(x.text)) depth++;
        else if ("([{".includes(x.text)) {
          if (depth === 0) break;
          depth--;
        } else if (x.text === ";" && depth === 0) break;
        continue;
      }
      if (depth === 0 && x.type === "ident" && DECL.has(x.text) && tokens[j - 1]?.text !== ".") {
        names = declaredNames(src, tokens, j);
        break;
      }
    }
    const ok =
      names.length > 0 &&
      names.every((n) => tokens.some((x, j) => j > k && inside.has(j) && x.type === "ident" && x.text === n && tokens[j - 1]?.text !== "."));
    if (ok) continue;
    const { line, column } = position(src, recv.start);
    out.push({
      file,
      line,
      column,
      rule: "unvalidated-body",
      severity: "warning",
      message: `${recv.text}.${t.text}() is used without validation: pass it to validate(schema, value) from "renox" (or the schema's parse) before reading its fields`,
    });
  }
  return out;
}
