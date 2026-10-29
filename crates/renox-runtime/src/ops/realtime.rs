//! `op_realtime_*` (`docs/contracts/ops.md` 1.5.0 section 18; #281).
//!
//! The connections live in the cell (`renox-realtime`'s hub); the isolate
//! reaches them only through a [`RealtimeHost`] the cell puts in the
//! deployment's [`RealtimeSlot`]. `subscribe` is checked first: the Cedar
//! action `realtime.subscribe` on `Renox::Topic::"<topic>"` with the
//! request's principal, fail closed (no slot, no engine, no permit: deny).
//! `publish` and `send` are not policy-checked (server code decided). A
//! `fragment` payload is rendered by the host off the isolate thread.
//!
//! The pure part compiles without V8; the ops are behind the `v8` feature.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, RwLock};

use serde::Deserialize;

/// A payload as the bootstrap serialised it (`ops.schema.json`
/// `$defs/realtimePayload`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum RtPayload {
    /// A string, `{ text }`, or `{ json }` (as its `JSON.stringify` text).
    Text { text: String, event: Option<String> },
    /// `{ fragment, data }`: a `partial` template of `module` (`app` or a
    /// module name) with `data` as JSON text.
    Fragment {
        fragment: String,
        data: String,
        module: String,
        event: Option<String>,
    },
}

/// A refusal of the host: `code` is `RENOX_REALTIME_LIMIT`,
/// `RENOX_REALTIME_BACKPRESSURE`, or `RENOX_RENDER_LIMIT`; `details` its
/// `details` object.
#[derive(Debug, Clone, PartialEq)]
pub struct RtError {
    pub code: &'static str,
    pub details: serde_json::Value,
    pub message: String,
}

/// What the publishing invocation used to render a `fragment` payload.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct RtRender {
    pub fuel: u64,
    pub ms: f64,
}

pub type RtFuture<T> = Pin<Box<dyn Future<Output = Result<T, RtError>> + Send>>;

/// The cell's side of the ops: one per deployment.
pub trait RealtimeHost: Send + Sync {
    /// Called after the op's `realtime.subscribe` check allowed it; an
    /// unknown or closed `conn` is ignored.
    fn subscribe(&self, conn: &str, topic: &str) -> Result<(), RtError>;
    fn unsubscribe(&self, conn: &str, topic: &str);
    /// The connections the message was queued for, and what rendering a
    /// fragment cost.
    fn publish(&self, topic: &str, payload: RtPayload) -> RtFuture<(usize, RtRender)>;
    fn send(&self, conn: &str, payload: RtPayload) -> RtFuture<RtRender>;
    fn close(&self, conn: &str, code: u16, reason: &str);
}

/// The deployment's slot, filled by the cell when the cell is created.
/// Empty: every op is a no-op answer (`publish` reaches 0 connections)
/// except `subscribe`, which is refused.
pub type RealtimeSlot = Arc<RwLock<Option<Arc<dyn RealtimeHost>>>>;

pub fn new_slot() -> RealtimeSlot {
    Arc::new(RwLock::new(None))
}

/// The phase of a realtime dispatch (`ops.schema.json`
/// `$defs/realtime_dispatch`), plus `connect`: the prelude alone (principal
/// and `guard`) before the handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimePhase {
    Connect,
    Open,
    Message,
    Close,
}

impl RealtimePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            RealtimePhase::Connect => "connect",
            RealtimePhase::Open => "open",
            RealtimePhase::Message => "message",
            RealtimePhase::Close => "close",
        }
    }
}

/// One inbound frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RealtimeData {
    Text(String),
    Binary(Vec<u8>),
}

/// A realtime dispatch, as a request extension: the cell builds a `GET`
/// of the route's URL with the upgrade request's headers and this.
#[derive(Debug, Clone)]
pub struct RealtimeCall {
    pub phase: RealtimePhase,
    /// The hub's connection id (empty for `connect`).
    pub conn: String,
    pub transport: renox_realtime::Transport,
    /// The platform page session id (`ctx.session.id`), empty without one.
    pub session: String,
    pub data: Option<RealtimeData>,
    /// `close`: the code and reason.
    pub close: Option<(u16, String)>,
    /// The principal resolved at `connect`; `None` for `connect` itself.
    pub principal: Option<std::sync::Arc<renox_authz::Principal>>,
}

/// How a realtime run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimeResult {
    Ok,
    /// The module has no handler for the phase; the cell skips it.
    NoHandler,
    Threw,
    /// The guard denied (`connect`) or the handler threw `RENOX_FORBIDDEN`.
    Forbidden,
}

/// In the response extensions of a realtime dispatch.
#[derive(Debug, Clone)]
pub struct RealtimeOutcome {
    pub result: RealtimeResult,
    /// The request's principal (what `connect` resolved).
    pub principal: Option<std::sync::Arc<renox_authz::Principal>>,
}

/// `ops.md` section 18: a topic is at most 256 characters of segments
/// `[A-Za-z0-9_.-]+` split on `:`.
pub fn valid_topic(topic: &str) -> bool {
    !topic.is_empty()
        && topic.len() <= 256
        && topic.split(':').all(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        })
}

#[cfg(feature = "v8")]
pub(crate) use v8_ops::*;

#[cfg(feature = "v8")]
mod v8_ops {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use deno_core::{OpState, op2};
    use deno_error::JsErrorBox;
    use renox_authz::{PlatformContext, Principal};

    use super::*;
    use crate::ops::authz::AuthzSlot;
    use crate::ops::request::{RequestState, live_request, op_error};

    /// The realtime environment of one isolate (op state).
    pub(crate) struct RealtimeEnv {
        pub slot: RealtimeSlot,
        pub authz: AuthzSlot,
    }

    fn host(state: &Rc<RefCell<OpState>>) -> (Option<Arc<dyn RealtimeHost>>, AuthzSlot) {
        let s = state.borrow();
        let env = s.borrow::<Rc<RealtimeEnv>>();
        (
            env.slot.read().ok().and_then(|h| h.clone()),
            env.authz.clone(),
        )
    }

    fn rt_error(e: RtError) -> JsErrorBox {
        op_error(e.code, e.details, &e.message)
    }

    fn principal_of(r: &RequestState) -> Principal {
        r.authz
            .principal
            .as_deref()
            .cloned()
            .unwrap_or_else(Principal::anonymous)
    }

    fn bad_topic() -> JsErrorBox {
        JsErrorBox::range_error(
            "realtime: a topic is 1 to 256 characters of segments [A-Za-z0-9_.-] split on ':'",
        )
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// `ctx.realtime.subscribe(conn, topic)`: the `realtime.subscribe`
    /// check with the request's principal (one `authz_evals`), then the
    /// hub. A deny rejects with `RENOX_FORBIDDEN`.
    #[op2(fast)]
    pub(crate) fn op_realtime_subscribe(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] conn: &str,
        #[string] topic: &str,
    ) -> Result<(), JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        if !valid_topic(topic) {
            return Err(bad_topic());
        }
        let (host, authz) = host(&state);
        let engine = authz.read().ok().and_then(|s| s.clone());
        let allow = {
            let mut r = request.borrow_mut();
            r.authz.evals += 1;
            let over = r.authz.evals > crate::ops::authz::MAX_EVALS;
            match engine {
                Some(st) if !over => {
                    st.decisions
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let platform = PlatformContext {
                        now_ms: now_ms(),
                        request: None,
                    };
                    st.engine
                        .check_topic(&principal_of(&r), topic, &platform)
                        .allow
                }
                _ => false,
            }
        };
        if !allow {
            return Err(op_error(
                "RENOX_FORBIDDEN",
                serde_json::json!({
                    "action": "realtime.subscribe",
                    "resource": { "type": "Topic", "id": topic },
                    "reason": "deny",
                }),
                "You are not allowed to do this.",
            ));
        }
        match host {
            Some(h) => h.subscribe(conn, topic).map_err(rt_error),
            None => Ok(()),
        }
    }

    #[op2(fast)]
    pub(crate) fn op_realtime_unsubscribe(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] conn: &str,
        #[string] topic: &str,
    ) -> Result<(), JsErrorBox> {
        live_request(&state.borrow(), token)?;
        if let (Some(h), _) = host(&state) {
            h.unsubscribe(conn, topic);
        }
        Ok(())
    }

    /// Adds a fragment render to the request's meter (`render_fuel`,
    /// `render_ms` of the publishing invocation).
    fn add_render(request: &Rc<RefCell<RequestState>>, r: RtRender) {
        let mut req = request.borrow_mut();
        req.render_fuel += r.fuel;
        req.render_ms += r.ms;
    }

    /// `ctx.realtime.publish(topic, payload)`: the number of connections
    /// the message was queued for.
    #[op2]
    #[number]
    pub(crate) async fn op_realtime_publish(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] topic: String,
        #[serde] payload: RtPayload,
    ) -> Result<u64, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        if !valid_topic(&topic) {
            return Err(bad_topic());
        }
        let Some(h) = host(&state).0 else {
            return Ok(0);
        };
        let (n, render) = h.publish(&topic, payload).await.map_err(rt_error)?;
        add_render(&request, render);
        Ok(n as u64)
    }

    #[op2]
    pub(crate) async fn op_realtime_send(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] conn: String,
        #[serde] payload: RtPayload,
    ) -> Result<(), JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let Some(h) = host(&state).0 else {
            return Ok(());
        };
        let render = h.send(&conn, payload).await.map_err(rt_error)?;
        add_render(&request, render);
        Ok(())
    }

    #[op2(fast)]
    pub(crate) fn op_realtime_close(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] conn: &str,
        code: u32,
        #[string] reason: &str,
    ) -> Result<(), JsErrorBox> {
        live_request(&state.borrow(), token)?;
        // RFC 6455: application codes are 1000 or 3000-4999.
        let code = match code {
            1000 | 3000..=4999 => code as u16,
            _ => {
                return Err(JsErrorBox::range_error(
                    "realtime.close: code is 1000 or 3000-4999",
                ));
            }
        };
        if let (Some(h), _) = host(&state) {
            let reason: String = reason.chars().take(123).collect();
            h.close(conn, code, &reason);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics() {
        assert!(valid_topic("room:42"));
        assert!(valid_topic("user:u_1:inbox"));
        assert!(!valid_topic(""));
        assert!(!valid_topic("room::1"));
        assert!(!valid_topic("room 1"));
        assert!(!valid_topic(&"a".repeat(257)));
    }

    #[test]
    fn payload_wire_shape() {
        let p: RtPayload =
            serde_json::from_str(r#"{"kind":"text","text":"hi","event":null}"#).unwrap();
        assert_eq!(
            p,
            RtPayload::Text {
                text: "hi".into(),
                event: None
            }
        );
        let p: RtPayload = serde_json::from_str(
            r#"{"kind":"fragment","fragment":"partials/msg","data":"{}","module":"app","event":"m"}"#,
        )
        .unwrap();
        assert!(matches!(p, RtPayload::Fragment { .. }));
    }
}
