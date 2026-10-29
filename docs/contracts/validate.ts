// Checks the contracts in docs/contracts against their own examples:
//   - every JSON Schema here uses only the keywords this checker implements;
//   - every *.valid.json example validates and every *.invalid.json fails, for
//     the reason named by "[expect: ...]" in its $comment when there is one;
//   - artifact directories follow docs/contracts/artifact.md (paths, content
//     hash, manifest, migrations, public files, templates, pages, security,
//     modules: rules V1-V23, versions 0, 1, 1.1 and 1.2);
//   - meter batches follow docs/contracts/meter.md (schema plus rule M1);
//   - client-event batches and raw CSP report bodies follow
//     docs/contracts/client-events.md (schema plus rules CE1 and CE2), and
//     every event kind has a valid example;
//   - the error catalogue docs/contracts/errors.md has exactly one row for
//     every code used in ops.md, deploy-api.md, schemas/deploy-api.yaml and
//     docs/23-failure-modes.md, and ctx.d.ts uses exactly the codes of ops.md
//     section 13;
//   - module manifests, renox.toml [modules] and renox.lock follow
//     docs/contracts/manifest.md (schemas plus rules MF1-MF12, single files
//     and whole example projects);
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
declare const Bun: { YAML: { parse(text: string): unknown }; TOML: { parse(text: string): unknown } };

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

/** The methods a route answers: its own for a function, GET and HEAD (and POST with actions) for a page. */
function routeMethods(route: JsonObject): string[] {
  if (route.kind !== "page") return [route.method as string];
  const actions = (route.actions as string[] | undefined) ?? [];
  return actions.length > 0 ? ["GET", "HEAD", "POST"] : ["GET", "HEAD"];
}

/** Version 1.1: ids of an installed module start with modules/<name>/; every other id is the app's. */
const MODULE_PREFIX = /^modules\/([a-z][a-z0-9_]{0,31})\//u;
const ownerOf = (id: string | undefined): string => (id === undefined ? null : MODULE_PREFIX.exec(id))?.[1] ?? "app";
const localId = (id: string): string => id.replace(MODULE_PREFIX, "");
const listOf = (v: Json | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const installedModules = (manifest: JsonObject): Map<string, JsonObject> =>
  new Map((Array.isArray(manifest.modules) ? (manifest.modules as JsonObject[]) : []).map((m) => [m.name as string, m]));

/** V17, V18, V21 (mounts), V22 on the modules, slots, and module-owned ids of a manifest that passed the schema. */
function artifactModuleRules(manifest: JsonObject): string[] {
  const errors: string[] = [];
  const listed = new Map<string, JsonObject>();
  (Array.isArray(manifest.modules) ? (manifest.modules as JsonObject[]) : []).forEach((m, i) => {
    const name = m.name as string;
    const where = `modules[${i}] ${name}`;
    for (const problem of [name.includes("__") ? 'contains "__"' : null, name.endsWith("_") ? 'ends with "_"' : null, name === "app" || name === "renox" ? "is reserved" : null]) {
      if (problem !== null) errors.push(`V17: ${where}: name ${problem}`);
    }
    if (listed.has(name)) errors.push(`V17: ${where}: listed twice`);
    for (const dep of listOf(m.dependencies)) if (!listed.has(dep)) errors.push(`V17: ${where}: depends on ${dep}, which is not listed before it`);
    for (const which of ["permissions", "approved"]) {
      const p = m[which] as JsonObject;
      if (p.tables !== undefined && p.tables !== `${name}__*`) errors.push(`V17: ${where}: ${which}.tables "${p.tables}" is not "${name}__*"`);
      for (const secret of listOf(p.secrets)) if (!secret.startsWith(`${name.toUpperCase()}_`)) errors.push(`V17: ${where}: ${which}.secrets "${secret}" does not start with ${name.toUpperCase()}_`);
    }
    const permissions = m.permissions as JsonObject;
    const approved = m.approved as JsonObject;
    if (permissions.tables !== undefined && permissions.tables !== approved.tables) errors.push(`V22: ${where}: tables "${permissions.tables}" were not approved`);
    for (const key of ["network", "secrets", "slots", "hooks"]) {
      for (const v of listOf(permissions[key])) if (!listOf(approved[key]).includes(v)) errors.push(`V22: ${where}: ${key} "${v}" was not approved`);
    }
    listed.set(name, m);
  });

  const entry = (manifest.code as JsonObject).entry as JsonObject;
  for (const [id, path] of Object.entries(entry)) {
    const owner = ownerOf(id);
    if (owner === "app") {
      if ((path as string).startsWith("modules/")) errors.push(`V18: code.entry "${id}": an app module may not live under code/modules/`);
    } else if (!listed.has(owner)) errors.push(`V18: code.entry "${id}": module "${owner}" is not in modules`);
    else if (!(path as string).startsWith(`modules/${owner}/`)) errors.push(`V18: code.entry "${id}": code/${path} is not under code/modules/${owner}/`);
  }
  for (const [name, m] of listed) {
    if (listOf((m.exports as JsonObject).services).length > 0 && !(`modules/${name}/services` in entry)) errors.push(`V18: ${name} exports services but has no modules/${name}/services entry`);
  }
  const templates = (isObject(manifest.templates) ? manifest.templates : {}) as Record<string, JsonObject>;
  for (const id of Object.keys(templates)) {
    const owner = ownerOf(id);
    if (owner !== "app" && !listed.has(owner)) errors.push(`V18: templates "${id}": module "${owner}" is not in modules`);
  }
  for (const [slot, fills] of Object.entries(isObject(manifest.slots) ? manifest.slots : {})) {
    (fills as JsonObject[]).forEach((f, i) => {
      const where = `slots.${slot}[${i}]`;
      const m = listed.get(f.module as string);
      if (m === undefined) return void errors.push(`V18: ${where}: module "${f.module}" is not in modules`);
      const template = f.template as string;
      if (ownerOf(template) !== f.module) errors.push(`V18: ${where}: template "${template}" is not under modules/${f.module}/`);
      else if (templates[template]?.kind !== "partial") errors.push(`V18: ${where}: template "${template}" is not a partial of templates`);
      if (!listOf((m.permissions as JsonObject).slots).includes(slot)) errors.push(`V22: ${where}: ${f.module} does not have the slot "${slot}" in its permissions`);
    });
  }
  (manifest.routes as JsonObject[]).forEach((route, i) => {
    const owner = ownerOf((route.module ?? route.template) as string | undefined);
    if (owner === "app") return;
    const m = listed.get(owner);
    if (m === undefined) return void errors.push(`V18: routes[${i}]: module "${owner}" is not in modules`);
    const mount = m.mount as string;
    const path = route.path as string;
    if (mount !== "/" && path !== mount && !path.startsWith(`${mount}/`)) errors.push(`V21: routes[${i}] ${path} is not under ${owner}'s mount ${mount}`);
  });
  return errors;
}

/** V14 (template kind matches its id) on manifest.templates; a module's ids are read without modules/<name>/. */
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

/** V4, V7, V8, V9, V14 (kinds), V15, V16, V17, V18, V21, V22 on a manifest that already passed the schema. */
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
      if (!localId(module).startsWith(prefix)) errors.push(`V7: ${where}: module "${module}" must be under ${prefix}`);
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
        // Routes of different owners (the app, installed modules) collide after mounting: V21.
        const other = routes[previous] as JsonObject;
        const same = ownerOf((other.module ?? other.template) as string | undefined) === ownerOf(module ?? (route.template as string | undefined));
        errors.push(`${same ? "V8" : "V21"}: ${where}: conflicts with routes[${previous}] for ${method}`);
        break;
      }
      shapes.set(shape, i);
    }
  });
  for (const key of Object.keys(entry)) {
    // A module's services and hooks entries are loaded by the bootstrap, not by a route.
    if (!used.has(key) && !/^modules\/[a-z][a-z0-9_]{0,31}\/(services|hooks)$/u.test(key)) errors.push(`V7: code.entry "${key}" is not used by any route`);
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
  errors.push(...artifactModuleRules(manifest));
  errors.push(...entriesRules(manifest));
  return errors;
}

/**
 * V23 (version 1.2): `entries` names exactly the `code.entry` ids; each
 * route's handler is among its module's recorded exports (`export` of a
 * function route, `load` and `actions` of a page route); a module's
 * `services` entry exports every service of `exports.services`, and the
 * `services` and `hooks` entries stay eager (ops.md 1.4.0 section 11).
 */
function entriesRules(manifest: JsonObject): string[] {
  if (!isObject(manifest.entries)) return [];
  const errors: string[] = [];
  const version = (manifest.artifact as JsonObject).version;
  if (version !== 1) errors.push(`V23: entries needs artifact.version 1 (version 1.2), got ${version}`);
  const entries = manifest.entries as Record<string, JsonObject>;
  const code = (manifest.code as JsonObject).entry as JsonObject;
  for (const id of Object.keys(code)) if (!(id in entries)) errors.push(`V23: code.entry "${id}" has no entries record`);
  for (const id of Object.keys(entries)) if (!(id in code)) errors.push(`V23: entries "${id}" is not a key of code.entry`);
  const exportsOf = (id: string): string[] => (Array.isArray(entries[id]?.exports) ? (entries[id]?.exports as string[]) : []);
  for (const [i, route] of (manifest.routes as JsonObject[]).entries()) {
    const id = route.module as string | undefined;
    if (id === undefined || !(id in entries)) continue;
    const need: string[] = [];
    if (route.kind === "function" && typeof route.export === "string") need.push(route.export);
    if (route.kind === "page") {
      if (route.load === true) need.push("load");
      if (Array.isArray(route.actions) && route.actions.length > 0) need.push("actions");
    }
    for (const name of need) if (!exportsOf(id).includes(name)) errors.push(`V23: routes[${i}]: module "${id}" does not export "${name}"`);
  }
  for (const m of Array.isArray(manifest.modules) ? (manifest.modules as JsonObject[]) : []) {
    for (const part of ["services", "hooks"]) {
      const id = `modules/${m.name}/${part}`;
      if (entries[id]?.eager === false) errors.push(`V23: entries "${id}" must be eager (hooks and services are checked at isolate creation)`);
    }
    const services = isObject(m.exports) && Array.isArray(m.exports.services) ? (m.exports.services as string[]) : [];
    const id = `modules/${m.name}/services`;
    if (id in entries) for (const s of services) if (!exportsOf(id).includes(s)) errors.push(`V23: "${id}" does not export service "${s}"`);
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

/** client-events.md: CE1, the request body is at most 32 KB; CE2, `extra` is at most 1 KB of JSON. */
const MAX_CLIENT_BODY_BYTES = 32 * 1024;
const MAX_CLIENT_EXTRA_BYTES = 1024;
function clientEventRules(batch: JsonObject): string[] {
  const errors: string[] = [];
  const { $comment: _ignored, ...body } = batch;
  const bytes = encoder.encode(JSON.stringify(body)).length;
  if (bytes > MAX_CLIENT_BODY_BYTES) errors.push(`CE1: body is ${bytes} bytes, limit ${MAX_CLIENT_BODY_BYTES}`);
  (batch.events as JsonObject[]).forEach((e, i) => {
    if (e.extra === undefined) return;
    const size = encoder.encode(JSON.stringify(e.extra)).length;
    if (size > MAX_CLIENT_EXTRA_BYTES) errors.push(`CE2: events[${i}].extra is ${size} bytes, limit ${MAX_CLIENT_EXTRA_BYTES}`);
  });
  return errors;
}

// ---------------------------------------------------------------------------
// manifest.md: module.toml, renox.toml [modules], renox.lock (MF1-MF12)
// ---------------------------------------------------------------------------

const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
const strings = (v: Json | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

type Semver = [number, number, number, string[]];
function parseVersion(v: string): Semver | null {
  const m = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/u.exec(v);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? [] : m[4].split(".")];
}
/** Semver precedence: a release is above its pre-releases; numeric identifiers compare as numbers. */
function compareVersions(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  const [pa, pb] = [a[3], b[3]];
  if (pa.length === 0 || pb.length === 0) return pb.length - pa.length;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const [x, y] = [pa[i] as string, pb[i] as string];
    if (x === y) continue;
    const [nx, ny] = [/^[0-9]+$/u.test(x), /^[0-9]+$/u.test(y)];
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}
/** manifest.md section 2: does `version` satisfy `range`? A pre-release satisfies only an exact range. */
function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (v === null) return false;
  const interval = /^>=(\S+) <(\S+)$/u.exec(range);
  if (interval !== null) {
    const [lo, hi] = [parseVersion(interval[1] as string), parseVersion(interval[2] as string)];
    return lo !== null && hi !== null && v[3].length === 0 && compareVersions(v, lo) >= 0 && compareVersions(v, hi) < 0;
  }
  const loose = /^([~^])(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?(?:\.(0|[1-9][0-9]*))?$/u.exec(range);
  if (loose !== null) {
    if (v[3].length > 0) return false;
    const parts = [loose[2], loose[3], loose[4]].filter((p) => p !== undefined).map(Number);
    const lo: Semver = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, []];
    const hi: Semver = [0, 0, 0, []];
    // ~: the next minor (the next major for ~X); ^: the next change of the left-most non-zero part given.
    const nonZero = parts.findIndex((p) => p !== 0);
    const at = loose[1] === "~" ? Math.min(parts.length - 1, 1) : nonZero === -1 ? parts.length - 1 : nonZero;
    for (let i = 0; i < at; i++) hi[i] = lo[i] as number;
    hi[at] = (lo[at] as number) + 1;
    return compareVersions(v, lo) >= 0 && compareVersions(v, hi) < 0;
  }
  const exact = parseVersion(range.replace(/^=/u, ""));
  return exact !== null && compareVersions(v, exact) === 0;
}

/** MF1. Returns the reason, or null when `name` may be a module name. */
function moduleNameProblem(name: string): string | null {
  if (!/^[a-z][a-z0-9_]{0,31}$/u.test(name)) return "does not match ^[a-z][a-z0-9_]{0,31}$";
  if (name.includes("__")) return 'contains "__"';
  if (name.endsWith("_")) return 'ends with "_"';
  if (name === "app" || name === "renox") return "is reserved";
  return null;
}

/** MF4 on a [permissions] table or a lock entry's `approved`. */
function permissionRules(name: string, permissions: JsonObject, where: string): string[] {
  const errors: string[] = [];
  if (permissions.tables !== undefined && permissions.tables !== `${name}__*`) {
    errors.push(`MF4: ${where}.tables "${permissions.tables}" is not "${name}__*"`);
  }
  for (const secret of strings(permissions.secrets)) {
    if (!secret.startsWith(`${name.toUpperCase()}_`)) errors.push(`MF4: ${where}.secrets "${secret}" does not start with ${name.toUpperCase()}_`);
  }
  return errors;
}

/** MF10: the reason a config value does not fit its declaration, or null. */
function configValueProblem(decl: JsonObject, value: Json): string | null {
  switch (decl.type) {
    case "string":
      if (typeof value !== "string") return "is not a string";
      return [...value].length > ((decl.max_length as number | undefined) ?? 4096) ? "is longer than max_length" : null;
    case "enum":
      return typeof value === "string" && strings(decl.values).includes(value) ? null : `is not one of ${JSON.stringify(decl.values)}`;
    case "int":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return "is not an int";
      if (typeof decl.min === "number" && value < decl.min) return `is below min ${decl.min}`;
      if (typeof decl.max === "number" && value > decl.max) return `is above max ${decl.max}`;
      return null;
    case "bool":
      return typeof value === "boolean" ? null : "is not a bool";
    default:
      return "has an unknown type";
  }
}

/** MF1, MF4, MF5 (self), MF6, MF8, MF9, MF10 on a module.toml that passed the schema. */
function moduleRules(doc: JsonObject): string[] {
  const errors: string[] = [];
  const name = (doc.module as JsonObject).name as string;
  const problem = moduleNameProblem(name);
  if (problem !== null) errors.push(`MF1: [module].name "${name}" ${problem}`);
  for (const dep of Object.keys(obj(doc.dependencies))) {
    const p = moduleNameProblem(dep);
    if (p !== null) errors.push(`MF1: [dependencies] "${dep}" ${p}`);
    if (dep === name) errors.push(`MF5: ${name} depends on itself`);
  }
  const permissions = obj(doc.permissions);
  errors.push(...permissionRules(name, permissions, "[permissions]"));

  const exports = obj(doc.exports);
  const view = new RegExp(`^${name}__public_[a-z0-9_]+_v[1-9][0-9]*$`, "u");
  for (const v of strings(exports.views)) if (!view.test(v)) errors.push(`MF6: view "${v}" is not ${name}__public_<id>_v<n>`);
  for (const [kind, entries] of [["event", obj(exports.events)], ["hook", obj(exports.hooks)]] as const) {
    for (const [n, entry] of Object.entries(entries)) {
      if (!n.startsWith(`${name}.`)) errors.push(`MF6: ${kind} "${n}" does not start with "${name}."`);
      for (const key of ["payload", "args", "result"]) {
        const schema = obj(entry)[key];
        if (schema !== undefined) for (const p of unsupportedKeywords(schema)) errors.push(`MF6: ${kind} "${n}" ${key} ${p}`);
      }
    }
  }

  const slots = (doc.slots as JsonObject[] | undefined) ?? [];
  const filled = new Set(slots.map((s) => s.name as string));
  const asked = new Set(strings(permissions.slots));
  for (const s of filled) if (!asked.has(s)) errors.push(`MF8: [[slots]] fills "${s}" but permissions.slots does not list it`);
  for (const s of asked) if (!filled.has(s)) errors.push(`MF8: permissions.slots lists "${s}" but no [[slots]] fills it`);
  for (const h of strings(permissions.hooks)) if (h.startsWith(`${name}.`)) errors.push(`MF8: permissions.hooks "${h}" is a hook of ${name} itself`);

  const actions = new Set(strings(obj(doc.authz).actions));
  slots.forEach((s, i) => {
    if (typeof s.requires === "string" && !actions.has(s.requires)) errors.push(`MF9: slots[${i}].requires "${s.requires}" is not in [authz].actions`);
  });
  ((doc.tools as JsonObject[] | undefined) ?? []).forEach((t, i) => {
    if (!actions.has(t.action as string)) errors.push(`MF9: tools[${i}].action "${t.action}" is not in [authz].actions`);
  });

  for (const [key, raw] of Object.entries(obj(doc.config))) {
    const decl = obj(raw);
    if (typeof decl.min === "number" && typeof decl.max === "number" && decl.min > decl.max) errors.push(`MF10: config.${key}: min is above max`);
    if (decl.default === undefined) continue;
    const p = configValueProblem(decl, decl.default);
    if (p !== null) errors.push(`MF10: config.${key}: default ${JSON.stringify(decl.default)} ${p}`);
    if (decl.required === true) errors.push(`MF10: config.${key}: required = true with a default`);
  }
  return errors;
}

/** MF1 on a renox.toml that passed the schema. */
function renoxRules(doc: JsonObject): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(obj(doc.modules))) {
    const p = moduleNameProblem(key);
    if (p !== null) errors.push(`MF1: [modules] "${key}" ${p}`);
  }
  return errors;
}

/** MF1, MF3 (unique names), MF4 (approved), MF5 (order) on a renox.lock that passed the schema. */
function lockRules(doc: JsonObject): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const e of doc.module as JsonObject[]) {
    const name = e.name as string;
    const p = moduleNameProblem(name);
    if (p !== null) errors.push(`MF1: lock entry "${name}" ${p}`);
    if (seen.has(name)) errors.push(`MF3: "${name}" has more than one lock entry`);
    for (const dep of strings(e.dependencies)) if (!seen.has(dep)) errors.push(`MF5: ${name} is listed before its dependency ${dep} (or ${dep} is not installed)`);
    seen.add(name);
    errors.push(...permissionRules(name, obj(e.approved), `${name}.approved`));
  }
  return errors;
}

/** Every regular file under `dir`, keyed by its path relative to `dir`. */
function readTreeFiles(dir: string, prefix = ""): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const d of fs.readdirSync(prefix === "" ? dir : `${dir}/${prefix}`, { withFileTypes: true })) {
    const path = prefix === "" ? d.name : `${prefix}/${d.name}`;
    if (d.isDirectory()) for (const [k, v] of readTreeFiles(dir, path)) out.set(k, v);
    else if (d.isFile()) out.set(path, fs.readFileSync(`${dir}/${path}`));
  }
  return out;
}

const normalisedPermissions = (p: JsonObject): string =>
  canonical({
    tables: (p.tables as Json | undefined) ?? null,
    network: strings(p.network).sort(),
    secrets: strings(p.secrets).sort(),
    slots: strings(p.slots).sort(),
    hooks: strings(p.hooks).sort(),
  });

/** The project rules (MF2, MF3, MF5, MF7-MF12) on an example app: renox.toml, renox.lock, path: module trees. */
function checkProject(dir: string): string[] {
  const errors: string[] = [];
  const toml = (path: string): Json => Bun.TOML.parse(fs.readFileSync(path, "utf8")) as Json;
  const renox = toml(`${dir}/renox.toml`);
  const lock = toml(`${dir}/renox.lock`);
  errors.push(...checkMessage("renox", renox).map((e) => `renox.toml ${e}`));
  errors.push(...checkMessage("renox-lock", lock).map((e) => `renox.lock ${e}`));
  if (errors.some((e) => e.includes(" schema ")) || !isObject(renox) || !isObject(lock)) return errors;

  const installed = obj(renox.modules) as Record<string, JsonObject>;
  const entries = new Map((lock.module as JsonObject[]).map((e) => [e.name as string, e]));
  const manifests = new Map<string, JsonObject>();
  const trees = new Map<string, string>();
  for (const [key, m] of Object.entries(installed)) {
    const source = m.source as string | undefined;
    if (source === undefined || !source.startsWith("path:")) continue; // official and git trees are not in the examples
    const tree = `${dir}/${source.slice("path:".length)}`;
    if (!fs.existsSync(`${tree}/module.toml`)) {
      errors.push(`MF12: ${key}: ${source}/module.toml is missing`);
      continue;
    }
    const manifest = toml(`${tree}/module.toml`);
    const manifestErrors = checkMessage("module", manifest);
    errors.push(...manifestErrors.map((e) => `${source.slice("path:".length)}/module.toml ${e}`));
    if (isObject(manifest) && !manifestErrors.some((e) => e.startsWith("schema"))) {
      manifests.set(key, manifest);
      trees.set(key, tree);
    }
  }
  const manifestOf = (name: string): JsonObject => manifests.get(name) ?? {};

  // MF3: one install per name and prefix; renox.toml and the lock list the same modules.
  const byName = new Map<string, string>();
  for (const [key, manifest] of manifests) {
    const name = (manifest.module as JsonObject).name as string;
    if (name !== key) errors.push(`MF3: renox.toml key "${key}" installs the module named "${name}"`);
    const other = byName.get(name);
    if (other !== undefined) errors.push(`MF3: module "${name}" is installed as "${other}" and as "${key}"`);
    byName.set(name, key);
  }
  for (const a of Object.keys(installed)) {
    for (const b of Object.keys(installed)) if (a !== b && b.startsWith(`${a}__`)) errors.push(`MF3: the prefix ${a}__ is a prefix of ${b}__`);
    if (!entries.has(a)) errors.push(`MF3: renox.toml module "${a}" has no renox.lock entry`);
  }
  for (const name of entries.keys()) if (!(name in installed)) errors.push(`MF3: renox.lock entry "${name}" is not in renox.toml`);

  // MF5: every dependency is installed; no cycle.
  for (const [key, manifest] of manifests) {
    for (const dep of Object.keys(obj(manifest.dependencies))) if (!(dep in installed)) errors.push(`MF5: ${key} depends on ${dep}, which is not installed`);
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      errors.push(`MF5: dependency cycle ${[...path.slice(path.indexOf(name)), name].join(" -> ")}`);
      return;
    }
    state.set(name, "visiting");
    for (const dep of Object.keys(obj(manifestOf(name).dependencies))) if (manifests.has(dep)) visit(dep, [...path, name]);
    state.set(name, "done");
  };
  for (const name of manifests.keys()) visit(name, []);

  // MF2: the locked version satisfies the tenant's range and every dependant's range.
  for (const [key, m] of Object.entries(installed)) {
    const e = entries.get(key);
    if (e !== undefined && !satisfies(e.version as string, m.version as string)) errors.push(`MF2: ${key} ${e.version} does not satisfy renox.toml "${m.version}"`);
  }
  for (const [key, manifest] of manifests) {
    for (const [dep, range] of Object.entries(obj(manifest.dependencies))) {
      const e = entries.get(dep);
      if (e !== undefined && !satisfies(e.version as string, range as string)) errors.push(`MF2: ${dep} ${e.version} does not satisfy ${key}'s range "${range}"`);
    }
  }

  // MF7: imports come from declared dependencies that export them.
  for (const [key, manifest] of manifests) {
    const deps = obj(manifest.dependencies);
    const imports = obj(manifest.imports);
    const uses: [string, string, (dep: JsonObject) => boolean][] = [
      ...strings(imports.services).map((s): [string, string, (d: JsonObject) => boolean] => {
        const [dep, service] = s.split(".") as [string, string];
        return [s, dep, (d) => service in obj(obj(d.exports).services)];
      }),
      ...strings(imports.views).map((v): [string, string, (d: JsonObject) => boolean] => [v, v.split("__")[0] as string, (d) => strings(obj(d.exports).views).includes(v)]),
    ];
    for (const [what, dep, exported] of uses) {
      if (!(dep in deps)) errors.push(`MF7: ${key} imports ${what}, but ${dep} is not in its [dependencies]`);
      else if (manifests.has(dep) && !exported(manifestOf(dep))) {
        errors.push(`MF7: ${key} imports ${what}, which ${dep} ${(manifestOf(dep).module as JsonObject).version} does not export`);
      }
    }
  }

  // MF8: filled hooks are exported by another installed module. MF9: slot templates exist.
  const hookOwners = new Map<string, string>();
  for (const [key, manifest] of manifests) for (const h of Object.keys(obj(obj(manifest.exports).hooks))) hookOwners.set(h, key);
  for (const [key, manifest] of manifests) {
    for (const h of strings(obj(manifest.permissions).hooks)) {
      const owner = hookOwners.get(h);
      if (owner === undefined || owner === key) errors.push(`MF8: ${key} fills hook "${h}", which no other installed module exports`);
    }
    for (const s of (manifest.slots as JsonObject[] | undefined) ?? []) {
      if (!fs.existsSync(`${trees.get(key)}/${s.template}`)) errors.push(`MF9: ${key}: slot template ${s.template} is not in the module tree`);
    }
  }

  for (const [key, m] of Object.entries(installed)) {
    const manifest = manifests.get(key);
    if (manifest === undefined) continue;
    const module = manifest.module as JsonObject;

    // MF10: renox.toml config values against the declarations; the resolved config.
    const decls = obj(manifest.config);
    const values = obj(m.config);
    const resolved: JsonObject = {};
    for (const [k, v] of Object.entries(values)) {
      if (!(k in decls)) errors.push(`MF10: ${key}.config.${k} is not declared in its [config]`);
      else {
        const p = configValueProblem(obj(decls[k]), v);
        if (p !== null) errors.push(`MF10: ${key}.config.${k} = ${JSON.stringify(v)} ${p}`);
      }
    }
    for (const [k, raw] of Object.entries(decls)) {
      const decl = obj(raw);
      const value = k in values ? values[k] : decl.default;
      if (value !== undefined) resolved[k] = value as Json;
      else if ((decl.required as boolean | undefined) ?? true) errors.push(`MF10: ${key}.config.${k} is required and has no value`);
    }

    // MF11: isolation is raised, never lowered.
    const rank = (i: Json | undefined): number => (i === "isolate" ? 1 : 0);
    const declared = (module.isolation as string | undefined) ?? "shared";
    const effective = (m.isolation as string | undefined) ?? declared;
    if (rank(effective) < rank(declared)) errors.push(`MF11: ${key}: renox.toml lowers isolation from ${declared} to ${effective}`);

    // MF12: the lock entry matches the manifest, the tree, and renox.toml.
    const e = entries.get(key);
    if (e === undefined) continue;
    const mismatch = (field: string, locked: Json | undefined, actual: Json | undefined): void => {
      if (canonical(locked ?? null) !== canonical(actual ?? null)) errors.push(`MF12: ${key}.${field} in renox.lock is ${JSON.stringify(locked)}, expected ${JSON.stringify(actual)}`);
    };
    mismatch("version", e.version, module.version);
    mismatch("hash", e.hash, contentHash(readTreeFiles(trees.get(key) as string)));
    mismatch("dependencies", e.dependencies, Object.keys(obj(manifest.dependencies)).sort());
    mismatch("config", e.config, resolved);
    mismatch("mount", e.mount, (m.mount as string | undefined) ?? `/${key}`);
    mismatch("source", e.source, (m.source as string | undefined) ?? "official");
    mismatch("isolation", e.isolation, effective);
    if (normalisedPermissions(obj(e.approved)) !== normalisedPermissions(obj(manifest.permissions))) {
      errors.push(`MF12: ${key}: [permissions] differ from the approved permissions in renox.lock; run renox approve ${key}`);
    }
  }
  return errors;
}

const schemaFile = (name: string): string => `${root}/schemas/${name}.schema.json`;

/**
 * A "message" is one JSON document kind with its schema and the semantic rules applied after it.
 * `def` validates against one `$defs` entry instead of the root. `wrapped` messages are raw wire
 * bodies (possibly arrays), written in examples as `{ "$comment": ..., "body": <raw body> }`.
 */
interface Message {
  schema: string;
  def?: string;
  wrapped?: boolean;
  rules?: (doc: JsonObject) => string[];
}
const messages: Record<string, Message> = {
  manifest: { schema: schemaFile("manifest"), rules: manifestRules },
  "route-table": { schema: schemaFile("route-table"), rules: routeTableRules },
  "migrations-checksums": { schema: schemaFile("migrations-checksums") },
  "overrides-index": { schema: schemaFile("manifest"), def: "overridesIndex" },
  "public-manifest": { schema: schemaFile("public-manifest") },
  "meter-batch": { schema: schemaFile("meter-record"), rules: meterBatchRules },
  "client-events": { schema: schemaFile("client-event"), rules: clientEventRules },
  "csp-report": { schema: schemaFile("client-event"), def: "cspReport", wrapped: true },
  "reports-json": { schema: schemaFile("client-event"), def: "reportsJson", wrapped: true },
  module: { schema: schemaFile("module-manifest"), rules: moduleRules },
  renox: { schema: schemaFile("module-manifest"), def: "renoxToml", rules: renoxRules },
  "renox-lock": { schema: schemaFile("renox-lock"), rules: lockRules },
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
  const target = message.def === undefined ? schema : resolveRef(schema, `#/$defs/${message.def}`);
  const body = message.wrapped === true && isObject(doc) ? (doc.body as Json) : doc;
  const errors = validate(target, body, schema).map((e) => `schema ${e}`);
  if (errors.length === 0 && message.rules !== undefined && isObject(doc)) errors.push(...message.rules(doc));
  return errors;
}

/** Walks an artifact directory and applies V1-V23. Returns one line per violation. */
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
  // Version 1.1: policies/, overrides/ and overrides.json belong to installed modules.
  const withModules = version >= 1 && isObject(manifest) && Array.isArray(manifest.modules) && manifest.modules.length > 0;

  const folded = new Map<string, string>();
  for (const path of files.keys()) {
    const key = path.toLowerCase();
    const other = folded.get(key);
    if (other !== undefined) errors.push(`V1: ${path} and ${other} differ only in case`);
    folded.set(key, path);
    const top = path.split("/")[0] as string;
    if (withModules && (top === "policies" || top === "overrides" || path === "overrides.json")) continue;
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
  if (!withModules) return errors;

  // V18: policies/<module>/<name>.cedar of installed modules (carried, evaluated from F5).
  const listed = installedModules(manifest);
  const paths = [...files.keys()];
  for (const p of paths.filter((f) => f.startsWith("policies/"))) {
    const m = /^policies\/([a-z][a-z0-9_]{0,31})\/[A-Za-z0-9_.-]+\.cedar$/u.exec(p);
    if (m === null) errors.push(`V18: ${p}: not policies/<module>/<name>.cedar`);
    else if (!listed.has(m[1] as string)) errors.push(`V18: ${p}: module "${m[1]}" is not in modules`);
  }
  // V19: migrations for every module that has tables, and none for a module that is not installed with tables.
  const migrated = new Set(paths.filter((p) => /^migrations\/[^/]+\/.+\.sql$/u.test(p)).map((p) => p.split("/")[1] as string));
  for (const [name, m] of listed) {
    if ((m.permissions as JsonObject).tables !== undefined && !migrated.has(name)) errors.push(`V19: ${name} declares tables but has no migrations/${name}/`);
  }
  for (const name of migrated) {
    if (name !== "app" && (listed.get(name)?.permissions as JsonObject | undefined)?.tables === undefined) errors.push(`V19: migrations/${name}/: ${name} is not an installed module with tables`);
  }
  // V20: overrides.json lists exactly the files under overrides/, each replacing a template of its module.
  const overrideFiles = paths.filter((p) => p.startsWith("overrides/")).map((p) => p.slice("overrides/".length));
  if (overrideFiles.length > 0 || files.has("overrides.json")) {
    if (!files.has("overrides.json")) errors.push("V20: overrides.json is missing");
    else {
      const index = JSON.parse(text("overrides.json")) as Json;
      errors.push(...checkMessage("overrides-index", index).map((e) => `V20: overrides.json ${e}`));
      const listedFiles = isObject(index) && isObject(index.files) ? index.files : {};
      const templates = isObject(manifest.templates) ? manifest.templates : {};
      for (const f of overrideFiles) if (!(f in listedFiles)) errors.push(`V20: overrides/${f} is not in overrides.json`);
      for (const [f, raw] of Object.entries(listedFiles)) {
        const owner = f.split("/")[0] as string;
        const expected = `modules/${f.replace(/\.html$/u, "")}`;
        const template = isObject(raw) ? raw.template : undefined;
        if (!overrideFiles.includes(f)) errors.push(`V20: overrides.json lists missing overrides/${f}`);
        if (!listed.has(owner)) errors.push(`V20: overrides/${f}: module "${owner}" is not in modules`);
        if (template !== expected) errors.push(`V20: overrides/${f}: template must be "${expected}"`);
        else if (!(expected in templates)) errors.push(`V20: overrides/${f}: template "${expected}" is not in manifest.templates`);
      }
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
for (const contract of ["artifact", "meter", "client-events", "deploy-api"]) {
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
// 3b. manifest.md examples: single TOML files (examples/manifest/<kind>.<case>.(valid|invalid).toml)
//     and whole projects (examples/manifest/projects/<case>.(valid|invalid)/). The reason of an
//     invalid one is "[expect: ...]" in a TOML comment (for a project, in its renox.toml).
const manifestDir = `${root}/examples/manifest`;
const manifestExpects = new Set<string>();
const judge = (label: string, valid: boolean, errors: string[], text: string): void => {
  if (valid) return report(errors.length === 0, `${label} validates`, errors);
  const expect = /\[expect: ([^\]]+)\]/u.exec(text)?.[1];
  if (expect !== undefined) manifestExpects.add(expect);
  const ok = errors.length > 0 && (expect === undefined || errors.some((e) => e.includes(expect)));
  report(ok, `${label} is rejected${expect === undefined ? "" : ` (${expect})`}`, errors.length > 0 ? errors : ["no error"]);
};
const manifestCounts: Record<string, { valid: number; invalid: number }> = { module: { valid: 0, invalid: 0 }, renox: { valid: 0, invalid: 0 }, "renox-lock": { valid: 0, invalid: 0 } };
for (const file of listDir(manifestDir).filter((f) => f.endsWith(".toml"))) {
  const kind = ["renox-lock", "renox", "module"].find((k) => file.startsWith(`${k}.`));
  const valid = file.endsWith(".valid.toml");
  if (kind === undefined || (!valid && !file.endsWith(".invalid.toml"))) {
    report(false, `examples/manifest/${file}: not <module|renox|renox-lock>.<case>.(valid|invalid).toml`);
    continue;
  }
  (manifestCounts[kind] as { valid: number; invalid: number })[valid ? "valid" : "invalid"]++;
  const text = fs.readFileSync(`${manifestDir}/${file}`, "utf8");
  let errors: string[];
  try {
    errors = checkMessage(kind, Bun.TOML.parse(text) as Json);
  } catch (e) {
    errors = [`not TOML: ${String(e)}`];
  }
  judge(`examples/manifest/${file}`, valid, errors, text);
}
for (const name of listDir(`${manifestDir}/projects`)) {
  const valid = name.endsWith(".valid");
  const dir = `${manifestDir}/projects/${name}`;
  judge(`examples/manifest/projects/${name}`, valid, checkProject(dir), fs.readFileSync(`${dir}/renox.toml`, "utf8"));
}
for (const [kind, { valid, invalid }] of Object.entries(manifestCounts)) {
  report(valid >= 1 && invalid >= 3, `manifest ${kind}: ${valid} valid and ${invalid} invalid examples (at least 1 and 3)`);
}
const mfMissing = Array.from({ length: 12 }, (_, i) => `MF${i + 1}`).filter((r) => !manifestExpects.has(r));
report(mfMissing.length === 0, "every rule MF1-MF12 has an invalid example that fails for it", mfMissing.map((r) => `${r} has none`));

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

// client-events.md: every event kind has at least one valid example.
const clientKinds = (resolveRef(readJson(schemaFile("client-event")), "#/$defs/kind") as JsonObject).enum as string[];
const exampleKinds = new Set<string>();
for (const file of listDir(`${root}/examples/client-events`).filter((f) => f.startsWith("client-events.") && f.endsWith(".valid.json"))) {
  const doc = readJson(`${root}/examples/client-events/${file}`);
  if (isObject(doc) && Array.isArray(doc.events)) for (const e of doc.events) if (isObject(e)) exampleKinds.add(e.kind as string);
}
const kindsWithout = clientKinds.filter((k) => !exampleKinds.has(k)).map((k) => `${k} has no valid example`);
report(kindsWithout.length === 0, `every client event kind has a valid example (${clientKinds.length} kinds)`, kindsWithout);

// 4. artifact.md directories: valid artifacts pass V1-V23; broken ones fail for the named rule.
const artifacts: { dir: string; expect?: string }[] = [
  { dir: "examples/hello-artifact" },
  { dir: "examples/artifact/notes-artifact" },
  { dir: "examples/artifact/shop-artifact" },
  { dir: "examples/artifact/broken-artifact", expect: "V2" }, // a file changed after hashing
  { dir: "examples/artifact/broken-templates-artifact", expect: "V14" }, // a template file not in the manifest
  { dir: "examples/artifact/modules-artifact" }, // version 1.1: the auth module mounted at /auth
  { dir: "examples/artifact/broken-module-migrations-artifact", expect: "V19" }, // auth has tables but no migrations
  { dir: "examples/artifact/broken-override-artifact", expect: "V20" }, // an override not in overrides.json
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
