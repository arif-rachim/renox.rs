# Chapter 3: Pages and templates

**What you build:** the `/board` page. A loader gives it a list of tasks, the template loops over them through a partial, and the strings come from a translation file. The tasks are a fixed list for now; chapter 4 moves them into the database.

## A page is two files

`pages/board/index.html` is the page at `/board`. Next to it, `pages/board/index.ts` may export `load`, which returns the template's data. Either file can stand alone: an `.html` with no loader renders without data, and a loader can return a `Response` (a redirect, JSON) instead of data ([App model, pages](../07-app-model.md#pages-ts-and-html-pairs-are-optional)).

The tasks, for now:

`lib/tasks.ts`:
```ts
// The board's tasks. For now a fixed list; chapter 4 moves them into SQLite.

export type Task = {
  id: number;
  title: string;
  done: number;
};

const SAMPLE: Task[] = [
  { id: 3, title: "Invite the team", done: 0 },
  { id: 2, title: "Write the first page", done: 0 },
  { id: 1, title: "Install the renox CLI", done: 1 },
];

/** The tasks, open ones first. */
export function listTasks(): Task[] {
  return [...SAMPLE].sort((a, b) => a.done - b.done || b.id - a.id);
}
```

The loader:

`pages/board/index.ts`:
```ts
// GET /board: the loader returns the template's data.
import { listTasks } from "../../lib/tasks";

export function load() {
  const tasks = listTasks();
  return {
    tasks: tasks.map((t) => ({ ...t, done: t.done === 1 })),
    open: tasks.filter((t) => t.done === 0).length,
  };
}
```

`lib/` is plain TypeScript: it is not a route, and pages and functions import from it.

## The template

`pages/board/index.html`:
```html
<r-layout use="main">
  <r-group slot="title"><r-t key="board.title" /></r-group>
  <h1><r-t key="board.title" /></h1>
  <section id="tasks" r-fragment="tasks">
    <p class="count"><r-t key="board.open" :n="open | number" /></p>
    <ul>
      <li r-for="task in tasks"><x-task :task="task" /></li>
      <li class="empty" r-empty="tasks"><r-t key="board.empty" /></li>
    </ul>
  </section>
</r-layout>
```

What each part does:

| Syntax | Meaning |
| --- | --- |
| `<r-layout use="main">` | Wraps the page in `pages/_layouts/main.html` |
| `<r-group slot="title">` | Fills the layout's `<slot name="title">`; `r-group` itself emits no element |
| `r-for="task in tasks"` | Repeats the element for each item |
| `r-empty="tasks"` | Shown instead when the list is empty |
| `r-fragment="tasks"` | Names a part of the page that can be rendered alone (chapter 5 uses it) |
| `<x-task :task="task" />` | Renders the partial `partials/task.html`; `:task` passes a value, not a string |
| `<r-t key="board.open" :n="open \| number" />` | A translated string, with `{n}` filled in; `\| number` formats the number for the locale |

The partial declares its props, so a typo in a caller is a build error and not an empty box:

`partials/task.html`:
```html
<r-props task="Task" />
<article :class="{ task: true, done: task.done }">
  <span class="check"><r-group r-if="task.done">✓</r-group><r-group r-else>○</r-group></span>
  <span class="title" dir="auto">{{ task.title | truncate(80) }}</span>
</article>
```

`:class="{ task: true, done: task.done }"` sets the classes whose value is true. `r-if` / `r-else` choose one of two elements. `{{ task.title | truncate(80) }}` prints the title, escaped, cut at 80 characters. Escaping is automatic: a title of `<b>hi</b>` shows those characters, and no markup reaches the page. `dir="auto"` lets a title in Arabic run right to left.

Templates are a small language on purpose: property access, comparisons, `&&`, `||`, `!`, `??` and filters, and no function calls. Anything that needs code goes in the loader ([Templates](../08-template-engine.md)).

## Strings in one place

`<r-t key="…">` looks the key up in `i18n/<locale>.json`. The app's own catalogue needs no module:

`i18n/en.json`:
```json
{
  "home": {
    "title": "Your team's board",
    "intro": "Add tasks, tick them off, and see your team's changes as they happen.",
    "open_board": "Open the board"
  },
  "board": {
    "title": "Board",
    "open": "{n} open",
    "empty": "Nothing to do yet."
  }
}
```

The home page and the layout's header now use keys too:

`pages/index.html`:
```html
<r-layout use="main">
  <h1><r-t key="home.title" /></h1>
  <p><r-t key="home.intro" /></p>
  <p><a href="/board"><r-t key="home.open_board" /></a></p>
</r-layout>
```

`pages/_layouts/main.html`:
```html
  <header>
    <a href="/"><strong>Team board</strong></a>
    <a href="/board"><r-t key="board.title" /></a>
  </header>
```

A second language is a second file (`i18n/ar.json`) with the same keys; the `i18n` module (chapter 6 installs it) picks the locale for each visitor.

## See it

Open http://localhost:8787/board. [What you should see: two open tasks above the done one](screenshots/03-board.png).

The test asks for the page and checks the order:

`tests/board.test.ts`:
```ts
describe.skipIf(!run)("the board", () => {
  test("lists the tasks, open ones first", async () => {
    const page = await t.page("/board");
    expect(page.status).toBe(200);
    expect(page.html).toContain("2 open");
    expect(page.html.indexOf("Invite the team")).toBeLessThan(page.html.indexOf("Install the renox CLI"));
    expect(page.html).toContain('<article class="task done">');
  });
```

## If it does not work

| You see | Why, and what to do |
| --- | --- |
| ``unknown component `<x-tsk>`: expected partials/tsk.html`` | The partial's file name must match the tag: `<x-task>` is `partials/task.html` |
| `i18n-missing-key  <r-t key="board.emptyy"> has no en translation` | The key is not in `i18n/en.json` (or the JSON does not parse) |
| `RENOX_RENDER_LIMIT` | A template ran out of render fuel (a loop over a huge list). Limit the list in the loader |
| A `{{ }}` shows up literally | Interpolation is not processed inside `<script>` and `<style>`, by design |

## Building with an AI agent

Ask: "Add a page at /board that lists tasks from a loader, with a partial for one task." The agent can call `search_docs` for the template syntax and `run_check` to see the template errors before you open the browser.

**Checkpoint:** [`examples/tutorial/step-03`](../../examples/tutorial/step-03/). Next: [data](04-data.md).
