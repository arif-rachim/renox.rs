// Prints `<dir> <hash>` for each directory argument, in argument order: the
// artifact hash `renox build` computes. CI builds the same examples on Linux
// and Windows and diffs the two outputs (.github/workflows/ci.yml, jobs
// `windows` and `windows-hash-parity`), so a line-ending or path-separator
// difference in the build shows up as a hash difference.
//
//   bun cli/scripts/build-hash.ts examples/hello examples/npm-compat
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArtifact } from "../src/lib/build.ts";

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: bun cli/scripts/build-hash.ts <dir>...");
  process.exit(2);
}

for (const dir of dirs) {
  const out = mkdtempSync(join(tmpdir(), "renox-hash-"));
  try {
    const { hash } = await buildArtifact(dir, out);
    console.log(`${dir} ${hash}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
