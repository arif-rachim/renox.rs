// Authorization at build and check time (#283; docs/11-authorization.md,
// docs/contracts/artifact.md 1.3 "Authorization and realtime", V24-V25):
//
// - the app's `[authz]` block from renox.toml, carried into the manifest;
// - `policies/app/*.cedar` and `policies/schema.cedarschema` into the
//   artifact (module policies come with the module trees, modules/build.ts);
// - each route module's `export const guard`, read statically (an object
//   literal of strings), into its route entry;
// - V25: guards, sensitive actions and default roles name actions of the
//   merged action set;
// - V24 and policy test cases through `renox-worker check-policies`, which
//   builds the same engine the cell builds (crates/renox-cell/src/authz).

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ValidationError } from "../errors.ts";
import { workerPath } from "./worker.ts";

/** `renox.toml [authz]` / a module's `[authz]` (manifest.md 1.1). */
export interface AuthzBlock {
  actions?: string[];
  ownership?: Record<string, { owner: string; org?: string }>;
  entities?: Record<string, { table?: string; id?: string; attrs?: string[] }>;
  default_roles?: Record<string, string[]>;
  sensitive?: string[];
  /** Only the app's `renox.toml [authz]` (manifest.md 1.8.0, MF19). */
  user_attrs?: string[];
}

/** `export const guard` (artifact.md 1.3, route `guard`). */
export interface Guard {
  action: string;
  resource?: { type: string; id: string };
  /** Artifact 1.13 (#795): a same-origin path a signed-in principal the guard denies is sent to (303); page routes only. */
  deny_redirect?: string;
}

/** The longest `guard.deny_redirect` (artifact.md 1.13). */
export const MAX_DENY_REDIRECT = 200;

/**
 * Why `path` is not a valid `guard.deny_redirect` (artifact.md 1.13, V25), or
 * `null`: a same-origin path starts with one `/` and has no `//`, no
 * backslash, no control character or whitespace, and at most 200 characters,
 * so it can never name another origin. The cell checks the same rule at load.
 */
export function denyRedirectProblem(path: string): string | null {
  if (path.length > MAX_DENY_REDIRECT) return `is longer than ${MAX_DENY_REDIRECT} characters`;
  if (!path.startsWith("/")) return "must start with /";
  if (path.includes("//")) return "must not contain //";
  if (path.includes("\\")) return "must not contain a backslash";
  if (/[\u0000-\u0020\u007f-\u009f\u2028\u2029]/u.test(path)) return "must not contain a control character or whitespace";
  return null;
}

/** The platform's own action every app may use without declaring it. */
export const PLATFORM_ACTIONS = ["realtime.subscribe"];

const ACTION = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u;

/** The attributes of `Renox::User` the platform owns (renox-authz `USER_ATTRS`): an app's `user_attrs` never names one (MF19). */
export const PLATFORM_USER_ATTRS = ["created_at", "email_verified", "has_password", "id", "mfa_verified", "org", "phone_verified"];
export const USER_ATTR_NAME = /^[a-z][a-z0-9_]{1,31}$/u;
export const MAX_USER_ATTRS = 8;

/**
 * MF19: `renox.toml [authz] user_attrs` names at most 8 boolean attributes,
 * each `^[a-z][a-z0-9_]{1,31}$`, distinct, none a platform attribute of
 * `Renox::User`. A module's `[authz]` has none.
 */
export function userAttrProblems(app: AuthzBlock | undefined, modules: readonly { name: string; authz?: AuthzBlock }[] = []): string[] {
  const out: string[] = [];
  for (const m of modules) if (m.authz?.user_attrs !== undefined) out.push(`MF19: ${m.name}: [authz] user_attrs is only for the app's renox.toml`);
  const names = app?.user_attrs;
  if (names === undefined) return out;
  if (!Array.isArray(names)) return [...out, "MF19: [authz] user_attrs must be an array of names"];
  if (names.length > MAX_USER_ATTRS) out.push(`MF19: [authz] user_attrs declares ${names.length} names, more than ${MAX_USER_ATTRS}`);
  const seen = new Set<string>();
  for (const n of names) {
    if (typeof n !== "string" || !USER_ATTR_NAME.test(n)) out.push(`MF19: [authz] user_attrs ${JSON.stringify(n)} does not match ^[a-z][a-z0-9_]{1,31}$`);
    else if (PLATFORM_USER_ATTRS.includes(n)) out.push(`MF19: [authz] user_attrs ${JSON.stringify(n)} is a platform attribute of Renox::User (${PLATFORM_USER_ATTRS.join(", ")})`);
    else if (seen.has(n)) out.push(`MF19: [authz] user_attrs names ${JSON.stringify(n)} twice`);
    seen.add(String(n));
  }
  return out;
}

/** The app's `[authz]`, or undefined when renox.toml has none. */
export function appAuthz(project: string): AuthzBlock | undefined {
  const path = join(project, "renox.toml");
  if (!existsSync(path)) return undefined;
  const raw = Bun.TOML.parse(readFileSync(path, "utf8")) as { authz?: AuthzBlock };
  return raw.authz;
}

/** `policies/app/*.cedar` and `policies/schema.cedarschema` of the app, by artifact path. */
export function appPolicyFiles(project: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const app = join(project, "policies", "app");
  if (existsSync(app)) {
    for (const f of readdirSync(app).filter((n) => n.endsWith(".cedar")).sort()) {
      out.set(`policies/app/${f}`, new Uint8Array(readFileSync(join(app, f))));
    }
  }
  const schema = join(project, "policies", "schema.cedarschema");
  if (existsSync(schema)) out.set("policies/schema.cedarschema", new Uint8Array(readFileSync(schema)));
  return out;
}

/** A problem with the `guard` export of a module. */
export class GuardError extends ValidationError {}

/**
 * The `guard` export of a module source, read without running it: an object
 * literal with string values (`{ action: "x.y", resource: { type: "T", id:
 * ":id" } }`), or `defineGuard({ ... })` around one. `null` when the module
 * exports no guard.
 */
export function readGuard(source: string, file: string): Guard | null {
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const m = /\bexport\s+const\s+guard\s*=\s*(?:defineGuard\s*\(\s*)?\{/u.exec(js);
  if (!m) {
    if (new Bun.Transpiler({ loader: "ts" }).scan(source).exports.includes("guard")) {
      throw new GuardError(`${file}: export const guard must be an object literal ({ action: "x.y", resource?: { type, id } })`, { file });
    }
    return null;
  }
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let end = start;
  for (; end < js.length; end++) {
    const c = js[end];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (end++; end < js.length && js[end] !== q; end++) if (js[end] === "\\") end++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) break;
  }
  const literal = js.slice(start, end + 1);
  // A JSON-like literal: quote the keys, turn single quotes and plain
  // template strings into JSON strings, drop trailing commas.
  const json = literal
    .replace(/`([^`$\\]*)`/gu, (_, s: string) => JSON.stringify(s))
    .replace(/'((?:[^'\\]|\\.)*)'/gu, (_, s: string) => JSON.stringify(s.replace(/\\'/gu, "'")))
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/gu, '$1"$2":')
    .replace(/,\s*([}\]])/gu, "$1");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new GuardError(`${file}: export const guard must be an object literal of strings, got ${literal.replace(/\s+/gu, " ")}`, { file });
  }
  const g = value as Guard;
  if (typeof g?.action !== "string" || !ACTION.test(g.action)) throw new GuardError(`${file}: guard.action must be <resource>.<verb>`, { file });
  if (g.resource !== undefined && (typeof g.resource?.type !== "string" || typeof g.resource?.id !== "string" || g.resource.id === "")) {
    throw new GuardError(`${file}: guard.resource is { type, id } with id a literal or ":<param>"`, { file });
  }
  const keys = Object.keys(g).filter((k) => k !== "action" && k !== "resource" && k !== "deny_redirect");
  if (keys.length) throw new GuardError(`${file}: guard has unknown keys ${keys.join(", ")}`, { file });
  if (g.deny_redirect !== undefined) {
    if (typeof g.deny_redirect !== "string") throw new GuardError(`${file}: guard.deny_redirect must be a same-origin path such as "/my"`, { file });
    const why = denyRedirectProblem(g.deny_redirect);
    if (why) throw new GuardError(`${file}: V25: guard.deny_redirect ${why}`, { file });
  }
  const out: Guard = { action: g.action };
  if (g.resource) out.resource = { type: g.resource.type, id: g.resource.id };
  if (g.deny_redirect !== undefined) out.deny_redirect = g.deny_redirect;
  return out;
}

/** The merged action set: the app's and every module's `authz.actions`, plus the platform's. */
export function mergedActions(app: AuthzBlock | undefined, modules: readonly { authz?: AuthzBlock }[]): Set<string> {
  return new Set([...PLATFORM_ACTIONS, ...(app?.actions ?? []), ...modules.flatMap((m) => m.authz?.actions ?? [])]);
}

interface RouteLike {
  kind: string;
  path?: string;
  module?: string;
  guard?: Guard;
}

/**
 * V25 (artifact.md section 6): every `guard.action`, `sensitive` action and
 * `default_roles` action is in the merged action set; a guard resource's
 * `:<param>` names a parameter of the route; `sensitive` is a subset of the
 * owner's own `actions`.
 */
export function v25Problems(routes: readonly RouteLike[], app: AuthzBlock | undefined, modules: readonly { name: string; authz?: AuthzBlock }[]): string[] {
  const actions = mergedActions(app, modules);
  const out: string[] = [];
  for (const r of routes) {
    if (!r.guard) continue;
    const at = `${r.module ?? r.path}`;
    if (!actions.has(r.guard.action)) out.push(`V25: ${at}: guard action ${r.guard.action} is not in the merged action set`);
    const id = r.guard.resource?.id;
    if (id?.startsWith(":")) {
      const params = new Set([...(r.path ?? "").matchAll(/[:*]([a-z_][a-z0-9_]*)/gu)].map((m) => m[1]));
      if (!params.has(id.slice(1))) out.push(`V25: ${at}: guard resource id ${id} is not a parameter of ${r.path}`);
    }
    // Artifact 1.13 (#795): `deny_redirect` is a same-origin path of a page guard, never the page's own path.
    const to = r.guard.deny_redirect;
    if (to !== undefined) {
      const why = denyRedirectProblem(to);
      if (r.kind !== "page") out.push(`V25: ${at}: guard.deny_redirect is for page routes only`);
      else if (why) out.push(`V25: ${at}: guard.deny_redirect ${why}`);
      else if (to === r.path) out.push(`V25: ${at}: guard.deny_redirect is the page's own path ${to} (a redirect loop)`);
    }
  }
  const owners: [string, AuthzBlock | undefined][] = [["app", app], ...modules.map((m): [string, AuthzBlock | undefined] => [m.name, m.authz])];
  for (const [owner, block] of owners) {
    if (!block) continue;
    const own = new Set(block.actions ?? []);
    for (const a of block.actions ?? []) if (!ACTION.test(a)) out.push(`V25: ${owner}: [authz] action ${JSON.stringify(a)} is not <resource>.<verb>`);
    for (const s of block.sensitive ?? []) if (!own.has(s)) out.push(`V25: ${owner}: sensitive action ${s} is not one of its own [authz] actions`);
    for (const [role, list] of Object.entries(block.default_roles ?? {})) {
      for (const a of list) if (!actions.has(a)) out.push(`V25: ${owner}: default role ${role} names ${a}, which is not in the merged action set`);
    }
  }
  return out;
}

/** One problem of `renox-worker check-policies`, with its file and line. */
export interface PolicyDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
}

/** A policy test case (`policies/tests/*.json`). */
export interface PolicyCase {
  description?: string;
  principal: { type: string; id: string; roles?: string[]; attrs?: Record<string, unknown> };
  action: string;
  resource?: { type: string; id?: string; [attr: string]: unknown };
  context?: Record<string, unknown>;
  expected: "allow" | "deny";
}

export interface PolicyResult {
  allow: boolean;
  reason: string;
  policies: string[];
  /** With `explain`: the deciding policies' text and the errors. */
  explanation?: { decision: string; reasons: string[]; errors: string[]; text: string };
}

/** `RENOX_POLICY_INVALID` (V24): every diagnostic with its file and line. */
export class PolicyError extends ValidationError {
  constructor(readonly diagnostics: PolicyDiagnostic[]) {
    const [first] = diagnostics;
    super(
      diagnostics.length === 1 && first
        ? `RENOX_POLICY_INVALID: ${first.message}`
        : `RENOX_POLICY_INVALID: ${diagnostics.length} policy errors:\n  ${diagnostics.map((d) => `${d.file}:${d.line}:${d.column}: ${d.message}`).join("\n  ")}`,
      first ? { file: first.file, line: first.line, column: first.column, hint: "fix the policy, then save again" } : {},
    );
  }
}

/**
 * Validates the policies of an artifact's files (manifest.json and
 * policies/**) against the merged schema with `renox-worker
 * check-policies`, and evaluates `cases` with the resulting engine.
 * Returns the diagnostics (empty when valid) and one result per case.
 */
export async function checkPolicies(
  files: ReadonlyMap<string, Uint8Array>,
  cases: readonly PolicyCase[] = [],
  worker = workerPath(),
  explain = false,
): Promise<{ errors: PolicyDiagnostic[]; results: PolicyResult[] }> {
  const dec = new TextDecoder();
  const manifest = files.get("manifest.json");
  if (!manifest) throw new ValidationError("check-policies: no manifest.json");
  const policies: Record<string, string> = {};
  for (const [p, b] of files) if (p.startsWith("policies/")) policies[p] = dec.decode(b);
  // A resource without an `id` names a kind of resource, not an entity:
  // the case is a resource-less check (`r-can` without `:resource`).
  const wire = cases.map((c) => (c.resource !== undefined && c.resource.id === undefined ? { ...c, resource: undefined } : c));
  const parsed = JSON.parse(dec.decode(manifest)) as Record<string, unknown>;
  const input = { manifest: parsed, policies, cases: wire, explain, columns: entityColumns(files, parsed) };
  const p = Bun.spawn([worker, "check-policies"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(JSON.stringify(input));
  await p.stdin.end();
  const [text, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new ValidationError(`renox-worker check-policies failed (exit code ${code}): ${err.trim()}`);
  const out = JSON.parse(text) as { errors: PolicyDiagnostic[]; results?: PolicyResult[] };
  return { errors: out.errors, results: out.results ?? [] };
}

/**
 * The declared columns of every `[authz.entities]` table (#292): the
 * artifact's migrations applied in an in-memory SQLite in deployment order
 * (the modules', then the app's), then `pragma table_info`. The cell types
 * entity attributes from the tenant's real tables; this gives `renox check`
 * and `renox test` the same types without a database. A migration that
 * does not apply here is skipped: its tables stay untyped (`String`).
 */
export function entityColumns(files: ReadonlyMap<string, Uint8Array>, manifest: Record<string, unknown>): Record<string, Record<string, string>> {
  const blocks: AuthzBlock[] = [];
  if (manifest.authz) blocks.push(manifest.authz as AuthzBlock);
  const modules = Array.isArray(manifest.modules) ? (manifest.modules as { name?: string; authz?: AuthzBlock }[]) : [];
  for (const m of modules) if (m.authz) blocks.push(m.authz);
  const tables = new Set<string>();
  for (const b of blocks) for (const e of Object.values(b.entities ?? {})) if (typeof (e as { table?: unknown }).table === "string") tables.add((e as { table: string }).table);
  if (tables.size === 0) return {};
  const dec = new TextDecoder();
  const db = new Database(":memory:");
  try {
    for (const owner of [...modules.map((m) => m.name ?? ""), "app"]) {
      const prefix = `migrations/${owner}/`;
      const sql = [...files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith(".sql")).sort();
      for (const p of sql) {
        try {
          db.exec(dec.decode(files.get(p)));
        } catch {
          // Not applicable here (an extension, a module's view of another): untyped.
        }
      }
    }
    const out: Record<string, Record<string, string>> = {};
    for (const t of tables) {
      const cols = db.query("select name, type from pragma_table_info(?)").all(t) as { name: string; type: string }[];
      if (cols.length) out[t] = Object.fromEntries(cols.map((c) => [c.name, c.type]));
    }
    return out;
  } finally {
    db.close();
  }
}

/** Reads `policies/tests/*.json` of a project (an array, or `{ cases: [...] }` per file). */
export function readPolicyCases(project: string): { file: string; cases: PolicyCase[] }[] {
  const dir = join(project, "policies", "tests");
  if (!existsSync(dir)) return [];
  const out: { file: string; cases: PolicyCase[] }[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { cases?: unknown[] }).cases;
    const ok = (c: PolicyCase): boolean =>
      typeof c === "object" && c !== null && typeof c.action === "string" && typeof c.principal?.type === "string" && typeof c.principal?.id === "string" && (c.expected === "allow" || c.expected === "deny");
    if (!Array.isArray(list) || !list.every((c) => ok(c as PolicyCase))) {
      throw new ValidationError(`policies/tests/${f}: expected [{ principal: { type, id, roles? }, action, resource?, expected: "allow" | "deny" }]`, { file: `policies/tests/${f}` });
    }
    out.push({ file: `policies/tests/${f}`, cases: list as PolicyCase[] });
  }
  return out;
}
