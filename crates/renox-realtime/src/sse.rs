//! The SSE transport (`text/event-stream`, `ops.md` 1.5.0 section 18, "On
//! the wire"): `retry: 1000` once, then per message `id: <n>`, `event:`
//! when set, one `data:` line per line of the payload, a blank line; a
//! `: keep-alive` comment every 15 s. A failed write is the client going
//! away.

use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::time::{Instant, MissedTickBehavior};

use crate::{Closed, Conn, Event, Outbound, close};

/// The first bytes of every stream.
pub const PREAMBLE: &str = "retry: 1000\n\n";
/// The keep-alive comment.
pub const KEEPALIVE: &str = ": keep-alive\n\n";

/// One event in the wire format.
pub fn encode(e: &Event) -> String {
    let mut out = format!("id: {}\n", e.id);
    if let Some(name) = &e.event {
        // An event name is one line.
        out.push_str("event: ");
        out.push_str(&name.replace(['\r', '\n'], " "));
        out.push('\n');
    }
    for line in e.data.split('\n') {
        out.push_str("data: ");
        out.push_str(line.strip_suffix('\r').unwrap_or(line));
        out.push('\n');
    }
    out.push('\n');
    out
}

/// The `Last-Event-ID` header's value, when it is a number of this hub.
pub fn last_event_id(header: Option<&str>) -> Option<u64> {
    header.and_then(|v| v.trim().parse().ok())
}

/// Streams `conn` to `w` until the hub closes it or a write fails.
pub async fn serve<W>(mut w: W, mut conn: Conn) -> Closed
where
    W: AsyncWrite + Unpin,
{
    let keepalive_every = conn.hub().limits().sse_keepalive;
    let gone = || Closed {
        code: close::GOING_AWAY,
        reason: "client".into(),
    };
    let closed = 'run: {
        if w.write_all(PREAMBLE.as_bytes()).await.is_err() || w.flush().await.is_err() {
            break 'run gone();
        }
        let mut keepalive =
            tokio::time::interval_at(Instant::now() + keepalive_every, keepalive_every);
        keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let closed_fut = conn.closed();
        tokio::pin!(closed_fut);
        loop {
            tokio::select! {
                biased;
                c = &mut closed_fut => break 'run c,
                m = conn.rx.recv() => match m {
                    Some(Outbound::Message(e)) => {
                        if w.write_all(encode(&e).as_bytes()).await.is_err() || w.flush().await.is_err() {
                            break 'run gone();
                        }
                    }
                    None => break 'run Closed { code: close::GOING_AWAY, reason: "hub".into() },
                },
                _ = keepalive.tick() => {
                    if w.write_all(KEEPALIVE.as_bytes()).await.is_err() || w.flush().await.is_err() {
                        break 'run gone();
                    }
                }
            }
        }
    };
    let _ = w.shutdown().await;
    conn.finish(closed.code, &closed.reason);
    closed
}
