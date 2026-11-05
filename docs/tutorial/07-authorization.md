# Chapter 7: Authorization

**What you build:** a Cedar policy that says who may open the board and who may change a team's tasks; a guard on the page; checks in the actions on the task as stored; and remove buttons only for admins and owners.

Chapter 6 already filters every query by team. This chapter states the rule once, as a policy, so the page, the actions, the template and later the live feed all ask the same question.

## Declare the actions

`renox.toml`:
```toml
# Chapter 7: who may do what on the board (policies/app/board.cedar).
[authz]
actions = ["board.view", "task.edit", "task.delete"]

[authz.entities]
Task = { table = "app__tasks", attrs = ["team_id"] }
```

`actions` are the names your policies and code use. `[authz.entities]` declares `Task` as a resource type with the attribute `team_id`, so a policy can compare it.

## The policy

Policies live in `policies/app/*.cedar` ([Cedar](https://www.cedarpolicy.com) is a policy language from AWS; Renoxium evaluates it in Rust):

`policies/app/board.cedar`:
```cedar
// Chapter 7: the board's policies. `principal.org` is the session's active
// team; the org module puts it on the principal.

// The page's guard: any signed-in user opens /board.
permit (principal is Renox::User, action == Renox::Action::"board.view", resource == Renox::Action::"board.view");

// Members of the team add and tick off its tasks, and nobody else.
permit (principal is Renox::User, action == Renox::Action::"task.edit", resource is App::Task)
when { principal has org && resource.team_id == principal.org };

// Removing is for the team too; the action also asks for an admin or an
// owner (chapter 7 explains why that check is not here).
permit (principal is Renox::User, action == Renox::Action::"task.delete", resource is App::Task)
when { principal has org && resource.team_id == principal.org };
```

`principal.org` is the session's active team. The `org` module puts it on the principal, so a policy can compare it with `resource.team_id`. Nothing is allowed unless a `permit` matches: a missing attribute, an unknown action or a visitor who is not signed in all mean deny.

## Use it

**The guard** runs before any code of the page. A visitor who is not signed in gets 403 (`RENOX_FORBIDDEN`) and the loader never runs:

`pages/board/index.ts`:
```ts
/** Signed-in users only: checked before any code of this page runs. */
export const guard = { action: "board.view" };
```

**In the actions**, `authz.require` checks the task as loaded from the database, never as the form describes it, and throws `RENOX_FORBIDDEN` (403) on a deny:

`pages/board/index.ts`:
```ts
  async toggle({ db, form, authz }: ActionContext) {
    const team = await activeTeam();
    if (team instanceof Response) return team;
    const task = await findTask(db, team.id, form.get("task"));
    if (task === null) return new Response("No such task", { status: 404 });
    // The task as loaded from the database, never as the form describes it.
    await authz.require("task.edit", asResource(task));
    await db.execute("update app__tasks set done = 1 - done where id = ?", [task.id]);
  },
```

`asResource` turns a row into what the policy sees:

`lib/tasks.ts`:
```ts
/** A task as the policy sees it: its type, id and the attributes renox.toml declares. */
export const asResource = (t: Task) => ({ type: "Task", id: String(t.id), team_id: t.team_id });
```

## Only admins and owners remove

The natural policy for that is `permit (principal in Renox::Role::"admin", …)`. Today it would never match: `org` keeps a member's role in its own table and does not hand it to the policy engine as a role assignment (#470). So the policy allows removing for the team, and the action adds the role check, with the role from `org.currentOrg()`:

`pages/board/index.ts`:
```ts
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
```

The template hides the button the same way. `r-can="task.delete" :resource="task"` asks the policy for each task, and `manager` carries the role:

`partials/task.html`:
```html
  <x-form action="remove" hx-target="#tasks" hx-swap="outerHTML" r-if="manager" r-can="task.delete" :resource="task">
    <input type="hidden" name="task" :value="task.id">
    <button type="submit" class="remove"><r-t key="board.remove" /></button>
  </x-form>
```

Hiding a button is a convenience, not protection: the action checks again, and a hand-made `POST` without the role gets 403. The loader computes `manager` once:

`pages/board/index.ts`:
```ts
    // Admins and owners see the remove buttons; the action checks it again.
    team: { name: team.name, manager: team.role !== "member" },
```

## Test the policy

`policies/tests/*.json` cases are evaluated by `renox test` with the same engine, without a browser or a database:

`policies/tests/board.json`:
```json
[
  { "description": "a signed-in user opens the board", "principal": { "type": "User", "id": "u_lina" }, "action": "board.view", "expected": "allow" },
  { "description": "a visitor who is not signed in does not", "principal": { "type": "Anonymous", "id": "anonymous" }, "action": "board.view", "expected": "deny" },
  { "description": "a member ticks off a task of their team", "principal": { "type": "User", "id": "u_omar", "attrs": { "org": "o_acme" } }, "action": "task.edit", "resource": { "type": "Task", "id": "1", "team_id": "o_acme" }, "expected": "allow" },
  { "description": "not a task of another team", "principal": { "type": "User", "id": "u_omar", "attrs": { "org": "o_acme" } }, "action": "task.edit", "resource": { "type": "Task", "id": "2", "team_id": "o_other" }, "expected": "deny" },
  { "description": "nor without a team", "principal": { "type": "User", "id": "u_sara" }, "action": "task.edit", "resource": { "type": "Task", "id": "1", "team_id": "o_acme" }, "expected": "deny" },
  { "description": "a task of the team may be removed", "principal": { "type": "User", "id": "u_lina", "attrs": { "org": "o_acme" } }, "action": "task.delete", "resource": { "type": "Task", "id": "1", "team_id": "o_acme" }, "expected": "allow" },
  { "description": "not one of another team", "principal": { "type": "User", "id": "u_sara", "attrs": { "org": "o_other" } }, "action": "task.delete", "resource": { "type": "Task", "id": "1", "team_id": "o_acme" }, "expected": "deny" }
]
```

```
(pass) policy policies/tests/board.json: a member ticks off a task of their team -> allow
(pass) policy policies/tests/board.json: not a task of another team -> deny
…
```

`renox authz explain --user <id> --action task.edit --resource Task:1` prints which policy decided a request on the dev database. It does not run the `org` hook, so give the attribute yourself: `--attr org=o_acme` sets `principal.org`. The output lists the attributes it used.

## See it

Invite a second user from `/org/members` (the link is in `outbox__mail`), accept it in another browser, and open `/board` as them. [What you should see: the member's board, without remove buttons](screenshots/07-member.png).

## If it does not work

| You see | Why, and what to do |
| --- | --- |
| 403 `RENOX_FORBIDDEN` on `/board` when signed in | No `permit` matches `board.view`. Check the action name in `renox.toml`, the policy and the guard are the same |
| `RENOX_POLICY_INVALID` from `renox check` | The policy names an action or entity that is not declared, or an attribute with the wrong type. The message names the file and line |
| `RENOX_FORBIDDEN` with `reason: missing_attribute` in the log | The resource object lacks `team_id`: pass `asResource(task)`, not the raw form values |
| Every request is denied for a team member | `principal.org` is missing: the user has no active team (create or switch at `/org`) |
| An owner cannot remove | Check `team.role`; `org` roles are `member`, `admin` and `owner` |

## Building with an AI agent

Ask: "Write a Cedar policy so only members of the active team can change its tasks, with policy tests." The agent has `list_policies` and `authz_explain` over MCP; with the gap above, have it prove the policy with `policies/tests/*.json` cases and `run_tests`.

**Checkpoint:** [`examples/tutorial/step-07`](../../examples/tutorial/step-07/). Next: [realtime](08-realtime.md).
