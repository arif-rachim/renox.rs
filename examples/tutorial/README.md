# examples/tutorial

The checkpoints of the tutorial ([`docs/tutorial/`](../../docs/tutorial/README.md), #430): a team task board built in ten chapters. `step-NN` is the complete app at the end of chapter NN, and the whole of `step-(NN-1)` plus that chapter's changes. The one file a chapter removes, `seeds/tasks.sql` in step 06, is named in `cli/tests/tutorial.test.ts`.

| Step | Adds |
| --- | --- |
| `step-01` | What `renox new --template tutorial` writes: a health route, a page, a layout, a test |
| `step-02` | `public/app.css` and a header |
| `step-03` | `/board`: a loader, a partial with props, loops, filters, `i18n/en.json` |
| `step-04` | `migrations/001_tasks.sql`, the loader on SQLite, `seeds/tasks.sql` for the tests |
| `step-05` | The actions `add`, `toggle`, `remove`; `<x-form>`; htmx and the `tasks` fragment |
| `step-06` | `auth`, `org` and `i18n` (`renox add org`); `modules/outbox` (fills `org.send_mail`); tasks per team |
| `step-07` | `[authz]`, `policies/app/board.cedar` and its test cases, the guard, `authz.require`, `r-can` |
| `step-08` | `[realtime.feeds]`, `functions/sse/board.ts`, the subscribe policy, `public/board.js` |
| `step-09` | `tests/board.test.ts`: a flow per role and page snapshots |
| `step-10` | `pages/_404.html`; the finished app |

## How they stay true

`cli/tests/tutorial.test.ts` (part of `make ts-test`):

- copies each step to a temporary folder with `@renoxium/sdk`, `typescript` and `bun-types` linked as `bun install` would, then builds it, runs `renox check` (the type check included) and `renox test`;
- checks every code block of `docs/tutorial/NN-*.md` that names a file (`` `path`: `` on the line before the block) against that file in `step-NN`, line for line;
- checks that `cli/templates/tutorial/` is `step-01`, and that `renox new --template tutorial` runs under `renox dev`.

After changing `step-01`, regenerate the template:

```sh
bun examples/tutorial/sync-template.ts
```

A change to a step usually belongs in every later step too, and in the chapter that shows the file.

## Run a step

```sh
cp -r examples/tutorial/step-08 /tmp/board && cd /tmp/board
bun install
renox dev
```

The test files start with a guard: the repository's own `bun test` runs every test file it finds, and these are meant for `renox test` only (#479 removes the guard).

## Screenshots

`docs/tutorial/screenshots/` holds one per chapter, taken from these steps under `renox dev` with Chromium.
