// renox migrate [--db <file>]: build the artifact, then run its migration
// plan against the dev tenant file (.renox/data/dev/app.db) through the
// embedded worker (`renox-worker migrate`, #235): each installed module in
// renox.lock order under its own prefix, then the app's. Prints what was
// applied per module. A changed file that already ran is refused
// (checksum), like on deploy (D17: forward-only).

import { join, resolve } from "node:path";

import { EXIT, ValidationError } from "../errors.ts";
import { artifactsDir, buildArtifact } from "../lib/build.ts";
import { workerPath } from "../lib/worker.ts";
import { DEV_TENANT } from "./dev.ts";

export interface MigrateReport {
  ok: boolean;
  module?: string;
  error?: string;
  modules: { module: string; applied: string[]; skipped: string[] }[];
}

/** Run the plan of the artifact in `artifact` against `db`. */
export async function migrateArtifact(artifact: string, db: string, worker = workerPath()): Promise<MigrateReport> {
  const p = Bun.spawn([worker, "migrate", artifact, db], { stdout: "pipe", stderr: "pipe" });
  const [text, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  try {
    return JSON.parse(text) as MigrateReport;
  } catch {
    throw new ValidationError(`renox-worker migrate failed (exit code ${code}): ${err.trim()}`);
  }
}

/** The dev tenant file of `renox dev`. */
export const devDb = (project: string): string => join(project, ".renox", "data", DEV_TENANT, "app.db");

export async function run(args: string[]): Promise<number> {
  const d = args.indexOf("--db");
  if ((d >= 0 && !args[d + 1]) || args.some((a, i) => a.startsWith("-") && a !== "--db" && args[i - 1] !== "--db")) {
    console.error("usage: renox migrate [--db <file>]");
    return EXIT.USER;
  }
  const project = process.cwd();
  const db = d >= 0 ? resolve(args[d + 1] as string) : devDb(project);
  const built = await buildArtifact(project, artifactsDir(project));
  const r = await migrateArtifact(built.dir, db);
  for (const m of r.modules) {
    if (m.applied.length) console.log(`${m.module}: applied ${m.applied.join(", ")}`);
    else console.log(`${m.module}: up to date`);
  }
  if (!r.ok) {
    console.error(`renox migrate: ${r.module ? `${r.module}: ` : ""}${r.error ?? "failed"}`);
    return EXIT.VALIDATION;
  }
  return EXIT.OK;
}
