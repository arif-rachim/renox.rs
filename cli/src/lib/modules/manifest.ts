// module.toml (docs/contracts/manifest.md section 2): read, validate against
// schemas/module-manifest.schema.json, and the single-file rules MF1, MF4,
// MF5 (self), MF6, MF8, MF9, MF10.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import manifestSchema from "../../../../docs/contracts/schemas/module-manifest.schema.json";
import lockSchema from "../../../../docs/contracts/schemas/renox-lock.schema.json";
import { type Json, type JsonObject, isObject, validate } from "../schema.ts";

export const schemas = { manifest: manifestSchema as unknown as JsonObject, lock: lockSchema as unknown as Json };

/** One rule violation: the rule id (`MF1`–`MF12`, or `schema`), where, and why. */
export interface ModuleProblem {
  rule: string;
  file: string;
  message: string;
}

export const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
export const strings = (v: Json | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The parts of a parsed module.toml the CLI reads. */
export interface Manifest {
  doc: JsonObject;
  name: string;
  version: string;
  isolation: "shared" | "isolate";
  description: string | undefined;
  dependencies: Record<string, string>;
  permissions: Permissions;
}

export interface Permissions {
  tables?: string;
  network: string[];
  secrets: string[];
  slots: string[];
  hooks: string[];
}

export function permissionsOf(p: JsonObject): Permissions {
  return {
    ...(typeof p.tables === "string" ? { tables: p.tables } : {}),
    network: strings(p.network),
    secrets: strings(p.secrets),
    slots: strings(p.slots),
    hooks: strings(p.hooks),
  };
}

/** Order-insensitive form, for MF12 (approved = requested). */
export const samePermissions = (a: Permissions, b: Permissions): boolean => {
  const norm = (p: Permissions) => JSON.stringify([p.tables ?? null, [...p.network].sort(), [...p.secrets].sort(), [...p.slots].sort(), [...p.hooks].sort()]);
  return norm(a) === norm(b);
};

/** MF1. The reason, or null when `name` may be a module name. */
export function moduleNameProblem(name: string): string | null {
  if (!/^[a-z][a-z0-9_]{0,31}$/u.test(name)) return "does not match ^[a-z][a-z0-9_]{0,31}$";
  if (name.includes("__")) return 'contains "__"';
  if (name.endsWith("_")) return 'ends with "_"';
  if (name === "app" || name === "renox") return "is reserved";
  return null;
}

/** MF4 on a [permissions] table or a lock entry's `approved`. */
export function permissionProblems(name: string, p: JsonObject, where: string): string[] {
  const out: string[] = [];
  if (p.tables !== undefined && p.tables !== `${name}__*`) out.push(`MF4: ${where}.tables "${String(p.tables)}" is not "${name}__*"`);
  for (const s of strings(p.secrets)) if (!s.startsWith(`${name.toUpperCase()}_`)) out.push(`MF4: ${where}.secrets "${s}" does not start with ${name.toUpperCase()}_`);
  return out;
}

/** MF10: the reason a config value does not fit its declaration, or null. */
export function configValueProblem(decl: JsonObject, value: Json): string | null {
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

/** The single-file rules on a module.toml that passed the schema. */
export function manifestRules(doc: JsonObject): string[] {
  const errors: string[] = [];
  const name = obj(doc.module).name as string;
  const problem = moduleNameProblem(name);
  if (problem !== null) errors.push(`MF1: [module].name "${name}" ${problem}`);
  for (const dep of Object.keys(obj(doc.dependencies))) {
    const p = moduleNameProblem(dep);
    if (p !== null) errors.push(`MF1: [dependencies] "${dep}" ${p}`);
    if (dep === name) errors.push(`MF5: ${name} depends on itself`);
  }
  const permissions = obj(doc.permissions);
  errors.push(...permissionProblems(name, permissions, "[permissions]"));
  const exports = obj(doc.exports);
  const view = new RegExp(`^${name}__public_[a-z0-9_]+_v[1-9][0-9]*$`, "u");
  for (const v of strings(exports.views)) if (!view.test(v)) errors.push(`MF6: view "${v}" is not ${name}__public_<id>_v<n>`);
  for (const [kind, entries] of [["event", obj(exports.events)], ["hook", obj(exports.hooks)]] as const) {
    for (const n of Object.keys(entries)) if (!n.startsWith(`${name}.`)) errors.push(`MF6: ${kind} "${n}" does not start with "${name}."`);
  }
  const slots = Array.isArray(doc.slots) ? (doc.slots as JsonObject[]) : [];
  const filled = new Set(slots.map((s) => s.name as string));
  const asked = new Set(strings(permissions.slots));
  for (const s of filled) if (!asked.has(s)) errors.push(`MF8: [[slots]] fills "${s}" but permissions.slots does not list it`);
  for (const s of asked) if (!filled.has(s)) errors.push(`MF8: permissions.slots lists "${s}" but no [[slots]] fills it`);
  for (const h of strings(permissions.hooks)) if (h.startsWith(`${name}.`)) errors.push(`MF8: permissions.hooks "${h}" is a hook of ${name} itself`);
  const actions = new Set(strings(obj(doc.authz).actions));
  slots.forEach((s, i) => {
    if (typeof s.requires === "string" && !actions.has(s.requires)) errors.push(`MF9: slots[${i}].requires "${s.requires}" is not in [authz].actions`);
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

const problem = (file: string) => (e: string): ModuleProblem => {
  const m = /^(MF[0-9]+): (.*)$/su.exec(e);
  return m ? { rule: m[1] as string, file, message: m[2] as string } : { rule: "schema", file, message: e };
};

/** Reads `<tree>/module.toml`; `problems` is empty when it is valid. `file` names it for messages. */
export function readManifest(tree: string, file: string): { manifest: Manifest | null; problems: ModuleProblem[] } {
  const path = join(tree, "module.toml");
  if (!existsSync(path)) return { manifest: null, problems: [{ rule: "MF12", file, message: "module.toml is missing" }] };
  let doc: Json;
  try {
    doc = Bun.TOML.parse(readFileSync(path, "utf8")) as Json;
  } catch (e) {
    return { manifest: null, problems: [{ rule: "schema", file, message: `invalid TOML: ${(e as Error).message}` }] };
  }
  const schemaErrors = validate(schemas.manifest, doc);
  if (schemaErrors.length > 0 || !isObject(doc)) return { manifest: null, problems: schemaErrors.map((e) => ({ rule: "schema", file, message: e })) };
  const errors = manifestRules(doc).map(problem(file));
  const module = obj(doc.module);
  return {
    manifest: {
      doc,
      name: module.name as string,
      version: module.version as string,
      isolation: module.isolation === "isolate" ? "isolate" : "shared",
      description: typeof module.description === "string" ? module.description : undefined,
      dependencies: Object.fromEntries(Object.entries(obj(doc.dependencies)).map(([k, v]) => [k, String(v)])),
      permissions: permissionsOf(obj(doc.permissions)),
    },
    problems: errors,
  };
}
