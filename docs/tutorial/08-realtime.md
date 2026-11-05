# Chapter 8: Realtime

**What you build:** when anyone on the team adds, ticks off or removes a task, every open board of that team updates within a moment, without a reload. It takes one line of configuration, one route, one policy rule and a ten-line script.

## The change feed

`renox.toml`:
```toml
# Chapter 8: every committed change of a task reaches the team's topic.
[realtime.feeds]
app__tasks = "board:{team_id}"
```

After every committed change of a row of `app__tasks`, the platform publishes `{ table, rowid, op }` to the topic `board:<team_id>` of that row. Your actions do not change at all: a rolled-back action publishes nothing.

## Subscribe: an SSE route

Files under `functions/sse/` are Server-Sent Events routes. The connection is held by the platform in Rust, not by your code: `open` runs once to subscribe, and an idle connection costs a few KB and no isolate.

`functions/sse/board.ts`:
```ts
// GET /sse/board: the live feed of the active team. `[realtime.feeds]` in
// renox.toml sends every committed change of app__tasks to `board:<team>`;
// this route only subscribes the connection to its own team's topic.
interface SseCtx {
  conn: { id: string };
  principal: { attrs: { org?: unknown } } | null;
  realtime: { subscribe(conn: { id: string }, topic: string): Promise<void> };
}

export const guard = { action: "board.view" };

export const sse = {
  async open({ conn, principal, realtime }: SseCtx) {
    const team = principal?.attrs.org;
    if (typeof team !== "string") throw new Error("no active team");
    await realtime.subscribe(conn, `board:${team}`);
  },
};
```

The topic comes from the principal, never from the URL, so a user cannot ask for another team's topic. The policy has the last word anyway: subscribing is the action `realtime.subscribe` on the topic, and with no `permit` it is refused.

`policies/app/board.cedar`:
```cedar
// Chapter 8: the live feed of your own team only.
permit (principal is Renox::User, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "board:*" && principal has org && resource.segments.contains(principal.org) };
```

## Refresh the list

The feed says *that* something changed, not what each member should see. So the browser fetches the `tasks` fragment again, through the loader and the template, with that member's own permissions (the remove buttons stay right for each role):

`public/board.js`:
```js
// Chapter 8: when the server says the board changed, fetch the tasks
// fragment again, so every member sees it through their own permissions.
document.addEventListener("DOMContentLoaded", () => {
  const tasks = document.getElementById("tasks");
  if (tasks === null || !tasks.dataset.live) return;
  const feed = new EventSource(tasks.dataset.live);
  feed.addEventListener("message", () => {
    htmx.ajax("GET", location.pathname, { target: "#tasks", swap: "outerHTML" });
  });
});
```

The fragment tells the script where its feed is:

`pages/board/index.html`:
```html
    <section id="tasks" r-fragment="tasks" data-live="/sse/board">
```

and the layout loads the script:

`pages/_layouts/main.html`:
```html
  <script src="/board.js" defer></script>
```

The script is a file in `public/` because pages send a strict content security policy: inline scripts without the page's nonce do not run.

## See it

Open the board in two browser windows signed in as members of the same team. Add a task in one. [What you should see: the other window shows it without a reload](screenshots/08-live.png).

The test opens a feed for two teams and checks that only the right one hears the change:

`tests/board.test.ts`:
```ts
  test("live: the feed of a team hears its changes, and only its own", async () => {
    const lina = t.as("Lina");
    const sara = t.as("Sara");
    const linaFeed = await lina.sse("/sse/board");
    const saraFeed = await sara.sse("/sse/board");
    await Bun.sleep(200);
    await lina.action("/board", "add", { title: "Seen live" });
    expect((await linaFeed.next(5000))?.data).toContain("app__tasks");
    expect(await saraFeed.next(500)).toBeNull();
    linaFeed.close();
    saraFeed.close();
  });
});
```

## Limits to know

- Cloudflare, in front of every app, cuts a connection that sends nothing for 100 seconds. The platform sends a heartbeat every 15 seconds on SSE, so you do not have to.
- A connection whose queue fills (256 messages) is closed with code 1008 (`RENOX_REALTIME_BACKPRESSURE`). `EventSource` reconnects by itself, and SSE replays recent events from `Last-Event-ID`.
- Connections per app and per user are capped by tier; over the cap the upgrade gets 503 `RENOX_REALTIME_LIMIT`.

## If it does not work

| You see | Why, and what to do |
| --- | --- |
| The other window does not update | Open the browser's network tab: `/sse/board` should stay open. A 403 means the guard or the subscribe policy denied it |
| `RENOX_FORBIDDEN` when the feed opens | No `permit` for `realtime.subscribe` on `board:<team>`: check the topic name in `[realtime.feeds]`, the route and the policy match |
| "no active team" in the terminal | The user has no team; the route refuses to subscribe |
| `[browser] js.error … htmx is not defined` | `board.js` ran before htmx: both scripts need `defer`, htmx first |

## Building with an AI agent

Ask: "Make the board update live for every team member with the realtime feed." Point the agent at this chapter and [Fragments and realtime](../09-htmx-realtime.md); the test above is how it proves the feed is scoped to the team.

**Checkpoint:** [`examples/tutorial/step-08`](../../examples/tutorial/step-08/). Next: [tests](09-tests.md).
