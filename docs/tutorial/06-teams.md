# Chapter 6: Sign-in and teams with modules

**What you build:** sign-up and sign-in, teams with roles, and invitations, without writing any auth code. Each task belongs to a team, and the board shows the active team's tasks.

## Install the modules

A module is a packaged piece of an app: its own tables, pages, services and policies. The official `org` module brings teams ("organisations"); it needs `auth` (users, passwords, sessions) and `i18n` (the locale). One command installs all three after showing what each asks for:

```sh
renox add org
```

```
org needs auth, which is not installed; it is installed with it:
auth 1.0.0 (official): Users, passwords (argon2id), sessions, and the login, register and account pages
It asks for:
  tables   auth__*
  network  accounts.google.com, oauth2.googleapis.com, www.googleapis.com, github.com, api.github.com, login.microsoftonline.com, graph.microsoft.com, stg-id.uaepass.ae, id.uaepass.ae
  secrets  AUTH_GOOGLE_CLIENT_SECRET, AUTH_GITHUB_CLIENT_SECRET, AUTH_MICROSOFT_CLIENT_SECRET, AUTH_UAEPASS_CLIENT_SECRET
  slots    app.header
…
Approve and install org and auth, i18n? [y/N] y
installed auth 1.0.0 (needed by org)
installed i18n 1.0.0 (needed by org)
installed org 1.0.0; run renox migrate to create its tables
```

The network hosts and secrets are for optional sign-in with Google, GitHub, Microsoft or UAE PASS. A module can reach only what you approve here, and only its own `auth__*` tables. `renox add` writes the modules into `renox.toml` and pins exact versions and content hashes in `renox.lock`:

`renox.toml`:
```toml
[modules]
org = { version = "^1.0.0" }
auth = { version = "^1.0.0" }
i18n = { version = "^1.0.0" }
outbox = { version = "^1.0.0", source = "path:modules/outbox" }
```

(`outbox` is the next section.) Save, and `renox dev` serves the modules' pages: `/auth/register`, `/auth/login`, `/auth/account`, `/org` (your teams, create one) and `/org/members` (members, roles, invitations). Roles are `member`, `admin` and `owner` ([org's README](../../modules/org/README.md)).

## Invitations need a mail sender

An admin invites by email. `org` hands the invitation to the hook `org.send_mail`, and some module must fill it. The official `email` module fills `auth.send_mail` (password resets) but not yet `org.send_mail` (#475), so the board carries a ten-line module of its own. It keeps each invitation in a table so you can pass the link on yourself:

`modules/outbox/module.toml`:
```toml
[module]
name = "outbox"
version = "1.0.0"
description = "Keeps the invitation mails org asks to send, so a team can be tried before a mail module delivers them"

[permissions]
tables = "outbox__*"
hooks = ["org.send_mail"]
```

`modules/outbox/hooks.ts`:
```ts
// org asks `org.send_mail` to deliver an invitation; no official module
// sends it yet, so this one keeps the mail in outbox__mail for the
// owner to pass on. Replace it with a mail module before real users join.
interface Mail {
  to: string;
  template: string;
  args: { url: string; org_name: string };
}

interface HookCtx {
  db: { execute(sql: string, params?: unknown[]): Promise<unknown> };
}

export const hooks = {
  "org.send_mail": {
    async handle(ctx: HookCtx, mail: Mail) {
      await ctx.db.execute("insert into outbox__mail (mail_to, template, url, org_name, created_at) values (?, ?, ?, ?, ?)", [mail.to, mail.template, mail.args.url, mail.args.org_name, Math.floor(Date.now() / 1000)]);
    },
  },
};
```

`modules/outbox/migrations/001_init.sql`:
```sql
create table outbox__mail (
  id         integer primary key,
  mail_to    text    not null,
  template   text    not null,
  url        text    not null,
  org_name   text    not null,
  created_at integer not null
) strict;
```

```sh
renox add outbox --source path:modules/outbox
```

Replace it with a mail module before real users join. Until then, the link of an invitation is in `outbox__mail.url`.

## A task belongs to a team

Migrations only move forward, so the team goes into a new file:

`migrations/002_tasks_team.sql`:
```sql
-- Chapter 6: a task belongs to a team. Migrations only move forward, so
-- the column is added here, not written into 001.
alter table app__tasks add column team_id text not null default '';
create index app__tasks_team on app__tasks (team_id, id);
```

Every query now names the team. A task of another team is never read or changed, because the `where` clause says so:

`lib/tasks.ts`:
```ts
export function listTasks(db: DbStatements, team: string): Promise<Task[]> {
  return db.query<Task>("select id, title, done, team_id from app__tasks where team_id = ? order by done, id desc limit 200", [team]);
}

/** One task of the team, or null. */
export function findTask(db: DbStatements, team: string, id: unknown): Promise<Task | null> {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) return Promise.resolve(null);
  return db.queryOne<Task>("select id, title, done, team_id from app__tasks where id = ? and team_id = ?", [n, team]);
}
```

The loader asks `org` for the active team. A module's services are imported from `renox:modules`; the call runs as the signed-in user, so `currentOrg()` is that user's active team or `null`:

`pages/board/index.ts`:
```ts
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
```

The actions use `activeTeam()` and pass `team.id` to every query. The template shows a link to `/org` when there is no team yet:

`pages/board/index.html`:
```html
  <r-group r-if="!team">
    <p><r-t key="board.no_team" /> <a href="/org"><r-t key="board.create_team" /></a></p>
  </r-group>
  <r-group r-else>
    <p class="team">{{ team.name | upper }}</p>
```

The layout gets the modules' header: `<r-slot name="app.header" />` is filled by `auth` (the user menu, from `auth_user`) and `org` (the team switcher, from `org_switcher`):

`pages/_layouts/main.html`:
```html
  <header>
    <a href="/"><strong>Team board</strong></a>
    <a href="/board"><r-t key="board.title" /></a>
    <r-slot name="app.header" />
  </header>
```

## Types for `renox:modules`

`renox check` type checks your calls to `org`, but it does not see the module types `renox dev` generates under `.renox/types/` (#471). Until it does, declare what you call:

`renox-modules.d.ts`:
```ts
// The services of `renox:modules` this app calls. The type check needs
// this file until the generated module types are picked up (chapter 6).
declare module "renox:modules" {
  export const auth: {
    currentUser(): Promise<{ id: string; email: string; display_name: string } | null>;
  };
  export const org: {
    currentOrg(): Promise<{ id: string; slug: string; name: string; role: string } | null>;
    switcher(next?: string): Promise<unknown>;
  };
}
```

## The sample rows go

`seeds/tasks.sql` is gone in this step: its rows would belong to no team, and no one would see them.

## See it

Register at http://localhost:8787/auth/register, create a team at `/org`, then open `/board`. [What you should see: the team name, the user menu and the team switcher](screenshots/06-team.png).

The tests sign users up through the real `auth` pages and check that teams are kept apart:

`tests/board.test.ts`:
```ts
describe("the board, per team", () => {
  test("a new user creates a team, then adds and ticks off its tasks", async () => {
    const lina = await signUp("Lina");
    expect((await lina.page("/board")).html).toContain("You are not in a team yet.");
    expect((await lina.action("/org", "create", { name: "Acme" })).status).toBe(303);
    await lina.action("/board", "add", { title: "Write the tutorial" });
    await lina.action("/board", "toggle", { task: taskId("Write the tutorial") });
    const page = await lina.page("/board");
    expect(page.html).toContain("ACME");
    expect(page.html).toContain('<article class="task done">');
  });

  test("another team sees none of it and cannot change it", async () => {
    const sara = await signUp("Sara");
    await sara.action("/org", "create", { name: "Other" });
    expect((await sara.page("/board")).html).not.toContain("Write the tutorial");
    expect((await sara.action("/board", "toggle", { task: taskId("Write the tutorial") })).status).toBe(404);
  });
});
```

## If it does not work

| You see | Why, and what to do |
| --- | --- |
| `TS2307: Cannot find module 'renox:modules'` | Add `renox-modules.d.ts` as above (#471) |
| "Sign in and create a team first" (409) | The session has no active team: create one at `/org` |
| `RENOX_MODULE_SERVICE` in the terminal | A module's service threw (for example `org` refused a call the user's role does not allow). The module's own log line, just above, names the cause |
| `renox add` reports `MF2` or `MF11` | The version range in `renox.toml` cannot be met, or the module's source cannot be read. For a `path:` module, the folder must hold `module.toml` |
| An invitation never arrives | No module delivers `org.send_mail` mails yet; read the link from `outbox__mail` |
| `MF12: outbox.hash in renox.lock is "…", expected "…"` after you edit `modules/outbox` | The lock pins the module's content hash. Run `renox add outbox --source path:modules/outbox` again |

## Building with an AI agent

Ask: "Add sign-in and teams with the official modules; each task belongs to the active team." The agent should call `renox add` and not write auth code: `AGENTS.md` says so. Check that it scoped every query to the team; the tests above are the proof.

**Checkpoint:** [`examples/tutorial/step-06`](../../examples/tutorial/step-06/). Next: [authorization](07-authorization.md).
