// #235: `renox migrate` through the embedded worker (`renox-worker
// migrate`): module migrations in renox.lock order, then the app's; a
// changed file that already ran is refused (checksum, D17 forward-only).

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateArtifact } from "../src/commands/migrate.ts";
import { buildArtifact } from "../src/lib/build.ts";
import { shopWithAuth } from "./shop-auth-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();

test.skipIf(!worker)("auth's tables first, then the app's; a changed file is refused", async () => {
  const dir = await shopWithAuth();
  const out = mkdtempSync(join(tmpdir(), "renox-migrate-"));
  const db = join(out, "dev.db");
  const built = await buildArtifact(dir, join(out, "artifacts"));
  const r = await migrateArtifact(built.dir, db, worker);
  expect(r).toEqual({
    ok: true,
    modules: [
      { module: "auth", applied: ["001_users.sql"], skipped: [] },
      { module: "app", applied: ["001_init.sql"], skipped: [] },
    ],
  });
  const sqlite = new Database(db, { readonly: true });
  const names = (sqlite.query("select name from sqlite_master where type in ('table', 'view') and name not like 'renox__%' and name not like 'sqlite_%' order by name").all() as { name: string }[]).map((x) => x.name);
  sqlite.close();
  expect(names).toEqual(["app__orders", "auth__public_users_v1", "auth__users"]);
  // A second run applies nothing.
  const again = await migrateArtifact(built.dir, db, worker);
  expect(again.modules.map((m) => [m.module, m.applied, m.skipped])).toEqual([
    ["auth", [], ["001_users.sql"]],
    ["app", [], ["001_init.sql"]],
  ]);
  // auth's applied migration edited: refused before anything runs.
  writeFileSync(join(dir, "modules/auth/migrations/001_users.sql"), "create table auth__users (id text primary key, email text, name text);\n");
  const { addModule } = await import("../src/commands/add.ts");
  const log = console.log;
  console.log = () => {};
  await addModule(dir, "auth", { source: "path:modules/auth", yes: true }, async () => true);
  console.log = log;
  const changed = await buildArtifact(dir, join(out, "artifacts"));
  const refused = await migrateArtifact(changed.dir, db, worker);
  expect(refused.ok).toBe(false);
  expect(refused.module).toBe("auth");
  expect(refused.error).toContain("checksum of migration 001_users.sql does not match");
});
