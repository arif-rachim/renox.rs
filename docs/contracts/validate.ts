// Checks the contracts in docs/contracts against their own examples:
//   - every JSON Schema here uses only the keywords this checker implements;
//   - every *.valid.json example validates and every *.invalid.json fails, for
//     the reason named by "[expect: ...]" in its $comment when there is one;
//   - artifact directories follow docs/contracts/artifact.md (paths, content
//     hash, manifest, migrations, public files: rules V1-V13);
//   - meter batches follow docs/contracts/meter.md (schema plus rule M1);
//   - the error catalogue docs/contracts/errors.md has exactly one row for
//     every code used in ops.md, deploy-api.md, schemas/deploy-api.yaml and
//     docs/23-failure-modes.md, and ctx.d.ts uses exactly the codes of ops.md
//     section 13;
//   - control-plane <-> worker messages follow docs/contracts/deploy-api.md
//     (schemas/control-messages.schema.json plus rules R1-R3);
//   - schemas/deploy-api.yaml (OpenAPI 3.1): every operation has request and
//     response examples, every example validates against its schema, every
//     x-renox-invalid-examples entry fails, SSE examples validate per event,
//     and x-renox-state-machines equals the tables of deploy-api.md.
//
// Run from the repository root: bun run docs/contracts/validate.ts
//
// No dependencies: the root lockfile is not owned by contract issues, so the
// JSON Schema 2020-12 subset used by these schemas is implemented below. An
// unknown keyword is an error, so a schema can never rely on a keyword that is
// silently ignored here.
//
// `tsc --noEmit -p docs/contracts` type-checks this file with `types: []`, so
// Node and Bun types are not loaded; the few APIs used are declared locally.

interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
interface Fs {
  readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  readFileSync(path: string): Uint8Array;
  readFileSync(path: string, encoding: "utf8"): string;
  existsSync(path: string): boolean;
}
interface Hash {
  update(data: Uint8Array | string): Hash;
  digest(encoding: "hex"): string;
}
interface Crypto {
  createHash(algorithm: "sha256"): Hash;
}
declare const process: { exitCode: number | undefined };
declare const Bun: { YAML: { parse(text: string): unknown } };

const nodeModule = (name: string): Promise<unknown> => import(`node:${name}`);
const fs = (await nodeModule("fs")) as Fs;
const nodeCrypto = (await nodeModule("crypto")) as Crypto;

const root = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const encoder = new TextEncoder();

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const readJson = (path: string): Json => JSON.parse(fs.readFileSync(path, "utf8")) as Json;
const sha256 = (data: Uint8Array | string): string => nodeCrypto.createHash("sha256").update(data).digest("hex");
const rel = (path: string): string => path.slice(root.length + 1);

// ---------------------------------------------------------------------------
// JSON Schema 2020-12 subset
// ---------------------------------------------------------------------------

const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "contentEncoding",
  "format",
  "examples",
  "default",
]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs"]);
const SCHEMA_KEYWORDS = new Set(["additionalProperties", "propertyNames", "items", "not", "if", "then", "else"]);
const SCHEMA_LIST_KEYWORDS = new Set(["prefixItems", "oneOf", "anyOf", "allOf"]);
const VALUE_KEYWORDS = new Set([
  "$ref",
  "type",
  "enum",
  "const",
  "required",
  "minProperties",
  "maxProperties",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
]);

/** Returns the keywords of `schema` (recursively) that this checker does not implement. */
function unsupportedKeywords(schema: Json, at = "#"): string[] {
  if (typeof schema === "boolean") return [];
  if (!isObject(schema)) return [`${at}: a schema must be an object or a boolean`];
  const out: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    const here = `${at}/${key}`;
    if (ANNOTATIONS.has(key) || VALUE_KEYWORDS.has(key)) continue;
    if (SCHEMA_MAP_KEYWORDS.has(key) && isObject(value)) {
      for (const [name, sub] of Object.entries(value)) out.push(...unsupportedKeywords(sub, `${here}/${name}`));
    } else if (SCHEMA_KEYWORDS.has(key)) {
      out.push(...unsupportedKeywords(value, here));
    } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      value.forEach((sub, i) => out.push(...unsupportedKeywords(sub, `${here}/${i}`)));
    } else {
      out.push(`${here}: unsupported keyword`);
    }
  }
  return out;
}

function canonical(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k] as Json)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
const jsonEqual = (a: Json, b: Json): boolean => canonical(a) === canonical(b);

function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

const schemaDocs = new Map<string, Json>();
/** Another file under schemas/, for a `$ref` of the form `<file>.schema.json#<pointer>`. */
function schemaDoc(file: string): Json {
  if (!/^[a-z-]+\.schema\.json$/u.test(file)) throw new Error(`only $ref to schemas/<name>.schema.json is supported: ${file}`);
  let doc = schemaDocs.get(file);
  if (doc === undefined) {
    doc = readJson(`${root}/schemas/${file}`);
    schemaDocs.set(file, doc);
  }
  return doc;
}

/** Resolves `ref` to [schema, the root its own local refs resolve against]. */
function resolveRefIn(rootSchema: Json, ref: string): [Json, Json] {
  const hash = ref.indexOf("#");
  const file = hash === -1 ? ref : ref.slice(0, hash);
  const base = file === "" ? rootSchema : schemaDoc(file);
  return [resolveRef(base, hash === -1 ? "#" : ref.slice(hash)), base];
}

function resolveRef(rootSchema: Json, ref: string): Json {
  if (!ref.startsWith("#")) throw new Error(`only local $ref is supported: ${ref}`);
  let node: Json = rootSchema;
  for (const raw of ref.slice(1).split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(node) || !(key in node)) throw new Error(`unresolvable $ref: ${ref}`);
    node = node[key] as Json;
  }
  return node;
}

/** Validates `value` against `schema`; returns one line per violation ("<json path>: <keyword> ..."). */
function validate(schema: Json, value: Json, rootSchema: Json = schema, at = "$"): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${at}: false schema`];
  if (!isObject(schema)) throw new Error(`invalid schema at ${at}`);
  const errors: string[] = [];
  const fail = (msg: string) => errors.push(`${at}: ${msg}`);
  const sub = (s: Json, v: Json, path: string) => validate(s, v, rootSchema, path);

  if (typeof schema.$ref === "string") {
    const [target, base] = resolveRefIn(rootSchema, schema.$ref);
    errors.push(...validate(target, value, base, at));
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!types.some((t) => t === actual || (t === "number" && actual === "integer"))) {
      fail(`type: expected ${types.join("|")}, got ${actual}`);
      return errors;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => jsonEqual(e, value))) {
    fail(`enum: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if ("const" in schema && !jsonEqual(schema.const as Json, value)) {
    fail(`const: expected ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) fail(`minLength ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && length > schema.maxLength) fail(`maxLength ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      fail(`pattern: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) fail(`minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) fail(`maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      fail(`exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      fail(`exclusiveMaximum ${schema.exclusiveMaximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) fail(`minItems ${schema.minItems}`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) fail(`maxItems ${schema.maxItems}`);
    if (schema.uniqueItems === true && new Set(value.map(canonical)).size !== value.length) fail("uniqueItems");
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    value.forEach((item, i) => {
      if (i < prefix.length) errors.push(...sub(prefix[i] as Json, item, `${at}[${i}]`));
      else if (schema.items !== undefined) errors.push(...sub(schema.items, item, `${at}[${i}]`));
    });
  }

  if (isObject(value)) {
    const keys = Object.keys(value);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
      fail(`minProperties ${schema.minProperties}`);
    }
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
      fail(`maxProperties ${schema.maxProperties}`);
    }
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in value)) fail(`required: missing "${key}"`);
      }
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    const patterns = isObject(schema.patternProperties) ? Object.entries(schema.patternProperties) : [];
    for (const key of keys) {
      const child = value[key] as Json;
      const path = `${at}.${key}`;
      if (schema.propertyNames !== undefined) {
        for (const e of sub(schema.propertyNames, key, path)) errors.push(`${e} (property name)`);
      }
      let matched = false;
      if (key in properties) {
        matched = true;
        errors.push(...sub(properties[key] as Json, child, path));
      }
      for (const [pattern, s] of patterns) {
        if (new RegExp(pattern, "u").test(key)) {
          matched = true;
          errors.push(...sub(s, child, path));
        }
      }
      if (!matched && schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) fail(`additionalProperties: "${key}" is not allowed`);
        else errors.push(...sub(schema.additionalProperties, child, path));
      }
    }
  }

  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) errors.push(...sub(s, value, at));
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => sub(s, value, at).length === 0)) {
    fail("anyOf: no branch matches");
  }
  if (Array.isArray(schema.oneOf)) {
    const results = schema.oneOf.map((s) => sub(s, value, at));
    const passing = results.filter((r) => r.length === 0).length;
    if (passing !== 1) {
      // Report the closest branch so the reason stays readable.
      const closest = results.reduce((a, b) => (b.length < a.length ? b : a), results[0] ?? []);
      fail(`oneOf: ${passing} branches match, expected 1`);
      if (passing === 0) errors.push(...closest);
    }
  }
  if (schema.not !== undefined && sub(schema.not, value, at).length === 0) fail("not: value matches a forbidden schema");
  if (schema.if !== undefined) {
    const branch = sub(schema.if, value, at).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...sub(branch, value, at));
  }
  return errors;
}

// ---------------------------------------------------------------------------
// artifact.md: semantic rules
// ---------------------------------------------------------------------------

const MAX_CODE_BYTES = 20 * 1024 * 1024; // V5, docs/04-isolation-security.md "Bundle size"
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024; // V5, proposed
const MAX_ARTIFACT_FILES = 10_000; // V5, proposed
// eslint-disable-next-line no-control-regex
const FORBIDDEN_PATH_CHARS = /[\u0000-\u001f\u007f\\:]/u;

/** artifact.md section 1, "Paths" (V1). Returns the reason, or null when the path is fine. */
function pathProblem(path: string): string | null {
  if (path.normalize("NFC") !== path) return "not NFC";
  if (path.startsWith("/") || path.endsWith("/")) return "leading or trailing /";
  if (FORBIDDEN_PATH_CHARS.test(path)) return "backslash, colon, or control character";
  if (encoder.encode(path).length > 512) return "longer than 512 bytes";
  const segments = path.split("/");
  if (segments.length > 32) return "more than 32 segments";
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "empty, . or .. segment";
  return null;
}

/** artifact.md section 2: SHA-256 over "<sha256 hex>  <path>\n" lines sorted by UTF-8 path bytes. */
function contentHash(files: Map<string, Uint8Array>): string {
  const compare = (a: string, b: string): number => {
    const x = encoder.encode(a);
    const y = encoder.encode(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
    }
    return x.length - y.length;
  };
  const listing = [...files.keys()]
    .sort(compare)
    .map((path) => `${sha256(files.get(path) as Uint8Array)}  ${path}\n`)
    .join("");
  return sha256(listing);
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

/** V4, V7, V8, V9 on a manifest that already passed the schema. */
function manifestRules(manifest: JsonObject): string[] {
  const errors: string[] = [];
  const app = manifest.app as JsonObject;
  const code = manifest.code as JsonObject;
  const entry = code.entry as JsonObject;
  const routes = manifest.routes as JsonObject[];
  const permissions = manifest.permissions as JsonObject;

  try {
    new Intl.DateTimeFormat("en", { timeZone: app.timezone as string });
  } catch {
    errors.push(`V4: app.timezone "${app.timezone}" is not an IANA time zone`);
  }

  const used = new Set<string>();
  const shapes = new Map<string, number>();
  routes.forEach((route, i) => {
    const where = `routes[${i}] ${route.method} ${route.path}`;
    const module = route.module as string;
    used.add(module);
    if (!(module in entry)) errors.push(`V7: ${where}: module "${module}" is not a key of code.entry`);
    if (route.kind === "function" && route.export !== route.method) {
      errors.push(`V7: ${where}: export "${route.export}" must equal the method`);
    }
    const segments = parsePattern(route.path as string);
    const names = new Set<string>();
    segments.forEach((s, j) => {
      if (s.kind === "catchall" && j !== segments.length - 1) errors.push(`V8: ${where}: catch-all is not the last segment`);
      if (s.kind !== "static") {
        if (names.has(s.text)) errors.push(`V8: ${where}: parameter "${s.text}" appears twice`);
        names.add(s.text);
      }
    });
    const shape = `${route.method} /${segments.map((s) => (s.kind === "static" ? `s:${s.text}` : s.kind)).join("/")}`;
    const previous = shapes.get(shape);
    if (previous !== undefined) errors.push(`V8: ${where}: conflicts with routes[${previous}]`);
    else shapes.set(shape, i);
  });
  for (const key of Object.keys(entry)) {
    if (!used.has(key)) errors.push(`V7: code.entry "${key}" is not used by any route`);
  }

  for (const host of permissions.network as string[]) {
    const port = /:([0-9]+)$/u.exec(host.replace(/^http:\/\//u, ""))?.[1];
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
      errors.push(`V9: permissions.network "${host}": port out of range`);
    }
  }
  return errors;
}

/** V13 on a route table that already passed the schema. */
function routeTableRules(table: JsonObject): string[] {
  const errors: string[] = [];
  const active = new Set<string>();
  const pairs = new Set<string>();
  for (const e of table.entries as JsonObject[]) {
    const pair = `${e.hostname} ${e.deployment_hash}`;
    if (pairs.has(pair)) errors.push(`V13: duplicate entry for ${e.hostname} -> ${e.deployment_hash}`);
    pairs.add(pair);
    if (e.status === "active") {
      if (active.has(e.hostname as string)) errors.push(`V13: more than one active entry for ${e.hostname}`);
      active.add(e.hostname as string);
    }
  }
  return errors;
}

/** meter.md: M1, one invocation is one record, so request_id is unique within a batch. */
function meterBatchRules(batch: JsonObject): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const r of batch.records as JsonObject[]) {
    const id = r.request_id as string;
    if (seen.has(id)) errors.push(`M1: request_id ${id} appears twice in one batch`);
    seen.add(id);
  }
  return errors;
}

/** deploy-api.md section 8, R1 and R2 on a route snapshot that already passed the schema. */
function routeSnapshotRules(snapshot: JsonObject): string[] {
  const errors: string[] = [];
  const active = new Set<string>();
  const pairs = new Set<string>();
  for (const e of snapshot.entries as JsonObject[]) {
    const pair = `${e.hostname} ${e.deployment_hash}`;
    if (pairs.has(pair)) errors.push(`R1: duplicate entry for ${e.hostname} -> ${e.deployment_hash}`);
    pairs.add(pair);
    if (e.status === "active") {
      if (active.has(e.hostname as string)) errors.push(`R1: more than one active entry for ${e.hostname}`);
      active.add(e.hostname as string);
    }
    if ((e.version as number) > (snapshot.version as number)) {
      errors.push(`R2: entry ${e.hostname} -> ${e.deployment_hash} has version ${e.version} above the snapshot's ${snapshot.version}`);
    }
  }
  return errors;
}

/** deploy-api.md section 8, R1 and R3 on a route delta that already passed the schema. */
function routeDeltaRules(delta: JsonObject): string[] {
  const errors: string[] = [];
  const prev = delta.prev_version as number;
  const version = delta.version as number;
  if (version <= prev) errors.push(`R3: version ${version} is not above prev_version ${prev}`);
  const versions = new Set<number>();
  const pairs = new Set<string>();
  const changes = [...(delta.upserts as JsonObject[]), ...(delta.removals as JsonObject[])];
  for (const c of changes) {
    const v = c.version as number;
    if (v <= prev || v > version) errors.push(`R3: change ${c.hostname} -> ${c.deployment_hash} has version ${v} outside (${prev}, ${version}]`);
    if (versions.has(v)) errors.push(`R3: version ${v} is used by two changes`);
    versions.add(v);
    const pair = `${c.hostname} ${c.deployment_hash}`;
    if (pairs.has(pair)) errors.push(`R1: ${c.hostname} -> ${c.deployment_hash} changes twice in one delta`);
    pairs.add(pair);
  }
  const active = (delta.upserts as JsonObject[]).filter((e) => e.status === "active").map((e) => e.hostname as string);
  if (new Set(active).size !== active.length) errors.push("R1: two active upserts for one hostname");
  return errors;
}

const schemaFile = (name: string): string => `${root}/schemas/${name}.schema.json`;

/** A "message" is one JSON document kind with its schema and the semantic rules applied after it. */
interface Message {
  schema: string;
  /** A `$defs` entry of `schema` that the message validates against, instead of the root. */
  def?: string;
  rules?: (doc: JsonObject) => string[];
}
const messages: Record<string, Message> = {
  manifest: { schema: schemaFile("manifest"), rules: manifestRules },
  "route-table": { schema: schemaFile("route-table"), rules: routeTableRules },
  "migrations-checksums": { schema: schemaFile("migrations-checksums") },
  "public-manifest": { schema: schemaFile("public-manifest") },
  "meter-batch": { schema: schemaFile("meter-record"), rules: meterBatchRules },
};
const controlMessages: Record<string, Omit<Message, "schema">> = {
  node_register: {},
  node_registered: {},
  heartbeat: {},
  heartbeat_ack: {},
  route_snapshot: { rules: routeSnapshotRules },
  route_delta: { rules: routeDeltaRules },
  resync: {},
  prepare: {},
  prepare_result: {},
  secrets_bundle: {},
  certificate_update: {},
  certificate_remove: {},
  certificate_bundle: {},
  log_batch: {},
};
for (const [def, m] of Object.entries(controlMessages)) {
  messages[def] = { schema: schemaFile("control-messages"), def, ...m };
}

function checkMessage(kind: string, doc: Json): string[] {
  const message = messages[kind];
  if (message === undefined) throw new Error(`unknown message kind ${kind}`);
  const schema = readJson(message.schema);
  const target: Json = message.def === undefined ? schema : { $ref: `#/$defs/${message.def}` };
  const errors = validate(target, doc, schema).map((e) => `schema ${e}`);
  if (errors.length === 0 && message.rules !== undefined && isObject(doc)) errors.push(...message.rules(doc));
  return errors;
}

/** Walks an artifact directory and applies V1-V12. Returns one line per violation. */
function checkArtifact(dir: string): string[] {
  const errors: string[] = [];
  const files = new Map<string, Uint8Array>();
  const walk = (abs: string, prefix: string): void => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const path = prefix === "" ? d.name : `${prefix}/${d.name}`;
      const problem = pathProblem(path);
      if (problem !== null) errors.push(`V1: ${JSON.stringify(path)}: ${problem}`);
      if (d.isSymbolicLink()) errors.push(`V1: ${path}: symbolic link`);
      else if (d.isDirectory()) walk(`${abs}/${d.name}`, path);
      else if (d.isFile()) files.set(path, fs.readFileSync(`${abs}/${d.name}`));
      else errors.push(`V1: ${path}: not a regular file`);
    }
  };
  walk(dir, "");

  const folded = new Map<string, string>();
  for (const path of files.keys()) {
    const key = path.toLowerCase();
    const other = folded.get(key);
    if (other !== undefined) errors.push(`V1: ${path} and ${other} differ only in case`);
    folded.set(key, path);
    const top = path.split("/")[0] as string;
    if (top === "templates" || top === "policies") errors.push(`V1: ${top}/ is reserved and must be absent in version 0`);
    else if (!(path === "manifest.json" || ["code", "migrations", "public"].includes(top))) {
      errors.push(`V1: ${path}: not an allowed top-level entry`);
    }
  }

  const name = dir.split("/").pop() as string;
  const hash = contentHash(files);
  if (name !== hash) errors.push(`V2: directory name ${name} does not match the content hash ${hash}`);

  const text = (path: string): string => new TextDecoder().decode(files.get(path));
  if (!files.has("manifest.json")) return [...errors, "V3: manifest.json is missing"];
  let manifest: Json;
  try {
    manifest = JSON.parse(text("manifest.json")) as Json;
  } catch {
    return [...errors, "V3: manifest.json is not JSON"];
  }
  const manifestErrors = checkMessage("manifest", manifest);
  errors.push(...manifestErrors.map((e) => (e.startsWith("schema") ? `V3: ${e}` : e)));
  if (manifestErrors.some((e) => e.startsWith("schema")) || !isObject(manifest)) return errors;

  let total = 0;
  let codeBytes = 0;
  for (const [path, bytes] of files) {
    total += bytes.length;
    if (path.startsWith("code/")) codeBytes += bytes.length;
  }
  if (codeBytes > MAX_CODE_BYTES) errors.push(`V5: code/ is ${codeBytes} bytes, limit ${MAX_CODE_BYTES}`);
  if (total > MAX_ARTIFACT_BYTES) errors.push(`V5: artifact is ${total} bytes, limit ${MAX_ARTIFACT_BYTES}`);
  if (files.size > MAX_ARTIFACT_FILES) errors.push(`V5: ${files.size} files, limit ${MAX_ARTIFACT_FILES}`);

  const code = manifest.code as JsonObject;
  const codeFiles = [...files.keys()].filter((p) => p.startsWith("code/")).map((p) => p.slice("code/".length));
  if (code.format === "eszip") {
    if (codeFiles.length !== 1 || codeFiles[0] !== "bundle.eszip") {
      errors.push("V6: code.format eszip requires code/ to hold only bundle.eszip");
    }
  } else {
    for (const p of codeFiles) if (!/\.(js|mjs|json)$/u.test(p)) errors.push(`V6: code/${p}: esm-dir holds .js, .mjs, .json only`);
    for (const [id, path] of Object.entries(code.entry as JsonObject)) {
      if (!codeFiles.includes(path as string)) errors.push(`V6: code.entry "${id}" -> code/${path} does not exist`);
    }
  }

  const migrations = [...files.keys()].filter((p) => p.startsWith("migrations/"));
  if (migrations.length > 0) {
    if (!files.has("migrations/checksums.json")) errors.push("V11: migrations/checksums.json is missing");
    else {
      const checksums = JSON.parse(text("migrations/checksums.json")) as Json;
      const schemaErrors = checkMessage("migrations-checksums", checksums);
      errors.push(...schemaErrors.map((e) => `V11: checksums.json ${e}`));
      const listed = isObject(checksums) && isObject(checksums.files) ? checksums.files : {};
      const sql = migrations.filter((p) => p !== "migrations/checksums.json").map((p) => p.slice("migrations/".length));
      const numbers = new Map<string, number[]>();
      for (const p of sql) {
        const m = /^([a-z][a-z0-9_]{0,31})\/([0-9]{3})_[a-z0-9_]{1,64}\.sql$/u.exec(p);
        if (m === null) {
          errors.push(`V11: migrations/${p}: not <module>/NNN_<name>.sql`);
          continue;
        }
        numbers.set(m[1] as string, [...(numbers.get(m[1] as string) ?? []), Number(m[2])]);
        if (listed[p] === undefined) errors.push(`V11: migrations/${p} is not in checksums.json`);
        else if (listed[p] !== sha256(files.get(`migrations/${p}`) as Uint8Array)) {
          errors.push(`V11: migrations/${p}: checksum mismatch`);
        }
      }
      for (const p of Object.keys(listed)) if (!sql.includes(p)) errors.push(`V11: checksums.json lists missing ${p}`);
      for (const [module, list] of numbers) {
        list.sort((a, b) => a - b);
        if (list.some((n, i) => n !== i + 1)) errors.push(`V11: migrations/${module}: numbering has gaps or does not start at 001`);
      }
    }
  }

  const publicFiles = [...files.keys()].filter((p) => p.startsWith("public/"));
  if (publicFiles.length > 0) {
    if (!files.has("public/manifest.json")) errors.push("V12: public/manifest.json is missing");
    else {
      const index = JSON.parse(text("public/manifest.json")) as Json;
      errors.push(...checkMessage("public-manifest", index).map((e) => `V12: public/manifest.json ${e}`));
      const listed = isObject(index) && isObject(index.files) ? index.files : {};
      const served = publicFiles.filter((p) => p !== "public/manifest.json").map((p) => p.slice("public".length));
      for (const url of served) {
        const meta = listed[url];
        const bytes = files.get(`public${url}`) as Uint8Array;
        if (!isObject(meta)) errors.push(`V12: ${url} is not in public/manifest.json`);
        else if (meta.sha256 !== sha256(bytes) || meta.size !== bytes.length) errors.push(`V12: ${url}: hash or size mismatch`);
      }
      for (const url of Object.keys(listed)) if (!served.includes(url)) errors.push(`V12: public/manifest.json lists missing ${url}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failures = 0;
let passes = 0;
const report = (ok: boolean, label: string, details: string[] = []): void => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) for (const d of details.slice(0, 10)) console.log(`       ${d}`);
};

const listDir = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .map((d) => d.name)
        .sort()
    : [];

/** Checks a single-file example: valid must pass; invalid must fail, for the "[expect: X]" reason if given. */
function checkExample(path: string, check: (doc: Json) => string[]): void {
  const doc = readJson(path);
  const errors = check(doc);
  if (path.endsWith(".valid.json")) {
    report(errors.length === 0, `${rel(path)} validates`, errors);
    return;
  }
  const comment = isObject(doc) && typeof doc.$comment === "string" ? doc.$comment : "";
  const expect = /\[expect: ([^\]]+)\]/u.exec(comment)?.[1];
  const expected = expect === undefined || errors.some((e) => e.includes(expect));
  const why = expect === undefined ? "" : ` (${expect})`;
  report(errors.length > 0 && expected, `${rel(path)} is rejected${why}`, errors.length > 0 ? errors : ["no error"]);
}

// 1. Every schema uses only implemented keywords.
const schemas = [
  `${root}/ops.schema.json`,
  ...listDir(`${root}/schemas`)
    .filter((f) => f.endsWith(".schema.json"))
    .map((f) => `${root}/schemas/${f}`),
];
for (const path of schemas) {
  const problems = unsupportedKeywords(readJson(path));
  report(problems.length === 0, `${rel(path)} uses supported keywords only`, problems);
}

// 2. ops.md examples (examples/ops/<op>.(valid|invalid).json).
const opsSchema = readJson(`${root}/ops.schema.json`);
for (const file of listDir(`${root}/examples/ops`).filter((f) => f.endsWith(".json"))) {
  checkExample(`${root}/examples/ops/${file}`, (doc) => validate(opsSchema, doc));
}

// 3. Single-file examples (examples/<contract>/<message>.<case>.(valid|invalid).json).
for (const contract of ["artifact", "meter", "deploy-api"]) {
  for (const file of listDir(`${root}/examples/${contract}`).filter((f) => f.endsWith(".json"))) {
    const kind = Object.keys(messages)
      .filter((k) => file.startsWith(`${k}.`))
      .sort((a, b) => b.length - a.length)[0];
    if (kind === undefined) {
      report(false, `examples/${contract}/${file}: name does not start with a known message kind`);
      continue;
    }
    checkExample(`${root}/examples/${contract}/${file}`, (doc) => checkMessage(kind, doc));
  }
}
const meterBatchErrors = checkMessage("meter-batch", readJson(`${root}/examples/meter-batch.json`));
report(meterBatchErrors.length === 0, "examples/meter-batch.json validates", meterBatchErrors);

// Every control message has at least one valid and one invalid example.
const deployExamples = listDir(`${root}/examples/deploy-api`);
for (const kind of Object.keys(controlMessages)) {
  const mine = deployExamples.filter((f) => f.startsWith(`${kind}.`) && !Object.keys(controlMessages).some((k) => k.length > kind.length && k.startsWith(kind) && f.startsWith(`${k}.`)));
  const valid = mine.filter((f) => f.endsWith(".valid.json")).length;
  const invalid = mine.filter((f) => f.endsWith(".invalid.json")).length;
  report(valid > 0 && invalid > 0, `${kind}: ${valid} valid and ${invalid} invalid examples`);
}

// 4. artifact.md directories: valid artifacts pass V1-V12; broken ones fail for the named rule.
const artifacts: { dir: string; expect?: string }[] = [
  { dir: "examples/hello-artifact" },
  { dir: "examples/artifact/notes-artifact" },
  { dir: "examples/artifact/broken-artifact", expect: "V2" }, // a file changed after hashing
];
for (const { dir, expect } of artifacts) {
  for (const name of listDir(`${root}/${dir}`).filter((n) => /^[0-9a-f]{64}$/u.test(n))) {
    const errors = checkArtifact(`${root}/${dir}/${name}`);
    if (expect === undefined) report(errors.length === 0, `${dir}/${name.slice(0, 12)}… is a valid artifact`, errors);
    else report(errors.some((e) => e.startsWith(expect)), `${dir}/${name.slice(0, 12)}… is rejected (${expect})`, errors);
  }
}

// 5. The worked example's route table points at the worked example artifact.
const helloTable = readJson(`${root}/examples/hello-artifact/route-table.json`);
const helloHashes = listDir(`${root}/examples/hello-artifact`).filter((n) => /^[0-9a-f]{64}$/u.test(n));
const tableErrors = checkMessage("route-table", helloTable);
if (isObject(helloTable) && Array.isArray(helloTable.entries)) {
  for (const e of helloTable.entries) {
    if (isObject(e) && !helloHashes.includes(e.deployment_hash as string)) {
      tableErrors.push(`${e.hostname}: deployment_hash is not the worked example's hash`);
    }
  }
}
report(tableErrors.length === 0, "examples/hello-artifact/route-table.json validates and routes to the artifact", tableErrors);

// 6a. schemas/deploy-api.yaml: OpenAPI 3.1 with examples for every operation.
const api = Bun.YAML.parse(fs.readFileSync(`${root}/schemas/deploy-api.yaml`, "utf8")) as Json;
const apiErrors: string[] = [];
const local = (node: Json): Json => {
  // Follows a local `$ref` (components.responses, .examples, .parameters) to its target.
  let n = node;
  for (let i = 0; i < 8 && isObject(n) && typeof n.$ref === "string" && n.$ref.startsWith("#/"); i++) n = resolveRef(api, n.$ref);
  return n;
};
/** Checks one media type object: examples present, valid ones pass, x-renox-invalid-examples fail. */
function checkMedia(where: string, type: string, media: Json): void {
  if (!isObject(media)) return apiErrors.push(`${where} ${type}: not an object`) as unknown as void;
  const examples = isObject(media.examples) ? Object.entries(media.examples) : [];
  if (examples.length === 0) apiErrors.push(`${where} ${type}: no examples`);
  const schema = media.schema as Json;
  const problems = unsupportedKeywords(schema);
  if (problems.length > 0) apiErrors.push(...problems.map((p) => `${where} ${type} schema ${p}`));
  for (const [name, raw] of examples) {
    const ex = local(raw);
    if (!isObject(ex) || !("value" in ex)) {
      apiErrors.push(`${where} ${type} example ${name}: no value`);
      continue;
    }
    const value = ex.value as Json;
    if (type === "application/json") {
      for (const e of validate(schema, value, api)) apiErrors.push(`${where} example ${name}: ${e}`);
    } else if (type === "text/event-stream") {
      const events = isObject(media["x-renox-events"]) ? media["x-renox-events"] : {};
      if (typeof value !== "string") apiErrors.push(`${where} example ${name}: an event stream example is a string`);
      else {
        let seen = 0;
        for (const block of value.split("\n\n")) {
          const lines = block.split("\n").filter((l) => l !== "" && !l.startsWith(":"));
          if (lines.length === 0) continue;
          const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
          const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          const eventSchema = events[event];
          if (eventSchema === undefined) apiErrors.push(`${where} example ${name}: event "${event}" has no x-renox-events schema`);
          else for (const e of validate(eventSchema, JSON.parse(data) as Json, api)) apiErrors.push(`${where} example ${name} event ${event}: ${e}`);
          seen++;
        }
        if (seen === 0) apiErrors.push(`${where} example ${name}: no events`);
      }
    } else if (typeof value !== "string") {
      apiErrors.push(`${where} ${type} example ${name}: a binary example is a placeholder string`);
    }
  }
  const invalid = isObject(media["x-renox-invalid-examples"]) ? Object.entries(media["x-renox-invalid-examples"]) : [];
  for (const [name, ex] of invalid) {
    if (!isObject(ex)) continue;
    const errors = validate(schema, ex.value as Json, api);
    const expect = typeof ex["x-expect"] === "string" ? ex["x-expect"] : undefined;
    const ok = errors.length > 0 && (expect === undefined || errors.some((e) => e.includes(expect)));
    report(ok, `deploy-api.yaml ${where} invalid example ${name} is rejected${expect === undefined ? "" : ` (${expect})`}`, errors.length > 0 ? errors : ["no error"]);
  }
}
if (!isObject(api) || typeof api.openapi !== "string" || !api.openapi.startsWith("3.1.")) apiErrors.push("openapi is not 3.1.x");
const operationIds = new Set<string>();
let operations = 0;
const METHODS = ["get", "put", "post", "delete", "patch"];
for (const [path, item] of Object.entries(isObject(api) && isObject(api.paths) ? api.paths : {})) {
  if (!isObject(item)) continue;
  const pathParams = [...path.matchAll(/\{([a-z_]+)\}/gu)].map((m) => m[1] as string);
  const shared = Array.isArray(item.parameters) ? item.parameters.map(local) : [];
  for (const method of METHODS) {
    const op = item[method];
    if (!isObject(op)) continue;
    operations++;
    const where = `${method.toUpperCase()} ${path}`;
    const id = op.operationId as string;
    if (typeof id !== "string" || operationIds.has(id)) apiErrors.push(`${where}: missing or duplicate operationId`);
    operationIds.add(id);
    const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters.map(local) : [])];
    for (const p of pathParams) {
      if (!params.some((q) => isObject(q) && q.in === "path" && q.name === p)) apiErrors.push(`${where}: path parameter {${p}} is not declared`);
    }
    for (const q of params) if (isObject(q)) for (const pr of unsupportedKeywords(q.schema as Json)) apiErrors.push(`${where} parameter ${q.name} ${pr}`);
    const body = local(op.requestBody as Json);
    if (isObject(body) && isObject(body.content)) {
      for (const [type, media] of Object.entries(body.content)) checkMedia(`${where} request`, type, media);
    }
    const responses = isObject(op.responses) ? Object.entries(op.responses) : [];
    if (!responses.some(([status]) => status.startsWith("2"))) apiErrors.push(`${where}: no 2xx response`);
    let withExample = 0;
    for (const [status, raw] of responses) {
      const response = local(raw);
      if (!isObject(response) || !isObject(response.content)) continue;
      withExample++;
      for (const [type, media] of Object.entries(response.content)) checkMedia(`${where} ${status}`, type, media);
    }
    if (withExample === 0) apiErrors.push(`${where}: no response with a body example`);
  }
}
const componentSchemas = isObject(api) && isObject(api.components) && isObject(api.components.schemas) ? api.components.schemas : {};
for (const [name, schema] of Object.entries(componentSchemas)) {
  for (const p of unsupportedKeywords(schema)) apiErrors.push(`components.schemas.${name} ${p}`);
}
report(apiErrors.length === 0, `deploy-api.yaml: ${operations} operations, all with request and response examples that validate`, apiErrors);

// 6b. x-renox-state-machines equals the transition tables of deploy-api.md.
const deployText = fs.readFileSync(`${root}/deploy-api.md`, "utf8");
const machines = isObject(api) && isObject(api["x-renox-state-machines"]) ? api["x-renox-state-machines"] : {};
for (const [name, machine] of Object.entries(machines)) {
  const section = new RegExp(`<!-- state-machine: ${name} -->\\n([\\s\\S]*?)\\n\\n`, "u").exec(deployText)?.[1];
  const fromDoc: Record<string, string[]> = {};
  for (const m of (section ?? "").matchAll(/^\| `([a-z_]+)` \|[^|]*\| ([^|]*) \|/gmu)) {
    fromDoc[m[1] as string] = [...(m[2] as string).matchAll(/`([a-z_]+)`/gu)].map((x) => x[1] as string).sort();
  }
  const transitions = isObject(machine) && isObject(machine.transitions) ? machine.transitions : {};
  const fromYaml: Record<string, string[]> = {};
  for (const [state, to] of Object.entries(transitions)) fromYaml[state] = (Array.isArray(to) ? (to as string[]) : []).slice().sort();
  const diff: string[] = [];
  if (section === undefined) diff.push(`deploy-api.md has no "<!-- state-machine: ${name} -->" table`);
  for (const state of new Set([...Object.keys(fromDoc), ...Object.keys(fromYaml)])) {
    if (JSON.stringify(fromDoc[state]) !== JSON.stringify(fromYaml[state])) {
      diff.push(`${state}: deploy-api.md ${JSON.stringify(fromDoc[state] ?? null)} vs yaml ${JSON.stringify(fromYaml[state] ?? null)}`);
    }
    for (const to of fromYaml[state] ?? []) if (!(to in fromYaml)) diff.push(`${state} -> ${to}: unknown state`);
  }
  report(diff.length === 0, `deploy-api ${name} state machine: deploy-api.md table = deploy-api.yaml (${Object.keys(fromYaml).length} states)`, diff);
}

// 6. errors.md: one row per code; covers ops.md and docs/23-failure-modes.md;
//    ctx.d.ts matches ops.md section 13.
const CODE = /RENOX_[A-Z0-9]+(?:_[A-Z0-9]+)*/gu;
const codesIn = (text: string): Set<string> => new Set(text.match(CODE) ?? []);
const docText = (path: string): string => fs.readFileSync(path, "utf8");

const catalogue = new Map<string, string>(); // code -> phase
const duplicates: string[] = [];
for (const m of docText(`${root}/errors.md`).matchAll(/^\| `(RENOX_[A-Z0-9_]+)` \| (F[0-9]) \|/gmu)) {
  const [, code, phase] = m as unknown as [string, string, string];
  if (catalogue.has(code)) duplicates.push(`${code} has more than one row`);
  catalogue.set(code, phase);
}
report(catalogue.size > 0 && duplicates.length === 0, `errors.md has one row per code (${catalogue.size} codes)`, duplicates);

const opsText = docText(`${root}/ops.md`);
const sources: [string, Set<string>][] = [
  ["ops.md", codesIn(opsText)],
  ["docs/23-failure-modes.md", codesIn(docText(`${root}/../23-failure-modes.md`))],
  ["deploy-api.md", codesIn(deployText)],
  ["schemas/deploy-api.yaml", codesIn(docText(`${root}/schemas/deploy-api.yaml`))],
];
for (const [name, codes] of sources) {
  const missing = [...codes].filter((c) => !catalogue.has(c)).map((c) => `${c} is used in ${name} but has no row`);
  report(missing.length === 0, `every code in ${name} is in errors.md (${codes.size} codes)`, missing);
}
const used = new Set(sources.flatMap(([, codes]) => [...codes]));
const unused = [...catalogue]
  .filter(([code, phase]) => !used.has(code) && phase <= "F1")
  .map(([code]) => `${code} is in errors.md but used by neither source; only codes of a later phase may be reserved`);
report(unused.length === 0, "errors.md has no F1 code that ops.md and docs/23-failure-modes.md do not use", unused);

// ops.md section 13 table: | `CODE` | thrown|response|both | ...
const kinds = new Map<string, string>();
for (const m of opsText.matchAll(/^\| `(RENOX_[A-Z0-9_]+)` \| (thrown|response|both) \|/gmu)) {
  const [, code, kind] = m as unknown as [string, string, string];
  kinds.set(code, kind);
}
const ctxText = docText(`${root}/ctx.d.ts`);
/** String literals of `export type <name> = ...;`, following references to other code types in ctx.d.ts. */
const typeCodes = (name: string): Set<string> => {
  const body = new RegExp(`export type ${name} =([^;]*);`, "u").exec(ctxText)?.[1] ?? "";
  const out = codesIn(body);
  for (const ref of body.match(/\b[A-Z][A-Za-z]*ErrorCode\b/gu) ?? []) for (const c of typeCodes(ref)) out.add(c);
  return out;
};
const sameSet = (label: string, actual: Set<string>, expected: Set<string>): void => {
  const diff = [
    ...[...expected].filter((c) => !actual.has(c)).map((c) => `${c} is missing`),
    ...[...actual].filter((c) => !expected.has(c)).map((c) => `${c} is extra`),
  ];
  report(diff.length === 0, label, diff);
};
const ofKind = (...wanted: string[]): Set<string> =>
  new Set([...kinds].filter(([, kind]) => wanted.includes(kind)).map(([code]) => code));
report(kinds.size > 0, `ops.md section 13 lists ${kinds.size} codes`);
sameSet("ctx.d.ts RenoxErrorCode = ops.md section 13 thrown codes", typeCodes("RenoxErrorCode"), ofKind("thrown", "both"));
sameSet("ctx.d.ts ResponseErrorCode = ops.md section 13 response codes", typeCodes("ResponseErrorCode"), ofKind("response", "both"));
sameSet("ops.md section 13 lists every code used in ops.md", new Set(kinds.keys()), codesIn(opsText));

console.log(`\n${passes} passed, ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
