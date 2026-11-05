# Chapter 9: Tests

**What you build:** one test file with a flow for each role (signed out, owner, member, outsider) and snapshots of what the owner and the member see. No new app code: this chapter makes sure the board stays right as it grows.

## How `renox test` runs

`renox test` builds the app, starts the same worker `renox dev` uses, and gives **each test file its own fresh database**, with the migrations applied (and `seeds/*.sql`, if any). The tests talk HTTP to that worker, so they go through the guard, the policies, the CSRF check, the modules and the templates, as a browser would. `@renoxium/sdk/test` gives you:

| Helper | What it does |
| --- | --- |
| `app()` | The worker and the database for this file |
| `t.as("Lina")` | The same app as another user, with their own cookies |
| `t.page(path)` | `GET` a page |
| `t.action(path, name, form)` | Post a page action with the CSRF token, as `<x-form>` would |
| `t.request(method, path, init)` | Any request, with your own headers |
| `t.sse(path)`, `t.ws(path)` | Open a realtime route and read its messages |
| `t.db.query(sql, params)` | Read the test's database, for assertions |
| `snapshot(html, { role })` | Compare a page with the stored snapshot for that role |

## A flow per role

Helpers first. Users sign up through the real `auth` pages, and the invitation link comes from the `outbox` table:

`tests/board.test.ts`:
```ts
const PASSWORD = "correct horse battery";

/** The page's <main>: the header carries the team's random id, which changes on every run. */
const main = (html: string): string => html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);

/** A new user, registered and signed in, with their own cookies. */
async function signUp(name: string): Promise<TestApp> {
  const u = t.as(name);
  const email = `${name.toLowerCase()}@example.com`;
  await u.action("/auth/register", "default", { email, password: PASSWORD, display_name: name });
  expect((await u.action("/auth/login", "default", { email, password: PASSWORD })).status).toBe(303);
  return u;
}

/** The id of the task with this title. */
const taskId = (title: string): string => String(t.db.query<{ id: number }>("select id from app__tasks where title = ?", [title])[0]?.id);

/** The invitation link the outbox module kept for this address. */
const invitation = (email: string): string => new URL(t.db.query<{ url: string }>("select url from outbox__mail where mail_to = ? order by id desc limit 1", [email])[0]?.url as string).pathname;
```

The owner creates the team and uses every action. An htmx request is checked to return the fragment only:

`tests/board.test.ts`:
```ts
  test("owner: creates the team, adds, ticks off and removes tasks", async () => {
    lina = await signUp("Lina");
    expect((await lina.page("/board")).html).toContain("You are not in a team yet.");
    expect((await lina.action("/org", "create", { name: "Acme" })).status).toBe(303);
    await lina.action("/board", "add", { title: "Write the tutorial" });
    await lina.action("/board", "add", { title: "Ship <b>it</b>" });
    // An htmx request gets the tasks fragment only, not the whole page.
    const fragment = await lina.request("POST", "/board?/add", {
      headers: { "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": lina.cookie("__Host-renox_csrf") ?? "", "hx-request": "true", "hx-target": "tasks" },
      body: "title=Plan+the+demo",
    });
    expect(fragment.status).toBe(200);
    expect(fragment.html).toStartWith('<section id="tasks"');
    expect(fragment.html).toContain("3 open");
    expect((await lina.action("/board", "add", { title: "   " })).html).toContain("Write what needs doing.");
    await lina.action("/board", "toggle", { task: taskId("Write the tutorial") });
    await lina.action("/board", "remove", { task: taskId("Plan the demo") });
    const page = await lina.page("/board");
    expect(page.html).toContain("Ship &lt;b&gt;it&lt;/b&gt;");
    expect(page.html).toContain("1 open");
    expect(page.html).toContain(">Remove</button>");
    sdk?.snapshot(main(page.html), { role: "owner" });
  });
```

The member joins through the invitation. They can add and tick off, they see no remove button, and a hand-made remove request is refused:

`tests/board.test.ts`:
```ts
  test("member: joins by invitation, adds and ticks off, cannot remove", async () => {
    await lina.action("/org/members", "invite", { email: "omar@example.com", role: "member" });
    omar = await signUp("Omar");
    expect((await omar.action(invitation("omar@example.com"), "accept", {})).status).toBe(303);
    await omar.action("/board", "add", { title: "Review chapter 9" });
    await omar.action("/board", "toggle", { task: taskId("Ship <b>it</b>") });
    const page = await omar.page("/board");
    expect(page.html).toContain("Review chapter 9");
    expect(page.html).not.toContain(">Remove</button>");
    // The button is hidden, and the action refuses the request too.
    expect((await omar.action("/board", "remove", { task: taskId("Review chapter 9") })).status).toBe(403);
    sdk?.snapshot(main(page.html), { role: "member" });
  });
```

The outsider is in another team: they see none of it, and a request naming one of Acme's tasks is a 404, because the query never finds it:

`tests/board.test.ts`:
```ts
  test("outsider: another team sees none of it and cannot change it", async () => {
    const sara = await signUp("Sara");
    await sara.action("/org", "create", { name: "Other" });
    const page = await sara.page("/board");
    expect(page.html).toContain("Nothing to do yet.");
    expect(page.html).not.toContain("Review chapter 9");
    expect((await sara.action("/board", "toggle", { task: taskId("Review chapter 9") })).status).toBe(404);
  });
```

The tests inside one `describe` share one database and run in order, so the member's test sees the owner's tasks.

## Snapshots

`snapshot(html, { role })` stores the page the first time and compares it on every later run. It replaces what changes on every request (request ids, CSRF tokens, nonces, hashed file names) before comparing. The page header holds the team's random id, so the test snapshots only `<main>`:

`tests/board.test.ts`:
```ts
/** The page's <main>: the header carries the team's random id, which changes on every run. */
const main = (html: string): string => html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);
```

The snapshots are in `tests/__snapshots__/board.test.ts.snap`; review them like code. After an intended change to the page, update them and look at the diff:

```sh
renox test -u
git diff tests/__snapshots__
```

## Run it

```sh
renox test
```

```
(pass) policy policies/tests/board.json: a signed-in user opens the board -> allow
(pass) policy policies/tests/board.json: a visitor who is not signed in does not -> deny
(pass) policy policies/tests/board.json: a member ticks off a task of their team -> allow
(pass) policy policies/tests/board.json: not a task of another team -> deny
(pass) policy policies/tests/board.json: nor without a team -> deny
(pass) policy policies/tests/board.json: a task of the team may be removed -> allow
(pass) policy policies/tests/board.json: not one of another team -> deny
bun test v1.4.4

 7 pass
 0 fail
 2 snapshots, 26 expect() calls
Ran 7 tests across 2 files. [2.50s]
```

`renox test` exits with 0 when everything passed and 2 when anything failed, so CI can run it as it is.

## If it does not work

| You see | Why, and what to do |
| --- | --- |
| A snapshot fails after you changed the page on purpose | Run `renox test -u`, then read the diff before you commit |
| A snapshot fails on every run with a different value | Something per request is in the page (a time, a random id). Snapshot a smaller part, as `main()` does, or keep it out of the template |
| `expected 303, received 200` on login | The password is shorter than `auth`'s minimum (12 characters by default) |
| A test sees another test's data | Tests in one file share a database. Put independent tests in separate files |
| Exit code 3 | No worker or no Bun: see chapter 1 |

## Building with an AI agent

Ask: "Write a test flow for each role of the board: owner, member, outsider, signed out." With `run_tests` the agent runs them on the worker and sees the failures. Ask it to show you the snapshot diff before it updates snapshots.

**Checkpoint:** [`examples/tutorial/step-09`](../../examples/tutorial/step-09/). Next: [deploy and a custom domain](10-deploy.md).
