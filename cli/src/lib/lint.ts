// `renox check` source lints (docs/12-developer-experience.md, "renox
// check"): SQL built by interpolation or concatenation, and literal fetch
// URLs whose host is not declared in permissions.network.
//
// A small tokenizer, not a parser: it understands comments, strings, and
// template literals (with nested `${}`), which is what the two rules need.

export interface Finding {
  file: string;
  line: number;
  column: number;
  rule: "sql-interpolation" | "fetch-undeclared-host";
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
    const concatenated =
      arg.some((t) => t.type === "punct" && t.text === "+") ||
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
