import { SQL } from "bun";
import type { Db, Row } from "./db.ts";
import { tagStage } from "../log.ts";

/** Marks a failed statement with the stage `db` for the unhandled-error log (#402). */
const db = (err: unknown): never => {
  throw tagStage(err, "db");
};

interface SqlLike {
  unsafe<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

function wrap(sql: SqlLike, root: SQL): Db {
  return {
    async query<T extends Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      return [...(await sql.unsafe<T>(text, [...params]).catch(db))];
    },
    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return root.begin((tx) => fn(wrap(tx as unknown as SqlLike, root))) as Promise<T>;
    },
    async exec(text: string): Promise<void> {
      await sql.unsafe(text).catch(db);
    },
    async listen(channel: string, onPayload: (payload: string) => void) {
      const subscription = await root.listen(channel, onPayload);
      return () => subscription.unlisten();
    },
    close: () => root.close(),
  };
}

/** Postgres through Bun's built-in client; `url` is a postgres:// connection string. */
export function openPostgres(url: string): Db {
  const sql = new SQL(url);
  return wrap(sql as unknown as SqlLike, sql);
}
