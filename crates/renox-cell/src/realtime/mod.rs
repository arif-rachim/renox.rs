//! Realtime in the cell (#281; `docs/contracts/ops.md` 1.5.0 section 18).
//!
//! A `ws` or `sse` route is served here, not by the page or function path:
//!
//! 1. **Connect.** The isolate runs the realtime prelude only (phase
//!    `connect`): the principal from the session cookie (section 17) and
//!    the route's `guard`. A deny is 403 and nothing is upgraded.
//! 2. **Caps.** The hub accepts the connection or refuses it over the
//!    tenant or per-user cap: 503 `RENOX_REALTIME_LIMIT`, `Retry-After: 5`,
//!    a meter record with `status: busy`.
//! 3. **Handshake.** `101` (WebSocket, the gateway's [`WsUpgrade`]) or `200
//!    text/event-stream` (SSE); then `open` runs with the connection, each
//!    inbound frame runs `message`, and the end runs `close`. The handler
//!    runs use the principal resolved at connect, never one from a message.
//! 4. **Fan-out** never enters the isolate: `ctx.realtime.publish` queues
//!    the message on every subscribed connection in the hub
//!    ([`CellRealtime`] is the runtime's [`RealtimeHost`]); a `fragment`
//!    payload is rendered here, off the isolate thread.
//! 5. **Meter.** One record per connection at its end: `WS <pattern>` or
//!    `SSE <pattern>`, the handler runs summed, `realtime_conn_seconds` and
//!    `realtime_messages` (frames received plus messages delivered).
//!
//! The connection holds the cell in flight, so the cell is not evicted
//! while a connection is open.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use bytes::Bytes;
use http::{Request, Response, StatusCode, header};
use renox_gateway::RequestCtx;
use renox_gateway::upgrade::WsUpgrade;
use renox_meter::{MeterRecord, MeterStatus};
use renox_realtime::{ConnInfo, Hub, LimitReason, Payload, RealtimeError, Transport, sse, ws};
use renox_runtime::error::{ErrorCode, PlatformResponse};
use renox_runtime::isolate::{InvocationMeter, RealtimeRoute};
use renox_runtime::ops::realtime::{
    RealtimeCall, RealtimeData, RealtimeHost, RealtimeOutcome, RealtimePhase, RealtimeResult,
    RtError, RtFuture, RtPayload, RtRender,
};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

use crate::cell::Cell;
use crate::render::SharedPages;

/// The runtime's realtime host for one deployment: its hub, and the
/// templates a `fragment` payload is rendered with.
pub struct CellRealtime {
    pub hub: Arc<Hub>,
    pages: Option<SharedPages>,
}

impl std::fmt::Debug for CellRealtime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CellRealtime")
            .field("counters", &self.hub.snapshot())
            .finish_non_exhaustive()
    }
}

fn hub_error(e: RealtimeError) -> RtError {
    let reason = match e {
        RealtimeError::Limit(r) => r.as_str(),
        RealtimeError::Forbidden => "forbidden",
        RealtimeError::BadTopic => "topic",
    };
    RtError {
        code: e.code(),
        details: serde_json::json!({ "reason": reason }),
        message: format!("realtime: refused ({reason})"),
    }
}

impl CellRealtime {
    pub fn new(hub: Arc<Hub>, pages: Option<SharedPages>) -> Arc<CellRealtime> {
        Arc::new(CellRealtime { hub, pages })
    }

    /// A payload as the hub sends it; a `fragment` is rendered on the
    /// blocking pool under the render limits.
    async fn payload(&self, p: RtPayload) -> Result<(Payload, RtRender), RtError> {
        match p {
            RtPayload::Text { text, event } => {
                let p = Payload::text(text);
                Ok((
                    match event {
                        Some(e) => p.with_event(e),
                        None => p,
                    },
                    RtRender::default(),
                ))
            }
            RtPayload::Fragment {
                fragment,
                data,
                module,
                event,
            } => {
                let Some(pages) = self.pages.clone() else {
                    return Err(unknown_fragment(&fragment));
                };
                let id = partial_id(&fragment, &module);
                let rendered =
                    tokio::task::spawn_blocking(move || pages.render_partial(&id, &data))
                        .await
                        .map_err(|_| unknown_fragment(&fragment))?;
                let (html, fuel, ms) = rendered.map_err(|e| match e {
                    crate::render::PartialError::Unknown => unknown_fragment(&fragment),
                    crate::render::PartialError::Limit(limit) => RtError {
                        code: "RENOX_RENDER_LIMIT",
                        details: serde_json::json!({ "limit": limit }),
                        message: "realtime: the fragment hit a render limit".into(),
                    },
                    crate::render::PartialError::Failed(m) => RtError {
                        code: "RENOX_INTERNAL",
                        details: serde_json::json!({ "fragment": fragment, "reason": m }),
                        message: "realtime: the fragment could not be rendered".into(),
                    },
                })?;
                let p = Payload::html(html);
                Ok((
                    match event {
                        Some(e) => p.with_event(e),
                        None => p,
                    },
                    RtRender { fuel, ms },
                ))
            }
        }
    }
}

fn unknown_fragment(fragment: &str) -> RtError {
    RtError {
        code: "RENOX_INTERNAL",
        details: serde_json::json!({ "fragment": fragment, "reason": "unknown_fragment" }),
        message: format!("realtime: no partial template `{fragment}`"),
    }
}

/// `partials/chat-message.html` of module `chat` is the template id
/// `modules/chat/partials/chat-message`; the app's has no prefix.
pub fn partial_id(fragment: &str, module: &str) -> String {
    let f = fragment.strip_suffix(".html").unwrap_or(fragment);
    let f = f.trim_start_matches('/');
    if module == "app" || module.is_empty() {
        f.to_string()
    } else {
        let prefix = format!("modules/{module}/");
        if f.starts_with(&prefix) {
            f.to_string()
        } else {
            format!("{prefix}{f}")
        }
    }
}

impl RealtimeHost for CellRealtime {
    fn subscribe(&self, conn: &str, topic: &str) -> Result<(), RtError> {
        self.hub.subscribe(conn, topic, true).map_err(hub_error)
    }

    fn unsubscribe(&self, conn: &str, topic: &str) {
        self.hub.unsubscribe(conn, topic);
    }

    fn publish(&self, topic: &str, payload: RtPayload) -> RtFuture<(usize, RtRender)> {
        let hub = self.hub.clone();
        let topic = topic.to_string();
        let this = CellRealtime {
            hub: self.hub.clone(),
            pages: self.pages.clone(),
        };
        Box::pin(async move {
            let (p, render) = this.payload(payload).await?;
            let n = hub.publish(&topic, p).map_err(hub_error)?;
            Ok((n, render))
        })
    }

    fn send(&self, conn: &str, payload: RtPayload) -> RtFuture<RtRender> {
        let hub = self.hub.clone();
        let conn = conn.to_string();
        let this = CellRealtime {
            hub: self.hub.clone(),
            pages: self.pages.clone(),
        };
        Box::pin(async move {
            let (p, render) = this.payload(payload).await?;
            hub.send(&conn, p).map_err(hub_error)?;
            Ok(render)
        })
    }

    fn close(&self, conn: &str, code: u16, reason: &str) {
        self.hub.close(conn, code, reason);
    }
}

/// What a connection's handler runs used, summed for its one record.
#[derive(Debug, Default)]
struct Usage {
    cpu_ms: f64,
    peak_heap_bytes: u64,
    fetch_sent_bytes: u64,
    fetch_received_bytes: u64,
    fetch_blocked: u64,
    db_ms: f64,
    db_rows: u64,
    logs_dropped: u64,
    authz_evals: u64,
    render_fuel: u64,
    render_ms: f64,
}

impl Usage {
    fn add(&mut self, m: &InvocationMeter) {
        self.cpu_ms += m.cpu_ms;
        self.peak_heap_bytes = self.peak_heap_bytes.max(m.peak_heap_bytes);
        self.fetch_sent_bytes += m.fetch_sent_bytes;
        self.fetch_received_bytes += m.fetch_received_bytes;
        self.fetch_blocked += m.fetch_blocked;
        self.db_ms += m.db_ms;
        self.db_rows += m.db_rows;
        self.logs_dropped += m.logs_dropped;
        self.authz_evals += m.authz_evals;
        self.render_fuel += m.render_fuel;
        self.render_ms += m.render_ms;
    }
}

/// One connection's context, shared by its handler runs.
struct Session {
    cell: Arc<Cell>,
    ctx: RequestCtx,
    route: RealtimeRoute,
    parts: http::request::Parts,
    session: String,
    principal: Option<Arc<renox_authz::Principal>>,
    /// The wall-clock budget of one handler run.
    wall: Duration,
    usage: Usage,
}

impl Session {
    /// Runs one phase in the isolate.
    async fn run(
        &mut self,
        phase: RealtimePhase,
        conn: &str,
        data: Option<RealtimeData>,
        close: Option<(u16, String)>,
    ) -> (
        RealtimeResult,
        Option<Arc<renox_authz::Principal>>,
        http::StatusCode,
    ) {
        let mut req = Request::builder()
            .method(http::Method::GET)
            .uri(self.parts.uri.clone())
            .body(Bytes::new())
            .expect("valid request");
        *req.headers_mut() = self.parts.headers.clone();
        req.extensions_mut().insert(RealtimeCall {
            phase,
            conn: conn.to_string(),
            transport: self.route.transport,
            session: self.session.clone(),
            data,
            close,
            principal: self.principal.clone(),
        });
        let rt_ctx = renox_runtime::RequestCtx {
            request_id: self.ctx.request_id.clone(),
            deadline: Instant::now() + self.wall,
        };
        let out = self.cell.isolate.dispatch(rt_ctx, req).await;
        self.usage.add(&out.meter);
        let status = out.response.status();
        match out.response.extensions().get::<RealtimeOutcome>() {
            Some(o) => (o.result, o.principal.clone(), status),
            None if status == StatusCode::FORBIDDEN => (RealtimeResult::Forbidden, None, status),
            None => (RealtimeResult::Threw, None, status),
        }
    }
}

/// Serves a `ws` or `sse` route (module doc, steps 1 to 5).
pub(crate) async fn serve(
    manager: &crate::CellManager,
    cell: Arc<Cell>,
    ctx: RequestCtx,
    mut parts: http::request::Parts,
    route: RealtimeRoute,
    session: String,
) -> Response<Body> {
    let t0 = Instant::now();
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let meter_route = format!(
        "{} {}",
        match route.transport {
            Transport::Ws => "WS",
            Transport::Sse => "SSE",
        },
        route.pattern
    );
    let allow_get = || {
        Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "GET")
            .body(Body::empty())
            .expect("valid response")
    };
    if parts.method != http::Method::GET {
        return allow_get();
    }
    let upgrade = match route.transport {
        Transport::Ws => match parts.extensions.remove::<WsUpgrade>() {
            Some(u) => Some(u),
            None => return allow_get(),
        },
        Transport::Sse => {
            let accepts = parts
                .headers
                .get(header::ACCEPT)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|a| a.contains("text/event-stream"));
            if !accepts {
                return allow_get();
            }
            None
        }
    };
    let Some(host) = cell.realtime.clone() else {
        return to_body(PlatformResponse::error(
            ErrorCode::Internal,
            &ctx.request_id,
        ));
    };
    let wall = ctx
        .deadline
        .saturating_duration_since(t0)
        .max(Duration::from_secs(1));
    let mut s = Session {
        cell: cell.clone(),
        ctx: ctx.clone(),
        route: route.clone(),
        parts: parts.clone(),
        session,
        principal: None,
        wall,
        usage: Usage::default(),
    };
    let record = move |m: &crate::CellManager,
                       s: &Session,
                       status: MeterStatus,
                       http_status: u16,
                       conn: Option<(f64, u64)>,
                       ingress: u64| {
        m.record_realtime(MeterRecord {
            request_id: s.ctx.request_id.clone(),
            tenant_id: s.ctx.tenant_id.clone(),
            deployment_hash: s.ctx.deployment_hash.clone(),
            route: meter_route.clone(),
            started_at,
            cpu_ms: (s.usage.cpu_ms * 1000.0).round() / 1000.0,
            wall_ms: t0.elapsed().as_secs_f64() * 1000.0,
            peak_heap_bytes: s.usage.peak_heap_bytes,
            ingress_bytes: ingress,
            egress_bytes: 0,
            fetch_sent_bytes: s.usage.fetch_sent_bytes,
            fetch_received_bytes: s.usage.fetch_received_bytes,
            fetch_blocked: s.usage.fetch_blocked,
            db_ms: (s.usage.db_ms * 1000.0).round() / 1000.0,
            db_rows: s.usage.db_rows,
            render_fuel: s.usage.render_fuel,
            render_ms: (s.usage.render_fuel > 0).then_some(s.usage.render_ms),
            logs_dropped: s.usage.logs_dropped,
            http_status,
            status,
            kind: None,
            authz_evals: Some(s.usage.authz_evals).filter(|n| *n > 0),
            realtime_conn_seconds: conn.map(|(secs, _)| (secs * 1000.0).round() / 1000.0),
            realtime_messages: conn.map(|(_, n)| n),
        });
    };

    // 1. Connect: principal and guard, before any handshake.
    let (result, principal, status) = s.run(RealtimePhase::Connect, "", None, None).await;
    match result {
        RealtimeResult::Ok => {}
        RealtimeResult::Forbidden => {
            record(manager, &s, MeterStatus::Forbidden, 403, None, 0);
            return to_body(PlatformResponse::error(
                ErrorCode::Forbidden,
                &ctx.request_id,
            ));
        }
        _ => {
            record(manager, &s, MeterStatus::Error, status.as_u16(), None, 0);
            return to_body(PlatformResponse::error(
                ErrorCode::Internal,
                &ctx.request_id,
            ));
        }
    }
    s.principal = principal;

    // 2. Caps.
    let user = match s.principal.as_deref() {
        Some(p) if p.kind != renox_authz::PrincipalKind::Anonymous => p.id.clone(),
        _ => format!("ip:{}", ctx.client_ip),
    };
    let last_event_id = sse::last_event_id(
        parts
            .headers
            .get("last-event-id")
            .and_then(|v| v.to_str().ok()),
    );
    let mut conn = match host.hub.connect(ConnInfo {
        user,
        transport: route.transport,
        last_event_id,
    }) {
        Ok(c) => c,
        Err(e) => {
            record(manager, &s, MeterStatus::Busy, 503, None, 0);
            let reason = match &e {
                RealtimeError::Limit(r) => r.as_str(),
                _ => LimitReason::Tenant.as_str(),
            };
            // ops.md 1.5.0 section 18, "Limits": 503, `Retry-After: 5`.
            let body = serde_json::json!({ "error": {
                "code": "RENOX_REALTIME_LIMIT",
                "request_id": ctx.request_id,
                "message": "Too many realtime connections. Try again shortly.",
                "details": { "reason": reason },
            }});
            return Response::builder()
                .status(StatusCode::SERVICE_UNAVAILABLE)
                .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
                .header(header::CACHE_CONTROL, "no-store")
                .header(header::RETRY_AFTER, "5")
                .header("x-renox-request-id", ctx.request_id.as_str())
                .body(Body::from(body.to_string()))
                .expect("valid response");
        }
    };
    let conn_id = conn.id.clone();

    // Delivered messages are counted on their way to the transport.
    let delivered = Arc::new(AtomicU64::new(0));
    let (count_tx, count_rx) = mpsc::channel(host.hub.limits().queue);
    let mut hub_rx = std::mem::replace(&mut conn.rx, count_rx);
    let counter = delivered.clone();
    tokio::spawn(async move {
        while let Some(m) = hub_rx.recv().await {
            counter.fetch_add(1, Ordering::Relaxed);
            if count_tx.send(m).await.is_err() {
                break;
            }
        }
    });

    // The connection keeps the cell in flight until it ends.
    let held = crate::manager::OwnedInFlight::take(&cell);
    let manager = manager.clone();
    match route.transport {
        Transport::Ws => {
            let upgrade = upgrade.expect("checked above");
            let response = upgrade.accept();
            tokio::spawn(async move {
                let _held = held;
                let Some(io) = upgrade.upgraded().await else {
                    conn.finish(1006, "handshake");
                    drop(conn);
                    record(&manager, &s, MeterStatus::Ok, 101, Some((0.0, 0)), 0);
                    return;
                };
                let (in_tx, mut in_rx) = mpsc::channel::<ws::Inbound>(16);
                let opened = Instant::now();
                let hub = host.hub.clone();
                let serve = tokio::spawn(ws::serve(io, conn, in_tx));
                // 3. open, then one `message` run per inbound frame, in order.
                let (open, _, _) = s.run(RealtimePhase::Open, &conn_id, None, None).await;
                let mut status = MeterStatus::Ok;
                match open {
                    RealtimeResult::Ok | RealtimeResult::NoHandler => {}
                    RealtimeResult::Forbidden => hub.close(&conn_id, 1008, "forbidden"),
                    RealtimeResult::Threw => {
                        status = MeterStatus::Error;
                        hub.close(&conn_id, 1011, "open failed");
                    }
                }
                let mut received = 0u64;
                let mut ingress = 0u64;
                let mut has_message = true;
                while let Some(m) = in_rx.recv().await {
                    received += 1;
                    let data = match m {
                        ws::Inbound::Text(t) => {
                            ingress += t.len() as u64;
                            RealtimeData::Text(t)
                        }
                        ws::Inbound::Binary(b) => {
                            ingress += b.len() as u64;
                            RealtimeData::Binary(b)
                        }
                    };
                    if has_message {
                        let (r, _, _) = s
                            .run(RealtimePhase::Message, &conn_id, Some(data), None)
                            .await;
                        has_message = r != RealtimeResult::NoHandler;
                    }
                }
                let closed = serve.await.unwrap_or(renox_realtime::Closed {
                    code: 1011,
                    reason: "transport".into(),
                });
                let _ = s
                    .run(
                        RealtimePhase::Close,
                        &conn_id,
                        None,
                        Some((closed.code, closed.reason.clone())),
                    )
                    .await;
                let lifetime = opened.elapsed().as_secs_f64();
                let messages = received + delivered.load(Ordering::Relaxed);
                record(
                    &manager,
                    &s,
                    status,
                    101,
                    Some((lifetime, messages)),
                    ingress,
                );
            });
            response
        }
        Transport::Sse => {
            let (body_tx, body) = crate::manager::ChannelBody::channel();
            let (w, mut r) = tokio::io::duplex(16 * 1024);
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8 * 1024];
                loop {
                    match r.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if body_tx
                                .send(Ok(Bytes::copy_from_slice(&buf[..n])))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                    }
                }
            });
            tokio::spawn(async move {
                let _held = held;
                let opened = Instant::now();
                let hub = host.hub.clone();
                let serve = tokio::spawn(sse::serve(w, conn));
                let (open, _, _) = s.run(RealtimePhase::Open, &conn_id, None, None).await;
                let mut status = MeterStatus::Ok;
                match open {
                    RealtimeResult::Ok | RealtimeResult::NoHandler => {}
                    RealtimeResult::Forbidden => hub.close(&conn_id, 1008, "forbidden"),
                    RealtimeResult::Threw => {
                        status = MeterStatus::Error;
                        hub.close(&conn_id, 1011, "open failed");
                    }
                }
                let closed = serve.await.unwrap_or(renox_realtime::Closed {
                    code: 1011,
                    reason: "transport".into(),
                });
                let _ = s
                    .run(
                        RealtimePhase::Close,
                        &conn_id,
                        None,
                        Some((closed.code, closed.reason.clone())),
                    )
                    .await;
                let lifetime = opened.elapsed().as_secs_f64();
                record(
                    &manager,
                    &s,
                    status,
                    200,
                    Some((lifetime, delivered.load(Ordering::Relaxed))),
                    0,
                );
            });
            parts.extensions.clear();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/event-stream")
                .header(header::CACHE_CONTROL, "no-store")
                .header("x-accel-buffering", "no")
                .body(Body::new(body))
                .expect("valid response")
        }
    }
}

fn to_body(r: Response<Bytes>) -> Response<Body> {
    r.map(Body::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_ids() {
        assert_eq!(
            partial_id("partials/chat-message.html", "app"),
            "partials/chat-message"
        );
        assert_eq!(
            partial_id("partials/item", "chat"),
            "modules/chat/partials/item"
        );
        assert_eq!(
            partial_id("modules/chat/partials/item", "chat"),
            "modules/chat/partials/item"
        );
    }
}
