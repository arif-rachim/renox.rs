// GET /board: the loader returns the template's data.
import { listTasks } from "../../lib/tasks";

export function load() {
  const tasks = listTasks();
  return {
    tasks: tasks.map((t) => ({ ...t, done: t.done === 1 })),
    open: tasks.filter((t) => t.done === 0).length,
  };
}
