// The database interface the API is written against. Two implementations:
// Postgres through Bun's built-in client (production, compose) and PGlite
// (tests, `CONTROL_DATABASE_URL=pglite:memory`). Statements use `$1` parameters
// only; no SQL text is ever built from request input.

export type Row = Record<string, unknown>;

export interface Db {
  /** Runs one parameterised statement and returns its rows. */
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs `fn` in one transaction; it commits when `fn` resolves and rolls back when it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  /** Runs a script of several statements without parameters (migrations only). */
  exec(sql: string): Promise<void>;
  /** Postgres LISTEN; resolves to the unsubscribe function. */
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** Reads a bigint column, which the drivers return as number, bigint or string. */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint" || typeof v === "string") return Number(v);
  throw new TypeError(`expected a number, got ${typeof v}`);
}

export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

/** jsonb parameters are passed as text and cast with `$n::text::jsonb` (a bare `::jsonb` makes Bun's client encode the string a second time). */
export const jsonb = (v: unknown): string => JSON.stringify(v);
