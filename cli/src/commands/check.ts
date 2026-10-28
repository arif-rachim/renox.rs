// renox check: renox.toml schema, route conflicts, template diagnostics,
// manifest schema (by building in memory), SQL interpolation lint, undeclared fetch hosts,
// handlers that write to global scope.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CliError, EXIT, location } from "../errors.ts";
import { buildFiles } from "../lib/build.ts";
import { type Finding, lintFetch, lintGlobalState, lintSql } from "../lib/lint.ts";
import { readProject } from "../lib/project.ts";
import { securityReport } from "../check/security.ts";
import { discoverFunctions, discoverPages, routesOf, sortRoutes } from "../lib/routes.ts";
import { TemplateError } from "../lib/templates-compile.ts";

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

export async function check(project: string): Promise<CheckReport> {
  const errors: CliError[] = [];
  const findings: Finding[] = [];
  let network: string[] = [];
  try {
    network = readProject(project).permissions.network;
    await buildFiles(project);
  } catch (e) {
    // A missing renox.toml is not a check finding: the folder is not an app (exit 1).
    // Template errors are one error per diagnostic, each with its file and line.
    if (e instanceof TemplateError) for (const d of e.locations()) errors.push(new CliError(d.message, EXIT.VALIDATION, d.where));
    else if (e instanceof CliError && e.exitCode === EXIT.VALIDATION) errors.push(e);
    else throw e;
  }
  for (const f of sources(project)) {
    if (f.startsWith("tests/") || /\.(test|spec)\.(ts|js|mjs)$/u.test(f)) continue;
    const src = readFileSync(join(project, f), "utf8");
    findings.push(...lintSql(src, f), ...lintFetch(src, f, network), ...lintGlobalState(src, f));
  }
  return { errors, findings };
}

/** `renox check --security`: the effective headers, CORS, and buckets per route (#47). */
export function securityOutput(project: string): string {
  const config = readProject(project);
  return securityReport(config.security ?? {}, sortRoutes(routesOf(discoverFunctions(project), discoverPages(project))));
}

export async function run(args: string[]): Promise<number> {
  const security = args.includes("--security");
  if (args.some((a) => a !== "--security")) {
    console.error("usage: renox check [--security]");
    return EXIT.USER;
  }
  const { errors, findings } = await check(process.cwd());
  if (security && errors.length === 0) process.stdout.write(securityOutput(process.cwd()));
  for (const e of errors) console.error(`${location(e) ? `${location(e)}  ` : ""}error  ${e.message}${e.hint ? `\n  hint: ${e.hint}` : ""}`);
  for (const f of findings) console.error(`${f.file}:${f.line}:${f.column}  ${f.severity}  ${f.rule}  ${f.message}`);
  const failed = errors.length + findings.filter((f) => f.severity === "error").length;
  console.error(failed ? `renox check: ${failed} error(s)` : `renox check: ok${findings.length ? ` (${findings.length} warning(s))` : ""}`);
  return failed ? EXIT.VALIDATION : EXIT.OK;
}
