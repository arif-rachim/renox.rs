// The help of the CLI (#449): every command answers `--help` with its usage
// and exit 0, an unknown command gets "did you mean", an unknown flag is
// named, and `renox --help` is grouped. The overview is snapshotted.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { GROUPS, HELP, overview, suggest, unknownFlag } from "../src/lib/usage.ts";

const main = join(import.meta.dir, "../src/main.ts");
const run = (args: string[]) => {
  const p = Bun.spawnSync(["bun", main, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

/** The command names of main.ts's COMMANDS table. */
const commands = (): string[] => {
  const src = readFileSync(main, "utf8");
  const body = /const COMMANDS[^{]*\{([^;]*)\};/u.exec(src)?.[1] ?? "";
  return [...body.matchAll(/(?:^|,)\s*([a-z]+)(?=\s*[:,}])/gu)].map((m) => m[1] as string);
};

test("every command of main.ts has help, and every help entry is a command", () => {
  const names = commands();
  expect(names.length).toBeGreaterThan(15);
  expect([...names].sort()).toEqual(Object.keys(HELP).sort());
  for (const h of Object.values(HELP)) expect(GROUPS).toContain(h.group);
});

test("the `new` usage line and summary name every template under cli/templates/ (#618)", () => {
  const templates = readdirSync(join(import.meta.dir, "../templates"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  expect(templates.length).toBeGreaterThanOrEqual(4);
  const line = /--template ([a-z|-]+)\]/u.exec(HELP.new?.usage[0] ?? "")?.[1]?.split("|") ?? [];
  expect([...line].sort()).toEqual([...templates].sort());
  for (const name of templates) expect(HELP.new?.summary).toContain(`${name}:`);
});

test("`renox <command> --help` and `-h` print that command's usage and exit 0, for every command", () => {
  for (const name of Object.keys(HELP)) {
    const r = run([name, "--help"]);
    expect([name, r.code]).toEqual([name, 0]);
    expect(r.out).toStartWith(`usage: renox ${name}`);
  }
  expect(run(["deploy", "-h"]).out).toStartWith("usage: renox deploy");
  expect(run(["help", "logs"]).out).toStartWith("usage: renox logs");
});

test("an unknown command suggests the nearest one and does not dump the whole help", () => {
  const r = run(["depoly"]);
  expect(r.code).toBe(1);
  expect(r.err).toBe('renox: unknown command "depoly". Did you mean "deploy"?\nRun `renox --help` for the list of commands.\n');
  expect(suggest("lgos", Object.keys(HELP))).toBe("logs");
  expect(suggest("dep", Object.keys(HELP))).toBe("deploy");
  expect(suggest("frobnicate", Object.keys(HELP))).toBeNull();
});

test("an unknown flag is named, with a suggestion, before the command runs", () => {
  const r = run(["dev", "--prot", "8000"]);
  expect(r.code).toBe(1);
  expect(r.err).toStartWith("renox dev: unknown flag --prot (did you mean --port?)");
  expect(unknownFlag("deploy", ["--rollback", "abc", "--app", "x"])).toBeNull();
  expect(unknownFlag("deploy", ["--force"])).toBe("--force");
  // renox test passes its flags on to bun test.
  expect(unknownFlag("test", ["--bail"])).toBeNull();
  expect(unknownFlag("secrets", ["set", "KEY", "--", "--not-a-flag"])).toBeNull();
});

test("renox --help groups the commands", () => {
  expect(overview("0.0.0 (renox-worker 0.0.0)")).toMatchSnapshot();
  const r = run(["--help"]);
  expect(r.code).toBe(0);
  for (const g of GROUPS) expect(r.out).toContain(`${g}:`);
});
