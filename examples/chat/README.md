# examples/chat

A chat with one WebSocket room per page (#282; `docs/09-htmx-realtime.md`). It is the app of benchmark B14 (`docs/14-benchmarks.md`). The whole app is about 150 lines; read it in this order:

| File | What it does |
| --- | --- |
| `renox.toml` | auth (with i18n), and two actions: `room.enter` (the routes' guard) and `room.join` (a room as loaded from the database) |
| `migrations/001_rooms.sql` | `app__rooms` (`general` is public, `team` private) and `app__members` |
| `policies/app/chat.cedar` | Any signed-in user enters. A public room is open to all, a private room to its members. A signed-in user may subscribe to `room:*` |
| `lib/rooms.ts` | The room row with `member` computed for the user, as the policy's resource |
| `functions/ws/chat/[room].ts` | The socket. The guard denies a signed-out upgrade with 403. `open` asks `room.join` (a refusal closes with 1008), then subscribes to `room:<id>`. `message` renders `partials/message.html` and publishes it to the room |
| `partials/message.html` | One message, as an htmx out-of-band fragment (`<div id="messages" hx-swap-oob="beforeend">`). It is rendered in Rust, off the isolate thread, once per message, whatever the number of listeners |
| `pages/index.{ts,html}` | The rooms you may join |
| `pages/rooms/[room].{ts,html}` | The room. The page runs the same policy check as the socket, so a room you may not join is 403. Its script opens the socket and appends each fragment |

The connections live in the cell's realtime hub (#278, #281): the isolate runs only `open` and `message`, and fan-out never enters it. Messages are not stored. Once one room works, history is a table and a loader.

## Screenshots

`RENOX_WORKER_PATH=../../target/debug/renox-worker bun tests/browser-check.ts` drives Chromium under `renox dev`. Two users join #general and each sees the other's message, and #team answers 403. The run takes these screenshots:

- `screenshots/1-rooms.png`: the rooms Lina may join (only #general);
- `screenshots/2-room.png`: #general as Omar sees it, both messages;
- `screenshots/3-private-room.png`: #team for a non-member.

## Tests

`renox test` (or `RENOX_WORKER_PATH=... bun test`) runs `tests/chat.test.ts` and the policy cases in `policies/tests/chat.json`:

- two users in a room see each other's fragment, and the text is escaped;
- a non-member's socket to #team closes with 1008, and a member's opens;
- a signed-out upgrade is refused by the guard (403, no socket).

`cli/tests/chat-fixture.test.ts` builds the app (the `ws` route with its guard, the policy files), checks it and runs `renox test`.

## B14

`bench/run.sh B14` opens 10,000 idle sockets to #general on a worker and reports the worker's RSS and the isolate heap (`bench/scenarios/B14`, `bench/lib/ws-load.ts`). The dev container result is `bench/results/2026-10-29-B14-dev-container.md`; the `node-small` run is O3 (#158).
