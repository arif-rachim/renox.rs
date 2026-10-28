// The JSON Schema 2020-12 subset used by the contract schemas in
// docs/contracts/schemas: the same subset docs/contracts/validate.ts
// implements, with no dependency. An unknown keyword is an error, so a schema
// never relies on a keyword that is silently ignored.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

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
export function unsupportedKeywords(schema: Json, at = "#"): string[] {
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
export function validate(schema: Json, value: Json, rootSchema: Json = schema, at = "$"): string[] {
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
