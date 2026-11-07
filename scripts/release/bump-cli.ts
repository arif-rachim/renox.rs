// bun run bump-cli <patch|minor|major|x.y.z> [--dry-run] [--yes]
// bun run bump-cli --tag-only [x.y.z]      tag a release commit already on main
//
// Releases the renox CLI, create-renox and @renoxium/sdk at one version: they
// share the tag cli-v<version>, which runs release-cli.yml and release-sdk.yml.
// Bumps the version and the install lines, dates the CHANGELOG entry
// "## <version> (unreleased)" (write the notes first), runs the tests, then
// commits, tags and pushes main. Pin a new worker first: bun run pin-worker.

import {
  type Flags,
  changelogRelease,
  cli,
  commitTagPush,
  confirm,
  escapeRe,
  guard,
  nextVersion,
  parseFlags,
  preflight,
  regenerateLlms,
  read,
  replaceIn,
  review,
  run,
  today,
  write,
} from "./lib.ts";

/** Files that carry the install line `cli-v<version>` and/or `renox <version> (renox-worker ...)`. */
export const INSTALL_DOCS = [
  "cli/README.md",
  "docs/12-developer-experience.md",
  "docs/getting-started.md",
  "docs/tutorial/01-install.md",
];

const pkgVersion = (file: string): string => (JSON.parse(read(file)) as { version: string }).version;

/** Applies every file change of a release from `from` to `to`, except www/public/llms-full.txt (regenerated). */
export const applyCliBump = (from: string, to: string, date: string): void => {
  // First: without release notes nothing else changes.
  write("CHANGELOG.md", changelogRelease(read("CHANGELOG.md"), to, date));
  const f = escapeRe(from);
  for (const pkg of ["cli/package.json", "sdk/package.json"])
    replaceIn(pkg, new RegExp(`^  "version": "${f}",$`, "mu"), `  "version": "${to}",`);
  for (const name of ["@renox/cli", "@renoxium/sdk"])
    replaceIn("bun.lock", new RegExp(`("name": "${escapeRe(name)}",\\n\\s+"version": )"${f}"`, "u"), `$1"${to}"`);
  replaceIn("control/dashboard/lib/install.ts", new RegExp(`CLI_VERSION = "${f}"`, "u"), `CLI_VERSION = "${to}"`);
  replaceIn("control/dashboard/tests/onboarding.test.ts", new RegExp(`cli-v${f}/`, "u"), `cli-v${to}/`);
  for (const doc of INSTALL_DOCS) {
    replaceIn(doc, new RegExp(`cli-v${f}/`, "u"), `cli-v${to}/`);
    replaceIn(doc, new RegExp(`renox ${f} \\(renox-worker`, "u"), `renox ${to} (renox-worker`);
  }
};

const tests = (flags: Flags): void =>
  guard(
    flags,
    ["bun", "run", "--filter", "@renox/cli", "--filter", "@renoxium/sdk", "--filter", "@renox/dashboard", "check"],
    ["bun", "test", "cli/tests", "sdk/tests", "control/dashboard/tests/onboarding.test.ts", "www/tests/llms.test.ts"],
  );

const tagOnly = (flags: Flags): void => {
  const current = pkgVersion("cli/package.json");
  const version = flags.positional[0] ?? current;
  if (version !== current) throw new Error(`cli/package.json says ${current}, not ${version}: run bump-cli ${version} instead`);
  if (pkgVersion("sdk/package.json") !== version) throw new Error(`sdk/package.json is not ${version}`);
  const tag = `cli-v${version}`;
  preflight(tag, flags);
  console.log(`tag ${tag} on ${run(["git", "log", "--oneline", "-1"], { quiet: true })}`);
  if (flags.dryRun) return console.log("dry run: nothing tagged or pushed.");
  confirm(`Tag ${tag} and push it (starts release-cli and release-sdk)?`, flags);
  run(["git", "tag", "-a", tag, "-m", tag]);
  run(["git", "push", "origin", tag]);
  console.log(`\npushed ${tag}. Watch: gh run list --workflow release-cli.yml -L1; gh run list --workflow release-sdk.yml -L1`);
};

if (import.meta.main) cli(() => {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.tagOnly) return tagOnly(flags);
  const arg = flags.positional[0];
  if (!arg) throw new Error("usage: bun run bump-cli <patch|minor|major|x.y.z> [--dry-run] [--yes] | --tag-only [x.y.z]");
  const from = pkgVersion("cli/package.json");
  const sdk = pkgVersion("sdk/package.json");
  if (sdk !== from) throw new Error(`cli/package.json (${from}) and sdk/package.json (${sdk}) differ; fix that first`);
  const to = nextVersion(from, arg);
  const tag = `cli-v${to}`;
  console.log(`CLI + SDK ${from} -> ${to} (tag ${tag})`);
  preflight(tag, flags);

  applyCliBump(from, to, today());
  regenerateLlms();
  tests(flags);
  review(flags);

  confirm(`Commit, tag ${tag} and push to main?`, flags);
  commitTagPush(`Release ${tag}\n\nVersion ${to} for the CLI, create-renox and @renoxium/sdk; the install\nline moves to ${tag}; CHANGELOG dates the ${to} entry.`, tag);
  console.log(`\npushed ${tag}. Watch: gh run list --workflow release-cli.yml -L1; gh run list --workflow release-sdk.yml -L1`);
});
