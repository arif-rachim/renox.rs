// A JSON Schema 2020-12 subset validator for the contract schemas in
// docs/contracts/schemas (the same subset docs/contracts/validate.ts
// implements; no dependency). An unknown keyword is reported as an error,
// so a schema never relies on a keyword that is silently ignored.

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
  "$defs",
]);

function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function canonical(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k] as Json)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function resolveRef(root: Json, ref: string): Json {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  let node: Json = root;
  for (const part of ref.slice(2).split("/")) {
    if (!isObject(node) || !(part in node)) throw new Error(`unresolved $ref ${ref}`);
    node = node[part] as Json;
  }
  return node;
}

const regexCache = new Map<string, RegExp>();
function regex(p: string): RegExp {
  let r = regexCache.get(p);
  if (!r) {
    r = new RegExp(p, "u");
    regexCache.set(p, r);
  }
  return r;
}

/** Errors of `value` against `schema`, as `"<json path>: <reason>"`. Empty when valid. */
export function validate(schema: Json, value: Json, root: Json = schema, at = "$"): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${at}: not allowed`];
  if (!isObject(schema)) return [`${at}: invalid schema`];
  const errs: string[] = [];
  const t = typeOf(value);
  for (const [key, kw] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    switch (key) {
      case "$ref":
        errs.push(...validate(resolveRef(root, kw as string), value, root, at));
        break;
      case "type": {
        const types = Array.isArray(kw) ? (kw as string[]) : [kw as string];
        const ok = types.some((ty) => ty === t || (ty === "number" && t === "integer"));
        if (!ok) errs.push(`${at}: expected ${types.join(" | ")}, got ${t}`);
        break;
      }
      case "enum":
        if (!(kw as Json[]).some((e) => canonical(e) === canonical(value))) errs.push(`${at}: not one of the allowed values`);
        break;
      case "const":
        if (canonical(kw as Json) !== canonical(value)) errs.push(`${at}: must be ${JSON.stringify(kw)}`);
        break;
      case "required":
        if (isObject(value)) for (const r of kw as string[]) if (!(r in value)) errs.push(`${at}: missing ${r}`);
        break;
      case "properties":
        if (isObject(value))
          for (const [p, sub] of Object.entries(kw as JsonObject))
            if (p in value) errs.push(...validate(sub, value[p] as Json, root, `${at}.${p}`));
        break;
      case "patternProperties":
      case "additionalProperties":
        if (isObject(value) && key === "additionalProperties") {
          const known = new Set(Object.keys((schema.properties as JsonObject | undefined) ?? {}));
          const patterns = Object.keys((schema.patternProperties as JsonObject | undefined) ?? {});
          for (const [p, v] of Object.entries(value)) {
            if (known.has(p) || patterns.some((pat) => regex(pat).test(p))) continue;
            if (kw === false) errs.push(`${at}: unknown key ${JSON.stringify(p)}`);
            else errs.push(...validate(kw as Json, v as Json, root, `${at}.${p}`));
          }
        }
        if (isObject(value) && key === "patternProperties")
          for (const [pat, sub] of Object.entries(kw as JsonObject))
            for (const [p, v] of Object.entries(value))
              if (regex(pat).test(p)) errs.push(...validate(sub, v as Json, root, `${at}.${p}`));
        break;
      case "propertyNames":
        if (isObject(value)) for (const p of Object.keys(value)) errs.push(...validate(kw as Json, p, root, `${at}[${JSON.stringify(p)}]`));
        break;
      case "minProperties":
        if (isObject(value) && Object.keys(value).length < (kw as number)) errs.push(`${at}: fewer than ${kw} properties`);
        break;
      case "maxProperties":
        if (isObject(value) && Object.keys(value).length > (kw as number)) errs.push(`${at}: more than ${kw} properties`);
        break;
      case "items":
        if (Array.isArray(value)) {
          const start = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
          value.slice(start).forEach((v, i) => errs.push(...validate(kw as Json, v, root, `${at}[${i + start}]`)));
        }
        break;
      case "prefixItems":
        if (Array.isArray(value))
          (kw as Json[]).forEach((sub, i) => {
            if (i < value.length) errs.push(...validate(sub, value[i] as Json, root, `${at}[${i}]`));
          });
        break;
      case "minItems":
        if (Array.isArray(value) && value.length < (kw as number)) errs.push(`${at}: fewer than ${kw} items`);
        break;
      case "maxItems":
        if (Array.isArray(value) && value.length > (kw as number)) errs.push(`${at}: more than ${kw} items`);
        break;
      case "uniqueItems":
        if (kw === true && Array.isArray(value) && new Set(value.map(canonical)).size !== value.length)
          errs.push(`${at}: items are not unique`);
        break;
      case "minLength":
        if (typeof value === "string" && [...value].length < (kw as number)) errs.push(`${at}: shorter than ${kw}`);
        break;
      case "maxLength":
        if (typeof value === "string" && [...value].length > (kw as number)) errs.push(`${at}: longer than ${kw}`);
        break;
      case "pattern":
        if (typeof value === "string" && !regex(kw as string).test(value)) errs.push(`${at}: does not match ${kw}`);
        break;
      case "minimum":
        if (typeof value === "number" && value < (kw as number)) errs.push(`${at}: below ${kw}`);
        break;
      case "maximum":
        if (typeof value === "number" && value > (kw as number)) errs.push(`${at}: above ${kw}`);
        break;
      case "exclusiveMinimum":
        if (typeof value === "number" && value <= (kw as number)) errs.push(`${at}: not above ${kw}`);
        break;
      case "exclusiveMaximum":
        if (typeof value === "number" && value >= (kw as number)) errs.push(`${at}: not below ${kw}`);
        break;
      case "allOf":
        for (const sub of kw as Json[]) errs.push(...validate(sub, value, root, at));
        break;
      case "anyOf":
        if (!(kw as Json[]).some((sub) => validate(sub, value, root, at).length === 0)) errs.push(`${at}: matches none of anyOf`);
        break;
      case "oneOf": {
        const n = (kw as Json[]).filter((sub) => validate(sub, value, root, at).length === 0).length;
        if (n !== 1) errs.push(`${at}: matches ${n} of oneOf`);
        break;
      }
      case "not":
        if (validate(kw as Json, value, root, at).length === 0) errs.push(`${at}: matches a forbidden schema`);
        break;
      case "if": {
        const branch = validate(kw as Json, value, root, at).length === 0 ? schema.then : schema.else;
        if (branch !== undefined) errs.push(...validate(branch as Json, value, root, at));
        break;
      }
      case "then":
      case "else":
        break;
      default:
        errs.push(`${at}: schema keyword ${key} is not supported`);
    }
  }
  return errs;
}
