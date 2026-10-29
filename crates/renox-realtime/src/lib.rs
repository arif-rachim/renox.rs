//! `renox-realtime`: a tenant's realtime connections, owned by Rust in the
//! tenant's cell (`docs/09-htmx-realtime.md`, ADR D9; `docs/contracts/ops.md`
//! 1.5.0 section 18; #278).
//!
//! - [`Hub`]: connections with tenant and user caps, topics, fan-out
//!   through a bounded queue per connection (a slow consumer is closed with
//!   1008; `publish` never waits), the outbound message limit, the replay
//!   buffer for `Last-Event-ID`, and the [`Counters`] the meter needs.
//! - [`ws`]: the WebSocket transport over any `AsyncRead + AsyncWrite`:
//!   frames, the inbound size limit (1009), the flood limit (1008),
//!   heartbeats (ping every 30 s, pong within 10 s, else 1001).
//! - [`sse`]: the event-stream encoder and transport: `retry`, `id`,
//!   `event`, `data`, keep-alive comments.
//!
//! The isolate never runs during fan-out: the cell runs `open`, `message`,
//! and `close` and calls the hub from the ops.

mod hub;
pub mod sse;
pub mod ws;

use std::time::Duration;

pub use hub::{
    Closed, Conn, ConnInfo, Counters, Event, FREE_CONNECTIONS, Hub, LimitReason, Outbound,
    PAID_CONNECTIONS, RealtimeError, Transport, close, valid_topic,
};

/// The limits of `ops.md` 1.5.0 section 18. The connection caps, the
/// 64 KB messages, and the 256-message queue are `docs/04` values; the
/// topics, inbound rate, heartbeat, and replay numbers are *proposed*
/// (Open 15).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    pub tenant_connections: usize,
    pub user_connections: usize,
    pub topics_per_connection: usize,
    pub max_inbound_bytes: usize,
    pub max_outbound_bytes: usize,
    pub queue: usize,
    pub inbound_per_second: u32,
    pub ping_every: Duration,
    pub pong_timeout: Duration,
    pub sse_keepalive: Duration,
    pub replay_events: usize,
    pub replay_window: Duration,
}

impl Limits {
    /// The free tier.
    pub fn free() -> Limits {
        Limits {
            tenant_connections: FREE_CONNECTIONS,
            user_connections: 10,
            topics_per_connection: 64,
            max_inbound_bytes: 64 * 1024,
            max_outbound_bytes: 64 * 1024,
            queue: 256,
            inbound_per_second: 100,
            ping_every: Duration::from_secs(30),
            pong_timeout: Duration::from_secs(10),
            sse_keepalive: Duration::from_secs(15),
            replay_events: 100,
            replay_window: Duration::from_secs(60),
        }
    }

    /// The paid tiers: 10,000 connections per tenant.
    pub fn paid() -> Limits {
        Limits {
            tenant_connections: PAID_CONNECTIONS,
            ..Limits::free()
        }
    }
}

impl Default for Limits {
    fn default() -> Self {
        Limits::free()
    }
}

/// What a handler sends (`ops.md` section 18, `RealtimePayload`), after the
/// cell has rendered a `fragment`: text, JSON (sent as its text), or HTML.
/// `event` names the SSE event; a WebSocket ignores it.
#[derive(Debug, Clone, PartialEq)]
pub enum Payload {
    Text {
        text: String,
        event: Option<String>,
    },
    Json {
        json: serde_json::Value,
        event: Option<String>,
    },
    Html {
        html: String,
        event: Option<String>,
    },
}

impl Payload {
    pub fn text(s: impl Into<String>) -> Payload {
        Payload::Text {
            text: s.into(),
            event: None,
        }
    }

    pub fn json(v: serde_json::Value) -> Payload {
        Payload::Json {
            json: v,
            event: None,
        }
    }

    pub fn html(s: impl Into<String>) -> Payload {
        Payload::Html {
            html: s.into(),
            event: None,
        }
    }

    pub fn with_event(self, name: impl Into<String>) -> Payload {
        let e = Some(name.into());
        match self {
            Payload::Text { text, .. } => Payload::Text { text, event: e },
            Payload::Json { json, .. } => Payload::Json { json, event: e },
            Payload::Html { html, .. } => Payload::Html { html, event: e },
        }
    }

    /// The text on the wire and the event name.
    pub fn into_parts(self) -> (String, Option<String>) {
        match self {
            Payload::Text { text, event } => (text, event),
            Payload::Json { json, event } => (json.to_string(), event),
            Payload::Html { html, event } => (html, event),
        }
    }
}
