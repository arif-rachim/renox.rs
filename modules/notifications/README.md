# notifications

In-app notifications (`docs/18-build-plan.md` M9). A module or the app calls `notify(user, item)`. The user's open pages update their badge and list without a reload, over SSE (`docs/09-htmx-realtime.md`). The user chooses per category which channels they get.

## Install

```toml
[modules]
notifications = { version = "^1.0", mount = "/notifications", config = { channels = "whatsapp" } }
```

It needs `auth` (the signed-in user, the login hop) and `i18n` (the page language).

| Config | Default | Meaning |
| --- | --- | --- |
| `base_path` | `/notifications` | Where the app mounts the module, for the badge's links |
| `channels` | `""` | Other channels, comma-separated (`whatsapp`, `email`). The module runs `notifications.deliver` for each one the user has not turned off |

## Service

```ts
import { notifications } from "renox:modules";

await notifications.notify(userId, { category: "orders", title: "Order #42 shipped", body: "On its way", link: "/orders/42" });
```

| Service | Result |
| --- | --- |
| `notify(user, { category, title, body?, link? })` | `{ id, channels }`. It writes the row and pushes the badge and the item to `notif:user:<user>`. Then it runs `notifications.deliver` once for each other channel. Every channel, in-app included, honours the user's preferences. `id` is `null` when the user turned in-app off for the category. The arguments must be: `category` matching `[a-z][a-z0-9_.-]*`; `title` from 1 to 200 characters; `body` up to 2000 characters. `link` is kept only when it is a path of the app or an `https` URL |
| `list({ unread?, limit? })` | The signed-in user's notifications, newest first (at most 100) |
| `unreadCount()` | The signed-in user's unread count |
| `markRead(id)`, `markAllRead()` | Marks one notification (or all of them) read, and pushes the new count |
| `preferences()`, `setPreference({ category, channel, enabled })` | The signed-in user's channels per category: `inapp` plus the configured ones. Everything is on until turned off |
| `badge()` | The header badge's data, or `null` when signed out |

`notifications__items` and `notifications__prefs` are owned by `user_id` (`[authz.ownership]`). Every statement goes through `db.scoped()`, so one user's call never reads or changes another user's rows.

## Hook

`notifications.deliver` receives `{ user, channel, item: { id, category, title, body, link } }` once per enabled channel. `whatsapp` (#290) fills it for `whatsapp`, and `email` will fill it in F7. A filler declares it with `permissions.hooks = ["notifications.deliver"]`.

## Slot

`partials/badge.html` fills `app.header`: a link to the list with the unread count, which updates live (`hx-ext="sse"`, `sse-swap="notif-badge"`). The host page puts the badge's data in its own data:

```ts
import { notifications } from "renox:modules";

export async function load() {
  return { notif_badge: await notifications.badge() };
}
```

## Pages and the live stream

| Route | |
| --- | --- |
| `GET <mount>` | The list, live: new items at the top (`sse-swap="notif-item"`). Actions `read` and `all` |
| `GET <mount>/prefs` | Channels per category. Action `set` |
| `GET <mount>/sse/notifications` | The SSE stream of the signed-in user. It subscribes the connection to `notif:user:<principal id>`. Events: `notif-badge` (`partials/count.html`) and `notif-item` (`partials/item.html`) |

Signed out, the pages send the visitor to auth's login page, and the stream ends at once.

## Policy

Subscribing is the platform action `realtime.subscribe`, and it is fail-closed. `policies/notifications.cedar` allows a user only their own topic:

```cedar
permit (principal is Renox::User, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "notif:user:*" && resource.segments.contains(principal.id) };
```

User ids are auth's 32 hex digits, so no id can equal the segments `notif` or `user`.

## Listeners

`org.member_added` for a member who is not the owner: "You joined an organisation". auth has no "login from a new device" event yet, so there is no listener for it. Apps add their own notifications through `notify`.

## Tests

`renox test` in this folder runs `tests/notifications.test.ts` against `tests/app`. That app has auth, org, notifications, and `deliver`, a fixture that records `notifications.deliver`. The tests cover:

- two SSE clients: a notification reaches alice's badge and list, never bob's;
- bob's subscribe to alice's topic through another route is refused (`docs/24-threat-model.md` "Subscribing to another user's topic");
- a signed-out stream gets nothing;
- the header badge, the unread count, and mark read with the badge following live;
- a preference stopping WhatsApp, then in-app;
- links;
- snapshots in English and Arabic.
