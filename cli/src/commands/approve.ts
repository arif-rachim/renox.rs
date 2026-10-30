// `renox approve <module>` (manifest.md 1.2, sections 3 and 5; #323): show
// what changed between the approved set in renox.lock and the module's
// current [permissions] (and its version, migrations, isolation), then write
// the new approval and `approved_version`.
//
//   renox approve <module> [--yes]

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { UserError, ValidationError } from "../errors.ts";
import { readLock, writeLock } from "../lib/modules/lock.ts";
import { type Permissions } from "../lib/modules/manifest.ts";
import { readModulesTable, resolveModules } from "../lib/modules/resolve.ts";

export interface PermissionDiff {
  added: Record<string, string[]>;
  removed: Record<string, string[]>;
}

const KEYS = ["network", "secrets", "slots", "hooks", "roles"] as const;

export function diffPermissions(from: Permissions, to: Permissions): PermissionDiff {
  const added: Record<string, string[]> = {};
  const removed: Record<string, string[]> = {};
  const list = (p: Permissions, k: string) => ((p as unknown as Record<string, string[] | undefined>)[k] ?? []) as string[];
  for (const k of KEYS) {
    const a = list(to, k).filter((x) => !list(from, k).includes(x));
    const r = list(from, k).filter((x) => !list(to, k).includes(x));
    if (a.length) added[k] = a;
    if (r.length) removed[k] = r;
  }
  if (from.tables !== to.tables) {
    if (to.tables !== undefined) added.tables = [to.tables];
    if (from.tables !== undefined) removed.tables = [from.tables];
  }
  return { added, removed };
}

export interface ApproveResult {
  diff: PermissionDiff;
  from: string;
  to: string;
  migrations: string[];
  written: boolean;
}

export async function approve(project: string, name: string, confirm: (lines: string[]) => Promise<boolean>): Promise<ApproveResult> {
  const { entries } = readLock(project);
  const entry = entries?.find((e) => e.name === name);
  if (entries === null || entry === undefined) throw new UserError(`${name} is not in renox.lock`, { hint: `run renox add ${name}` });
  const { specs } = readModulesTable(project);
  const spec = specs[name];
  if (spec === undefined) throw new UserError(`${name} is not in renox.toml [modules]`);
  const { modules, problems } = resolveModules(project, { [name]: spec });
  const m = modules.find((x) => x.name === name);
  const blocking = problems.filter((p) => p.rule !== "MF12");
  if (m === undefined || blocking.length > 0) throw new ValidationError(blocking.map((p) => `${p.rule}: ${p.message}`).join("\n") || `${name} cannot be resolved`, { file: "renox.toml" });
  // MF11: a tenant may raise isolation, never lower it.
  if (m.manifest.isolation === "isolate" && entry.isolation === "shared") throw new ValidationError(`MF11: ${name} asks for isolate; renox.toml lowers it to shared`, { file: "renox.toml" });
  const diff = diffPermissions(entry.approved, m.manifest.permissions);
  const migDir = join(m.tree, "migrations");
  const migrations = existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort() : [];
  const from = entry.approved_version ?? entry.version;
  const lines = [
    `${name} ${from} -> ${m.manifest.version}`,
    ...Object.entries(diff.added).map(([k, v]) => `  + ${k}: ${v.join(", ")}`),
    ...Object.entries(diff.removed).map(([k, v]) => `  - ${k}: ${v.join(", ")}`),
    `  migrations: ${migrations.length ? migrations.join(", ") : "none"}`,
    `  isolation: ${m.spec.isolation ?? m.manifest.isolation}`,
  ];
  if (!(await confirm(lines))) return { diff, from, to: m.manifest.version, migrations, written: false };
  const next = entries.map((e) =>
    e.name === name
      ? { ...e, version: m.manifest.version, hash: m.hash, approved: m.manifest.permissions, approved_version: m.manifest.version, ...(m.sig ? { key_id: m.sig.key_id, signature: m.sig.signature } : {}) }
      : e,
  );
  writeLock(project, next);
  return { diff, from, to: m.manifest.version, migrations, written: true };
}

export async function run(args: string[]): Promise<number> {
  const name = args.find((a) => !a.startsWith("-"));
  if (name === undefined) throw new UserError("usage: renox approve <module> [--yes]");
  const yes = args.includes("--yes") || args.includes("-y");
  const r = await approve(process.cwd(), name, async (lines) => {
    for (const l of lines) console.log(l);
    if (yes) return true;
    process.stdout.write("approve? [y/N] ");
    for await (const line of console) return /^y(es)?$/iu.test(line.trim());
    return false;
  });
  console.log(r.written ? `approved ${name} ${r.to}` : "not approved");
  return r.written ? 0 : 1;
}
