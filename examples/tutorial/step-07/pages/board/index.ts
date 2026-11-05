// GET /board: the active team's tasks. POST ?/add, ?/toggle and ?/remove
// change them; an htmx request gets only the `tasks` fragment back.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";
import { auth, org } from "renox:modules";

import { asResource, findTask, listTasks, parseTitle } from "../../lib/tasks";

/** Signed-in users only: checked before any code of this page runs. */
export const guard = { action: "board.view" };

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
    // Admins and owners see the remove buttons; the action checks it again.
    team: { name: team.name, manager: team.role !== "member" },
    tasks: tasks.map((t) => ({ ...asResource(t), title: t.title, done: t.done === 1 })),
    open: tasks.filter((t) => t.done === 0).length,
    error: null,
  };
}

/** The active team, or a Response that ends the action. */
async function activeTeam(): Promise<{ id: string; role: string } | Response> {
  const team = await org.currentOrg();
  return team ?? new Response("Create a team first", { status: 409 });
}

export const actions = {
  async add({ db, form }: ActionContext) {
    const team = await activeTeam();
    if (team instanceof Response) return team;
    const parsed = parseTitle(form.get("title"));
    if ("error" in parsed) return { error: parsed.error };
    await db.execute("insert into app__tasks (title, team_id, created_at) values (?, ?, ?)", [parsed.title, team.id, Math.floor(Date.now() / 1000)]);
  },

  async toggle({ db, form, authz }: ActionContext) {
    const team = await activeTeam();
    if (team instanceof Response) return team;
    const task = await findTask(db, team.id, form.get("task"));
    if (task === null) return new Response("No such task", { status: 404 });
    // The task as loaded from the database, never as the form describes it.
    await authz.require("task.edit", asResource(task));
    await db.execute("update app__tasks set done = 1 - done where id = ?", [task.id]);
  },

  async remove({ db, form, authz }: ActionContext) {
    const team = await activeTeam();
    if (team instanceof Response) return team;
    const task = await findTask(db, team.id, form.get("task"));
    if (task === null) return new Response("No such task", { status: 404 });
    await authz.require("task.delete", asResource(task));
    // Only the team's admins and owners (chapter 7 says why this is not in the policy).
    if (team.role === "member") return new Response("Only admins and owners remove tasks", { status: 403 });
    await db.execute("delete from app__tasks where id = ?", [task.id]);
  },
};
