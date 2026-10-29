// renox check [--secrets] [--security]: renox.toml schema, route conflicts,
// template diagnostics, manifest schema (by building in memory), SQL
// interpolation lint, undeclared fetch hosts, handlers that write to global
// scope, redirects to a target from the request (#111), and the bundle-hygiene rules (#115): secrets in what the build
// ships, forbidden files in public/. `--secrets` runs only the secret scan;
// `--security` also prints the effective headers per route (#47).
// `--target <hash | artifact dir>` (#96) warns about the columns and tables
// the project's migrations create that the target deployment's code does
// not know: rolling back to it is a pointer switch, migrations never run
// backwards (D17, expand/contract), so the older code must tolerate them.

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { CliError, EXIT, location, UserError } from "../errors.ts";
import { artifactsDir, buildFiles } from "../lib/build.ts";
import { scanBundle, SECRET_HINT } from "../lib/secrets.ts";
import { type Finding, lintFetch, lintGlobalState, lintRedirect, lintSql } from "../lib/lint.ts";
import { readProject } from "../lib/project.ts";
import { noPublicSourcemaps } from "../check/no-public-sourcemaps.ts";
import { securityReport } from "../check/security.ts";
import { discoverFunctions, discoverPages, routesOf, sortRoutes } from "../lib/routes.ts";
import { TemplateError } from "../lib/templates-compile.ts";
import { projectProblems } from "../lib/modules/resolve.ts";
import { contractProblems, installedModules } from "../lib/modules/build.ts";
import { exportProblems } from "../check/exports.ts";

const SKIP = new Set(["node_modules", ".renox", ".git", "dist"]);

function sources(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (SKIP.has(d.name)) continue;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...sources(dir, r));
    else if (d.isFile() && /\.(ts|js|mjs)$/u.test(d.name) && !d.name.endsWith(".d.ts")) out.push(r);
  }
  return out;
}

export interface CheckReport {
  /** Config, route, and build problems (renox.toml, functions/, migrations, manifest). */
  errors: CliError[];
  findings: Finding[];
}

export interface CheckOptions {
  /** Only the secret scan. */
  secretsOnly?: boolean;
  /** Override drift is an error, not a warning (#235). */
  strict?: boolean;
}

export async function check(project: string, options: CheckOptions = {}): Promise<CheckReport> {
  const errors: CliError[] = [];
  const findings: Finding[] = [];
  let network: string[] = [];
  try {
    network = readProject(project).permissions.network;
    const built = await buildFiles(project);
    const secrets = scanBundle(built.maps, built.files);
    for (const s of secrets.findings) {
      findings.push({ file: s.file, line: s.line, column: s.column, rule: "secret", severity: "error", message: `${s.description}: ${s.masked}; ${SECRET_HINT}` });
    }
    for (const m of secrets.markersWithoutReason) {
      findings.push({ file: m.file, line: m.line, column: 1, rule: "secret", severity: "error", message: "renox-allow-secret needs a reason (renox-allow-secret: <why this is not a secret>)" });
    }
    if (!options.secretsOnly) {
      // docs/23-failure-modes.md "Template override drifted": the diff, then go on (or fail with --strict).
      for (const d of built.drift) {
        findings.push({ file: `overrides/${d.file}`, line: 1, column: 1, rule: "override-drift", severity: options.strict ? "error" : "warning", message: `the module's original changed since the override was made (${d.stored.slice(0, 12)} -> ${d.current.slice(0, 12)})\n${d.diff}` });
      }
      for (const k of built.skipped) {
        findings.push({ file: k.path, line: 1, column: 1, rule: "forbidden-file", severity: "warning", message: `left out of the artifact: ${k.reason}` });
      }
    }
  } catch (e) {
    // A missing renox.toml is not a check finding: the folder is not an app (exit 1).
    // Template errors are one error per diagnostic, each with its file and line.
    if (e instanceof TemplateError) for (const d of e.locations()) errors.push(new CliError(d.message, EXIT.VALIDATION, d.where));
    else if (e instanceof CliError && e.exitCode === EXIT.VALIDATION) errors.push(e);
    else throw e;
  }
  if (options.secretsOnly) return { errors, findings };
  // Handlers and services that are missing or not functions (#265): the
  // runtime evaluates route modules lazily, so this is caught here.
  if (errors.length === 0) {
    for (const p of exportProblems(project)) errors.push(new CliError(p.message, EXIT.VALIDATION, { file: p.file }));
  }
  // Modules and renox.lock (docs/contracts/manifest.md section 6): each problem names its rule.
  if (existsSync(join(project, "renox.toml"))) {
    const problems = projectProblems(project);
    for (const p of problems) errors.push(new CliError(`${p.rule}: ${p.message}`, EXIT.VALIDATION, { file: p.file }));
    // Module contracts in the code (#235): only on a consistent lock.
    const { modules } = installedModules(project);
    if (problems.length === 0 && modules.length) {
      for (const p of contractProblems(project, modules)) errors.push(new CliError(`${p.rule}: ${p.message}`, EXIT.VALIDATION, { file: p.file, line: p.line }));
    }
  }
  findings.push(...noPublicSourcemaps(project));
  for (const f of sources(project)) {
    if (f.startsWith("tests/") || /\.(test|spec)\.(ts|js|mjs)$/u.test(f)) continue;
    const src = readFileSync(join(project, f), "utf8");
    findings.push(...lintSql(src, f), ...lintFetch(src, f, network), ...lintGlobalState(src, f), ...lintRedirect(src, f));
  }
  return { errors, findings };
}

/** Tables and their columns after running `sqls` in order on an empty database. */
export function schemaOf(sqls: string[]): Map<string, Set<string>> {
  const db = new Database(":memory:");
  try {
    for (const sql of sqls) db.exec(sql);
    const out = new Map<string, Set<string>>();
    const tables = db.query("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all() as { name: string }[];
    for (const { name } of tables) {
      const cols = db.query("select name from pragma_table_info(?)").all(name) as { name: string }[];
      out.set(name, new Set(cols.map((c) => c.name)));
    }
    return out;
  } finally {
    db.close();
  }
}

const MIGRATION = /^[0-9]{3}_[a-z0-9_]+\.sql$/u;
const sqlFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((n) => MIGRATION.test(n)).sort().map((n) => readFileSync(join(dir, n), "utf8")) : [];

/** The artifact directory of `target`: a directory path, or a hash under `.renox/artifact/`. */
export function targetDir(project: string, target: string): string {
  const dir = /^[0-9a-f]{64}$/u.test(target) ? join(artifactsDir(project), target) : isAbsolute(target) ? target : resolve(project, target);
  if (!existsSync(join(dir, "manifest.json")) || !statSync(dir).isDirectory()) {
    throw new UserError(`no artifact for --target ${target}`, { hint: "build that version with `renox build` (artifacts stay in .renox/artifact/<hash>/) or pass the artifact directory" });
  }
  return dir;
}

/**
 * `--target` (#96): one warning per table or column the project's
 * migrations (the live schema once applied) have that the target's
 * `migrations/app/` do not.
 */
export type SchemaFinding = Omit<Finding, "rule"> & { rule: "schema" };

export function targetFindings(project: string, target: string): SchemaFinding[] {
  const dir = targetDir(project, target);
  const name = /^[0-9a-f]{64}$/u.test(target) ? target.slice(0, 12) : target;
  const live = schemaOf(sqlFiles(join(project, "migrations")));
  const known = schemaOf(sqlFiles(join(dir, "migrations", "app")));
  const findings: SchemaFinding[] = [];
  const at = { file: "migrations", line: 1, column: 1, rule: "schema" as const, severity: "warning" as const };
  for (const [table, cols] of live) {
    const theirs = known.get(table);
    if (theirs === undefined) {
      findings.push({ ...at, message: `table ${table} is in the live schema but unknown to ${name}; its code must tolerate it (D17, expand/contract)` });
      continue;
    }
    for (const c of cols) {
      if (!theirs.has(c)) findings.push({ ...at, message: `column ${table}.${c} is in the live schema but unknown to ${name}; its code must tolerate it (D17, expand/contract)` });
    }
  }
  return findings;
}

/** `renox check --security`: the effective headers, CORS, and buckets per route (#47). */
export function securityOutput(project: string): string {
  const config = readProject(project);
  return securityReport(config.security ?? {}, sortRoutes(routesOf(discoverFunctions(project), discoverPages(project))));
}

export async function run(args: string[]): Promise<number> {
  const flags = new Set(["--secrets", "--security", "--json", "--strict"]);
  const t = args.indexOf("--target");
  const target = t >= 0 ? args[t + 1] : undefined;
  const rest = t >= 0 ? [...args.slice(0, t), ...args.slice(t + 2)] : args;
  if ((t >= 0 && (target === undefined || target.startsWith("-"))) || rest.some((a) => !flags.has(a)) || new Set(rest).size !== rest.length) {
    console.error("usage: renox check [--secrets] [--security] [--json] [--strict] [--target <hash | artifact dir>]");
    return EXIT.USER;
  }
  const security = args.includes("--security");
  const { errors, findings: lint } = await check(process.cwd(), { secretsOnly: args.includes("--secrets"), strict: args.includes("--strict") });
  const findings: (Finding | SchemaFinding)[] = lint;
  if (target !== undefined) {
    try {
      findings.push(...targetFindings(process.cwd(), target));
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      console.error(`error  ${e.message}${e.hint ? `\n  hint: ${e.hint}` : ""}`);
      return e.exitCode;
    }
  }
  const failedCount = errors.length + findings.filter((f) => f.severity === "error").length;
  if (args.includes("--json")) {
    const rule = (m: string): string | undefined => /^(MF[0-9]+):/u.exec(m)?.[1];
    const report = {
      ok: failedCount === 0,
      errors: errors.map((e) => ({ ...(rule(e.message) ? { rule: rule(e.message) } : {}), ...(e.file ? { file: e.file } : {}), ...(e.line ? { line: e.line } : {}), message: e.message })),
      findings,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return failedCount ? EXIT.VALIDATION : EXIT.OK;
  }
  if (security && errors.length === 0) process.stdout.write(securityOutput(process.cwd()));
  for (const e of errors) console.error(`${location(e) ? `${location(e)}  ` : ""}error  ${e.message}${e.hint ? `\n  hint: ${e.hint}` : ""}`);
  for (const f of findings) console.error(`${f.file}:${f.line}:${f.column}  ${f.severity}  ${f.rule}  ${f.message}`);
  const failed = errors.length + findings.filter((f) => f.severity === "error").length;
  console.error(failed ? `renox check: ${failed} error(s)` : `renox check: ok${findings.length ? ` (${findings.length} warning(s))` : ""}`);
  return failed ? EXIT.VALIDATION : EXIT.OK;
}
