// Artifact rules V1-V13 (docs/contracts/artifact.md section 6) on an artifact
// held in memory as path -> bytes. One implementation for `renox check`, the
// control plane's upload validation (#52), and the contract examples.

import manifestSchema from "../../../docs/contracts/schemas/manifest.schema.json";
import checksumsSchema from "../../../docs/contracts/schemas/migrations-checksums.schema.json";
import publicSchema from "../../../docs/contracts/schemas/public-manifest.schema.json";
import routeTableSchema from "../../../docs/contracts/schemas/route-table.schema.json";
import { contentHash, sha256Hex } from "./hash.ts";
import { pathProblem } from "./paths.ts";
import { isObject, validate, type Json, type JsonObject } from "./schema.ts";

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

/** V4, V7, V8, V9 (and V10 with a tier) on a manifest that passed the schema. */
export function manifestRules(manifest: JsonObject, tier?: TierLimits): Violation[] {
  const out: Violation[] = [];
  const app = manifest.app as JsonObject;
  const code = manifest.code as JsonObject;
  const entry = code.entry as JsonObject;
  const routes = manifest.routes as JsonObject[];
  const permissions = manifest.permissions as JsonObject;

  try {
    new Intl.DateTimeFormat("en", { timeZone: app.timezone as string });
  } catch {
    out.push({ rule: "V4", field: "app.timezone", reason: `"${app.timezone}" is not an IANA time zone` });
  }

  const used = new Set<string>();
  const shapes = new Map<string, number>();
  routes.forEach((route, i) => {
    const field = `routes[${i}]`;
    const where = `${route.method} ${route.path}`;
    const module = route.module as string;
    used.add(module);
    if (!(module in entry)) out.push({ rule: "V7", field, reason: `${where}: module "${module}" is not a key of code.entry` });
    if (route.kind === "function" && route.export !== route.method) {
      out.push({ rule: "V7", field, reason: `${where}: export "${route.export}" must equal the method` });
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
    const shape = `${route.method} /${segments.map((s) => (s.kind === "static" ? `s:${s.text}` : s.kind)).join("/")}`;
    const previous = shapes.get(shape);
    if (previous !== undefined) out.push({ rule: "V8", field, reason: `${where} conflicts with routes[${previous}]` });
    else shapes.set(shape, i);
  });
  for (const key of Object.keys(entry)) {
    if (!used.has(key)) out.push({ rule: "V7", field: `code.entry.${key}`, reason: "not used by any route" });
  }

  (permissions.network as string[]).forEach((host, i) => {
    const port = /:([0-9]+)$/u.exec(host.replace(/^http:\/\//u, ""))?.[1];
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
      out.push({ rule: "V9", field: `permissions.network[${i}]`, reason: `"${host}": port out of range` });
    }
  });

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
export function checkManifest(manifest: Json, tier?: TierLimits): Violation[] {
  const schemaErrors = schemaViolations("V3", manifestSchema as Json, manifest, "");
  if (schemaErrors.length > 0 || !isObject(manifest)) return schemaErrors;
  return manifestRules(manifest, tier);
}

/** V1-V12 (V10 when `options.tier` is set) on an artifact held as path -> bytes. */
export function checkArtifactFiles(files: ReadonlyMap<string, Uint8Array>, options: CheckOptions = {}): CheckResult {
  const out: Violation[] = [];
  const hash = contentHash(files);
  let sizeBytes = 0;
  for (const bytes of files.values()) sizeBytes += bytes.length;
  const result = (manifest: JsonObject | null): CheckResult => ({ hash, manifest, sizeBytes, violations: out });

  const folded = new Map<string, string>();
  for (const path of files.keys()) {
    const problem = pathProblem(path);
    if (problem !== null) out.push({ rule: "V1", path, reason: problem });
    const key = path.toLowerCase();
    const other = folded.get(key);
    if (other !== undefined) out.push({ rule: "V1", path, reason: `differs from ${other} only in case` });
    folded.set(key, path);
    const top = path.split("/")[0] as string;
    if (top === "templates" || top === "policies") out.push({ rule: "V1", path, reason: `${top}/ is reserved and must be absent in version 0` });
    else if (!(path === "manifest.json" || (["code", "migrations", "public"].includes(top) && path.includes("/")))) {
      out.push({ rule: "V1", path, reason: "not an allowed top-level entry" });
    }
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
  const manifestErrors = checkManifest(manifest, options.tier);
  out.push(...manifestErrors);
  if (!isObject(manifest) || manifestErrors.some((v) => v.rule === "V3")) return result(null);
  if (options.app !== undefined && (manifest.app as JsonObject).name !== options.app) {
    out.push({ rule: "V3", field: "app.name", reason: `"${(manifest.app as JsonObject).name}" is not the app "${options.app}"` });
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

  const publicFiles = [...files.keys()].filter((p) => p.startsWith("public/"));
  if (publicFiles.length > 0) {
    if (!files.has("public/manifest.json")) out.push({ rule: "V12", path: "public/manifest.json", reason: "missing" });
    else {
      let index: Json = null;
      try {
        index = JSON.parse(text("public/manifest.json")) as Json;
      } catch {
        out.push({ rule: "V12", path: "public/manifest.json", reason: "not JSON" });
      }
      out.push(...schemaViolations("V12", publicSchema as Json, index, "public/manifest.json"));
      const listed = isObject(index) && isObject(index.files) ? index.files : {};
      const served = publicFiles.filter((p) => p !== "public/manifest.json").map((p) => p.slice("public".length));
      for (const url of served) {
        const meta = listed[url];
        const bytes = files.get(`public${url}`) as Uint8Array;
        if (!isObject(meta)) out.push({ rule: "V12", path: `public${url}`, reason: "not in public/manifest.json" });
        else if (meta.sha256 !== sha256Hex(bytes) || meta.size !== bytes.length) out.push({ rule: "V12", path: `public${url}`, reason: "hash or size mismatch" });
      }
      for (const url of Object.keys(listed)) if (!served.includes(url)) out.push({ rule: "V12", path: `public${url}`, reason: "listed but missing" });
    }
  }
  return result(manifest);
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
