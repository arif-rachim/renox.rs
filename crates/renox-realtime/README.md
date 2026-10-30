# renox-realtime

A tenant's realtime connections, owned by Rust in the tenant's cell (`docs/09-htmx-realtime.md`, ADR D9; `docs/contracts/ops.md` 1.5.0 section 18; #278). The isolate runs only `open`, `message`, and `close`; fan-out never touches it. A leaf crate: no other Renox crate, no V8.

## The model

| Piece | What it is |
| --- | --- |
| `Hub` | One per tenant: its connections, its topics, its counters |
| `Conn` | One accepted connection: a bounded outbound queue (256 messages) and a close signal. Owned by its transport; dropping it disconnects |
| `ws::serve(stream, conn, inbound)` | The WebSocket transport after the handshake, over any `AsyncRead + AsyncWrite`: data messages go to `inbound` (the cell runs `message`), queued messages go out as text frames |
| `sse::serve(writer, conn)` | The SSE transport: `retry: 1000`, then `id:` / `event:` / `data:` per message, `: keep-alive` every 15 s |

`Hub::connect(ConnInfo { user, transport, last_event_id })` checks the tenant and user caps. `subscribe(conn, topic, allowed)` takes the caller's authorization decision (the Cedar `realtime.subscribe` check is the cell's, #281) and replays missed events to an SSE reconnect. `publish(topic, payload)` queues the message for every subscriber with `try_send` and returns how many it was queued for. `send(conn, payload)` queues for one connection, and `close(conn, code, reason)` closes one. An unknown or closed connection id is ignored, not an error (`ops.md` section 18).

Pub/sub is a map from topic to subscribers, and each connection has its own `mpsc` queue. `docs/09` names `tokio::sync::broadcast`, but a broadcast channel cannot close the one slow receiver with 1008 while the others continue: a lagging receiver only loses messages. The per-connection queue gives the contract's backpressure rule exactly.

## Limits (`ops.md` 1.5.0 section 18)

| Limit | Value | On the limit | Test (`tests/hub.rs`) |
| --- | --- | --- | --- |
| Connections per tenant | 100 free / 10,000 paid (`docs/04`) | `connect` → `RealtimeError::Limit(Tenant)` (`RENOX_REALTIME_LIMIT`; the cell answers 503, `Retry-After: 5`) | `tenant_and_user_caps` |
| Connections per user (principal id, or `ip:<addr>` for anonymous) | 10 | `Limit(User)` | `tenant_and_user_caps` |
| Topics per connection | 64 *proposed* | `subscribe` → `Limit(Topics)` | `topics_per_connection_and_bad_topics` |
| Topic shape | ≤ 256 characters, segments `[A-Za-z0-9_.-]+` split on `:` | `BadTopic` (the bootstrap throws `RangeError` first) | `topics_per_connection_and_bad_topics` |
| Inbound message | 64 KB, fragments counted together, checked from the frame header before the payload is read | close 1009 `message_size` | `oversized_frame_closed_with_1009` |
| Outbound message | 64 KB after rendering | `publish` / `send` → `Limit(MessageSize)` | `outbound_message_size` |
| Inbound messages per connection | 100 per second *proposed* | close 1008 `flood`; other connections are not delayed | `flood_closes_that_connection_only` |
| Outbound queue | 256 messages | that connection is closed with 1008 `backpressure`; `publish` never waits | `slow_consumer_closed_with_1008_publish_never_waits` |
| Heartbeat | ping every 30 s, pong within 10 s *proposed*; SSE `: keep-alive` every 15 s | close 1001 `heartbeat` | `heartbeat_timeout_closes`, `sse_wire_format_and_keepalive` |
| Replay buffer per topic | the last 100 events or 60 s *proposed* | an SSE reconnect with `Last-Event-ID` gets the missed events of the topics it subscribes to; outside the buffer, none | `replay_after_reconnect_with_last_event_id` |

`Limits::free()` and `Limits::paid()` hold these values. Event ids are one increasing sequence per hub (so per topic too), the SSE `id:` a reconnect sends back.

## Counters

`Hub::snapshot()` → `Counters`: `live`, `opened`, `connection_seconds` (of closed connections), `messages_in` (frames received), `messages_out` (messages queued to connections: `publish`, `send`, replay), `refused` by reason, `closes` by reason (`backpressure`, `flood`, `message_size`, `heartbeat`, `client`, `eof`, `dropped`, or the reason a handler gave). The cell turns them into the per-connection meter record (`realtime_conn_seconds`, `realtime_messages`) and the metrics endpoint. `Conn::lifetime()` is the connection's own seconds.

## Why our own WebSocket codec

`src/ws.rs` reads and writes RFC 6455 frames itself, about 150 lines, rather than using `tokio-tungstenite` or the `fastwebsockets` already in the tree through `deno_runtime`:

- The 64 KB limit is checked from the frame header before any payload byte is buffered, and fragments of one message count together.
- The reader is polled inside the connection's one task and is never cancelled mid-frame, so heartbeats, queued messages, and closes are written while a read is pending. One task per connection is what keeps B14 under its budget.
- No new dependency and no `openssl`. The handshake (`Sec-WebSocket-Accept`) is the cell's (#281).

Client frames must be masked. Reserved bits, unknown opcodes, a bad control frame, or a stray continuation close with 1002, and text that is not UTF-8 with 1007. A client close is echoed with its code.

## B14 on the crate

`tests/scale.rs`: 10,000 idle WebSocket connections, each served over an in-memory duplex stream and subscribed to one topic, add **≈ 47 MB** of RSS (about 4.9 KB per connection, the test's client halves included). The target is ≤ 50 MB. Result: `bench/results/2026-10-29-B14-crate-dev-container.md`. The test is skipped, with a reason, on a host under 2 GB. The end-to-end B14 (gateway, cell, isolate heap unchanged) is #282.

## What the cell must do (#281)

- Check `Origin`, verify the cookie, resolve the principal, evaluate the `guard`, then `connect` (503 on a cap), complete the handshake (101 or `200 text/event-stream`), run `open`.
- Pass `ws::Inbound` messages to the isolate's `message`, one at a time; run `close` with the `Closed` that `serve` returns; write the meter record.
- Evaluate `realtime.subscribe` with `renox-authz` and pass the decision to `subscribe`.
- Render `fragment` payloads before `publish` / `send` (64 KB after rendering).
