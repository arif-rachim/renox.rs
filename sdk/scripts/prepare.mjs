// `prepare` of the package: builds dist/ before `npm pack` and `npm publish`
// (#376). Plain Node, no shell: npm runs lifecycle scripts through cmd.exe on
// Windows, where a `test -x ...; then ...; fi` one-liner fails. With no
// TypeScript compiler in the workspace (`bun install --production`) nothing is
// built and the script says so.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(sdk, "..", "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsc)) {
  console.log("renox: no TypeScript compiler in node_modules (bun install --production), sdk/dist is not built");
  process.exit(0);
}

rmSync(join(sdk, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: sdk, stdio: "inherit" });
