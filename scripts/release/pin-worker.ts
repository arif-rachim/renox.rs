// bun run pin-worker [x.y.z] [--dry-run] [--yes]
//
// Pins a released renox-worker in the CLI: run it after bump-worker's
// release-worker.yml run is green. Takes the sha256 of each binary from the
// release's SHA256SUMS (the pdf variant from SHA256SUMS.unpacked, the hash
// after gunzip), writes them into PINNED_WORKER (cli/src/worker/verify.ts),
// moves WORKER_VERSION and the docs to the new version, adds a CHANGELOG
// line, runs the tests, then commits and pushes main (no tag: the next
// bump-cli ships it). Default version: crates/renox-cell/Cargo.toml's.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INSTALL_DOCS } from "./bump-cli.ts";
import {
  type Flags,
  changelogAddWorkerLine,
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
  replaceAll,
  replaceIn,
  review,
  run,
  write,
} from "./lib.ts";

const VERIFY = "cli/src/worker/verify.ts";

/** asset name -> sha256, from a SHA256SUMS file ("<hash>  <name>" lines). */
export const parseSums = (text: string): Map<string, string> => {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/u.exec(line.trim());
    if (m) sums.set(m[2]!, m[1]!);
  }
  return sums;
};

/** Rewrites the `<key>: { "target": "hash", ... }` block of PINNED_WORKER, target by target. */
const rewriteBlock = (src: string, key: string, hashOf: (target: string) => string): string => {
  const re = new RegExp(`(\\n  ${key}: \\{\\n)([\\s\\S]*?)(\\n  \\},)`, "u");
  const m = re.exec(src);
  if (!m) throw new Error(`${VERIFY}: no "${key}: {" block in PINNED_WORKER`);
  const body = m[2]!.replace(/"([^"]+)": "[0-9a-f]{64}"/gu, (_all, target: string) => `"${target}": "${hashOf(target)}"`);
  return src.slice(0, m.index) + m[1] + body + m[3] + src.slice(m.index + m[0].length);
};

/**
 * PINNED_WORKER at `version`: every target pinned today gets the new release's hash;
 * a target missing from the release is an error, not a silent drop.
 */
export const rewritePins = (src: string, version: string, sums: Map<string, string>, unpacked: Map<string, string>): string => {
  const pick = (map: Map<string, string>, asset: string, file: string): string => {
    const hash = map.get(asset);
    if (!hash) throw new Error(`worker-v${version} has no ${asset} in ${file}`);
    return hash;
  };
  let out = replaceAll(src, /(\n  version: )"\d+\.\d+\.\d+",/u, `$1"${version}",`, VERIFY);
  out = rewriteBlock(out, "sha256", (t) => {
    const exe = t.includes("windows") ? ".exe" : "";
    return pick(sums, `renox-worker-${version}-${t}${exe}`, "SHA256SUMS");
  });
  out = rewriteBlock(out, "pdf", (t) => pick(unpacked, `renox-worker-${version}-${t}-pdf`, "SHA256SUMS.unpacked"));
  return out;
};

export const currentPinned = (src: string): string => {
  const m = /\n  version: "(\d+\.\d+\.\d+)",/u.exec(src);
  if (!m) throw new Error(`${VERIFY}: no version in PINNED_WORKER`);
  return m[1]!;
};

/** The version strings outside PINNED_WORKER (docs regenerate llms-full.txt afterwards). */
const applyVersionStrings = (from: string, to: string): void => {
  const f = escapeRe(from);
  replaceIn("cli/scripts/fetch-worker.ts", new RegExp(`WORKER_VERSION = "${f}"`, "u"), `WORKER_VERSION = "${to}"`);
  for (const file of ["ops/README.md", "ops/scripts/bootstrap-node.sh"])
    replaceIn(file, new RegExp(`--worker-version ${f}\\b`, "u"), `--worker-version ${to}`);
  for (const doc of INSTALL_DOCS) replaceIn(doc, new RegExp(`\\(renox-worker ${f}\\)`, "u"), `(renox-worker ${to})`);
  replaceIn("README.md", new RegExp(`worker-v${f}\\b`, "u"), `worker-v${to}`);
  replaceIn("README.md", new RegExp(`renox-worker-${f}-`, "u"), `renox-worker-${to}-`);
  replaceIn("docs/12-developer-experience.md", new RegExp(`\\bv=${f};`, "u"), `v=${to};`);
};

/** Lines that still name the old version, for a human to read (history is often right to keep it). */
const leftovers = (from: string): void => {
  const p = Bun.spawnSync(
    ["git", "grep", "-n", "-F", from, "--", "cli/src", "cli/scripts", "cli/README.md", "docs/12-developer-experience.md", "docs/getting-started.md", "docs/tutorial", "README.md", "ops/README.md", "ops/scripts"],
    { stdout: "pipe" },
  );
  const out = new TextDecoder().decode(p.stdout).trim();
  if (out) console.log(`\nstill naming ${from} (check by hand; prose about history may stay):\n${out}\n`);
};

/** The version the CLI pins now. */
export const pinnedVersion = (): string => currentPinned(read(VERIFY));

/** Why the release `tag` cannot be pinned yet, or null when its checksum assets are there. */
export const releaseNotReady = (tag: string): string | null => {
  const view = Bun.spawnSync(["gh", "release", "view", tag, "--json", "assets", "-q", ".assets[].name"], { stdout: "pipe", stderr: "pipe" });
  if (view.exitCode !== 0) return `no release ${tag} yet: is release-worker.yml finished? (gh run list --workflow release-worker.yml -L1)`;
  const assets = new TextDecoder().decode(view.stdout).split(/\r?\n/u);
  for (const need of ["SHA256SUMS", "SHA256SUMS.unpacked"])
    if (!assets.includes(need)) return `${tag} has no ${need} yet: wait for release-worker.yml to finish`;
  return null;
};

/** Pins worker `version` (default: crates/renox-cell's) in the CLI, commits and pushes main. */
export const pinWorker = (version: string | undefined, flags: Flags): string => {
  const cargo = /^version = "(\d+\.\d+\.\d+)"$/mu.exec(read("crates/renox-cell/Cargo.toml"))?.[1];
  const to = version ?? cargo;
  if (!to) throw new Error("no version: pass one, or set crates/renox-cell/Cargo.toml");
  const from = pinnedVersion();
  console.log(`pin renox-worker ${from} -> ${to}`);
  if (from === to) console.warn(`warning: the CLI already pins ${to}; the hashes are re-read from the release`);
  preflight(null, flags);

  const tag = `worker-v${to}`;
  const notReady = releaseNotReady(tag);
  if (notReady) throw new Error(notReady);

  const dir = mkdtempSync(join(tmpdir(), "renox-pin-"));
  try {
    run(["gh", "release", "download", tag, "-p", "SHA256SUMS", "-p", "SHA256SUMS.unpacked", "-D", dir]);
    const sums = parseSums(readFileSync(join(dir, "SHA256SUMS"), "utf8"));
    const unpacked = parseSums(readFileSync(join(dir, "SHA256SUMS.unpacked"), "utf8"));
    write(VERIFY, rewritePins(read(VERIFY), to, sums, unpacked));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (from !== to) applyVersionStrings(from, to);
  const cliVersion = (JSON.parse(read("cli/package.json")) as { version: string }).version;
  const line = `- Pins \`renox-worker\` ${to}.`;
  if (!read("CHANGELOG.md").includes(line))
    write("CHANGELOG.md", changelogAddWorkerLine(read("CHANGELOG.md"), line, nextVersion(cliVersion, "patch")));
  regenerateLlms();
  guard(
    flags,
    ["bun", "run", "--filter", "@renox/cli", "check"],
    ["bun", "test", "cli/tests/worker-verify.test.ts", "cli/tests/fetch-worker.test.ts", "www/tests/llms.test.ts"],
  );
  if (from !== to) leftovers(from);
  review(flags);

  confirm(`Commit "Pin renox-worker ${to} in the CLI" and push to main?`, flags);
  commitTagPush(`Pin renox-worker ${to} in the CLI\n\nPINNED_WORKER takes the sha256 of ${tag} (SHA256SUMS, and\nSHA256SUMS.unpacked for the pdf variant); WORKER_VERSION and the docs follow.`, null);
  console.log("\npushed. Next: write the CHANGELOG notes, then bun run bump-cli patch");
  return to;
};

if (import.meta.main) cli(() => {
  const flags = parseFlags(process.argv.slice(2));
  pinWorker(flags.positional[0], flags);
});
