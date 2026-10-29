// renox build [--out <dir>]

import { resolve } from "node:path";

import { EXIT } from "../errors.ts";
import { artifactsDir, buildArtifact } from "../lib/build.ts";

export async function run(args: string[]): Promise<number> {
  const project = process.cwd();
  const o = args.indexOf("--out");
  if ((o >= 0 && !args[o + 1]) || args.some((a, i) => a.startsWith("-") && a !== "--out" && args[i - 1] !== "--out")) {
    console.error("usage: renox build [--out <dir>]");
    return EXIT.USER;
  }
  const out = o >= 0 ? resolve(args[o + 1] as string) : artifactsDir(project);
  const r = await buildArtifact(project, out, undefined, { secrets: true });
  for (const k of r.skipped) console.error(`skipped ${k.path}: ${k.reason}`);
  for (const a of r.allowedSecrets) console.error(`allowed ${a.file}:${a.line}  ${a.pattern}  renox-allow-secret: ${a.allowed}`);
  // docs/23-failure-modes.md "Template override drifted": a warning with the diff; the build goes on.
  for (const d of r.drift) console.error(`warning: overrides/${d.file}: the module's original changed since the override was made\n${d.diff}`);
  console.log(`artifact ${r.hash}`);
  console.log(`  ${r.manifest.routes.length} routes, ${Object.keys(r.manifest.code.entry).length} modules, ${Math.round(r.ms)} ms`);
  console.log(`  ${r.dir}`);
  return EXIT.OK;
}
