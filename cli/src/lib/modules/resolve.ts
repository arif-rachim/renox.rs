// The module resolver (docs/contracts/manifest.md sections 4-6;
// docs/10-modules.md): reads renox.toml [modules], fetches each module tree
// (path:, git:, or an official module), validates its module.toml, checks
// every range across the dependency graph, orders the modules
// topologically (cycles rejected with the cycle printed), and turns the
// result into renox.lock entries. `projectProblems` applies the project
// rules MF2, MF3, MF5, MF7-MF12 to an app and its lock.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

import { hashFiles, readTree } from "../hash.ts";
import { type Json, type JsonObject, isObject, validate } from "../schema.ts";
import { type LockEntry, readLock } from "./lock.ts";
import { type Manifest, type ModuleProblem, configValueProblem, moduleNameProblem, obj, readManifest, samePermissions, schemas, strings } from "./manifest.ts";
import { isRange, satisfies } from "./semver.ts";

/** One `renox.toml [modules]` entry. */
export interface InstallSpec {
  version: string;
  source?: string;
  mount?: string;
  config?: Record<string, string | number | boolean>;
  isolation?: "shared" | "isolate";
}

/** A fetched and validated module. */
export interface ResolvedModule {
  name: string;
  spec: InstallSpec;
  manifest: Manifest;
  /** Absolute path of the module tree. */
  tree: string;
  /** The lock's `source`: `official`, `path:<dir>`, or `git:<url>#<40-hex>`. */
  source: string;
  hash: string;
}

/**
 * Official modules whose catalog folder is not their module name
 * (`manifest.md` section 1: the catalog's `2fa` is installed as `twofa`,
 * a name cannot start with a digit; #287).
 */
const CATALOG_DIRS: Readonly<Record<string, string>> = { twofa: "2fa" };

/** The official modules shipped with this CLI (manifest.md Open 1: the repository's modules/). */
export const OFFICIAL_MODULES = resolvePath(import.meta.dir, "../../../../modules");

/** Where a module tree comes from, after the `git:` ref is resolved to a commit. */
export interface TreeSource {
  tree: string;
  source: string;
}

/** The `[modules]` table of renox.toml, validated against manifest.md section 4. */
export function readModulesTable(project: string): { specs: Record<string, InstallSpec>; problems: ModuleProblem[] } {
  const doc = Bun.TOML.parse(readFileSync(join(project, "renox.toml"), "utf8")) as Json;
  const modules = isObject(doc) ? (doc.modules as Json | undefined) : undefined;
  if (modules === undefined) return { specs: {}, problems: [] };
  const errors = validate(obj(schemas.manifest.$defs).renoxToml as Json, { modules }, schemas.manifest);
  const problems: ModuleProblem[] = errors.map((message) => ({ rule: "schema", file: "renox.toml", message }));
  for (const key of Object.keys(obj(modules))) {
    const p = moduleNameProblem(key);
    if (p !== null) problems.push({ rule: "MF1", file: "renox.toml", message: `[modules] "${key}" ${p}` });
  }
  return { specs: problems.length ? {} : (modules as unknown as Record<string, InstallSpec>), problems };
}

function git(args: string[], cwd?: string): string {
  const r = Bun.spawnSync(["git", ...args], { ...(cwd ? { cwd } : {}), stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim().split("\n").pop() ?? ""}`);
  return r.stdout.toString().trim();
}

/**
 * The tree of `name` from `source`: `path:` relative to the app, `git:`
 * cloned at the ref into `.renox/modules/<name>/<commit>/` (reused when
 * present), absent = the official module of this CLI.
 */
export function fetchTree(project: string, name: string, source: string | undefined): TreeSource {
  if (source === undefined || source === "official") return { tree: join(OFFICIAL_MODULES, CATALOG_DIRS[name] ?? name), source: "official" };
  if (source.startsWith("path:")) return { tree: resolvePath(project, source.slice("path:".length)), source };
  if (source.startsWith("git:")) {
    const spec = source.slice("git:".length);
    const hashAt = spec.lastIndexOf("#");
    const [url, ref] = [spec.slice(0, hashAt), spec.slice(hashAt + 1)];
    let commit = ref;
    if (!/^[0-9a-f]{40}$/u.test(ref)) {
      const lines = git(["ls-remote", url, ref, `${ref}^{}`]).split("\n").filter(Boolean);
      // A peeled annotated tag (`ref^{}`) names the commit; else the ref itself.
      const peeled = lines.find((l) => l.endsWith("^{}")) ?? lines[0];
      if (peeled === undefined) throw new Error(`git ref ${ref} not found in ${url}`);
      commit = peeled.split(/\s+/u)[0] as string;
    }
    const tree = join(project, ".renox", "modules", name, commit);
    if (!existsSync(join(tree, "module.toml"))) {
      const tmp = `${tree}.tmp-${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(dirname(tree), { recursive: true });
      git(["clone", "--quiet", url, tmp]);
      git(["-c", "advice.detachedHead=false", "checkout", "--quiet", commit], tmp);
      rmSync(join(tmp, ".git"), { recursive: true, force: true });
      rmSync(tree, { recursive: true, force: true });
      renameSync(tmp, tree);
    }
    return { tree, source: `git:${url}#${commit}` };
  }
  throw new Error(`unsupported source ${source}`);
}

/** SHA-256 of a module tree (manifest.md section 5: the artifact.md section 2 listing). */
export const treeHash = (tree: string): string => hashFiles(readTree(tree));

export interface Resolution {
  /** Topological order: every module after its dependencies, ties by name. */
  modules: ResolvedModule[];
  problems: ModuleProblem[];
}

/**
 * Fetches and validates every module of `specs` and checks the graph: each
 * `[dependencies]` range is satisfied by the installed version (else an
 * error naming both modules), no cycle (printed), every dependency installed.
 */
export function resolveModules(project: string, specs: Record<string, InstallSpec>, pinned: Record<string, string> = {}): Resolution {
  const problems: ModuleProblem[] = [];
  const found = new Map<string, ResolvedModule>();
  for (const [name, spec] of Object.entries(specs)) {
    const file = `modules: ${name}`;
    let src: TreeSource;
    try {
      src = fetchTree(project, name, pinned[name] ?? spec.source);
    } catch (e) {
      problems.push({ rule: "MF11", file, message: `cannot fetch ${spec.source ?? "official module"}: ${(e as Error).message}` });
      continue;
    }
    const { manifest, problems: mp } = readManifest(src.tree, `${name}/module.toml`);
    problems.push(...mp);
    if (manifest === null) continue;
    if (manifest.name !== name) problems.push({ rule: "MF3", file: "renox.toml", message: `renox.toml key "${name}" installs the module named "${manifest.name}"` });
    if (!isRange(spec.version)) problems.push({ rule: "MF2", file: "renox.toml", message: `${name}: "${spec.version}" is not a range of manifest.md section 2` });
    else if (!satisfies(manifest.version, spec.version)) problems.push({ rule: "MF2", file: "renox.toml", message: `${name} ${manifest.version} (${src.source}) does not satisfy renox.toml "${spec.version}"` });
    if (manifest.isolation === "isolate" && spec.isolation === "shared") problems.push({ rule: "MF11", file: "renox.toml", message: `${name}: renox.toml lowers isolation from isolate to shared` });
    found.set(name, { name, spec, manifest, tree: src.tree, source: src.source, hash: treeHash(src.tree) });
  }
  for (const a of Object.keys(specs)) for (const b of Object.keys(specs)) if (a !== b && b.startsWith(`${a}__`)) problems.push({ rule: "MF3", file: "renox.toml", message: `the prefix ${a}__ is a prefix of ${b}__` });
  // Ranges across the graph.
  for (const m of found.values()) {
    for (const [dep, range] of Object.entries(m.manifest.dependencies)) {
      const d = found.get(dep);
      if (!(dep in specs)) problems.push({ rule: "MF5", file: `${m.name}/module.toml`, message: `${m.name} depends on ${dep} ${range}, which is not installed; add it with renox add ${dep}` });
      else if (d !== undefined && !satisfies(d.manifest.version, range)) {
        problems.push({ rule: "MF2", file: `${m.name}/module.toml`, message: `${m.name} needs ${dep} "${range}", but ${dep} ${d.manifest.version} is installed` });
      }
    }
  }
  const { order, cycle } = topological([...found.values()]);
  if (cycle !== null) problems.push({ rule: "MF5", file: "renox.toml", message: `dependency cycle ${cycle.join(" -> ")}` });
  return { modules: order, problems };
}

/** Kahn's algorithm with the ready set in name order; the first cycle found, as a path. */
export function topological(mods: ResolvedModule[]): { order: ResolvedModule[]; cycle: string[] | null } {
  const byName = new Map(mods.map((m) => [m.name, m]));
  const deps = (m: ResolvedModule) => Object.keys(m.manifest.dependencies).filter((d) => byName.has(d));
  const placed = new Set<string>();
  const order: ResolvedModule[] = [];
  while (order.length < mods.length) {
    const ready = mods.filter((m) => !placed.has(m.name) && deps(m).every((d) => placed.has(d))).sort((a, b) => (a.name < b.name ? -1 : 1));
    const next = ready[0];
    if (next === undefined) break;
    placed.add(next.name);
    order.push(next);
  }
  if (order.length === mods.length) return { order, cycle: null };
  // Walk from an unplaced module along unplaced dependencies until a name repeats.
  const path: string[] = [];
  let cur = mods.filter((m) => !placed.has(m.name)).sort((a, b) => (a.name < b.name ? -1 : 1))[0] as ResolvedModule;
  while (!path.includes(cur.name)) {
    path.push(cur.name);
    cur = byName.get(deps(cur).filter((d) => !placed.has(d)).sort()[0] as string) as ResolvedModule;
  }
  return { order, cycle: [...path.slice(path.indexOf(cur.name)), cur.name] };
}

/** The resolved config of manifest.md section 5 and the MF10 problems of the tenant's values. */
export function resolvedConfig(m: ResolvedModule): { config: LockEntry["config"]; problems: ModuleProblem[] } {
  const problems: ModuleProblem[] = [];
  const decls = obj(m.manifest.doc.config);
  const values = m.spec.config ?? {};
  const config: LockEntry["config"] = {};
  for (const [k, v] of Object.entries(values)) {
    if (!(k in decls)) problems.push({ rule: "MF10", file: "renox.toml", message: `${m.name}.config.${k} is not declared in its [config]` });
    else {
      const p = configValueProblem(obj(decls[k]), v as Json);
      if (p !== null) problems.push({ rule: "MF10", file: "renox.toml", message: `${m.name}.config.${k} = ${JSON.stringify(v)} ${p}` });
    }
  }
  for (const [k, raw] of Object.entries(decls)) {
    const decl = obj(raw);
    const value = k in values ? values[k] : (decl.default as string | number | boolean | undefined);
    if (value !== undefined) config[k] = value;
    else if ((decl.required as boolean | undefined) ?? true) problems.push({ rule: "MF10", file: "renox.toml", message: `${m.name}.config.${k} is required and has no value; set it in renox.toml [modules] ${m.name} config` });
  }
  return { config, problems };
}

/** The lock entry of a resolved module; `approved` is what the tenant approved. */
export function lockEntryOf(m: ResolvedModule, approved = m.manifest.permissions): LockEntry {
  return {
    name: m.name,
    version: m.manifest.version,
    source: m.source,
    hash: m.hash,
    isolation: m.spec.isolation ?? m.manifest.isolation,
    mount: m.spec.mount ?? `/${m.name}`,
    dependencies: Object.keys(m.manifest.dependencies).sort(),
    config: resolvedConfig(m).config,
    approved,
  };
}

/**
 * Every project rule of manifest.md section 6 on the app as it is now:
 * renox.toml, the module trees, and renox.lock. A module installed in
 * renox.toml without a lock entry fails (MF3); a manifest whose
 * [permissions] differ from the approved ones fails (MF12).
 */
export function projectProblems(project: string): ModuleProblem[] {
  const { specs, problems } = readModulesTable(project);
  if (problems.length) return problems;
  const { entries, problems: lockProblems } = readLock(project);
  if (Object.keys(specs).length === 0 && entries === null) return [];
  const out = [...lockProblems];
  const locked = new Map((entries ?? []).map((e) => [e.name, e]));
  // Resolve against the pinned sources of the lock (a git ref resolves to the locked commit).
  const pinned = Object.fromEntries([...locked].filter(([, e]) => e.source.startsWith("git:")).map(([n, e]) => [n, e.source]));
  const { modules, problems: rp } = resolveModules(project, specs, pinned);
  out.push(...rp);
  for (const name of Object.keys(specs)) if (!locked.has(name)) out.push({ rule: "MF3", file: "renox.lock", message: `renox.toml module "${name}" has no renox.lock entry; run renox add ${name}` });
  for (const name of locked.keys()) if (!(name in specs)) out.push({ rule: "MF3", file: "renox.lock", message: `renox.lock entry "${name}" is not in renox.toml` });
  const byName = new Map(modules.map((m) => [m.name, m]));
  for (const m of modules) {
    const doc = m.manifest.doc;
    // MF7: imports come from declared dependencies that export them.
    const imports = obj(doc.imports);
    const uses: [string, string, (d: JsonObject) => boolean][] = [
      ...strings(imports.services).map((s): [string, string, (d: JsonObject) => boolean] => {
        const [dep, service] = s.split(".") as [string, string];
        return [s, dep, (d) => service in obj(obj(d.exports).services)];
      }),
      ...strings(imports.views).map((v): [string, string, (d: JsonObject) => boolean] => [v, v.split("__")[0] as string, (d) => strings(obj(d.exports).views).includes(v)]),
    ];
    for (const [what, dep, exported] of uses) {
      const d = byName.get(dep);
      if (!(dep in m.manifest.dependencies)) out.push({ rule: "MF7", file: `${m.name}/module.toml`, message: `${m.name} imports ${what}, but ${dep} is not in its [dependencies]` });
      else if (d !== undefined && !exported(d.manifest.doc)) out.push({ rule: "MF7", file: `${m.name}/module.toml`, message: `${m.name} imports ${what}, which ${dep} ${d.manifest.version} does not export` });
    }
    // MF8: filled hooks are exported by another installed module. MF9: slot templates exist.
    for (const h of m.manifest.permissions.hooks) {
      const owner = modules.find((o) => h in obj(obj(o.manifest.doc.exports).hooks));
      if (owner === undefined || owner.name === m.name) out.push({ rule: "MF8", file: `${m.name}/module.toml`, message: `${m.name} fills hook "${h}", which no other installed module exports` });
    }
    for (const s of Array.isArray(doc.slots) ? (doc.slots as JsonObject[]) : []) {
      if (!existsSync(join(m.tree, s.template as string))) out.push({ rule: "MF9", file: `${m.name}/module.toml`, message: `slot template ${String(s.template)} is not in the module tree` });
    }
    out.push(...resolvedConfig(m).problems);
    // MF12: the lock entry matches.
    const e = locked.get(m.name);
    if (e === undefined) continue;
    const actual = lockEntryOf(m, e.approved);
    for (const field of ["version", "hash", "dependencies", "config", "mount", "source", "isolation"] as const) {
      if (JSON.stringify(e[field]) !== JSON.stringify(actual[field])) {
        out.push({ rule: "MF12", file: "renox.lock", message: `${m.name}.${field} in renox.lock is ${JSON.stringify(e[field])}, expected ${JSON.stringify(actual[field])}; run renox add ${m.name} to update the lock` });
      }
    }
    if (!samePermissions(e.approved, m.manifest.permissions)) {
      out.push({ rule: "MF12", file: "renox.lock", message: `${m.name}: [permissions] differ from the approved permissions in renox.lock; run renox add ${m.name} to approve them` });
    }
  }
  return out;
}
