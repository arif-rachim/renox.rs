// GET /board: the tasks. POST ?/add, ?/toggle and ?/remove change them;
// an htmx request gets only the `tasks` fragment back.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { findTask, listTasks, parseTitle } from "../../lib/tasks";

export async function load({ db }: LoaderContext) {
  const tasks = await listTasks(db);
  return {
    tasks: tasks.map((t) => ({ ...t, done: t.done === 1 })),
    open: tasks.filter((t) => t.done === 0).length,
    error: null,
  };
}

// Each action runs in its own transaction. Returning an object (or
// nothing) runs `load` again and renders the page, or only the fragment
// htmx asked for, with that object merged over the loader's data.
export const actions = {
  async add({ db, form }: ActionContext) {
    const parsed = parseTitle(form.get("title"));
    if ("error" in parsed) return { error: parsed.error };
    await db.execute("insert into app__tasks (title, created_at) values (?, ?)", [parsed.title, Math.floor(Date.now() / 1000)]);
  },

  async toggle({ db, form }: ActionContext) {
    const task = await findTask(db, form.get("task"));
    if (task === null) return new Response("No such task", { status: 404 });
    await db.execute("update app__tasks set done = 1 - done where id = ?", [task.id]);
  },

  async remove({ db, form }: ActionContext) {
    const task = await findTask(db, form.get("task"));
    if (task === null) return new Response("No such task", { status: 404 });
    await db.execute("delete from app__tasks where id = ?", [task.id]);
  },
};
