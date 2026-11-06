// Compiles the `renox` binary with what it needs on disk at run time (#448):
//
//   bun scripts/compile.ts [--target bun-linux-x64] [--outfile dist/renox] [--no-minify]
//   bun scripts/compile.ts --bundle [--outfile dist/npm/cli/bin/renox.js] [--no-minify]
//
// --bundle writes one JavaScript file for Bun (`#!/usr/bin/env bun`) instead of
// a binary: the npm package @renoxium/cli (#440, D30; scripts/pack-npm.ts).
//
// 1. Bundles src/lib/test-harness.ts into one ES module: `renox test` writes
//    it to .renox/test/harness.js for the `bun test` process, which cannot
//    import files from inside the binary.
// 2. Reads every official module under modules/ (the trees `renox add` and
//    `renox build` resolve, hashed as they are).
// 3. Writes both into src/lib/embedded.ts, runs `bun build --compile`, and
//    puts the placeholder back whatever happens, so the generated copy is
//    never committed.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { readTree } from "../src/lib/hash.ts";
import { modulesDigest, REPO_MODULES } from "../src/lib/modules/official.ts";

const CLI = join(import.meta.dir, "..");
const EMBEDDED = join(CLI, "src/lib/embedded.ts");

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const target = arg("--target");
const bundle = process.argv.includes("--bundle");
const outfile = arg("--outfile") ?? (bundle ? join(CLI, "..", "dist/npm/cli/bin/renox.js") : join(CLI, "dist/renox"));
const minify = !process.argv.includes("--no-minify");

const version = (JSON.parse(readFileSync(join(CLI, "package.json"), "utf8")) as { version: string }).version;

const bundled = await Bun.build({ entrypoints: [join(CLI, "src/lib/test-harness.ts")], target: "bun", format: "esm", minify });
if (!bundled.success) {
  for (const l of bundled.logs) console.error(l);
  throw new Error("could not bundle the test harness");
}
const harness = await (bundled.outputs[0] as Blob).text();

const files = readTree(REPO_MODULES);
const modules = Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, data]) => [path, Buffer.from(data).toString("base64")]));
const embedded = { version, modulesDigest: modulesDigest(files), modules, harness };

const placeholder = readFileSync(EMBEDDED, "utf8");
if (!placeholder.includes("export const EMBEDDED = null as Embedded | null;")) throw new Error(`${EMBEDDED} is not the placeholder; restore it with git checkout`);
writeFileSync(EMBEDDED, placeholder.replace("export const EMBEDDED = null as Embedded | null;", () => `export const EMBEDDED = ${JSON.stringify(embedded)} as Embedded | null;`));
try {
  if (bundle) {
    const r = await Bun.build({ entrypoints: [join(CLI, "src/main.ts")], target: "bun", format: "esm", minify });
    if (!r.success) {
      for (const l of r.logs) console.error(l);
      throw new Error("could not bundle src/main.ts");
    }
    // Bun keeps the entry's own shebang; one line, once.
    const code = (await (r.outputs[0] as Blob).text()).replace(/^#!.*\n/u, "");
    mkdirSync(dirname(resolve(outfile)), { recursive: true });
    writeFileSync(outfile, `#!/usr/bin/env bun\n${code}`);
    chmodSync(outfile, 0o755);
  } else {
    const cmd = ["bun", "build", "--compile", ...(minify ? ["--minify"] : []), ...(target ? [`--target=${target}`] : []), join(CLI, "src/main.ts"), "--outfile", outfile];
    const p = Bun.spawnSync(cmd, { cwd: CLI, stdout: "inherit", stderr: "inherit" });
    if (p.exitCode !== 0) throw new Error(`bun build --compile failed (exit ${p.exitCode})`);
  }
} finally {
  writeFileSync(EMBEDDED, placeholder);
}
console.log(`renox ${version}${target ? ` (${target})` : ""} -> ${outfile}: ${Object.keys(modules).length} module files (${embedded.modulesDigest.slice(0, 12)}), harness ${Math.round(harness.length / 1024)} KB`);
