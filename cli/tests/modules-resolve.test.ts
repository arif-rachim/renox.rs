// #234: the module resolver and renox.lock (docs/contracts/manifest.md
// sections 2, 5, 6): ranges, cycles, unsatisfied ranges naming both
// modules, path: and git: sources, a stable lock.

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatLock } from "../src/lib/modules/lock.ts";
import { lockEntryOf, readModulesTable, resolveModules, treeHash } from "../src/lib/modules/resolve.ts";
import { isRange, satisfies } from "../src/lib/modules/semver.ts";
import { AUTH_EXTRA, app, writeModule } from "./modules-fixture.ts";

test("ranges of manifest.md section 2", () => {
  const cases: [string, string, boolean][] = [
    ["1.4.2", "^1.2", true],
    ["2.0.0", "^1.2", false],
    ["0.3.9", "^0.3", true],
    ["0.4.0", "^0.3", false],
    ["0.0.4", "^0.0.4", true],
    ["0.0.5", "^0.0.4", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["1.0.0", "=1.0.0", true],
    ["1.4.0", ">=1.2.0 <1.5.0", true],
    ["1.5.0", ">=1.2.0 <1.5.0", false],
    ["1.3.0-rc.1", "^1.0", false],
    ["1.3.0-rc.1", "1.3.0-rc.1", true],
  ];
  for (const [v, r, ok] of cases) expect([v, r, satisfies(v, r)]).toEqual([v, r, ok]);
  for (const bad of ["*", "1.x", "^1 || ^2", "1.0.0 - 2.0.0"]) expect([bad, isRange(bad)]).toEqual([bad, false]);
});

test("org after auth: versions resolve and the order is topological, ties by name", () => {
  const dir = app(
    { org: '{ version = "^1.0", source = "path:modules/org" }', auth: '{ version = "^1.0", source = "path:modules/auth" }', gcc: '{ version = "~0.1", source = "path:modules/gcc" }' },
    [
      { name: "auth", version: "1.2.0", extra: AUTH_EXTRA },
      { name: "org", version: "1.0.0", dependencies: { auth: "^1.1" } },
      { name: "gcc", version: "0.1.3" },
    ],
  );
  const { specs } = readModulesTable(dir);
  const r = resolveModules(dir, specs);
  expect(r.problems).toEqual([]);
  expect(r.modules.map((m) => `${m.name}@${m.manifest.version}`)).toEqual(["auth@1.2.0", "gcc@0.1.3", "org@1.0.0"]);
  rmSync(dir, { recursive: true });
});

test("a cycle is rejected with the cycle printed", () => {
  const dir = app({ a: '{ version = "^1.0", source = "path:modules/a" }', b: '{ version = "^1.0", source = "path:modules/b" }' }, [
    { name: "a", version: "1.0.0", dependencies: { b: "^1.0" } },
    { name: "b", version: "1.0.0", dependencies: { a: "^1.0" } },
  ]);
  const r = resolveModules(dir, readModulesTable(dir).specs);
  expect(r.problems).toEqual([{ rule: "MF5", file: "renox.toml", message: "dependency cycle a -> b -> a" }]);
  rmSync(dir, { recursive: true });
});

test("an unsatisfied dependency range is an error naming both modules", () => {
  const dir = app({ auth: '{ version = "^1.0", source = "path:modules/auth" }', org: '{ version = "^1.0", source = "path:modules/org" }' }, [
    { name: "auth", version: "1.2.0", extra: AUTH_EXTRA },
    { name: "org", version: "1.0.0", dependencies: { auth: "^2.0" } },
  ]);
  const r = resolveModules(dir, readModulesTable(dir).specs);
  expect(r.problems).toEqual([{ rule: "MF2", file: "org/module.toml", message: 'org needs auth "^2.0", but auth 1.2.0 is installed' }]);
  // The tenant's own range too.
  const r2 = resolveModules(dir, { auth: { version: "^1.5", source: "path:modules/auth" } });
  expect(r2.problems[0]?.message).toBe('auth 1.2.0 (path:modules/auth) does not satisfy renox.toml "^1.5"');
  // A dependency that is not installed: never installed implicitly.
  const r3 = resolveModules(dir, { org: { version: "^1.0", source: "path:modules/org" } });
  expect(r3.problems[0]?.message).toContain("org depends on auth ^2.0, which is not installed");
  rmSync(dir, { recursive: true });
});

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

test("path: and git: sources; git is cloned at the ref and pinned to its commit", () => {
  // A local bare repository stands in for https://git.example.test/acme.git
  // through git's own url.<base>.insteadOf (no hook in the CLI).
  const repos = mkdtempSync(join(tmpdir(), "renox-git-"));
  const work = writeModule(repos, { name: "acme", version: "0.4.1" });
  git(["init", "--quiet", "-b", "main"], work);
  git(["add", "."], work);
  git(["commit", "--quiet", "-m", "acme 0.4.1"], work);
  git(["tag", "v0.4.1"], work);
  git(["clone", "--quiet", "--bare", work, join(repos, "acme.git")], repos);
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: work }).stdout.toString().trim();
  const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${repos}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://git.example.test/" };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const dir = app({ acme: '{ version = "^0.4", source = "git:https://git.example.test/acme.git#v0.4.1" }', auth: '{ version = "^1.0", source = "path:modules/auth" }' }, [{ name: "auth", version: "1.0.0", extra: AUTH_EXTRA }]);
    const r = resolveModules(dir, readModulesTable(dir).specs);
    expect(r.problems).toEqual([]);
    const acme = r.modules.find((m) => m.name === "acme");
    expect(acme?.source).toBe(`git:https://git.example.test/acme.git#${commit}`);
    expect(existsSync(join(dir, ".renox", "modules", "acme", commit, "module.toml"))).toBe(true);
    expect(existsSync(join(dir, ".renox", "modules", "acme", commit, ".git"))).toBe(false);
    expect(r.modules.find((m) => m.name === "auth")?.source).toBe("path:modules/auth");
    // The hash covers the checked-out files only (no .git).
    rmSync(join(work, ".git"), { recursive: true });
    expect(acme?.hash).toBe(treeHash(work));
    rmSync(dir, { recursive: true });
  } finally {
    process.env = saved;
    rmSync(repos, { recursive: true });
  }
});

test("the lock content and hashes are stable across runs", () => {
  const dir = app({ auth: '{ version = "^1.0", source = "path:modules/auth", config = { registration = "invite" } }' }, [{ name: "auth", version: "1.0.0", extra: AUTH_EXTRA }]);
  const once = () => formatLock(resolveModules(dir, readModulesTable(dir).specs).modules.map((m) => lockEntryOf(m)));
  const a = once();
  expect(once()).toBe(a);
  expect(a).toContain('config = { registration = "invite", session_days = 30 }');
  expect(a).toContain('approved = { tables = "auth__*", network = ["accounts.google.com"], secrets = ["AUTH_GOOGLE_CLIENT_SECRET"], slots = [], hooks = [] }');
  // The lock parses back and passes the contract schema (formatLock is checked by the add tests too).
  const parsed = Bun.TOML.parse(a) as { module: { hash: string }[] };
  expect(parsed.module[0]?.hash).toMatch(/^[0-9a-f]{64}$/u);
  expect(readFileSync(join(dir, "modules", "auth", "module.toml"), "utf8")).toContain('name = "auth"');
  rmSync(dir, { recursive: true });
});
