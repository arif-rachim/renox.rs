// renox build [--out <dir>]

import { resolve } from "node:path";

import { artifactsDir, buildArtifact } from "../lib/build.ts";

export async function run(args: string[]): Promise<number> {
  const project = process.cwd();
  const o = args.indexOf("--out");
  const out = o >= 0 && args[o + 1] ? resolve(args[o + 1] as string) : artifactsDir(project);
  const r = await buildArtifact(project, out);
  console.log(`artifact ${r.hash}`);
  console.log(`  ${r.manifest.routes.length} routes, ${Object.keys(r.manifest.code.entry).length} modules, ${Math.round(r.ms)} ms`);
  console.log(`  ${r.dir}`);
  return 0;
}
