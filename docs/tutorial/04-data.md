# Chapter 4: Data

**What you build:** a table for the tasks, created by a migration, and a loader that reads it with a parameterised query.

## One SQLite database per app

Every app has its own SQLite database: one file, opened next to your app's code, and nothing to provision or connect to. Your code reaches it through `ctx.db`. It never sees a file path or a connection string. Every statement passes an authorizer: your app's tables start with `app__`, and each module may touch only its own prefix (`auth__`, `org__`, …) ([Data](../06-data.md)).

## A migration

A migration is a `.sql` file in `migrations/`. They run once each, in name order, and only forward: to change a table later you add a new file, never edit an old one (chapter 6 does exactly that).

`migrations/001_tasks.sql`:
```sql
-- The board's tasks. Every table of the app starts with app__.
create table app__tasks (
  id         integer primary key,
  title      text    not null,
  done       integer not null default 0,
  created_at integer not null
) strict;
```

`strict` makes SQLite check the column types. Save: `renox dev` applies the new migration when it rebuilds. In production `renox deploy` runs pending migrations before the new code takes traffic.

## Read it in the loader

The tasks module now takes the database. The query has a `?` placeholder and the value goes in a separate array:

`lib/tasks.ts`:
```ts
// The board's tasks: the queries the page runs, always with parameters
// (`?`), never with a value pasted into the SQL.
import type { DbStatements } from "@renoxium/sdk";

export type Task = {
  id: number;
  title: string;
  done: number;
};

/** The tasks, open ones first. */
export function listTasks(db: DbStatements): Promise<Task[]> {
  return db.query<Task>("select id, title, done from app__tasks order by done, id desc limit ?", [200]);
}
```

The loader receives `ctx` and passes `db` on. `LoaderContext` is the type of a loader's `ctx`:

`pages/board/index.ts`:
```ts
// GET /board: the loader reads the tasks from the app's SQLite database.
import type { LoaderContext } from "@renoxium/sdk";

import { listTasks } from "../../lib/tasks";

export async function load({ db }: LoaderContext) {
  const tasks = await listTasks(db);
  return {
    tasks: tasks.map((t) => ({ ...t, done: t.done === 1 })),
    open: tasks.filter((t) => t.done === 0).length,
  };
}
```

The template and the partial do not change: the rows have the same shape as the fixed list of chapter 3.

## Never build SQL from strings

`renox check` refuses SQL put together from values:

```ts
db.query(`select id from app__tasks where title = '${title}'`);
```

```
lib/bad.ts:2:61  error  sql-interpolation  db.query(): SQL built with template interpolation; pass values as ? parameters
```

Always write `db.query("… where title = ?", [title])`. One gap to know about: the rule does not yet see through a type argument, so `` db.query<Task>(`…${title}`) `` passes the check (#474). The rule is a lint; the habit is the protection.

## Sample rows for the tests

The dev board is empty: there is no form until the next chapter. `renox test` loads every `seeds/*.sql` file into each test file's fresh database after the migrations:

`seeds/tasks.sql`:
```sql
-- Sample tasks. `renox test` loads seeds/*.sql into each test's database.
insert into app__tasks (title, done, created_at) values
  ('Install the renox CLI', 1, 0),
  ('Write the first page', 0, 0),
  ('Invite the team', 0, 0);
```

`docs/06-data.md` lists `renox db seed` to load the same files into the dev database. That command does not exist yet (#480).

The test now also checks the table:

`tests/board.test.ts`:
```ts
  test("the rows come from the migration's table", () => {
    expect(t.db.query("select count(*) as n from app__tasks")).toEqual([{ n: 3 }]);
  });
```

`t.db.query` reads the test's database directly, for assertions.

## See it

Open http://localhost:8787/board. [What you should see: "0 open" and "Nothing to do yet."](screenshots/04-board.png), because the dev database has the table and no rows. `renox test` sees the three seeded tasks:

```sh
renox test
```

```
 4 pass
 0 fail
```

## If it does not work

The database codes below appear in the terminal (and in `renox logs` once deployed). The browser only gets `RENOX_INTERNAL` with the request id, so nothing about your schema leaks.

| You see | Why, and what to do |
| --- | --- |
| `RENOX_DB_SQL` with `no such table: app__tasks` | The migration did not run: check the file is in `migrations/` and ends in `.sql`, then save any file so `renox dev` rebuilds |
| `RENOX_DB_AUTH` | The statement touches a table without the `app__` prefix, or a module's table. Rename the table |
| `RENOX_DB_PARAM` | The number of `?` and of values differ, or a value is not a string, number, boolean, null or bytes |
| `RENOX_DB_MULTI_STATEMENT` | One `query` call holds two statements. Make two calls |
| A migration you edited does not change the table | Migrations run once. Add `002_….sql` with an `alter table` instead |

## Building with an AI agent

Ask: "Store the tasks in SQLite with a migration and read them in the loader." `AGENTS.md` tells the agent about the `app__` prefix, forward-only migrations and `?` parameters, and `run_check` catches interpolated SQL.

**Checkpoint:** [`examples/tutorial/step-04`](../../examples/tutorial/step-04/). Next: [functions and forms](05-actions.md).
