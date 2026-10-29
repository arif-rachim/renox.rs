// renox remove <name>: drop a module from renox.toml [modules] and
// renox.lock. Migrations are forward-only (D17), so its tables stay in the
// tenant file; the command says so. A module another installed module
// depends on cannot be removed.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EXIT, UserError, ValidationError } from "../errors.ts";
import { readProject } from "../lib/project.ts";
import { readLock, writeLock } from "../lib/modules/lock.ts";
import { readModulesTable } from "../lib/modules/resolve.ts";
import { removeTableEntry } from "../lib/modules/toml.ts";

export function removeModule(project: string, name: string): number {
  readProject(project);
  const { specs } = readModulesTable(project);
  const { entries } = readLock(project);
  if (!(name in specs) && !(entries ?? []).some((e) => e.name === name)) throw new UserError(`${name} is not installed`);
  const dependants = (entries ?? []).filter((e) => e.dependencies.includes(name)).map((e) => e.name);
  if (dependants.length) throw new ValidationError(`${name} cannot be removed: ${dependants.join(", ")} depend${dependants.length === 1 ? "s" : ""} on it`, { hint: `remove ${dependants.join(", ")} first` });
  const tomlPath = join(project, "renox.toml");
  writeFileSync(tomlPath, removeTableEntry(readFileSync(tomlPath, "utf8"), "modules", name));
  if (entries !== null) writeLock(project, entries.filter((e) => e.name !== name));
  const tables = (entries ?? []).find((e) => e.name === name)?.approved.tables;
  console.log(`removed ${name}`);
  if (tables !== undefined) console.warn(`warning: migrations are forward-only, so the ${tables} tables stay in the tenant database (docs/13-decisions.md D17)`);
  return EXIT.OK;
}

export function run(args: string[]): number {
  if (args.length !== 1 || (args[0] as string).startsWith("-")) throw new UserError("usage: renox remove <module>");
  return removeModule(process.cwd(), args[0] as string);
}
