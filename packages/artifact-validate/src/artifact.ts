// Artifact rules V1-V22 (versions 0, 1 and 1.1) (docs/contracts/artifact.md section 6) on an artifact
// held in memory as path -> bytes. One implementation for `renox check`, the
// control plane's upload validation (#52), and the contract examples.

import manifestSchema from "../../../docs/contracts/schemas/manifest.schema.json";
import checksumsSchema from "../../../docs/contracts/schemas/migrations-checksums.schema.json";
import publicSchema from "../../../docs/contracts/schemas/public-manifest.schema.json";
import routeTableSchema from "../../../docs/contracts/schemas/route-table.schema.json";
import { contentHash, sha256Hex } from "./hash.ts";
import { pathProblem } from "./paths.ts";
import { isObject, unsupportedKeywords, validate, type Json, type JsonObject } from "./schema.ts";

/** One broken rule: never a filesystem path of the machine doing the check. */
export interface Violation {
  rule: string;
  path?: string;
  field?: string;
  reason: string;
}

export const MAX_CODE_BYTES = 20 * 1024 * 1024; // V5, docs/04-isolation-security.md "Bundle size"
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024; // V5
export const MAX_ARTIFACT_FILES = 10_000; // V5

/** Per-request limits of a tier (docs/04-isolation-security.md "Per-tenant limits"), for V10. */
export interface TierLimits {
  cpu_ms: number;
  wall_ms: number;
  memory_mb: number;
  concurrency: number;
}

export const TIERS: Record<"free" | "paid", TierLimits> = {
  free: { cpu_ms: 50, wall_ms: 30_000, memory_mb: 128, concurrency: 50 },
  paid: { cpu_ms: 500, wall_ms: 60_000, memory_mb: 512, concurrency: 500 },
};

export interface CheckOptions {
  /** V2: the hash the artifact must have (its directory name, or the upload header). */
  expectedHash?: string;
  /** V10: the tenant's tier limits. Omitted: V10 is not checked (renox check without a tenant). */
  tier?: TierLimits;
  /** The app the artifact must belong to (deploy-api.md section 3, checked as V3). */
  app?: string;
}

export interface CheckResult {
  hash: string;
  /** The manifest when it is valid JSON that passed the schema, else null. */
  manifest: JsonObject | null;
  /** Total bytes of all files. */
  sizeBytes: number;
  violations: Violation[];
}

type Segment = { kind: "static" | "param" | "catchall"; text: string };

function parsePattern(path: string): Segment[] {
  if (path === "/") return [];
  return path
    .slice(1)
    .split("/")
    .map((s) => {
      if (s.startsWith(":")) return { kind: "param", text: s.slice(1) };
      if (s.startsWith("*")) return { kind: "catchall", text: s.slice(1) };
      return { kind: "static", text: s };
    });
}

const schemaViolations = (rule: string, schema: Json, doc: Json, what: string): Violation[] =>
  validate(schema, doc).map((e) => {
    const [where, ...rest] = e.split(": ");
    return { rule, field: `${what}${(where ?? "$").slice(1)}`, reason: rest.join(": ") };
  });

/** The methods a route answers: its own for a function, GET and HEAD (and POST with actions) for a page, GET for ws and sse (1.3). */
function routeMethods(route: JsonObject): string[] {
  if (route.kind === "ws" || route.kind === "sse") return ["GET"];
  if (route.kind === "webhook") return ["POST"];
  if (route.kind !== "page") return [route.method as string];
  const actions = (route.actions as string[] | undefined) ?? [];
  return actions.length > 0 ? ["GET", "HEAD", "POST"] : ["GET", "HEAD"];
}

/** Version 1.3: tool and job routes have no path (#304); everything else takes part in matching. */
const hasPath = (route: JsonObject): boolean => route.kind !== "tool" && route.kind !== "job";

/** Version 1.3: the module-id prefix a route kind requires (V7), for the app and for a module. */
function routePrefix(kind: string, owner: string): string {
  switch (kind) {
    case "page":
      return "pages/";
    case "ws":
      return "functions/ws/";
    case "sse":
      return "functions/sse/";
    case "tool":
      return owner === "app" ? "functions/tools/" : "tools/";
    case "job":
      return "jobs/";
    case "webhook":
      return "functions/webhooks/";
    default:
      return "functions/";
  }
}

/** The exports a route needs in its module's `entries` record (V23). */
function routeExports(route: JsonObject): string[] {
  const need: string[] = [];
  if (route.kind === "function" && typeof route.export === "string") need.push(route.export);
  if (route.kind === "page") {
    if (route.load === true) need.push("load");
    if (Array.isArray(route.actions) && route.actions.length > 0) need.push("actions");
  }
  if (route.kind === "ws" || route.kind === "sse") need.push(route.kind as string);
  if (route.kind === "tool") need.push("default");
  if (route.kind === "webhook") need.push("POST");
  if (route.kind === "job") need.push("run", "schedule");
  if (isObject(route.guard)) need.push("guard");
  return need;
}

// artifact.md 1.3: the platform actions every app may name in a guard, a tool or a policy.
const PLATFORM_ACTIONS = ["realtime.subscribe"];
const RESERVED_PATHS = ["/mcp", "/.well-known/oauth-protected-resource/mcp"];
const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});

/** V27: a five-field cron expression with numbers, `*`, lists, ranges and steps (ops.md section 20). */
export function cronProblem(expr: string): string | null {
  const fields = expr.split(" ");
  if (fields.length !== 5) return `${fields.length} fields, expected 5`;
  const bounds: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  for (const [i, field] of fields.entries()) {
    const [lo, hi] = bounds[i] as [number, number];
    for (const item of field.split(",")) {
      const m = /^(\*|([0-9]+)(?:-([0-9]+))?)(?:\/([0-9]+))?$/u.exec(item);
      if (m === null) return `field ${i + 1}: "${item}" is not a number, a range, * or a step`;
      if (m[2] !== undefined) {
        const a = Number(m[2]);
        const b = m[3] === undefined ? a : Number(m[3]);
        if (a < lo || b > hi || a > b) return `field ${i + 1}: "${item}" is outside ${lo}-${hi}`;
      }
      if (m[4] !== undefined && Number(m[4]) < 1) return `field ${i + 1}: a step is at least 1`;
    }
  }
  return null;
}

/** Version 1.1: ids of an installed module start with modules/<name>/; every other id is the app's. */
const MODULE_PREFIX = /^modules\/([a-z][a-z0-9_]{0,31})\//u;
const ownerOf = (id: string | undefined): string => (id === undefined ? null : MODULE_PREFIX.exec(id))?.[1] ?? "app";
const localId = (id: string): string => id.replace(MODULE_PREFIX, "");

/** manifest.md MF1, applied by V17: the reason `name` cannot be an installed module, or null. */
function moduleNameProblem(name: string): string | null {
  if (name.includes("__")) return 'contains "__"';
  if (name.endsWith("_")) return 'ends with "_"';
  // MF1: `app` is the tenant's code, `renox` the platform, `authz` the platform's event namespace (`authz.roles_changed`, #272).
  if (name === "app" || name === "renox" || name === "authz") return "is reserved (MF1)";
  return null;
}

const strings = (v: Json | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The installed modules of a version 1.1 manifest, by name (an empty map for versions 0 and 1). */
const installed = (manifest: JsonObject): Map<string, JsonObject> =>
  new Map((Array.isArray(manifest.modules) ? (manifest.modules as JsonObject[]) : []).map((m) => [m.name as string, m]));

/** V17, V18, V21 (mounts), V22 on the modules, slots, and module-owned ids of a manifest that passed the schema. */
function moduleRules(manifest: JsonObject): Violation[] {
  const out: Violation[] = [];
  const entries = Array.isArray(manifest.modules) ? (manifest.modules as JsonObject[]) : [];
  const listed = new Map<string, JsonObject>();
  entries.forEach((m, i) => {
    const field = `modules[${i}]`;
    const name = m.name as string;
    const problem = moduleNameProblem(name);
    if (problem !== null) out.push({ rule: "V17", field, reason: `name "${name}" ${problem}` });
    if (listed.has(name)) out.push({ rule: "V17", field, reason: `"${name}" is listed twice` });
    for (const dep of strings(m.dependencies)) {
      if (!listed.has(dep)) out.push({ rule: "V17", field, reason: `${name} depends on ${dep}, which is not listed before it` });
    }
    for (const which of ["permissions", "approved"]) {
      const p = m[which] as JsonObject;
      if (p.tables !== undefined && p.tables !== `${name}__*`) out.push({ rule: "V17", field: `${field}.${which}.tables`, reason: `"${p.tables}" is not "${name}__*"` });
      for (const secret of strings(p.secrets)) {
        if (!secret.startsWith(`${name.toUpperCase()}_`)) out.push({ rule: "V17", field: `${field}.${which}.secrets`, reason: `"${secret}" does not start with ${name.toUpperCase()}_` });
      }
    }
    const permissions = m.permissions as JsonObject;
    const approved = m.approved as JsonObject;
    if (permissions.tables !== undefined && permissions.tables !== approved.tables) {
      out.push({ rule: "V22", field: `${field}.permissions.tables`, reason: `"${permissions.tables}" was not approved` });
    }
    for (const key of ["network", "secrets", "slots", "hooks"]) {
      const allowed = new Set(strings(approved[key]));
      for (const v of strings(permissions[key])) if (!allowed.has(v)) out.push({ rule: "V22", field: `${field}.permissions.${key}`, reason: `"${v}" was not approved` });
    }
    listed.set(name, m);
  });

  const entry = (manifest.code as JsonObject).entry as JsonObject;
  for (const [id, path] of Object.entries(entry)) {
    const owner = ownerOf(id);
    if (owner === "app") {
      if ((path as string).startsWith("modules/")) out.push({ rule: "V18", field: `code.entry.${id}`, reason: `an app module may not live under code/modules/` });
    } else if (!listed.has(owner)) out.push({ rule: "V18", field: `code.entry.${id}`, reason: `module "${owner}" is not in modules` });
    else if (!(path as string).startsWith(`modules/${owner}/`)) out.push({ rule: "V18", field: `code.entry.${id}`, reason: `code/${path} is not under code/modules/${owner}/` });
  }
  for (const [name, m] of listed) {
    if (strings((m.exports as JsonObject).services).length > 0 && !(`modules/${name}/services` in entry)) {
      out.push({ rule: "V18", field: "code.entry", reason: `${name} exports services but has no modules/${name}/services entry` });
    }
  }
  const templates = (isObject(manifest.templates) ? manifest.templates : {}) as Record<string, JsonObject>;
  for (const id of Object.keys(templates)) {
    const owner = ownerOf(id);
    if (owner !== "app" && !listed.has(owner)) out.push({ rule: "V18", field: `templates.${id}`, reason: `module "${owner}" is not in modules` });
  }
  for (const [slot, fills] of Object.entries(isObject(manifest.slots) ? manifest.slots : {})) {
    (fills as JsonObject[]).forEach((f, i) => {
      const field = `slots.${slot}[${i}]`;
      const m = listed.get(f.module as string);
      if (m === undefined) return void out.push({ rule: "V18", field, reason: `module "${f.module}" is not in modules` });
      const template = f.template as string;
      if (ownerOf(template) !== f.module) out.push({ rule: "V18", field, reason: `template "${template}" is not under modules/${f.module}/` });
      else if (templates[template]?.kind !== "partial") out.push({ rule: "V18", field, reason: `template "${template}" is not a partial of templates` });
      if (!strings((m.permissions as JsonObject).slots).includes(slot)) out.push({ rule: "V22", field, reason: `${f.module} does not have the slot "${slot}" in its permissions` });
    });
  }
  (manifest.routes as JsonObject[]).forEach((route, i) => {
    const owner = ownerOf((route.module ?? route.template) as string | undefined);
    if (owner === "app") return;
    const m = listed.get(owner);
    if (m === undefined) return void out.push({ rule: "V18", field: `routes[${i}]`, reason: `module "${owner}" is not in modules` });
    if (!hasPath(route)) return;
    const mount = m.mount as string;
    const path = route.path as string;
    if (mount !== "/" && path !== mount && !path.startsWith(`${mount}/`)) out.push({ rule: "V21", field: `routes[${i}]`, reason: `${path} is not under ${owner}'s mount ${mount}` });
  });
  return out;
}

/** V14: a template's kind follows from its id (a module's ids are read without their modules/<name>/ prefix). */
function templateKindProblem(fullId: string, kind: string): string | null {
  const id = localId(fullId);
  const last = id.split("/").pop() as string;
  const expected = id.startsWith("partials/")
    ? "partial"
    : id.startsWith("pages/_layouts/")
      ? "layout"
      : id === "pages/_error"
        ? "error"
        : id === "pages/_404"
          ? "not_found"
          : last.startsWith("_")
            ? null
            : "page";
  if (expected === null) return `"${fullId}" is not a page, layout, partial, error, or 404 template`;
  return kind === expected ? null : `"${fullId}" must have kind "${expected}", not "${kind}"`;
}

/** V4, V7, V8, V9, V14 (kinds), V15, V16, V17, V18, V21, V22 (and V10 with a tier) on a manifest that passed the schema. */
export function manifestRules(manifest: JsonObject, tier?: TierLimits): Violation[] {
  const out: Violation[] = [];
  const app = manifest.app as JsonObject;
  const code = manifest.code as JsonObject;
  const entry = code.entry as JsonObject;
  const routes = manifest.routes as JsonObject[];
  const permissions = manifest.permissions as JsonObject;
  const templates = (isObject(manifest.templates) ? manifest.templates : {}) as Record<string, JsonObject>;
  const security = (isObject(manifest.security) ? manifest.security : {}) as Record<string, Json>;

  try {
    new Intl.DateTimeFormat("en", { timeZone: app.timezone as string });
  } catch {
    out.push({ rule: "V4", field: "app.timezone", reason: `"${app.timezone}" is not an IANA time zone` });
  }

  const used = new Set<string>();
  const shapes = new Map<string, number>();
  const pageTemplates = new Map<string, number>();
  routes.forEach((route, i) => {
    const field = `routes[${i}]`;
    const page = route.kind === "page";
    const kind = route.kind as string;
    const where = page ? `page ${route.path}` : hasPath(route) ? `${(route.method as string | undefined) ?? kind.toUpperCase()} ${route.path}` : `${kind} ${route.name}`;
    const module = route.module as string | undefined;
    if (module !== undefined) {
      used.add(module);
      if (!(module in entry)) out.push({ rule: "V7", field, reason: `${where}: module "${module}" is not a key of code.entry` });
      const prefix = routePrefix(kind, ownerOf(module));
      if (!localId(module).startsWith(prefix)) out.push({ rule: "V7", field, reason: `${where}: module "${module}" must be under ${prefix}` });
    }
    if (kind === "function" && route.export !== route.method) {
      out.push({ rule: "V7", field, reason: `${where}: export "${route.export}" must equal the method` });
    }
    // Tool and job routes have no path (artifact 1.3): V8 and V21 do not apply; V25 and V27 check them below.
    if (!hasPath(route)) return;
    const path = route.path as string;
    if (RESERVED_PATHS.includes(path) || path.startsWith("/.well-known/oauth-protected-resource/")) {
      out.push({ rule: "V21", field, reason: `${where}: the path is reserved for the cell (ops.md section 19)` });
    }
    if (page) {
      const load = route.load === true;
      const actions = (route.actions as string[] | undefined) ?? [];
      const template = route.template as string | undefined;
      const htmlOnly = module === undefined && !load && actions.length === 0 && template !== undefined;
      const tsOnly = module !== undefined && load && template === undefined;
      const pair = module !== undefined && template !== undefined;
      if (!(htmlOnly || tsOnly || pair)) {
        out.push({ rule: "V15", field, reason: `${where}: module/load/actions/template is not an .html-only, .ts-only, or .ts + .html page` });
      }
      if (template !== undefined) {
        const t = templates[template];
        if (t === undefined) out.push({ rule: "V15", field, reason: `${where}: template "${template}" is not a key of templates` });
        else if (t.kind !== "page") out.push({ rule: "V15", field, reason: `${where}: template "${template}" has kind "${t.kind}", not "page"` });
        pageTemplates.set(template, (pageTemplates.get(template) ?? 0) + 1);
      }
    }
    const segments = parsePattern(route.path as string);
    const names = new Set<string>();
    segments.forEach((s, j) => {
      if (s.kind === "catchall" && j !== segments.length - 1) out.push({ rule: "V8", field, reason: `${where}: catch-all is not the last segment` });
      if (s.kind !== "static") {
        if (names.has(s.text)) out.push({ rule: "V8", field, reason: `${where}: parameter "${s.text}" appears twice` });
        names.add(s.text);
      }
    });
    const pattern = `/${segments.map((s) => (s.kind === "static" ? `s:${s.text}` : s.kind)).join("/")}`;
    for (const method of routeMethods(route)) {
      const shape = `${method} ${pattern}`;
      const previous = shapes.get(shape);
      if (previous !== undefined) {
        // Routes of different owners (the app, installed modules) collide after mounting: V21.
        const other = routes[previous] as JsonObject;
        const rule = ownerOf((other.module ?? other.template) as string | undefined) === ownerOf(module ?? (route.template as string | undefined)) ? "V8" : "V21";
        out.push({ rule, field, reason: `${where} conflicts with routes[${previous}] for ${method}` });
        break;
      }
      shapes.set(shape, i);
    }
  });
  for (const key of Object.keys(entry)) {
    // A module's services and hooks entries are loaded by the bootstrap, not by a route.
    if (!used.has(key) && !/^modules\/[a-z][a-z0-9_]{0,31}\/(services|hooks)$/u.test(key)) out.push({ rule: "V7", field: `code.entry.${key}`, reason: "not used by any route" });
  }

  for (const [id, t] of Object.entries(templates)) {
    const problem = templateKindProblem(id, t.kind as string);
    if (problem !== null) out.push({ rule: "V14", field: `templates.${id}`, reason: problem });
    if (t.kind === "page") {
      const count = pageTemplates.get(id) ?? 0;
      if (count !== 1) out.push({ rule: "V15", field: `templates.${id}`, reason: `page template used by ${count} page routes, expected 1` });
      const targets = new Set<string>();
      for (const [name, fragment] of Object.entries((t.fragments as JsonObject | undefined) ?? {})) {
        const target = (fragment as JsonObject).target;
        if (typeof target !== "string") continue;
        if (targets.has(target)) out.push({ rule: "V15", field: `templates.${id}`, reason: `fragment "${name}" repeats target "${target}"` });
        targets.add(target);
      }
    }
  }

  const csp = (isObject(security.csp) ? security.csp : {}) as Record<string, Json>;
  for (const [key, sources] of Object.entries(csp)) {
    if (!Array.isArray(sources)) continue;
    for (const s of sources) {
      if (s !== "'unsafe-inline'" && s !== "'unsafe-eval'") continue;
      if (csp.allow_unsafe !== true) out.push({ rule: "V16", field: `security.csp.${key}`, reason: `${s} requires csp.allow_unsafe = true` });
      if (key !== "script_src" && key !== "style_src") out.push({ rule: "V16", field: `security.csp.${key}`, reason: `${s} is allowed only in script_src and style_src` });
    }
  }
  const cors = (isObject(security.cors) ? security.cors : {}) as Record<string, Json>;
  if (cors.credentials === true && (!Array.isArray(cors.origins) || cors.origins.length === 0)) {
    out.push({ rule: "V16", field: "security.cors", reason: "credentials requires a non-empty cors.origins" });
  }
  const answered = new Set(routes.filter(hasPath).flatMap((r) => routeMethods(r).map((m) => `${m} ${r.path}`)));
  const buckets = new Set<string>();
  ((security.ratelimit as JsonObject[] | undefined) ?? []).forEach((b, i) => {
    const key = `${b.method} ${b.path}`;
    if (!answered.has(key)) out.push({ rule: "V16", field: `security.ratelimit[${i}]`, reason: `no route answers ${key}` });
    const bucket = `${key} ${b.key}`;
    if (buckets.has(bucket)) out.push({ rule: "V16", field: `security.ratelimit[${i}]`, reason: `duplicate bucket ${bucket}` });
    buckets.add(bucket);
  });

  (permissions.network as string[]).forEach((host, i) => {
    const port = /:([0-9]+)$/u.exec(host.replace(/^http:\/\//u, ""))?.[1];
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
      out.push({ rule: "V9", field: `permissions.network[${i}]`, reason: `"${host}": port out of range` });
    }
  });

  out.push(...moduleRules(manifest));
  out.push(...entriesRules(manifest));
  out.push(...authzRules(manifest));
  out.push(...webhookStorageRules(manifest));

  if (tier !== undefined && isObject(manifest.limits)) {
    for (const [key, value] of Object.entries(manifest.limits)) {
      const max = tier[key as keyof TierLimits];
      if (typeof value === "number" && max !== undefined && value > max) {
        out.push({ rule: "V10", field: `limits.${key}`, reason: `${value} is above the tier's ${max}` });
      }
    }
  }
  return out;
}

/** V3 (schema) and the manifest rules on a parsed manifest.json. */
/**
 * V23 (version 1.2): `entries` names exactly the `code.entry` ids; each route's
 * handler is among its module's recorded exports; a module's `services` entry
 * exports every service of `exports.services`, and the `services` and `hooks`
 * entries stay eager (ops.md 1.4.0 section 11).
 */
function entriesRules(manifest: JsonObject): Violation[] {
  if (!isObject(manifest.entries)) return [];
  const out: Violation[] = [];
  const version = (manifest.artifact as JsonObject).version;
  if (version !== 1) out.push({ rule: "V23", field: "entries", reason: `needs artifact.version 1 (version 1.2), got ${version}` });
  const entries = manifest.entries as Record<string, JsonObject>;
  const code = (manifest.code as JsonObject).entry as JsonObject;
  for (const id of Object.keys(code)) if (!(id in entries)) out.push({ rule: "V23", field: `code.entry.${id}`, reason: "has no entries record" });
  for (const id of Object.keys(entries)) if (!(id in code)) out.push({ rule: "V23", field: `entries.${id}`, reason: "is not a key of code.entry" });
  const exportsOf = (id: string): string[] => strings(entries[id]?.exports);
  (manifest.routes as JsonObject[]).forEach((route, i) => {
    const id = route.module as string | undefined;
    if (id === undefined || !(id in entries)) return;
    for (const name of routeExports(route)) if (!exportsOf(id).includes(name)) out.push({ rule: "V23", field: `routes[${i}]`, reason: `module "${id}" does not export "${name}"` });
  });
  for (const m of Array.isArray(manifest.modules) ? (manifest.modules as JsonObject[]) : []) {
    for (const part of ["services", "hooks"]) {
      const id = `modules/${m.name}/${part}`;
      if (entries[id]?.eager === false) out.push({ rule: "V23", field: `entries.${id}`, reason: "must be eager (hooks and services are checked at isolate creation)" });
    }
    const id = `modules/${m.name}/services`;
    if (id in entries) for (const s of strings(obj(m.exports).services)) if (!exportsOf(id).includes(s)) out.push({ rule: "V23", field: `entries.${id}`, reason: `does not export service "${s}"` });
  }
  return out;
}

/**
 * V25 (references of an authz block, guards, tools), V26 (the single-file part:
 * ownership and feed tables under the owner's prefix, feed topics) and V27
 * (job schedules) on a manifest that passed the schema; the migration part of
 * V26 is in checkArtifactFiles. A tool route carries its `name` (unique across
 * the app and its modules) and a job route its `name` (unique per owner) and
 * `schedule` instead of a path (#304).
 */
function authzRules(manifest: JsonObject): Violation[] {
  const out: Violation[] = [];
  const owners: [string, JsonObject, JsonObject][] = [["app", obj(manifest.authz), obj(manifest.realtime)]];
  for (const m of Array.isArray(manifest.modules) ? (manifest.modules as JsonObject[]) : []) owners.push([m.name as string, obj(m.authz), obj(m.realtime)]);
  const actions = new Set(PLATFORM_ACTIONS);
  for (const [, authz] of owners) for (const a of strings(authz.actions)) actions.add(a);
  const entities = new Map<string, Set<string>>();
  for (const [owner, authz, realtime] of owners) {
    const prefix = `${owner}__`;
    const own = new Set(strings(authz.actions));
    for (const a of strings(authz.sensitive)) if (!own.has(a)) out.push({ rule: "V25", field: `${owner}.authz.sensitive`, reason: `"${a}" is not one of its actions` });
    for (const [role, acts] of Object.entries(obj(authz.default_roles))) {
      for (const a of strings(acts)) if (!actions.has(a)) out.push({ rule: "V25", field: `${owner}.authz.default_roles.${role}`, reason: `"${a}" is not in the merged action set` });
    }
    entities.set(owner, new Set(Object.keys(obj(authz.entities))));
    for (const [type, decl] of Object.entries(obj(authz.entities))) {
      const table = obj(decl).table;
      if (typeof table === "string" && !table.startsWith(prefix)) out.push({ rule: "V25", field: `${owner}.authz.entities.${type}.table`, reason: `"${table}" is not under ${prefix}` });
    }
    for (const table of Object.keys(obj(authz.ownership))) if (!table.startsWith(prefix)) out.push({ rule: "V25", field: `${owner}.authz.ownership`, reason: `"${table}" is not under ${prefix}` });
    for (const [table, pattern] of Object.entries(obj(realtime.feeds))) {
      if (!table.startsWith(prefix)) out.push({ rule: "V26", field: `${owner}.realtime.feeds`, reason: `"${table}" is not under ${prefix}` });
      const topic = String(pattern).replace(/\{[a-z][a-z0-9_]{0,63}\}/gu, "x");
      if (!/^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)*$/u.test(topic)) out.push({ rule: "V26", field: `${owner}.realtime.feeds.${table}`, reason: `"${pattern}" is not a topic` });
    }
  }
  const toolNames = new Set<string>();
  const jobNames = new Set<string>();
  (manifest.routes as JsonObject[]).forEach((route, i) => {
    const owner = ownerOf((route.module ?? route.template) as string | undefined);
    const field = `routes[${i}]`;
    const guard = route.guard;
    if (isObject(guard)) {
      if (!actions.has(guard.action as string)) out.push({ rule: "V25", field, reason: `guard.action "${guard.action}" is not in the merged action set` });
      const resource = guard.resource;
      if (isObject(resource)) {
        const type = resource.type as string;
        const [typeOwner, typeName] = type.includes(":") ? (type.split(":") as [string, string]) : [owner, type];
        if (!(entities.get(typeOwner)?.has(typeName) ?? false)) out.push({ rule: "V25", field, reason: `guard.resource.type "${type}" is not a declared entity of ${typeOwner}` });
        const id = resource.id as string;
        if (id.startsWith(":") && !(hasPath(route) && parsePattern(route.path as string).some((s) => s.kind !== "static" && s.text === id.slice(1)))) {
          out.push({ rule: "V25", field, reason: `guard.resource.id "${id}" names no parameter of ${String(route.path)}` });
        }
      }
    }
    if (route.kind === "tool") {
      const name = route.name as string;
      if (toolNames.has(name)) out.push({ rule: "V25", field, reason: `tool "${name}" is declared twice` });
      toolNames.add(name);
      if (!actions.has(route.action as string)) out.push({ rule: "V25", field, reason: `tool "${name}": action "${route.action}" is not in the merged action set` });
      for (const p of unsupportedKeywords(route.input as Json)) out.push({ rule: "V25", field, reason: `tool "${name}" input ${p}` });
    }
    if (route.kind === "job") {
      const key = `${owner} ${route.name}`;
      if (jobNames.has(key)) out.push({ rule: "V27", field, reason: `job "${route.name}" of ${owner} is declared twice` });
      jobNames.add(key);
      const problem = cronProblem(route.schedule as string);
      if (problem !== null) out.push({ rule: "V27", field, reason: `job "${route.name}": schedule "${route.schedule}": ${problem}` });
      if (typeof route.tz === "string") {
        try {
          new Intl.DateTimeFormat("en", { timeZone: route.tz });
        } catch {
          out.push({ rule: "V27", field, reason: `job "${route.name}": tz "${route.tz}" is not an IANA time zone` });
        }
      }
    }
  });
  return out;
}

export function checkManifest(manifest: Json, tier?: TierLimits): Violation[] {
  const schemaErrors = schemaViolations("V3", manifestSchema as Json, manifest, "");
  if (schemaErrors.length > 0 || !isObject(manifest)) return schemaErrors;
  return manifestRules(manifest, tier);
}

/** V1-V12, V14-V29 (V10 when `options.tier` is set) on an artifact held as path -> bytes. */
export function checkArtifactFiles(files: ReadonlyMap<string, Uint8Array>, options: CheckOptions = {}): CheckResult {
  const out: Violation[] = [];
  const hash = contentHash(files);
  let sizeBytes = 0;
  for (const bytes of files.values()) sizeBytes += bytes.length;
  const result = (manifest: JsonObject | null): CheckResult => ({ hash, manifest, sizeBytes, violations: out });

  for (const path of files.keys()) {
    const problem = pathProblem(path);
    if (problem !== null) out.push({ rule: "V1", path, reason: problem });
  }

  if (options.expectedHash !== undefined && options.expectedHash !== hash) {
    out.push({ rule: "V2", reason: `the content hash is ${hash}, not ${options.expectedHash}` });
  }

  const text = (path: string): string => new TextDecoder().decode(files.get(path));
  if (!files.has("manifest.json")) {
    out.push({ rule: "V3", path: "manifest.json", reason: "missing" });
    return result(null);
  }
  let manifest: Json;
  try {
    manifest = JSON.parse(text("manifest.json")) as Json;
  } catch {
    out.push({ rule: "V3", path: "manifest.json", reason: "not JSON" });
    return result(null);
  }
  const version = isObject(manifest) && isObject(manifest.artifact) && typeof manifest.artifact.version === "number" ? manifest.artifact.version : 0;
  // Version 1.1: policies/, overrides/ and overrides.json belong to installed modules.
  const withModules = version >= 1 && isObject(manifest) && Array.isArray(manifest.modules) && manifest.modules.length > 0;
  const folded = new Map<string, string>();
  for (const path of files.keys()) {
    const key = path.toLowerCase();
    const other = folded.get(key);
    if (other !== undefined) out.push({ rule: "V1", path, reason: `differs from ${other} only in case` });
    folded.set(key, path);
    const top = path.split("/")[0] as string;
    if (withModules && (top === "overrides" || path === "overrides.json")) continue;
    if (top === "policies") {
      // Version 1.3: the app's own policy set and schema (V24); version 1.1: a listed module's files (V18).
      if (version === 0) out.push({ rule: "V1", path, reason: "policies/ must be absent in version 0" });
      continue;
    } else if (version === 0 && (top === "templates" || path === "public.json")) {
      out.push({ rule: "V1", path, reason: `${top === "templates" ? "templates/" : "public.json"} must be absent in version 0` });
    } else if (path === "sbom.cdx.json") {
      // Version 1.4: the optional SBOM (V29 checks its header below).
      if (version === 0) out.push({ rule: "V1", path, reason: "sbom.cdx.json must be absent in version 0" });
    } else if (!(path === "manifest.json" || path === "public.json" || (["code", "migrations", "public", "templates"].includes(top) && path.includes("/")))) {
      out.push({ rule: "V1", path, reason: "not an allowed top-level entry" });
    }
  }

  const manifestErrors = checkManifest(manifest, options.tier);
  out.push(...manifestErrors);
  if (!isObject(manifest) || manifestErrors.some((v) => v.rule === "V3")) return result(null);
  if (options.app !== undefined && (manifest.app as JsonObject).name !== options.app) {
    out.push({ rule: "V3", field: "app.name", reason: `"${(manifest.app as JsonObject).name}" is not the app "${options.app}"` });
  }

  if (files.has("sbom.cdx.json")) {
    let sbom: Json = null;
    try {
      sbom = JSON.parse(text("sbom.cdx.json")) as Json;
    } catch {
      // Reported below as not a CycloneDX document.
    }
    if (!isObject(sbom) || sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5") out.push({ rule: "V29", path: "sbom.cdx.json", reason: "not a CycloneDX 1.5 JSON document" });
  }

  let codeBytes = 0;
  for (const [path, bytes] of files) if (path.startsWith("code/")) codeBytes += bytes.length;
  if (codeBytes > MAX_CODE_BYTES) out.push({ rule: "V5", path: "code/", reason: `${codeBytes} bytes, limit ${MAX_CODE_BYTES}` });
  if (sizeBytes > MAX_ARTIFACT_BYTES) out.push({ rule: "V5", reason: `artifact is ${sizeBytes} bytes, limit ${MAX_ARTIFACT_BYTES}` });
  if (files.size > MAX_ARTIFACT_FILES) out.push({ rule: "V5", reason: `${files.size} files, limit ${MAX_ARTIFACT_FILES}` });

  const code = manifest.code as JsonObject;
  const codeFiles = [...files.keys()].filter((p) => p.startsWith("code/")).map((p) => p.slice("code/".length));
  if (code.format === "eszip") {
    if (codeFiles.length !== 1 || codeFiles[0] !== "bundle.eszip") {
      out.push({ rule: "V6", path: "code/", reason: "code.format eszip requires code/ to hold only bundle.eszip" });
    }
  } else {
    for (const p of codeFiles) if (!/\.(js|mjs|json)$/u.test(p)) out.push({ rule: "V6", path: `code/${p}`, reason: "esm-dir holds .js, .mjs, .json only" });
    for (const [id, path] of Object.entries(code.entry as JsonObject)) {
      if (!codeFiles.includes(path as string)) out.push({ rule: "V6", field: `code.entry.${id}`, reason: `code/${path} does not exist` });
    }
  }

  const migrations = [...files.keys()].filter((p) => p.startsWith("migrations/"));
  if (migrations.length > 0) {
    if (!files.has("migrations/checksums.json")) out.push({ rule: "V11", path: "migrations/checksums.json", reason: "missing" });
    else {
      let checksums: Json = null;
      try {
        checksums = JSON.parse(text("migrations/checksums.json")) as Json;
      } catch {
        out.push({ rule: "V11", path: "migrations/checksums.json", reason: "not JSON" });
      }
      out.push(...schemaViolations("V11", checksumsSchema as Json, checksums, "migrations/checksums.json"));
      const listed = isObject(checksums) && isObject(checksums.files) ? checksums.files : {};
      const sql = migrations.filter((p) => p !== "migrations/checksums.json").map((p) => p.slice("migrations/".length));
      const numbers = new Map<string, number[]>();
      for (const p of sql) {
        const m = /^([a-z][a-z0-9_]{0,31})\/([0-9]{3})_[a-z0-9_]{1,64}\.sql$/u.exec(p);
        if (m === null) {
          out.push({ rule: "V11", path: `migrations/${p}`, reason: "not <module>/NNN_<name>.sql" });
          continue;
        }
        numbers.set(m[1] as string, [...(numbers.get(m[1] as string) ?? []), Number(m[2])]);
        if (listed[p] === undefined) out.push({ rule: "V11", path: `migrations/${p}`, reason: "not in checksums.json" });
        else if (listed[p] !== sha256Hex(files.get(`migrations/${p}`) as Uint8Array)) {
          out.push({ rule: "V11", path: `migrations/${p}`, reason: "checksum mismatch" });
        }
      }
      for (const p of Object.keys(listed)) if (!sql.includes(p)) out.push({ rule: "V11", path: `migrations/${p}`, reason: "listed in checksums.json but missing" });
      for (const [module, list] of numbers) {
        list.sort((a, b) => a - b);
        if (list.some((n, i) => n !== i + 1)) out.push({ rule: "V11", path: `migrations/${module}/`, reason: "numbering has gaps or does not start at 001" });
      }
    }
  }

  // V12: the public index is public.json in version 1 and public/manifest.json in version 0.
  const indexPath = version === 0 ? "public/manifest.json" : "public.json";
  const publicFiles = [...files.keys()].filter((p) => p.startsWith("public/"));
  if (publicFiles.length > 0 || files.has(indexPath)) {
    if (!files.has(indexPath)) out.push({ rule: "V12", path: indexPath, reason: "missing" });
    else {
      let index: Json = null;
      try {
        index = JSON.parse(text(indexPath)) as Json;
      } catch {
        out.push({ rule: "V12", path: indexPath, reason: "not JSON" });
      }
      out.push(...schemaViolations("V12", publicSchema as Json, index, indexPath));
      const listed = isObject(index) && isObject(index.files) ? index.files : {};
      const served = publicFiles.filter((p) => p !== indexPath).map((p) => p.slice("public".length));
      for (const url of served) {
        const meta = listed[url];
        const bytes = files.get(`public${url}`) as Uint8Array;
        if (!isObject(meta)) out.push({ rule: "V12", path: `public${url}`, reason: `not in ${indexPath}` });
        else if (meta.sha256 !== sha256Hex(bytes) || meta.size !== bytes.length) out.push({ rule: "V12", path: `public${url}`, reason: "hash or size mismatch" });
      }
      for (const url of Object.keys(listed)) if (!served.includes(url)) out.push({ rule: "V12", path: `public${url}`, reason: `listed in ${indexPath} but missing` });
    }
  }

  // V14: templates/ holds exactly templates/<id>.jinja for the keys of manifest.templates, as UTF-8.
  const templateIds = Object.keys(isObject(manifest.templates) ? manifest.templates : {});
  for (const p of [...files.keys()].filter((f) => f.startsWith("templates/"))) {
    const id = p.slice("templates/".length).replace(/\.jinja$/u, "");
    if (!p.endsWith(".jinja") || !templateIds.includes(id)) out.push({ rule: "V14", path: p, reason: "not a template listed in manifest.templates" });
    else {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(files.get(p));
      } catch {
        out.push({ rule: "V14", path: p, reason: "not valid UTF-8" });
      }
    }
  }
  for (const id of templateIds) if (!files.has(`templates/${id}.jinja`)) out.push({ rule: "V14", path: `templates/${id}.jinja`, reason: "missing" });

  out.push(...policyAndFeedRules(files, manifest));
  if (withModules) out.push(...moduleTreeRules(files, manifest));
  return result(manifest);
}

/**
 * V24 (version 1.3): policies/app/<name>.cedar and policies/schema.cedarschema
 * of the app, and V18: policies/<module>/<name>.cedar of a listed module; each
 * non-empty UTF-8. V26: every feed and ownership table is created by a
 * migration of its owner.
 */
function policyAndFeedRules(files: ReadonlyMap<string, Uint8Array>, manifest: JsonObject): Violation[] {
  const out: Violation[] = [];
  const listed = installed(manifest);
  const paths = [...files.keys()];
  for (const p of paths.filter((f) => f.startsWith("policies/"))) {
    const app = p === "policies/schema.cedarschema" || /^policies\/app\/[A-Za-z0-9_.-]+\.cedar$/u.test(p);
    const m = /^policies\/([a-z][a-z0-9_]{0,31})\/[A-Za-z0-9_.-]+\.cedar$/u.exec(p);
    if (!app && m === null) out.push({ rule: "V24", path: p, reason: "not policies/app/<name>.cedar, policies/schema.cedarschema, or policies/<module>/<name>.cedar" });
    else if (!app && !listed.has(m?.[1] as string)) out.push({ rule: "V18", path: p, reason: `module "${m?.[1]}" is not in modules` });
    const bytes = files.get(p) as Uint8Array;
    if (bytes.length === 0) out.push({ rule: "V24", path: p, reason: "empty" });
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      out.push({ rule: "V24", path: p, reason: "not valid UTF-8" });
    }
  }
  const created = new Map<string, Set<string>>();
  for (const p of paths.filter((f) => /^migrations\/[^/]+\/.+\.sql$/u.test(f))) {
    const owner = p.split("/")[1] as string;
    const tables = created.get(owner) ?? new Set<string>();
    for (const m of new TextDecoder().decode(files.get(p)).matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?([a-z][a-z0-9_]*)["`]?/giu)) tables.add((m[1] as string).toLowerCase());
    created.set(owner, tables);
  }
  const owners: [string, JsonObject, JsonObject][] = [["app", obj(manifest.authz), obj(manifest.realtime)]];
  for (const [name, m] of listed) owners.push([name, obj(m.authz), obj(m.realtime)]);
  for (const [owner, authz, realtime] of owners) {
    const tables = created.get(owner) ?? new Set<string>();
    for (const t of Object.keys(obj(realtime.feeds))) if (!tables.has(t)) out.push({ rule: "V26", field: `${owner}.realtime.feeds`, reason: `"${t}": no migration of ${owner} creates it` });
    for (const t of Object.keys(obj(authz.ownership))) if (!tables.has(t)) out.push({ rule: "V26", field: `${owner}.authz.ownership`, reason: `"${t}": no migration of ${owner} creates it` });
  }
  return out;
}

/** V28 (webhook routes) and V29 (storage, AI) on a manifest that passed the schema (artifact 1.4); the SBOM part of V29 is in validateArtifact. */
function webhookStorageRules(manifest: JsonObject): Violation[] {
  const out: Violation[] = [];
  ((manifest.routes as JsonObject[]) ?? []).forEach((route, i) => {
    const field = `routes[${i}]`;
    const local = localId((route.module as string | undefined) ?? "");
    if (route.kind === "function" && local.startsWith("functions/webhooks/")) out.push({ rule: "V28", field, reason: "a module under functions/webhooks/ is a webhook route, not a function route" });
    if (route.kind !== "webhook") return;
    if (!local.startsWith("functions/webhooks/")) out.push({ rule: "V28", field, reason: `module "${route.module}" is not under functions/webhooks/` });
    if (parsePattern(route.path as string).some((seg) => seg.kind !== "static")) out.push({ rule: "V28", field, reason: `path "${route.path}" must have static segments only` });
  });
  const check = (field: string, storage: JsonObject) => {
    for (const t of strings(storage.allowed_types)) if (t.includes(";")) out.push({ rule: "V29", field: `${field}.allowed_types`, reason: `"${t}" carries parameters` });
    const widths = (obj(storage.images).widths as number[] | undefined) ?? [];
    if (widths.some((w, j) => j > 0 && w <= (widths[j - 1] as number))) out.push({ rule: "V29", field: `${field}.images.widths`, reason: "not ascending" });
  };
  check("storage", obj(manifest.storage));
  (Array.isArray(manifest.modules) ? (manifest.modules as JsonObject[]) : []).forEach((m, i) => check(`modules[${i}].storage`, obj(m.storage)));
  if (obj(manifest.ai).mode === "direct") {
    const permissions = obj(manifest.permissions);
    if (!strings(permissions.secrets).some((n) => /^AI_[A-Z0-9]+_KEY$/u.test(n))) out.push({ rule: "V29", field: "ai.mode", reason: "\"direct\" needs an AI_<PROVIDER>_KEY in permissions.secrets" });
    if (strings(permissions.network).length === 0) out.push({ rule: "V29", field: "ai.mode", reason: "\"direct\" needs the provider's host in permissions.network" });
  }
  return out;
}

/** V19, V20 on the files of a version 1.1 artifact whose manifest passed the schema. */
function moduleTreeRules(files: ReadonlyMap<string, Uint8Array>, manifest: JsonObject): Violation[] {
  const out: Violation[] = [];
  const listed = installed(manifest);
  const paths = [...files.keys()];

  // V19: migrations for every module that has tables, and none for a module that is not installed with tables.
  const migrated = new Set(paths.filter((p) => /^migrations\/[^/]+\/.+\.sql$/u.test(p)).map((p) => p.split("/")[1] as string));
  for (const [name, m] of listed) {
    if ((m.permissions as JsonObject).tables !== undefined && !migrated.has(name)) out.push({ rule: "V19", path: `migrations/${name}/`, reason: `${name} declares tables but has no migrations` });
  }
  for (const name of migrated) {
    if (name !== "app" && (listed.get(name)?.permissions as JsonObject | undefined)?.tables === undefined) {
      out.push({ rule: "V19", path: `migrations/${name}/`, reason: `${name} is not an installed module with tables` });
    }
  }

  // V20: overrides.json lists exactly the files under overrides/, each replacing a template of its module.
  const overrideFiles = paths.filter((p) => p.startsWith("overrides/")).map((p) => p.slice("overrides/".length));
  if (overrideFiles.length > 0 || files.has("overrides.json")) {
    if (!files.has("overrides.json")) out.push({ rule: "V20", path: "overrides.json", reason: "missing" });
    else {
      let index: Json = null;
      try {
        index = JSON.parse(new TextDecoder().decode(files.get("overrides.json"))) as Json;
      } catch {
        out.push({ rule: "V20", path: "overrides.json", reason: "not JSON" });
      }
      out.push(...schemaViolations("V20", { $ref: "#/$defs/overridesIndex", $defs: (manifestSchema as JsonObject).$defs as Json } as Json, index, "overrides.json"));
      const listedFiles = isObject(index) && isObject(index.files) ? index.files : {};
      const templates = (isObject(manifest.templates) ? manifest.templates : {}) as JsonObject;
      for (const f of overrideFiles) if (!(f in listedFiles)) out.push({ rule: "V20", path: `overrides/${f}`, reason: "not in overrides.json" });
      for (const [f, raw] of Object.entries(listedFiles)) {
        const owner = f.split("/")[0] as string;
        const template = isObject(raw) ? (raw.template as string) : "";
        if (!overrideFiles.includes(f)) out.push({ rule: "V20", path: `overrides/${f}`, reason: "listed in overrides.json but missing" });
        if (!listed.has(owner)) out.push({ rule: "V20", path: `overrides/${f}`, reason: `module "${owner}" is not in modules` });
        if (template !== `modules/${f.replace(/\.html$/u, "")}`) out.push({ rule: "V20", path: `overrides/${f}`, reason: `template must be "modules/${f.replace(/\.html$/u, "")}"` });
        else if (!(template in templates)) out.push({ rule: "V20", path: `overrides/${f}`, reason: `template "${template}" is not in manifest.templates` });
      }
    }
  }
  return out;
}

/** V13 on a route table document. */
export function checkRouteTable(table: Json): Violation[] {
  const out = schemaViolations("V13", routeTableSchema as Json, table, "");
  if (out.length > 0 || !isObject(table)) return out;
  const active = new Set<string>();
  const pairs = new Set<string>();
  for (const e of table.entries as JsonObject[]) {
    const pair = `${e.hostname} ${e.deployment_hash}`;
    if (pairs.has(pair)) out.push({ rule: "V13", reason: `duplicate entry for ${e.hostname} -> ${e.deployment_hash}` });
    pairs.add(pair);
    if (e.status === "active") {
      if (active.has(e.hostname as string)) out.push({ rule: "V13", reason: `more than one active entry for ${e.hostname}` });
      active.add(e.hostname as string);
    }
  }
  return out;
}

/** "V8: routes[1]: …" for printing a violation in one line. */
export const formatViolation = (v: Violation): string =>
  `${v.rule}: ${v.path ?? v.field ?? "artifact"}: ${v.reason}`;
