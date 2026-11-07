// bun run bump-worker <patch|minor|major|x.y.z> [--dry-run] [--yes]
//
// Releases renox-worker: sets the version of crates/renox-cell (Cargo.toml
// and its Cargo.lock entry, which release-worker.yml checks against the tag),
// checks the lockfile, then commits, tags worker-v<version> and pushes main.
// When release-worker.yml is green: bun run pin-worker.

import {
  cli,
  commitTagPush,
  confirm,
  escapeRe,
  nextVersion,
  parseFlags,
  preflight,
  read,
  replaceIn,
  review,
  run,
} from "./lib.ts";

const MANIFEST = "crates/renox-cell/Cargo.toml";

if (import.meta.main) cli(() => {
  const flags = parseFlags(process.argv.slice(2));
  const arg = flags.positional[0];
  if (!arg) throw new Error("usage: bun run bump-worker <patch|minor|major|x.y.z> [--dry-run] [--yes]");
  const from = /^version = "(\d+\.\d+\.\d+)"$/mu.exec(read(MANIFEST))?.[1];
  if (!from) throw new Error(`${MANIFEST}: no version line`);
  const to = nextVersion(from, arg);
  const tag = `worker-v${to}`;
  console.log(`renox-worker ${from} -> ${to} (tag ${tag})`);
  preflight(tag, flags);

  const f = escapeRe(from);
  replaceIn(MANIFEST, new RegExp(`^version = "${f}"$`, "mu"), `version = "${to}"`);
  replaceIn("Cargo.lock", new RegExp(`(name = "renox-cell"\\nversion = )"${f}"`, "u"), `$1"${to}"`);
  // The lockfile must now agree with the manifests (no resolution, no network).
  run(["cargo", "metadata", "--locked", "--offline", "--format-version", "1", "--no-deps"], { quiet: true });
  review(flags);

  confirm(`Commit, tag ${tag} and push to main (starts release-worker.yml)?`, flags);
  commitTagPush(`Release ${tag}\n\ncrates/renox-cell ${from} -> ${to}; the tag runs release-worker.yml.`, tag);
  console.log(`\npushed ${tag}. Watch: gh run watch $(gh run list --workflow release-worker.yml -L1 --json databaseId -q '.[0].databaseId')`);
  console.log("When it is green: bun run pin-worker");
});
