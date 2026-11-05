// GET /board: the active team's tasks. POST ?/add, ?/toggle and ?/remove
// change them; an htmx request gets only the `tasks` fragment back.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";
import { auth, org } from "renox:modules";

import { findTask, listTasks, parseTitle } from "../../lib/tasks";

export async function load({ db, url }: LoaderContext) {
  // The header's slot renders auth's user menu (auth_user) and org's team switcher (org_switcher).
  const auth_user = await auth.currentUser();
  const org_switcher = await org.switcher(url.pathname);
  const team = await org.currentOrg();
  if (team === null) return { auth_user, org_switcher, team: null, tasks: [], open: 0, error: null };
  const tasks = await listTasks(db, team.id);
  return {
    auth_user,
    org_switcher,
    team: { name: team.name },
    tasks: tasks.map((t) => ({ ...t, done: t.done === 1 })),
    open: tasks.filter((t) => t.done === 0).length,
    error: null,
  };
}

/** The active team, or a Response that ends the action. */
async function activeTeam(): Promise<{ id: string; role: string } | Response> {
  const team = await org.currentOrg();
  return team ?? new Response("Sign in and create a team first", { status: 409 });
}

export const actions = {
  async add({ db, form }: ActionContext) {
    const team = await activeTeam();
    if (team instanceof Response) return team;
    const parsed = parseTitle(form.get("title"));
    if ("error" in parsed) return { error: parsed.error };
    await db.execute("insert into app__tasks (title, team_id, created_at) values (?, ?, ?)", [parsed.title, team.id, Math.floor(Date.now() / 1000)]);
  },

  async toggle({ db, form }: ActionContext) {
    const team = await activeTeam();
    if (team instanceof Response) return team;
    const task = await findTask(db, team.id, form.get("task"));
    if (task === null) return new Response("No such task", { status: 404 });
    await db.execute("update app__tasks set done = 1 - done where id = ?", [task.id]);
  },

  async remove({ db, form }: ActionContext) {
    const team = await activeTeam();
    if (team instanceof Response) return team;
    const task = await findTask(db, team.id, form.get("task"));
    if (task === null) return new Response("No such task", { status: 404 });
    await db.execute("delete from app__tasks where id = ?", [task.id]);
  },
};
