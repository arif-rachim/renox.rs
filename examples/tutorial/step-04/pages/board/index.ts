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
