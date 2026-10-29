// renox add <name> [--version <range>] [--source path:<dir>|git:<url>#<ref>]
// [--mount <path>] [--yes]: resolve the module with the app's other modules,
// print what it asks for (docs/contracts/manifest.md section 3), wait for
// approval, then write renox.toml [modules] and renox.lock. A declined
// approval leaves both files unchanged. Running it again for an installed
// module re-resolves it and asks again for its current permissions (the
// approval MF12 asks for after a manifest change).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EXIT, UserError, ValidationError } from "../errors.ts";
import { readProject } from "../lib/project.ts";
import { readLock, writeLock } from "../lib/modules/lock.ts";
import { type ModuleProblem, obj } from "../lib/modules/manifest.ts";
import { type InstallSpec, type ResolvedModule, lockEntryOf, readModulesTable, resolveModules, resolvedConfig } from "../lib/modules/resolve.ts";
import { setTableEntry } from "../lib/modules/toml.ts";

export interface AddOptions {
  version?: string;
  source?: string;
  mount?: string;
  yes?: boolean;
}

const list = (xs: string[]): string => (xs.length ? xs.join(", ") : "(none)");

/** The approval text of manifest.md section 3 (snapshot in cli/tests/add.test.ts). */
export function permissionRequest(m: ResolvedModule, installed: Map<string, ResolvedModule>): string {
  const p = m.manifest.permissions;
  const doc = m.manifest.doc;
  const decls = obj(doc.config);
  const values = m.spec.config ?? {};
  const needed = Object.entries(decls)
    .filter(([k, d]) => !(k in values) && obj(d).default === undefined && ((obj(d).required as boolean | undefined) ?? true))
    .map(([k]) => k);
  const { config } = resolvedConfig(m);
  const tools = (Array.isArray(doc.tools) ? (doc.tools as { name?: string }[]) : []).map((t) => String(t.name));
  const deps = Object.entries(m.manifest.dependencies).map(([d, range]) => {
    const i = installed.get(d);
    return `${d} ${range}${i ? ` (installed ${i.manifest.version})` : " (not installed)"}`;
  });
  return [
    `${m.name} ${m.manifest.version} (${m.source})${m.manifest.description ? `: ${m.manifest.description}` : ""}`,
    "It asks for:",
    `  tables   ${p.tables ?? "(none)"}`,
    `  network  ${list(p.network)}`,
    `  secrets  ${list(p.secrets)}`,
    `  slots    ${list(p.slots)}`,
    `  hooks    ${list(p.hooks)}`,
    `  tools    ${list(tools)}`,
    `  config   ${list(Object.entries(config).map(([k, v]) => `${k} = ${JSON.stringify(v)}`))}${needed.length ? `; needs ${needed.join(", ")}` : ""}`,
    `Dependencies: ${list(deps)}`,
    `Mount: ${m.spec.mount ?? `/${m.name}`}   Isolation: ${m.spec.isolation ?? m.manifest.isolation}`,
  ].join("\n");
}

const show = (ps: ModuleProblem[]): string => ps.map((p) => `  ${p.rule}  ${p.file}: ${p.message}`).join("\n");

/** Reads one answer from stdin: only `y` or `yes` approves. */
async function askStdin(question: string): Promise<boolean> {
  process.stderr.write(`${question} [y/N] `);
  for await (const line of console) return /^\s*(y|yes)\s*$/iu.test(line);
  return false;
}

/** The whole command; `confirm` is injectable for tests. Returns the exit code. */
export async function addModule(project: string, name: string, options: AddOptions, confirm: (q: string) => Promise<boolean> = askStdin): Promise<number> {
  readProject(project); // renox.toml exists and is valid
  const { specs, problems: tableProblems } = readModulesTable(project);
  if (tableProblems.length) throw new ValidationError(`renox.toml [modules] is invalid:\n${show(tableProblems)}`, { file: "renox.toml" });
  const { entries } = readLock(project);
  const previous = specs[name];
  const spec: InstallSpec = {
    ...(previous ?? { version: "*" }),
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.mount !== undefined ? { mount: options.mount } : {}),
  };
  // Without a range: the fetched version, as ^X.Y.Z (filled in below).
  const all: Record<string, InstallSpec> = { ...specs, [name]: { ...spec, version: spec.version === "*" ? "0.0.0" : spec.version } };
  const pinned = Object.fromEntries((entries ?? []).filter((e) => e.name !== name && e.source.startsWith("git:")).map((e) => [e.name, e.source]));
  let resolution = resolveModules(project, all, pinned);
  const added = resolution.modules.find((m) => m.name === name);
  if (spec.version === "*" && added !== undefined) {
    all[name] = { ...spec, version: `^${added.manifest.version}` };
    resolution = resolveModules(project, all, pinned);
  }
  const target = resolution.modules.find((m) => m.name === name);
  const blocking = [...resolution.problems, ...(target ? resolvedConfig(target).problems : [])];
  if (blocking.length || target === undefined) {
    throw new ValidationError(`cannot install ${name}:\n${show(blocking)}`, { hint: "fix the problems above; nothing was written" });
  }
  const installed = new Map(resolution.modules.map((m) => [m.name, m]));
  console.log(permissionRequest(target, installed));
  const approved = options.yes === true || (await confirm(`Approve and install ${name}?`));
  if (!approved) {
    console.log(`${name} not installed: renox.toml and renox.lock are unchanged`);
    return EXIT.USER;
  }
  // renox.toml: the entry as the tenant wrote it plus what this command set.
  const entry = all[name] as InstallSpec;
  const tomlPath = join(project, "renox.toml");
  const value: Record<string, string | number | boolean | Record<string, string | number | boolean>> = { version: entry.version };
  if (entry.source !== undefined) value.source = entry.source;
  if (entry.mount !== undefined) value.mount = entry.mount;
  if (entry.config !== undefined) value.config = entry.config;
  if (entry.isolation !== undefined) value.isolation = entry.isolation;
  writeFileSync(tomlPath, setTableEntry(readFileSync(tomlPath, "utf8"), "modules", name, value));
  // renox.lock: every module in topological order; the others keep what they had approved.
  const kept = new Map((entries ?? []).map((e) => [e.name, e.approved]));
  writeLock(
    project,
    resolution.modules.map((m) => lockEntryOf(m, m.name === name ? m.manifest.permissions : (kept.get(m.name) ?? m.manifest.permissions))),
  );
  console.log(`installed ${name} ${target.manifest.version}; run renox migrate to create its tables`);
  return EXIT.OK;
}

export async function run(args: string[]): Promise<number> {
  const usage = "usage: renox add <module> [--version <range>] [--source path:<dir>|git:https://<repo>#<ref>] [--mount <path>] [--yes]";
  const opts: AddOptions = {};
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const value = (): string => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new UserError(`${a} needs a value\n${usage}`);
      return v;
    };
    if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--version") opts.version = value();
    else if (a === "--source") opts.source = value();
    else if (a === "--mount") opts.mount = value();
    else if (!a.startsWith("-") && name === undefined) name = a;
    else throw new UserError(`unexpected argument ${JSON.stringify(a)}\n${usage}`);
  }
  if (name === undefined) throw new UserError(usage);
  return addModule(process.cwd(), name, opts);
}
