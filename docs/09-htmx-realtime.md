# 09 — Partial rendering and realtime

For partial page updates the server sends HTML fragments and the browser swaps only what changed. One template and one loader serve both full renders and fragments; no extra endpoints are written.

## Fragment flow

1. The first request to `/products` renders the full page.
2. htmx sends `GET /products?q=shoes` with `HX-Request: true` and `HX-Target: product-list`.
3. Rust runs the same loader (told which fragment is requested) and renders only the `product_list` block via minijinja's per-block render. The layout is not rendered.
4. The response is a few KB of HTML. htmx swaps the fragment with the `morph` extension (idiomorph), wrapped in a View Transition.

Actions that update several parts at once (a button and the cart badge) return `{ fragments: [...] }`; Rust renders the extra fragments and marks them with `hx-swap-oob="true"` automatically.

**Why it feels smooth:** morphing changes only differing nodes, so input focus, scroll position, playing media, and running CSS animations are preserved; the View Transitions API animates state changes between fragments. Elements with `view-transition-name` slide to their new positions.

## Interaction layers

| Need | Solution | Done by |
| --- | --- | --- |
| First page | Full SSR | Rust + loader |
| Filter, paging, forms | Fragment + morph | Rust renders, htmx swaps |
| Dropdowns, modals, tabs | Alpine.js or vanilla JS | Browser, no server round trip |
| Highly interactive widgets | Islands (Preact/Svelte/Solid), bundled at deploy by the CLI | Browser |
| Notifications, feeds, progress | SSE | Rust |
| Chat, collaboration | WebSocket | Rust |

**Why htmx rather than a custom client:** htmx and idiomorph are mature and documented; the platform only needs to understand their headers on the server. A custom client is justified only later for tighter integration (automatic form validation from loader schemas, prefetching).

## Realtime: SSE and WebSocket

Connections are owned by Rust in the tenant's cell, not by the isolate. The isolate is invoked only on connect, incoming message, and disconnect, so thousands of idle connections use no tenant heap. Cost per connection is a few KB in tokio.

| | SSE | WebSocket |
| --- | --- | --- |
| Direction | Server → browser | Both |
| Good for | Notifications, feeds, progress, live fragment updates | Chat, collaboration, games, high-frequency input |
| htmx integration | `hx-ext="sse"`, `sse-connect`, `sse-swap` | `hx-ext="ws"`, `ws-connect`, `ws-send` |
| Through proxies/CDNs | Easy (plain HTTP) | Needs upgrade support |

```ts
// functions/ws/chat/[room].ts  ->  wss://host/ws/chat/:room
export const ws = {
  async open({ conn, params, auth, realtime }) {
    await auth.requireUser(conn.req);
    await realtime.subscribe(conn, `room:${params.room}`);      // checked by realtime.authorize
  },
  async message({ conn, data, params, realtime, render }) {
    const html = await render("partials/chat-message.html", { msg: data, user: conn.user });
    realtime.publish(`room:${params.room}`, html);              // HTML fragment to all subscribers
  },
  close({ conn }) { /* optional */ },
};
```

```html
<div hx-ext="sse" sse-connect="/sse/orders" sse-swap="order-updated">…</div>
```

- `realtime.publish(topic, payload)` can be called from WebSocket handlers, actions, services, or durable event handlers. Because all of a tenant's requests are on one node, pub/sub is in-process (`tokio::sync::broadcast`). Cross-node delivery exists only for replica-tier tenants, through a pluggable transport (NATS/Redis).
- Realtime from data changes uses SQLite's `update_hook`: changed table and rowid are mapped to topics and filtered by policy.
- Security and reliability: authentication at connect with the session cookie; per-topic authorization via the `realtime.authorize` hook; heartbeats; connection limits per tenant and per user; message size limits; backpressure (slow clients are disconnected); SSE supports `Last-Event-ID` for short replay after reconnect.
- Realtime is metered per tenant (connection-seconds and messages) for billing.

**Contract.** The runtime side of this section is `docs/contracts/ops.md` section 18 (1.5.0, #272): route kinds `ws` (`functions/ws/**`, `export const ws = { open, message, close }`) and `sse` (`functions/sse/**`, `export const sse = { open, close }`), the `conn` handle, `ctx.realtime` (`subscribe`, `unsubscribe`, `publish`, `send`, `close`), payloads as text, JSON, or a partial rendered by the cell (`{ fragment, data }`, which is how the `render(...)` of the example above reaches subscribers), the change feed from `[realtime.feeds]` after commit, the `Origin` rule at the upgrade, the limits table (connections per tenant and per user, 64 KB messages, a 256-message queue with a 1008 close for slow consumers, heartbeats, `Last-Event-ID` replay), and one meter record per connection. The `realtime.authorize` hook named above is **a Cedar policy, not a hook**: subscribing is the action `realtime.subscribe` on the resource `Renox::Topic` (attributes `name` and `segments`), fail-closed when no policy permits it.
