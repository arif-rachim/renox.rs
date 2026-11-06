// Builds the two npm packages of D30 under dist/npm (#440):
//
//   bun cli/scripts/pack-npm.ts [--out <dir>]      default: <repo>/dist/npm
//
//   <out>/cli            @renoxium/cli: bin/renox.js (the bundle, scripts/compile.ts --bundle)
//   <out>/create-renox   create-renox: bin/create-renox.js, depends on @renoxium/cli at the same version
//
// The version is cli/package.json's. The sources are cli/npm/*.

import { chmodSync, copyFileSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const CLI = join(import.meta.dir, "..");
const ROOT = join(CLI, "..");

const o = process.argv.indexOf("--out");
if (o >= 0 && !process.argv[o + 1]) throw new Error("usage: pack-npm.ts [--out <dir>]");
const out = resolve(o >= 0 ? (process.argv[o + 1] as string) : join(ROOT, "dist/npm"));

const version = (JSON.parse(readFileSync(join(CLI, "package.json"), "utf8")) as { version: string }).version;

const dirs = { cli: join(out, "cli"), create: join(out, "create-renox") };
for (const [dir, src] of [
  [dirs.cli, "npm/cli"],
  [dirs.create, "npm/create-renox"],
] as const) {
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(CLI, src), dir, { recursive: true });
}
chmodSync(join(dirs.create, "bin/create-renox.js"), 0o755);

const bundle = Bun.spawnSync(["bun", join(CLI, "scripts/compile.ts"), "--bundle", "--outfile", join(dirs.cli, "bin/renox.js")], { stdout: "inherit", stderr: "inherit" });
if (bundle.exitCode !== 0) throw new Error(`compile.ts --bundle failed (exit ${bundle.exitCode})`);

for (const dir of Object.values(dirs)) {
  const file = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8")) as { version: string; dependencies?: Record<string, string> };
  pkg.version = version;
  if (pkg.dependencies?.["@renoxium/cli"]) pkg.dependencies["@renoxium/cli"] = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  copyFileSync(join(ROOT, "LICENSE"), join(dir, "LICENSE"));
}

console.log(`@renoxium/cli ${version} -> ${dirs.cli}`);
console.log(`create-renox ${version} -> ${dirs.create}`);
