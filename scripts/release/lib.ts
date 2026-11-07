// Shared helpers of the release scripts (bump-worker, pin-worker, bump-cli).
// A release commit goes straight to main with its tag: no branch, no PR.
// See CLAUDE.md, "Releases".

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");

export type Bump = "patch" | "minor" | "major";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;

const parse = (v: string): [number, number, number] => {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`not a version x.y.z: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

export const compare = (a: string, b: string): number => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
};

/** The next version: a bump kind applied to `current`, or an explicit x.y.z above it. */
export const nextVersion = (current: string, arg: string): string => {
  const [maj, min, pat] = parse(current);
  if (arg === "patch") return `${maj}.${min}.${pat + 1}`;
  if (arg === "minor") return `${maj}.${min + 1}.0`;
  if (arg === "major") return `${maj + 1}.0.0`;
  parse(arg);
  if (compare(arg, current) <= 0) throw new Error(`${arg} is not above the current version ${current}`);
  return arg;
};

export interface Flags {
  dryRun: boolean;
  yes: boolean;
  tagOnly: boolean;
  skipTests: boolean;
  positional: string[];
}

/** The flags of this run, for the error path of cli(). */
let active: Flags | null = null;

export const parseFlags = (argv: string[]): Flags => {
  const flags: Flags = { dryRun: false, yes: false, tagOnly: false, skipTests: false, positional: [] };
  for (const a of argv) {
    if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--tag-only") flags.tagOnly = true;
    else if (a === "--skip-tests") flags.skipTests = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag ${a}`);
    else flags.positional.push(a);
  }
  active = flags;
  return flags;
};

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** A file of the repository, with LF line ends (a Windows checkout has CRLF). */
export const read = (file: string): string => readFileSync(join(ROOT, file), "utf8").replace(/\r\n/gu, "\n");
/** Writes LF text back with the line ends the file has on disk. */
export const write = (file: string, text: string): void => {
  const path = join(ROOT, file);
  const crlf = existsSync(path) && readFileSync(path, "utf8").includes("\r\n");
  writeFileSync(path, crlf ? text.replace(/\n/gu, "\r\n") : text);
};

/**
 * Replaces every match of `pattern` (made global) in `text`; throws when there is none,
 * so a string that moved fails the release instead of being skipped.
 */
export const replaceAll = (text: string, pattern: RegExp, replacement: string, where = "text"): string => {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  if (!re.test(text)) throw new Error(`${where}: no match for ${pattern}`);
  re.lastIndex = 0;
  return text.replace(re, replacement);
};

/** replaceAll on a file of the repository. */
export const replaceIn = (file: string, pattern: RegExp, replacement: string): void =>
  write(file, replaceAll(read(file), pattern, replacement, file));

const decode = (b: Uint8Array | undefined): string => (b ? new TextDecoder().decode(b).trim() : "");

/** Runs a command in the repository; prints it, stops on a non-zero exit, returns stdout. */
export const run = (cmd: string[], opts: { quiet?: boolean; cwd?: string } = {}): string => {
  if (!opts.quiet) console.log(`$ ${cmd.join(" ")}`);
  const p = Bun.spawnSync(cmd, {
    cwd: opts.cwd ?? ROOT,
    stdout: opts.quiet ? "pipe" : "inherit",
    stderr: opts.quiet ? "pipe" : "inherit",
  });
  if (p.exitCode !== 0) {
    const err = opts.quiet ? `\n${decode(p.stderr)}` : "";
    throw new Error(`failed (exit ${p.exitCode}): ${cmd.join(" ")}${err}`);
  }
  return opts.quiet ? decode(p.stdout) : "";
};

export const git = (...args: string[]): string => run(["git", ...args], { quiet: true });

/** Tracked files with changes now. */
const dirtyFiles = (): Set<string> => new Set(git("diff", "--name-only", "HEAD").split("\n").filter(Boolean));

/** Files dirty before the script changed anything (a dry run leaves them alone). */
let dirtyBefore: Set<string> | null = null;

/**
 * main, clean tracked tree, equal to origin/main, tag free locally and on origin.
 * A dry run reports the failures as warnings.
 */
export const preflight = (tag: string | null, flags: Flags): void => {
  const problems: string[] = [];
  git("fetch", "--quiet", "origin", "main", "--tags");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") problems.push(`on branch ${branch}, not main`);
  const status = git("status", "--porcelain");
  const tracked = status.split("\n").filter((l) => l && !l.startsWith("??"));
  dirtyBefore = dirtyFiles();
  if (tracked.length) problems.push(`uncommitted changes:\n  ${tracked.join("\n  ")}`);
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) problems.push("HEAD is not origin/main (pull or push first)");
  if (tag && git("tag", "--list", tag)) problems.push(`tag ${tag} exists locally`);
  if (tag && git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) problems.push(`tag ${tag} exists on origin`);
  if (!problems.length) return;
  const msg = `preflight:\n- ${problems.join("\n- ")}`;
  if (flags.dryRun) console.warn(`warning (dry run goes on): ${msg}`);
  else throw new Error(msg);
};

export const confirm = (question: string, flags: Flags): void => {
  if (flags.yes) return;
  const answer = prompt(`${question} [y/N]`);
  if (!answer || !/^y(es)?$/iu.test(answer.trim())) throw new Error("aborted");
};

/**
 * Shows the change; on a dry run, reverts the files the script changed (not
 * the ones that were dirty before it ran) and exits.
 */
const changedByRun = (): string[] => (dirtyBefore ? [...dirtyFiles()].filter((f) => !dirtyBefore!.has(f)) : []);

export const review = (flags: Flags): void => {
  const changed = changedByRun();
  if (!changed.length) console.log("no file changed.");
  else run(["git", "--no-pager", "diff", "--stat", "HEAD", "--", ...changed]);
  if (flags.dryRun) {
    if (changed.length) {
      run(["git", "--no-pager", "diff", "HEAD", "--", ...changed]);
      run(["git", "checkout", "HEAD", "--", ...changed]);
    }
    if (dirtyBefore?.size) console.warn(`left as they were (dirty before the run): ${[...dirtyBefore].join(", ")}`);
    console.log("dry run: changes shown above and reverted; nothing committed, tagged or pushed.");
    process.exit(0);
  }
};

/** Commits every tracked change, optionally tags it (annotated), and pushes main and the tag. */
export const commitTagPush = (message: string, tag: string | null): void => {
  run(["git", "commit", "-a", "-m", message]);
  if (tag) run(["git", "tag", "-a", tag, "-m", tag]);
  run(["git", "push", "origin", "main"]);
  if (tag) run(["git", "push", "origin", tag]);
};

/** Runs `main`, printing an error line instead of a stack for expected failures. */
export const cli = (main: () => Promise<void> | void): void => {
  Promise.resolve()
    .then(main)
    .catch((e: unknown) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      const changed = changedByRun();
      if (changed.length && active?.dryRun) {
        git("checkout", "HEAD", "--", ...changed);
        console.error("dry run: the changes are reverted.");
      } else if (changed.length) {
        console.error(`nothing pushed; changed files left for you: ${changed.join(", ")} (git checkout HEAD -- <files> discards them)`);
      }
      process.exit(1);
    });
};

/**
 * The local guard. Typecheck always; the tests where CI runs them (Linux, macOS):
 * on a Windows checkout (CRLF) the cli tests fail on main too, so there CI's
 * run after the push is the test.
 */
export const guard = (flags: Flags, typecheck: string[], tests: string[]): void => {
  run(typecheck);
  if (flags.skipTests) return console.warn("warning: --skip-tests: tests not run locally");
  if (process.platform === "win32") return console.warn("warning: tests not run on Windows (CRLF checkout fails them on main too); CI runs them after the push");
  run(tests);
};

/** Regenerates www/public/llms*.txt, keeping the line ends the checkout has. */
export const regenerateLlms = (): void => {
  const files = ["www/public/llms.txt", "www/public/llms-full.txt"];
  const crlf = files.map((f) => readFileSync(join(ROOT, f), "utf8").includes("\r\n"));
  run(["bun", "www/scripts/llms.ts"]);
  files.forEach((f, i) => {
    const text = readFileSync(join(ROOT, f), "utf8").replace(/\r\n/gu, "\n");
    writeFileSync(join(ROOT, f), crlf[i] ? text.replace(/\n/gu, "\r\n") : text);
  });
};

export const today = (): string => new Date().toISOString().slice(0, 10);

const UNRELEASED = /^## (\d+\.\d+\.\d+) \(unreleased\)$/mu;

/** The version of CHANGELOG.md's "(unreleased)" entry, or null. */
export const unreleasedVersion = (changelog: string): string | null => UNRELEASED.exec(changelog)?.[1] ?? null;

/** The [start, end) offsets of the section whose heading line is at `start`. */
const sectionEnd = (text: string, start: number): number => {
  const next = text.indexOf("\n## ", start + 1);
  return next === -1 ? text.length : next + 1;
};

/**
 * Adds a bullet under **Worker** of the unreleased entry; creates the entry
 * (`## <fallback> (unreleased)`) before the first release heading if there is none.
 */
export const changelogAddWorkerLine = (changelog: string, line: string, fallbackVersion: string): string => {
  let text = changelog;
  if (!UNRELEASED.test(text)) {
    const first = text.search(/^## /mu);
    const at = first === -1 ? text.length : first;
    text = `${text.slice(0, at)}## ${fallbackVersion} (unreleased)\n\n${text.slice(at)}`;
  }
  const start = text.search(UNRELEASED);
  const end = sectionEnd(text, start);
  const section = text.slice(start, end);
  let updated: string;
  const worker = section.indexOf("**Worker**\n\n");
  if (worker !== -1) {
    const at = worker + "**Worker**\n\n".length;
    updated = `${section.slice(0, at)}${line}\n${section.slice(at)}`;
  } else {
    updated = `${section.trimEnd()}\n\n**Worker**\n\n${line}\n\n`;
  }
  return text.slice(0, start) + updated + text.slice(end);
};

export const installBlock = (version: string): string =>
  [
    "**Install**",
    "",
    "```sh",
    `curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v${version}/install.sh | sh`,
    "```",
    "",
    "On Windows (x64, PowerShell): `irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex`.",
    "",
  ].join("\n");

/** Dates the `## <version> (unreleased)` entry and gives it an **Install** block after its first paragraph. */
export const changelogRelease = (changelog: string, version: string, date: string): string => {
  const heading = new RegExp(`^## ${escapeRe(version)} \\(unreleased\\)$`, "mu");
  const start = changelog.search(heading);
  if (start === -1) {
    const found = unreleasedVersion(changelog);
    throw new Error(
      `CHANGELOG.md has no "## ${version} (unreleased)" entry${found ? ` (it has ${found})` : ""}; write the release notes first`,
    );
  }
  const end = sectionEnd(changelog, start);
  let section = changelog.slice(start, end).replace(heading, `## ${version} (${date})`);
  if (!section.includes("**Install**")) {
    const lines = section.split("\n");
    // heading, blank, first paragraph..., blank: insert after the first paragraph.
    let i = 2;
    while (i < lines.length && lines[i] !== "") i++;
    lines.splice(i + 1, 0, ...installBlock(version).split("\n"));
    section = lines.join("\n");
  }
  return changelog.slice(0, start) + section + changelog.slice(end);
};

/** The body of the "(unreleased)" entry (without its heading), or null. */
export const unreleasedBody = (changelog: string): string | null => {
  const start = changelog.search(UNRELEASED);
  if (start === -1) return null;
  const section = changelog.slice(start, sectionEnd(changelog, start));
  return section.slice(section.indexOf("\n") + 1).trim();
};

/** Sets the "(unreleased)" entry to `## <version> (unreleased)` + `body`, replacing it or adding it first. */
export const setUnreleased = (changelog: string, version: string, body: string): string => {
  const entry = `## ${version} (unreleased)\n\n${body.trim()}\n\n`;
  const start = changelog.search(UNRELEASED);
  if (start !== -1) return changelog.slice(0, start) + entry + changelog.slice(sectionEnd(changelog, start));
  const first = changelog.search(/^## /mu);
  const at = first === -1 ? changelog.length : first;
  return changelog.slice(0, at) + entry + changelog.slice(at);
};

/** Renames the "(unreleased)" entry to `version` when it carries another one (a minor instead of the patch). */
export const renameUnreleased = (changelog: string, version: string): string => {
  const found = unreleasedVersion(changelog);
  return found && found !== version ? changelog.replace(UNRELEASED, `## ${version} (unreleased)`) : changelog;
};

/** The newest tag `<prefix><x.y.z>`, or null. */
export const lastTag = (prefix: string): string | null => {
  const tags = git("tag", "--list", `${prefix}*`).split("\n").filter((t) => /^\d+\.\d+\.\d+$/u.test(t.slice(prefix.length)));
  tags.sort((a, b) => compare(b.slice(prefix.length), a.slice(prefix.length)));
  return tags[0] ?? null;
};

/** Subjects of the non-merge commits since `tag` that touch `paths`, oldest first. */
export const commitsSince = (tag: string | null, paths: string[]): string[] =>
  git("log", "--no-merges", "--reverse", "--format=%s", ...(tag ? [`${tag}..HEAD`] : ["HEAD"]), "--", ...paths)
    .split("\n")
    .filter(Boolean);

/** A numbered menu; returns the index of the choice (Enter: the first). */
export const choose = (question: string, options: string[]): number => {
  console.log(`\n${question}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  for (;;) {
    const answer = (prompt(`choice [1-${options.length}, Enter = 1]:`) ?? "").trim();
    if (answer === "") return 0;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
    console.log("not a choice.");
  }
};

/** Opens `text` in the git editor (VISUAL, EDITOR or core.editor) and returns what was saved. */
export const editText = (text: string): string => {
  const file = join(tmpdir(), `renox-release-notes-${process.pid}.md`);
  writeFileSync(file, text);
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? git("var", "GIT_EDITOR");
  const line = `${editor} "${file}"`;
  const shell = process.platform === "win32" ? ["cmd", "/c", line] : ["sh", "-c", line];
  const p = Bun.spawnSync(shell, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`editor exited with ${p.exitCode}: ${editor}`);
  const out = readFileSync(file, "utf8").replace(/\r\n/gu, "\n");
  rmSync(file, { force: true });
  return out;
};
