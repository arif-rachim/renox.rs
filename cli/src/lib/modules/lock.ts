// renox.lock (docs/contracts/manifest.md section 5): read, validate, write.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Json, type JsonObject, isObject, validate } from "../schema.ts";
import { type ModuleProblem, type Permissions, obj, permissionProblems, permissionsOf, schemas, strings, moduleNameProblem } from "./manifest.ts";
import { tomlKey, tomlValue } from "./toml.ts";

export interface LockEntry {
  name: string;
  version: string;
  source: string;
  hash: string;
  isolation: "shared" | "isolate";
  mount: string;
  dependencies: string[];
  config: Record<string, string | number | boolean>;
  approved: Permissions;
}

export const LOCK_FILE = "renox.lock";

/** `null` when the app has no lock yet. Throws nothing: problems are returned. */
export function readLock(project: string): { entries: LockEntry[] | null; problems: ModuleProblem[] } {
  const path = join(project, LOCK_FILE);
  if (!existsSync(path)) return { entries: null, problems: [] };
  let doc: Json;
  try {
    doc = Bun.TOML.parse(readFileSync(path, "utf8")) as Json;
  } catch (e) {
    return { entries: null, problems: [{ rule: "schema", file: LOCK_FILE, message: `invalid TOML: ${(e as Error).message}` }] };
  }
  const errors = validate(schemas.lock, doc);
  if (errors.length > 0 || !isObject(doc)) return { entries: null, problems: errors.map((message) => ({ rule: "schema", file: LOCK_FILE, message })) };
  const problems: ModuleProblem[] = [];
  const seen = new Set<string>();
  const entries = (Array.isArray(doc.module) ? (doc.module as JsonObject[]) : []).map((e): LockEntry => {
    const name = e.name as string;
    const p = moduleNameProblem(name);
    if (p !== null) problems.push({ rule: "MF1", file: LOCK_FILE, message: `lock entry "${name}" ${p}` });
    if (seen.has(name)) problems.push({ rule: "MF3", file: LOCK_FILE, message: `"${name}" has more than one lock entry` });
    for (const dep of strings(e.dependencies)) if (!seen.has(dep)) problems.push({ rule: "MF5", file: LOCK_FILE, message: `${name} is listed before its dependency ${dep} (or ${dep} is not installed)` });
    seen.add(name);
    for (const m of permissionProblems(name, obj(e.approved), `${name}.approved`)) problems.push({ rule: "MF4", file: LOCK_FILE, message: m.slice("MF4: ".length) });
    return {
      name,
      version: e.version as string,
      source: e.source as string,
      hash: e.hash as string,
      isolation: e.isolation === "isolate" ? "isolate" : "shared",
      mount: e.mount as string,
      dependencies: strings(e.dependencies),
      config: obj(e.config) as LockEntry["config"],
      approved: permissionsOf(obj(e.approved)),
    };
  });
  return { entries, problems };
}

/** The lock file text, entries in the given (topological) order. */
export function formatLock(entries: LockEntry[]): string {
  const blocks = entries.map((e) => {
    const approved: JsonObject = { ...(e.approved.tables !== undefined ? { tables: e.approved.tables } : {}), network: e.approved.network, secrets: e.approved.secrets, slots: e.approved.slots, hooks: e.approved.hooks };
    const fields: [string, Json][] = [
      ["name", e.name],
      ["version", e.version],
      ["source", e.source],
      ["hash", e.hash],
      ["isolation", e.isolation],
      ["mount", e.mount],
      ["dependencies", e.dependencies],
      ["config", e.config],
      ["approved", approved],
    ];
    return `[[module]]\n${fields.map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`).join("\n")}\n`;
  });
  const head = "# Written by renox (renox add, renox remove); do not edit by hand (docs/contracts/manifest.md, MF12).\nversion = 1\n";
  return entries.length === 0 ? `${head}module = []\n` : `${head}${blocks.map((b) => `\n${b}`).join("")}`;
}

export function writeLock(project: string, entries: LockEntry[]): void {
  writeFileSync(join(project, LOCK_FILE), formatLock(entries));
}
