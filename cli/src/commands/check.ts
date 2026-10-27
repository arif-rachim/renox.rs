// renox check: renox.toml schema, route conflicts, manifest schema (by
// building in memory), SQL interpolation lint, undeclared fetch hosts.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildFiles, BuildError } from "../lib/build.ts";
import { type Finding, lintFetch, lintSql } from "../lib/lint.ts";
import { ConfigError, readProject } from "../lib/project.ts";
import { RouteError } from "../lib/routes.ts";

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
  errors: string[];
  findings: Finding[];
}

export async function check(project: string): Promise<CheckReport> {
  const errors: string[] = [];
  const findings: Finding[] = [];
  let network: string[] = [];
  try {
    network = readProject(project).permissions.network;
    await buildFiles(project);
  } catch (e) {
    if (e instanceof BuildError || e instanceof ConfigError || e instanceof RouteError) errors.push(e.message);
    else throw e;
  }
  for (const f of sources(project)) {
    if (f.startsWith("tests/") || /\.(test|spec)\.(ts|js|mjs)$/u.test(f)) continue;
    const src = readFileSync(join(project, f), "utf8");
    findings.push(...lintSql(src, f), ...lintFetch(src, f, network));
  }
  return { errors, findings };
}

export async function run(_args: string[]): Promise<number> {
  const { errors, findings } = await check(process.cwd());
  for (const e of errors) console.error(`error  ${e}`);
  for (const f of findings) console.error(`${f.file}:${f.line}:${f.column}  ${f.severity}  ${f.rule}  ${f.message}`);
  const failed = errors.length + findings.filter((f) => f.severity === "error").length;
  console.error(failed ? `renox check: ${failed} error(s)` : `renox check: ok${findings.length ? ` (${findings.length} warning(s))` : ""}`);
  return failed ? 1 : 0;
}
