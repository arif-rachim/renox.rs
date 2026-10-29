// `renox check --target <hash>` (#96; docs/23-failure-modes.md section 3,
// "Rollback to a hash whose migrations are older"): a rollback never runs
// migrations, so the check warns about the columns and tables the live
// schema has that the target's code does not know (D17, expand/contract).

import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { schemaOf, targetFindings } from "../src/commands/check.ts";
import { buildArtifact, artifactsDir } from "../src/lib/build.ts";

const repo = join(import.meta.dir, "../..");
const main = join(import.meta.dir, "../src/main.ts");

const ITEMS = "create table app__items (id integer primary key, name text not null);";
const PRICE = "alter table app__items add column price integer;";
const TAGS = "create table app__tags (id integer primary key);";

function hello(): string {
  const dir = mkdtempSync(join(tmpdir(), "renox-check-target-"));
  cpSync(join(repo, "examples/hello"), dir, { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes("_spike") });
  return dir;
}

describe("renox check --target", () => {
  test("schemaOf lists the tables and columns the migrations create", () => {
    const s = schemaOf([ITEMS, PRICE]);
    expect([...(s.get("app__items") ?? [])].sort()).toEqual(["id", "name", "price"]);
  });

  test("warns about each column and table the target does not know", () => {
    const project = mkdtempSync(join(tmpdir(), "renox-check-target-unit-"));
    mkdirSync(join(project, "migrations"));
    writeFileSync(join(project, "migrations/001_items.sql"), ITEMS);
    writeFileSync(join(project, "migrations/002_price.sql"), PRICE);
    writeFileSync(join(project, "migrations/003_tags.sql"), TAGS);
    const target = join(project, "old-artifact");
    mkdirSync(join(target, "migrations/app"), { recursive: true });
    writeFileSync(join(target, "manifest.json"), "{}");
    writeFileSync(join(target, "migrations/app/001_items.sql"), ITEMS);
    const messages = targetFindings(project, target).map((f) => `${f.severity} ${f.rule} ${f.message}`);
    expect(messages).toEqual([
      "warning schema column app__items.price is in the live schema but unknown to " + target + "; its code must tolerate it (D17, expand/contract)",
      "warning schema table app__tags is in the live schema but unknown to " + target + "; its code must tolerate it (D17, expand/contract)",
    ]);
    // The same schema on both sides: nothing to say.
    writeFileSync(join(target, "migrations/app/002_price.sql"), PRICE);
    writeFileSync(join(target, "migrations/app/003_tags.sql"), TAGS);
    expect(targetFindings(project, target)).toEqual([]);
  });

  test("the command prints the warning for a built hash and exits 0; an unknown hash exits 1", async () => {
    const project = hello();
    mkdirSync(join(project, "migrations"), { recursive: true });
    writeFileSync(join(project, "migrations/001_items.sql"), ITEMS);
    const old = await buildArtifact(project, artifactsDir(project));
    writeFileSync(join(project, "migrations/002_price.sql"), PRICE);
    const run = (args: string[]) => Bun.spawnSync(["bun", main, "check", ...args], { cwd: project, stderr: "pipe", stdout: "pipe" });
    const r = run(["--target", old.hash]);
    const err = r.stderr.toString();
    expect(err).toContain(`column app__items.price is in the live schema but unknown to ${old.hash.slice(0, 12)}`);
    expect(r.exitCode).toBe(0);
    const missing = run(["--target", "0".repeat(64)]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("no artifact for --target");
    expect(run(["--target"]).exitCode).toBe(1);
  });
});
