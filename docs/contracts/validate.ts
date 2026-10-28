// Checks the contracts in docs/contracts against their own examples:
//   - every JSON Schema here uses only the keywords this checker implements;
//   - every *.valid.json example validates and every *.invalid.json fails, for
//     the reason named by "[expect: ...]" in its $comment when there is one;
//   - artifact directories follow docs/contracts/artifact.md (paths, content
//     hash, manifest, migrations, public files, templates, pages, security:
//     rules V1-V16, versions 0 and 1);
//   - meter batches follow docs/contracts/meter.md (schema plus rule M1);
//   - the error catalogue docs/contracts/errors.md has exactly one row for
//     every code used in ops.md and docs/23-failure-modes.md, and ctx.d.ts
//     uses exactly the codes of ops.md section 13.
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

  if (typeof schema.$ref === "string") errors.push(...sub(resolveRef(rootSchema, schema.$ref), value, at));

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

/** The methods a route answers: its own for a function, GET and HEAD (and POST with actions) for a page. */
function routeMethods(route: JsonObject): string[] {
  if (route.kind !== "page") return [route.method as string];
  const actions = (route.actions as string[] | undefined) ?? [];
  return actions.length > 0 ? ["GET", "HEAD", "POST"] : ["GET", "HEAD"];
}

/** V14 (template kind matches its id) on manifest.templates. */
function templateKindProblem(id: string, kind: string): string | null {
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
  if (expected === null) return `"${id}" is not a page, layout, partial, error, or 404 template`;
  return kind === expected ? null : `"${id}" must have kind "${expected}", not "${kind}"`;
}

/** V4, V7, V8, V9, V14 (kinds), V15, V16 on a manifest that already passed the schema. */
function manifestRules(manifest: JsonObject): string[] {
  const errors: string[] = [];
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
    errors.push(`V4: app.timezone "${app.timezone}" is not an IANA time zone`);
  }

  const used = new Set<string>();
  const shapes = new Map<string, number>();
  const pageTemplates = new Map<string, number>();
  routes.forEach((route, i) => {
    const page = route.kind === "page";
    const where = page ? `routes[${i}] page ${route.path}` : `routes[${i}] ${route.method} ${route.path}`;
    const module = route.module as string | undefined;
    if (module !== undefined) {
      used.add(module);
      if (!(module in entry)) errors.push(`V7: ${where}: module "${module}" is not a key of code.entry`);
      const prefix = page ? "pages/" : "functions/";
      if (!module.startsWith(prefix)) errors.push(`V7: ${where}: module "${module}" must be under ${prefix}`);
    }
    if (!page && route.export !== route.method) {
      errors.push(`V7: ${where}: export "${route.export}" must equal the method`);
    }
    if (page) {
      const load = route.load === true;
      const actions = (route.actions as string[] | undefined) ?? [];
      const template = route.template as string | undefined;
      const htmlOnly = module === undefined && !load && actions.length === 0 && template !== undefined;
      const tsOnly = module !== undefined && load && template === undefined;
      const pair = module !== undefined && template !== undefined;
      if (!(htmlOnly || tsOnly || pair)) {
        errors.push(`V15: ${where}: module/load/actions/template is not an .html-only, .ts-only, or .ts + .html page`);
      }
      if (template !== undefined) {
        const t = templates[template];
        if (t === undefined) errors.push(`V15: ${where}: template "${template}" is not a key of templates`);
        else if (t.kind !== "page") errors.push(`V15: ${where}: template "${template}" has kind "${t.kind}", not "page"`);
        pageTemplates.set(template, (pageTemplates.get(template) ?? 0) + 1);
      }
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
    const pattern = `/${segments.map((s) => (s.kind === "static" ? `s:${s.text}` : s.kind)).join("/")}`;
    for (const method of routeMethods(route)) {
      const shape = `${method} ${pattern}`;
      const previous = shapes.get(shape);
      if (previous !== undefined) {
        errors.push(`V8: ${where}: conflicts with routes[${previous}] for ${method}`);
        break;
      }
      shapes.set(shape, i);
    }
  });
  for (const key of Object.keys(entry)) {
    if (!used.has(key)) errors.push(`V7: code.entry "${key}" is not used by any route`);
  }

  for (const [id, t] of Object.entries(templates)) {
    const problem = templateKindProblem(id, t.kind as string);
    if (problem !== null) errors.push(`V14: templates ${problem}`);
    if (t.kind === "page") {
      const count = pageTemplates.get(id) ?? 0;
      if (count !== 1) errors.push(`V15: page template "${id}" is used by ${count} page routes, expected 1`);
      const targets = new Set<string>();
      for (const [name, fragment] of Object.entries(t.fragments as JsonObject)) {
        const target = (fragment as JsonObject).target;
        if (typeof target !== "string") continue;
        if (targets.has(target)) errors.push(`V15: templates "${id}": fragment "${name}" repeats target "${target}"`);
        targets.add(target);
      }
    }
  }

  const csp = (isObject(security.csp) ? security.csp : {}) as Record<string, Json>;
  if (csp.allow_unsafe !== true) {
    for (const [key, sources] of Object.entries(csp)) {
      if (!Array.isArray(sources)) continue;
      for (const s of sources) {
        if (s === "'unsafe-inline'" || s === "'unsafe-eval'") {
          errors.push(`V16: security.csp.${key}: ${s} requires csp.allow_unsafe = true`);
        }
      }
    }
  }
  for (const [key, sources] of Object.entries(csp)) {
    if (!Array.isArray(sources) || key === "script_src" || key === "style_src") continue;
    for (const s of sources) {
      if (s === "'unsafe-inline'" || s === "'unsafe-eval'") errors.push(`V16: security.csp.${key}: ${s} is allowed only in script_src and style_src`);
    }
  }
  const cors = (isObject(security.cors) ? security.cors : {}) as Record<string, Json>;
  if (cors.credentials === true && (!Array.isArray(cors.origins) || cors.origins.length === 0)) {
    errors.push("V16: security.cors.credentials requires a non-empty cors.origins");
  }
  const answered = new Set(routes.flatMap((r) => routeMethods(r).map((m) => `${m} ${r.path}`)));
  const buckets = new Set<string>();
  ((security.ratelimit as JsonObject[] | undefined) ?? []).forEach((b, i) => {
    const key = `${b.method} ${b.path}`;
    if (!answered.has(key)) errors.push(`V16: security.ratelimit[${i}]: no route answers ${key}`);
    const bucket = `${key} ${b.key}`;
    if (buckets.has(bucket)) errors.push(`V16: security.ratelimit[${i}]: duplicate bucket ${bucket}`);
    buckets.add(bucket);
  });

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

const schemaFile = (name: string): string => `${root}/schemas/${name}.schema.json`;

/** A "message" is one JSON document kind with its schema and the semantic rules applied after it. */
interface Message {
  schema: string;
  rules?: (doc: JsonObject) => string[];
}
const messages: Record<string, Message> = {
  manifest: { schema: schemaFile("manifest"), rules: manifestRules },
  "route-table": { schema: schemaFile("route-table"), rules: routeTableRules },
  "migrations-checksums": { schema: schemaFile("migrations-checksums") },
  "public-manifest": { schema: schemaFile("public-manifest") },
  "meter-batch": { schema: schemaFile("meter-record"), rules: meterBatchRules },
};

function checkMessage(kind: string, doc: Json): string[] {
  const message = messages[kind];
  if (message === undefined) throw new Error(`unknown message kind ${kind}`);
  const errors = validate(readJson(message.schema), doc).map((e) => `schema ${e}`);
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
  const version =
    isObject(manifest) && isObject(manifest.artifact) && typeof manifest.artifact.version === "number"
      ? manifest.artifact.version
      : 0;

  const folded = new Map<string, string>();
  for (const path of files.keys()) {
    const key = path.toLowerCase();
    const other = folded.get(key);
    if (other !== undefined) errors.push(`V1: ${path} and ${other} differ only in case`);
    folded.set(key, path);
    const top = path.split("/")[0] as string;
    if (top === "policies") errors.push("V1: policies/ is reserved and must be absent");
    else if (version === 0 && (top === "templates" || path === "public.json")) {
      errors.push(`V1: ${top === "templates" ? "templates/" : "public.json"} must be absent in version 0`);
    } else if (!(path === "manifest.json" || path === "public.json" || ["code", "migrations", "public", "templates"].includes(top))) {
      errors.push(`V1: ${path}: not an allowed top-level entry`);
    }
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

  // V12: the public index is public.json in version 1 and public/manifest.json in version 0.
  const indexPath = version === 0 ? "public/manifest.json" : "public.json";
  const publicFiles = [...files.keys()].filter((p) => p.startsWith("public/"));
  if (publicFiles.length > 0 || files.has(indexPath)) {
    if (!files.has(indexPath)) errors.push(`V12: ${indexPath} is missing`);
    else {
      const index = JSON.parse(text(indexPath)) as Json;
      errors.push(...checkMessage("public-manifest", index).map((e) => `V12: ${indexPath} ${e}`));
      const listed = isObject(index) && isObject(index.files) ? index.files : {};
      const served = publicFiles.filter((p) => p !== indexPath).map((p) => p.slice("public".length));
      for (const url of served) {
        const meta = listed[url];
        const bytes = files.get(`public${url}`) as Uint8Array;
        if (!isObject(meta)) errors.push(`V12: ${url} is not in ${indexPath}`);
        else if (meta.sha256 !== sha256(bytes) || meta.size !== bytes.length) errors.push(`V12: ${url}: hash or size mismatch`);
      }
      for (const url of Object.keys(listed)) if (!served.includes(url)) errors.push(`V12: ${indexPath} lists missing ${url}`);
    }
  }

  // V14: templates/ holds exactly templates/<id>.jinja for the keys of manifest.templates, as UTF-8.
  const templateIds = Object.keys(isObject(manifest.templates) ? manifest.templates : {});
  const templateFiles = [...files.keys()].filter((p) => p.startsWith("templates/"));
  for (const p of templateFiles) {
    const id = p.slice("templates/".length).replace(/\.jinja$/u, "");
    if (!p.endsWith(".jinja") || !templateIds.includes(id)) errors.push(`V14: ${p} is not a template listed in manifest.templates`);
    else {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(files.get(p));
      } catch {
        errors.push(`V14: ${p} is not valid UTF-8`);
      }
    }
  }
  for (const id of templateIds) {
    if (!files.has(`templates/${id}.jinja`)) errors.push(`V14: templates/${id}.jinja is missing`);
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
for (const contract of ["artifact", "meter"]) {
  for (const file of listDir(`${root}/examples/${contract}`).filter((f) => f.endsWith(".json"))) {
    const kind = Object.keys(messages).find((k) => file.startsWith(`${k}.`));
    if (kind === undefined) {
      report(false, `examples/${contract}/${file}: name does not start with a known message kind`);
      continue;
    }
    checkExample(`${root}/examples/${contract}/${file}`, (doc) => checkMessage(kind, doc));
  }
}
const meterBatchErrors = checkMessage("meter-batch", readJson(`${root}/examples/meter-batch.json`));
report(meterBatchErrors.length === 0, "examples/meter-batch.json validates", meterBatchErrors);

// 4. artifact.md directories: valid artifacts pass V1-V12; broken ones fail for the named rule.
const artifacts: { dir: string; expect?: string }[] = [
  { dir: "examples/hello-artifact" },
  { dir: "examples/artifact/notes-artifact" },
  { dir: "examples/artifact/shop-artifact" },
  { dir: "examples/artifact/broken-artifact", expect: "V2" }, // a file changed after hashing
  { dir: "examples/artifact/broken-templates-artifact", expect: "V14" }, // a template file not in the manifest
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
