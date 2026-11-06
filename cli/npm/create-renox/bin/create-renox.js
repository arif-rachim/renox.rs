#!/usr/bin/env bun
// bun create renox <app> [--template <name>] (#440, ADR D30): runs `renox new`
// from the @renoxium/cli package this package depends on.
const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith("-")) {
  console.error("usage: bun create renox <app> [--template <name>]");
  process.exit(2);
}
const renox = Bun.fileURLToPath(import.meta.resolve("@renoxium/cli/bin/renox.js"));
const r = Bun.spawnSync(["bun", renox, "new", ...args], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(r.exitCode ?? 1);
