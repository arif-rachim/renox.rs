import { PGlite } from "@electric-sql/pglite";
import type { Db, Row } from "./db.ts";

interface PgliteLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

function wrap(pg: PgliteLike, root: PGlite): Db {
  return {
    async query<T extends Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(sql, [...params])).rows;
    },
    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return root.transaction((tx) => fn(wrap(tx as unknown as PgliteLike, root)));
    },
    async exec(sql: string): Promise<void> {
      await pg.exec(sql);
    },
    async listen(channel: string, onPayload: (payload: string) => void) {
      return root.listen(channel, onPayload);
    },
    close: () => root.close(),
  };
}

/** An in-process Postgres (WASM). `dataDir` undefined = in memory. */
export async function openPglite(dataDir?: string): Promise<Db> {
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  return wrap(pg as unknown as PgliteLike, pg);
}
