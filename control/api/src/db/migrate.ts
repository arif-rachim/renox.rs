// Forward-only SQL migrations from control/api/migrations/NNNN_<name>.sql.
// Each file runs in its own transaction; its SHA-256 is recorded, and a file
// that changed after it was applied stops the API from starting.

import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Db } from "./db.ts";

export const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url).pathname;

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  sha256: string;
}

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((file, i) => {
    const m = /^([0-9]{4})_([a-z0-9_]+)\.sql$/u.exec(file);
    if (m === null) throw new Error(`migration file name must be NNNN_<name>.sql: ${file}`);
    const version = Number(m[1]);
    if (version !== i + 1) throw new Error(`migration numbering must start at 0001 without gaps: ${file}`);
    const sql = readFileSync(`${dir}${file}`, "utf8");
    return { version, name: m[2] as string, sql, sha256: createHash("sha256").update(sql).digest("hex") };
  });
}

export class MigrationError extends Error {}

/** Applies every file not yet applied; returns the versions it applied. */
export async function migrate(db: Db, files = readMigrations()): Promise<number[]> {
  await db.exec(
    "create table if not exists schema_migrations (version integer primary key, name text not null, sha256 text not null, applied_at bigint not null)",
  );
  const applied = new Map(
    (await db.query<{ version: number; sha256: string }>("select version, sha256 from schema_migrations")).map((r) => [
      Number(r.version),
      r.sha256,
    ]),
  );
  const done: number[] = [];
  for (const file of files) {
    const known = applied.get(file.version);
    if (known !== undefined) {
      if (known !== file.sha256) {
        throw new MigrationError(`migration ${file.version}_${file.name} changed after it was applied`);
      }
      continue;
    }
    await db.transaction(async (tx) => {
      await tx.exec(file.sql);
      await tx.query("insert into schema_migrations (version, name, sha256, applied_at) values ($1, $2, $3, $4)", [
        file.version,
        file.name,
        file.sha256,
        Date.now(),
      ]);
    });
    done.push(file.version);
  }
  return done;
}
