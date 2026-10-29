// #234: renox add with permission approval (docs/contracts/manifest.md
// section 3), renox remove, and renox check's lock rules (MF3, MF12).

import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { addModule } from "../src/commands/add.ts";
import { removeModule } from "../src/commands/remove.ts";
import { readLock } from "../src/lib/modules/lock.ts";
import { schemas } from "../src/lib/modules/manifest.ts";
import { projectProblems } from "../src/lib/modules/resolve.ts";
import { validate } from "../src/lib/schema.ts";
import { AUTH_EXTRA, app } from "./modules-fixture.ts";

/** Runs `fn` with console.log captured. */
async function capture(fn: () => Promise<number> | number): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    const code = await fn();
    return { code, out: lines.join("\n") };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

const shop = () => app({}, [
  { name: "auth", version: "1.0.0", extra: AUTH_EXTRA },
  { name: "org", version: "1.0.0", dependencies: { auth: "^1.0" }, extra: '[permissions]\ntables = "org__*"\n' },
]);

test("the approval prompt shows what the module asks for", async () => {
  const dir = shop();
  let asked = "";
  const { code, out } = await capture(() =>
    addModule(dir, "auth", { source: "path:modules/auth" }, async (q) => {
      asked = q;
      return false;
    }),
  );
  expect(code).toBe(1);
  expect(asked).toBe("Approve and install auth?");
  expect(out.replace(/path:modules\/auth/u, "path:<tree>")).toMatchSnapshot();
  rmSync(dir, { recursive: true });
});

test("a declined approval leaves renox.toml and renox.lock unchanged", async () => {
  const dir = shop();
  const before = readFileSync(join(dir, "renox.toml"), "utf8");
  await capture(() => addModule(dir, "auth", { source: "path:modules/auth" }, async () => false));
  expect(readFileSync(join(dir, "renox.toml"), "utf8")).toBe(before);
  expect(readLock(dir).entries).toBeNull();
  rmSync(dir, { recursive: true });
});

test("--yes installs without asking: renox.toml entry and a lock in topological order", async () => {
  const dir = shop();
  const never = async (): Promise<boolean> => {
    throw new Error("asked");
  };
  expect((await capture(() => addModule(dir, "auth", { source: "path:modules/auth", yes: true }, never))).code).toBe(0);
  expect((await capture(() => addModule(dir, "org", { source: "path:modules/org", mount: "/teams", yes: true }, never))).code).toBe(0);
  const toml = readFileSync(join(dir, "renox.toml"), "utf8");
  expect(toml).toContain('[modules]\nauth = { version = "^1.0.0", source = "path:modules/auth" }\norg = { version = "^1.0.0", source = "path:modules/org", mount = "/teams" }\n');
  const lockText = readFileSync(join(dir, "renox.lock"), "utf8");
  expect(validate(schemas.lock, Bun.TOML.parse(lockText) as never)).toEqual([]);
  const { entries } = readLock(dir);
  expect(entries?.map((e) => [e.name, e.mount, e.dependencies])).toEqual([
    ["auth", "/auth", []],
    ["org", "/teams", ["auth"]],
  ]);
  expect(projectProblems(dir)).toEqual([]);
  // remove: org first (it depends on auth), and the tables stay.
  await expect(async () => removeModule(dir, "auth")).toThrow("auth cannot be removed: org depends on it");
  const { out } = await capture(() => removeModule(dir, "org"));
  expect(out).toContain("the org__* tables stay");
  expect(readLock(dir).entries?.map((e) => e.name)).toEqual(["auth"]);
  expect(readFileSync(join(dir, "renox.toml"), "utf8")).not.toContain("org =");
  rmSync(dir, { recursive: true });
});

test("org cannot be added before its dependency", async () => {
  const dir = shop();
  await expect(addModule(dir, "org", { source: "path:modules/org", yes: true })).rejects.toThrow("org depends on auth ^1.0, which is not installed");
  rmSync(dir, { recursive: true });
});

test("a manifest changed after approval fails renox check with MF12 until approved again", async () => {
  const dir = shop();
  await capture(() => addModule(dir, "auth", { source: "path:modules/auth", yes: true }));
  const manifest = join(dir, "modules", "auth", "module.toml");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace('network = ["accounts.google.com"]', 'network = ["accounts.google.com", "evil.example.com"]'));
  const problems = projectProblems(dir);
  expect(problems.map((p) => p.rule)).toContain("MF12");
  expect(problems.find((p) => p.message.includes("[permissions] differ"))?.message).toBe("auth: [permissions] differ from the approved permissions in renox.lock; run renox add auth to approve them");
  // The `--json` report of renox check carries the rule id.
  const proc = Bun.spawnSync(["bun", join(import.meta.dir, "../src/main.ts"), "check", "--json"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(proc.exitCode).toBe(2);
  const report = JSON.parse(proc.stdout.toString()) as { ok: boolean; errors: { rule?: string }[] };
  expect(report.ok).toBe(false);
  expect(report.errors.some((e) => e.rule === "MF12")).toBe(true);
  // Approving again (renox add) clears it.
  await capture(() => addModule(dir, "auth", { yes: true }));
  expect(projectProblems(dir)).toEqual([]);
  rmSync(dir, { recursive: true });
});

test("a module in renox.toml without a lock entry fails with MF3", () => {
  const dir = app({ auth: '{ version = "^1.0", source = "path:modules/auth" }' }, [{ name: "auth", version: "1.0.0", extra: AUTH_EXTRA }]);
  expect(projectProblems(dir)).toEqual([{ rule: "MF3", file: "renox.lock", message: 'renox.toml module "auth" has no renox.lock entry; run renox add auth' }]);
  rmSync(dir, { recursive: true });
});
