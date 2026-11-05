# Chapter 5: Functions and forms

**What you build:** a form to add tasks, a button to tick one off and one to remove it. Each is a page **action**. With htmx, the server sends back only the task list and the page swaps it in place, without a full reload.

## Actions

A page's `.ts` file may export `actions`. A form posting to `?/add` runs `actions.add`. Each action runs in its own database transaction: it commits when the action returns and rolls back when it throws. When an action returns an object (or nothing), the page's `load` runs again and the page is rendered with that object merged over the loader's data. A `Response` is sent as it is.

`pages/board/index.ts`:
```ts
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
```

Three things to notice:
- **Validation first.** `parseTitle` trims the title and refuses an empty or over-long one. It returns the i18n key of the error, and the action hands it to the template as `error`.
- **The task is loaded from the database**, by its id, before it is changed. An id that does not exist is a 404, not a silent no-op.
- **Form values are strings** (or files). `form.get("task")` is turned into a number before it reaches SQL.

`lib/tasks.ts`:
```ts
export const MAX_TITLE = 200;

/** The tasks, open ones first. */
export function listTasks(db: DbStatements): Promise<Task[]> {
  return db.query<Task>("select id, title, done from app__tasks order by done, id desc limit ?", [200]);
}

/** One task, or null. */
export function findTask(db: DbStatements, id: unknown): Promise<Task | null> {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) return Promise.resolve(null);
  return db.queryOne<Task>("select id, title, done from app__tasks where id = ?", [n]);
}

/** A title as typed, or the i18n key of the reason it cannot be one. */
export function parseTitle(raw: FormDataEntryValue | null): { title: string } | { error: string } {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (title === "") return { error: "board.error.empty" };
  if (title.length > MAX_TITLE) return { error: "board.error.long" };
  return { title };
}
```

## Forms with `<x-form>`

`<x-form action="add">` renders a `<form method="post" action="?/add">` with the CSRF token already inside, so the request passes the platform's CSRF check. A hand-written form needs `<x-csrf />`. The form now sits inside the `tasks` fragment:

`pages/board/index.html`:
```html
  <section id="tasks" r-fragment="tasks">
    <x-form action="add" class="add" hx-target="#tasks" hx-swap="outerHTML">
      <label><r-t key="board.new_task" /> <input name="title" maxlength="200" autocomplete="off" required></label>
      <button type="submit"><r-t key="board.add" /></button>
    </x-form>
    <p class="error" r-if="error">{{ error | t }}</p>
    <p class="count"><r-t key="board.open" :n="open | number" /></p>
    <ul>
      <li r-for="task in tasks"><x-task :task="task" /></li>
      <li class="empty" r-empty="tasks"><r-t key="board.empty" /></li>
    </ul>
  </section>
```

The partial gets the toggle and remove buttons:

`partials/task.html`:
```html
<r-props task="Task" />
<article :class="{ task: true, done: task.done }">
  <x-form action="toggle" hx-target="#tasks" hx-swap="outerHTML">
    <input type="hidden" name="task" :value="task.id">
    <button type="submit" class="check"><r-group r-if="task.done">✓</r-group><r-group r-else>○</r-group></button>
  </x-form>
  <span class="title" dir="auto">{{ task.title | truncate(80) }}</span>
  <x-form action="remove" hx-target="#tasks" hx-swap="outerHTML">
    <input type="hidden" name="task" :value="task.id">
    <button type="submit" class="remove"><r-t key="board.remove" /></button>
  </x-form>
</article>
```

`{{ error | t }}` translates the key the action returned, with the strings added to the catalogue:

`i18n/en.json`:
```json
    "new_task": "New task",
    "add": "Add",
    "remove": "Remove",
    "open": "{n} open",
    "empty": "Nothing to do yet.",
    "error": {
      "empty": "Write what needs doing.",
      "long": "Keep it under 200 characters."
```

## htmx: only the fragment

The forms work without JavaScript: the browser posts and the whole page comes back. Add htmx (one file, served from `public/`) and the same forms send `hx-post` requests instead:

`pages/_layouts/main.html`:
```html
  <meta name="htmx-config" content='{"includeIndicatorStyles": false}'>
  <title><slot name="title">Team board</slot></title>
  <link rel="stylesheet" href="/app.css">
  <script src="/htmx-2.0.4.min.js" defer></script>
```

Copy `htmx-2.0.4.min.js` from the [htmx release](https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js) (or from the checkpoint) into `public/`.

`<x-form>` already writes `hx-post`. `hx-target="#tasks"` tells htmx where the answer goes. htmx sends the target's id in the `HX-Target` header, the platform matches it to `r-fragment="tasks"`, runs the action and `load` as before, and renders only that fragment: no layout, no header, a few hundred bytes. `hx-swap="outerHTML"` replaces the old section with the new one. Because the form is inside the fragment, it comes back empty after an add.

[What you should see: one task ticked off, one open, and an empty form](screenshots/05-actions.png).

The tests drive the actions as a browser would: `t.action(path, name, form)` reads the CSRF token from a first `GET` and posts the form:

`tests/board.test.ts`:
```ts
  test("add: a task, escaped; an empty title is refused", async () => {
    const added = await t.action("/board", "add", { title: "Ship <b>it</b>" });
    expect(added.html).toContain("Ship &lt;b&gt;it&lt;/b&gt;");
    expect(added.html).toContain("3 open");
    expect((await t.action("/board", "add", { title: "   " })).html).toContain("Write what needs doing.");
  });

  test("toggle and remove", async () => {
    await t.action("/board", "toggle", { task: taskId("Invite the team") });
    expect((await t.page("/board")).html).toContain("2 open");
    await t.action("/board", "remove", { task: taskId("Ship <b>it</b>") });
    expect((await t.page("/board")).html).not.toContain("Ship &lt;b&gt;");
    expect((await t.action("/board", "toggle", { task: "999" })).status).toBe(404);
  });
```

The last test sends what htmx sends and checks that only the fragment comes back:

`tests/board.test.ts`:
```ts
  test("htmx: the fragment only, not the page", async () => {
    const res = await t.request("POST", "/board?/add", {
      headers: { "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": t.cookie("__Host-renox_csrf") ?? "", "hx-request": "true", "hx-target": "tasks" },
      body: "title=Plan+the+demo",
    });
```

## If it does not work

| You see | Why, and what to do |
| --- | --- |
| `RENOX_CSRF` (403) | The form has no token: use `<x-form>`, or put `<x-csrf />` inside a hand-written form. An htmx request needs the token too; `<x-form>` covers it |
| The whole page appears inside the list | The target id and the fragment name differ. `hx-target="#tasks"` needs `r-fragment="tasks"` on the element with `id="tasks"` |
| Nothing happens on submit, and `[browser] htmx.targetError` in the terminal | The `hx-target` selector matches nothing on the page |
| "No such task" (404) | The id in the form is not a task: check the hidden input's `:value="task.id"` |
| `RENOX_DB_CONSTRAINT` | A `not null` or `check` constraint refused the row; the transaction was rolled back, so nothing half-saved |

## Building with an AI agent

Ask: "Add actions to add, toggle and remove tasks, with htmx swapping only the list." Then ask it to run the tests (`run_tests`). The `htmx: the fragment only` test is the kind of check an agent can add to prove the fragment works.

**Checkpoint:** [`examples/tutorial/step-05`](../../examples/tutorial/step-05/). Next: [sign-in and teams with modules](06-teams.md).
