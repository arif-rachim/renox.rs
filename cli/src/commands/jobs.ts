// renox jobs list [--state scheduled|queued|running|dead] [--db <file>] [--json]
// renox jobs run <name> [--module <m>] [--db <file>]
// renox jobs retry <id> [--db <file>]
//
// The jobs of the app running under `renox dev` (ops.md 1.6.0 section 20,
// #297), read from and written to the dev tenant file (.renox/data/dev/
// app.db) the way the cell keeps them: a run is a row of `renox__outbox`
// named `job:<name>`, the coalescing key, next tick, last finish and running
// marker are rows of `renox__outbox_meta`. `run` writes a tick of a
// scheduled job now (coalescing into its waiting row, as the scheduler
// does); `retry` puts a dead run back in the queue. `renox dev` polls for
// rows written this way (`[jobs] poll_ms`), so they run within a second.
// A deployed app's jobs are shown and controlled by the `jobs` module.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { EXIT, UserError } from "../errors.ts";
import { devDb } from "./migrate.ts";

const USAGE = "usage: renox jobs list [--state scheduled|queued|running|dead] [--json] | run <name> [--module <m>] | retry <id>   [--db <file>]";
const STATES = ["scheduled", "queued", "running", "dead"] as const;
type State = (typeof STATES)[number];
const NAME = /^[a-z][a-z0-9_-]{0,63}$/u;
const MODULE = /^[a-z][a-z0-9_]{0,31}$/u;

export interface JobLine {
  id: string | null;
  module: string;
  name: string;
  tick: number | null;
  next_at: number | null;
  attempts: number;
  started_at: number | null;
  finished_at: number | null;
  last_error: string | null;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID, as the runtime writes them. */
export function ulid(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let n = BigInt(now) & 0xffffffffffffn;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  for (let i = 25; i >= 0; i--) s += CROCKFORD[Number((n >> BigInt(i * 5)) & 31n)];
  return s;
}

function open(file: string): Database {
  if (!existsSync(file)) throw new UserError(`no dev database at ${file}`, { hint: "start renox dev once (it creates .renox/data/dev/app.db), or pass --db <file>" });
  const db = new Database(file);
  db.exec("pragma busy_timeout = 5000");
  return db;
}

const meta = (db: Database, key: string): number | null => (db.query("select value from renox__outbox_meta where key = ?").get(key) as { value: number } | null)?.value ?? null;

/** The jobs in `state`, never the payload (what `op_jobs_list` answers). */
export function list(file: string, state: State): JobLine[] {
  const db = open(file);
  try {
    if (state === "scheduled") {
      const rows = db.query("select key, value from renox__outbox_meta where key like 'job_next:%' order by value").all() as { key: string; value: number }[];
      return rows.map((r) => {
        const [, module = "", name = ""] = r.key.split(":");
        return {
          id: null,
          module,
          name,
          tick: meta(db, `job_tick:${module}:${name}`),
          next_at: r.value,
          attempts: 0,
          started_at: null,
          finished_at: meta(db, `job_last:${module}:${name}`),
          last_error: null,
        };
      });
    }
    const from = state === "dead" ? "renox__outbox_dead" : "renox__outbox";
    const where = state === "dead" ? "" : state === "running" ? "and m.value is not null" : "and m.value is null";
    const order = state === "dead" ? "o.dead_at desc" : "o.next_at, o.id";
    const rows = db
      .query(
        `select o.id, o.module, o.name, o.payload, o.attempts, o.next_at, o.last_error, m.value as started_at ${state === "dead" ? ", o.dead_at" : ""}
         from ${from} o left join renox__outbox_meta m on m.key = 'job_running:' || o.id
         where o.name like 'job:%' ${where} order by ${order} limit 100`,
      )
      .all() as { id: string; module: string; name: string; payload: string; attempts: number; next_at: number; last_error: string | null; started_at: number | null; dead_at?: number }[];
    return rows.map((r) => {
      const name = r.name.slice("job:".length);
      return {
        id: r.id,
        module: r.module,
        name,
        tick: r.payload === "null" && state !== "dead" ? meta(db, `job_tick:${r.module}:${name}`) : null,
        next_at: state === "dead" ? null : r.next_at,
        attempts: r.attempts,
        started_at: r.started_at,
        finished_at: r.dead_at ?? null,
        last_error: r.last_error === null ? null : r.last_error.slice(0, 512),
      };
    });
  } finally {
    db.close();
  }
}

/** A tick of the scheduled job `module.name` now: one row, or the waiting row's tick moves (section 20, coalescing). Returns the row id. */
export function runNow(file: string, module: string, name: string, now = Date.now()): string {
  const db = open(file);
  try {
    return db.transaction(() => {
      const key = `job_tick:${module}:${name}`;
      const waiting = db.query("select id from renox__outbox where name = ? and target = ? and payload = 'null'").get(`job:${name}`, module) as { id: string } | null;
      if (meta(db, key) !== null && waiting) {
        db.query("update renox__outbox_meta set value = max(value, ?) where key = ?").run(now, key);
        db.query("update renox__outbox set next_at = min(next_at, ?) where id = ?").run(now, waiting.id);
        return waiting.id;
      }
      const id = ulid(now);
      db.query("insert into renox__outbox (id, target, name, payload, module, created_at, attempts, next_at) values (?, ?, ?, 'null', ?, ?, 0, ?)").run(id, module, `job:${name}`, module, now, now);
      db.query("insert into renox__outbox_meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, now);
      return id;
    })();
  } finally {
    db.close();
  }
}

/** A dead run back in the queue, attempts reset (`op_jobs_retry`, without the audit row a dev database does not need). */
export function retry(file: string, id: string, now = Date.now()): void {
  const db = open(file);
  try {
    db.transaction(() => {
      if (db.query("select 1 from renox__outbox where id = ? and name like 'job:%'").get(id)) throw new UserError(`job run ${id} is not dead (it is queued or running)`, { hint: "renox jobs list --state dead shows the runs that can be retried" });
      const row = db.query("select module, name, payload from renox__outbox_dead where id = ? and name like 'job:%'").get(id) as { module: string; name: string; payload: string } | null;
      if (!row) throw new UserError(`no dead job run ${id}`, { hint: "renox jobs list --state dead" });
      db.query("insert into renox__outbox (id, target, name, payload, module, created_at, attempts, next_at) select id, target, name, payload, module, created_at, 0, ? from renox__outbox_dead where id = ?").run(now, id);
      db.query("delete from renox__outbox_dead where id = ?").run(id);
      if (row.payload === "null") db.query("insert or ignore into renox__outbox_meta (key, value) values (?, ?)").run(`job_tick:${row.module}:${row.name.slice(4)}`, now);
    })();
  } finally {
    db.close();
  }
}

const when = (ms: number | null): string => (ms === null ? "-" : new Date(ms).toISOString().replace(".000Z", "Z"));

export function format(state: State, lines: JobLine[]): string {
  if (lines.length === 0) return `no ${state} jobs\n`;
  const rows = lines.map((l) => {
    const job = l.module === "app" ? l.name : `${l.module}.${l.name}`;
    switch (state) {
      case "scheduled":
        return `${job}  next ${when(l.next_at)}  last ${when(l.finished_at)}`;
      case "dead":
        return `${l.id}  ${job}  attempts ${l.attempts}  dead ${when(l.finished_at)}  ${l.last_error ?? ""}`.trimEnd();
      case "running":
        return `${l.id}  ${job}  started ${when(l.started_at)}  attempt ${l.attempts + 1}`;
      default:
        return `${l.id}  ${job}  due ${when(l.next_at)}  attempts ${l.attempts}${l.last_error ? `  ${l.last_error}` : ""}`;
    }
  });
  return `${rows.join("\n")}\n`;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function run(args: string[]): number {
  const [sub, arg] = args;
  const db = resolve(flag(args, "--db") ?? devDb(process.cwd()));
  if (sub === "list") {
    const state = (flag(args, "--state") ?? "scheduled") as State;
    if (!STATES.includes(state)) {
      console.error(USAGE);
      return EXIT.USER;
    }
    const lines = list(db, state);
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(lines, null, 2)}\n` : format(state, lines));
    return EXIT.OK;
  }
  if (sub === "run" && arg !== undefined && NAME.test(arg)) {
    const module = flag(args, "--module") ?? "app";
    if (!MODULE.test(module)) {
      console.error(USAGE);
      return EXIT.USER;
    }
    const id = runNow(db, module, arg);
    process.stdout.write(`queued ${module === "app" ? arg : `${module}.${arg}`} (${id}); renox dev runs it within a second\n`);
    return EXIT.OK;
  }
  if (sub === "retry" && arg !== undefined && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(arg)) {
    retry(db, arg);
    process.stdout.write(`queued ${arg} again\n`);
    return EXIT.OK;
  }
  console.error(USAGE);
  return EXIT.USER;
}
