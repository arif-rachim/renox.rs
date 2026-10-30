//! Controlled mode (#55): the worker registers with the control plane,
//! heartbeats, follows the control-message stream, and takes its routes,
//! tiers, artifacts and secrets from it; meters and logs go back over HTTP
//! (`docs/contracts/deploy-api.md` sections 7-11, `docs/03-architecture.md`).
//!
//! The request path never waits on the control plane: routes are applied to
//! the gateway's table in memory, artifacts are cached on disk, and meters
//! and logs are queued. What the worker does while the control plane is
//! unreachable is #98 (degraded mode).
//!
//! | Piece | File |
//! | --- | --- |
//! | HTTP client, node token | [`http`] |
//! | Route snapshots and deltas | [`routes`] |
//! | Secret bundles ([`crate::cell::SecretsSource`]) | [`secrets`] |
//! | Tenant logs ([`renox_runtime::LogSink`]) | [`log_sink`] |
//! | `GET /healthz` | [`health`] |
//! | Degraded mode: route snapshot file, 503 for uncached cold starts | [`degraded`] |
//! | Meter and log spool | [`crate::spool`] |
//! | `prepare` before activation (#96) | [`prepare`], [`crate::health_probe`] |
//! | Meters ([`renox_meter::BatchPoster`]) | [`MeterPoster`] |
//! | Artifacts | [`crate::artifact_s3`] |

pub mod degraded;
pub mod health;
pub mod http;
pub mod log_sink;
pub mod node_listener;
pub mod prepare;
pub mod routes;
pub mod secrets;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use ::http::{HeaderValue, Method, StatusCode, header};
use bytes::{Buf, BytesMut};
use http_body_util::BodyExt;
use renox_meter::BatchPoster;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use self::health::Health;
use self::http::{CALL_TIMEOUT, ControlClient, ControlError};
use self::routes::{Delta, RouteState, Snapshot};
use crate::manager::CellManager;

/// A node that sees nothing on its stream for this long reconnects (section 7).
pub const STREAM_IDLE: Duration = Duration::from_secs(45);
/// Reconnect backoff: from 1 s, doubling, at most 30 s (section 7).
pub const BACKOFF_MIN: Duration = Duration::from_secs(1);
pub const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// One control message (one SSE event) is at most this long.
const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;

/// `node_registered` (`$defs/node_registered`).
#[derive(Debug, Clone, Deserialize)]
pub struct Registered {
    pub heartbeat_interval_ms: u64,
    pub unhealthy_after_ms: u64,
    pub resync_interval_ms: u64,
    pub route_version: u64,
    /// 0.3: the bearer the control plane presents on the node listener.
    #[serde(default)]
    pub callback_token: Option<String>,
}

/// What the stream delivered that is not a route message: `prepare` (#96)
/// and certificate messages (#59).
pub type MessageHandler = Arc<dyn Fn(Value) + Send + Sync>;

/// [`BatchPoster`] for `POST /v1/ingest/meters`.
#[derive(Clone)]
pub struct MeterPoster {
    pub client: ControlClient,
}

impl BatchPoster for MeterPoster {
    async fn post(&self, body: Vec<u8>) -> Result<u16, String> {
        self.client
            .send(
                Method::POST,
                "/v1/ingest/meters",
                Some(body),
                &[],
                CALL_TIMEOUT,
            )
            .await
            .map(|a| a.status.as_u16())
            .map_err(|e| e.to_string())
    }
}

/// The control-plane side of a running controlled worker.
pub struct Controller {
    pub client: ControlClient,
    pub routes: Arc<RouteState>,
    pub health: Arc<Health>,
    /// Region and capacity sent at registration.
    region: String,
    max_cells: u32,
    manager: CellManager,
    /// Set once a registration succeeded since the last reconnect.
    registered: AtomicBool,
    /// Wakes the stream loop to re-register (a heartbeat got 409).
    reregister: Notify,
    /// Wakes the stream loop to fetch a snapshot now.
    resync: Notify,
    /// `resync_interval_ms` from the last registration (#97).
    resync_every: AtomicU64,
    others: std::sync::Mutex<Option<MessageHandler>>,
    tasks: std::sync::Mutex<Vec<JoinHandle<()>>>,
    /// The node listener's URL announced at registration and the callback
    /// token it accepts (deploy-api.md 0.3 section 15).
    node_listener: std::sync::Mutex<Option<(String, Arc<node_listener::CallbackToken>)>>,
    /// The data directory's disk level, sent on every heartbeat (deploy API
    /// 0.4 section 7, #311).
    disk: std::sync::Mutex<Option<crate::disk::DiskMonitor>>,
}

/// The heartbeat's `disk` (deploy API 0.4 section 7, `control-messages.schema.json`):
/// the node's four levels as the contract's three, with the watermark crossed.
pub fn heartbeat_disk(d: &crate::disk::DiskMonitor) -> serde_json::Value {
    use crate::disk::Level;
    let (level, watermark) = match d.level() {
        Level::Ok => ("ok", serde_json::Value::Null),
        Level::Warn => ("warn", 80.into()),
        Level::StopScheduling => ("critical", 90.into()),
        Level::RefuseWrites => ("critical", 95.into()),
    };
    json!({ "level": level, "free_bytes": d.available_bytes(), "watermark": watermark })
}

impl Controller {
    pub fn new(
        client: ControlClient,
        routes: Arc<RouteState>,
        health: Arc<Health>,
        manager: CellManager,
        region: &str,
        max_cells: u32,
    ) -> Arc<Controller> {
        Arc::new(Controller {
            client,
            routes,
            health,
            region: region.to_string(),
            max_cells,
            manager,
            registered: AtomicBool::new(false),
            reregister: Notify::new(),
            resync: Notify::new(),
            resync_every: AtomicU64::new(60_000),
            others: std::sync::Mutex::new(None),
            tasks: std::sync::Mutex::new(Vec::new()),
            node_listener: std::sync::Mutex::new(None),
            disk: std::sync::Mutex::new(None),
        })
    }

    /// Report this disk monitor's level on every heartbeat (#311).
    pub fn set_disk(&self, disk: crate::disk::DiskMonitor) {
        *self.disk.lock().expect("controller lock") = Some(disk);
    }

    /// Announce the node listener at `url` at every registration and keep
    /// the callback token the answer carries in `token`.
    pub fn set_node_listener(&self, url: String, token: Arc<node_listener::CallbackToken>) {
        *self.node_listener.lock().expect("controller lock") = Some((url, token));
    }

    /// Where `prepare` and certificate messages go.
    pub fn on_message(&self, handler: MessageHandler) {
        *self.others.lock().expect("controller lock") = Some(handler);
    }

    /// Whether the node is registered with the control plane right now.
    pub fn is_registered(&self) -> bool {
        self.registered.load(Ordering::SeqCst)
    }

    /// Starts the stream loop (registration, snapshot, stream) and the
    /// heartbeat. Neither blocks the gateway.
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        let stream = tokio::spawn(async move { me.stream_loop().await });
        self.tasks.lock().expect("controller lock").push(stream);
    }

    pub fn stop(&self) {
        for t in self.tasks.lock().expect("controller lock").drain(..) {
            t.abort();
        }
    }

    /// `POST /v1/nodes/register`.
    pub async fn register(&self) -> Result<Registered, ControlError> {
        let listener = self.node_listener.lock().expect("controller lock").clone();
        let mut body = json!({
            "type": "node_register",
            "schema_version": 0,
            "node_id": self.client.node_id(),
            "worker_version": env!("CARGO_PKG_VERSION"),
            "region": self.region,
            "max_cells": self.max_cells,
        });
        if let Some((url, _)) = &listener {
            body["listen_url"] = json!(url);
        }
        let a = self.client.post_json("/v1/nodes/register", &body).await?;
        if a.status != StatusCode::OK {
            return Err(ControlError::Status(a.status.as_u16()));
        }
        let reg: Registered = a.json().await?;
        if let Some((_, token)) = &listener {
            token.set(reg.callback_token.clone());
        }
        Ok(reg)
    }

    /// `GET /v1/nodes/{node_id}/routes`, applied. `conditional` sends
    /// `If-None-Match: "<table version>"` (the periodic resync of #97): a
    /// 304 means the table is current and costs one small request. After a
    /// gap or a `resync` the fetch is unconditional, since the table version
    /// can match while a lost change is missing.
    pub async fn fetch_snapshot(&self, conditional: bool) -> Result<u64, ControlError> {
        let ours = self.routes.version();
        let etag = [(
            header::IF_NONE_MATCH,
            HeaderValue::from_str(&format!("\"{ours}\"")).expect("digits"),
        )];
        let extra: &[(header::HeaderName, HeaderValue)] = if conditional { &etag } else { &[] };
        let a = self
            .client
            .send(
                Method::GET,
                &self.client.node_path("/routes"),
                None,
                extra,
                CALL_TIMEOUT,
            )
            .await?;
        match a.status {
            StatusCode::NOT_MODIFIED if conditional => Ok(ours),
            StatusCode::OK => {
                let snap: Snapshot = a.json().await?;
                let version = snap.version;
                self.routes.apply_snapshot(snap);
                Ok(version)
            }
            s => Err(ControlError::Status(s.as_u16())),
        }
    }

    async fn stream_loop(self: Arc<Self>) {
        let mut backoff = BACKOFF_MIN;
        let mut heartbeat: Option<JoinHandle<()>> = None;
        loop {
            self.registered.store(false, Ordering::SeqCst);
            let result = async {
                let reg = self.register().await?;
                self.registered.store(true, Ordering::SeqCst);
                self.resync_every
                    .store(reg.resync_interval_ms.max(1000), Ordering::SeqCst);
                if let Some(h) = heartbeat.take() {
                    h.abort();
                }
                heartbeat =
                    Some(self.clone().spawn_heartbeat(Duration::from_millis(
                        reg.heartbeat_interval_ms.max(1000),
                    )));
                self.fetch_snapshot(false).await?;
                self.health.recover("control_plane");
                self.follow_stream(&mut backoff).await
            }
            .await;
            match result {
                Ok(()) => tracing::info!("control stream ended; reconnecting"),
                Err(e) => {
                    if e.is_unreachable() {
                        self.health.degrade("control_plane", e.to_string());
                    }
                    tracing::warn!(error = %e, retry_in_ms = backoff.as_millis() as u64, "control plane");
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
    }

    /// Reads the SSE stream until it ends, idles for [`STREAM_IDLE`], or a
    /// re-registration is asked for.
    async fn follow_stream(&self, backoff: &mut Duration) -> Result<(), ControlError> {
        let accept = [(
            header::ACCEPT,
            HeaderValue::from_static("text/event-stream"),
        )];
        let answer = self
            .client
            .send(
                Method::GET,
                &self.client.node_path("/stream"),
                None,
                &accept,
                CALL_TIMEOUT,
            )
            .await?;
        if answer.status != StatusCode::OK {
            return Err(ControlError::Status(answer.status.as_u16()));
        }
        *backoff = BACKOFF_MIN;
        let mut body = answer.body;
        let mut buf = BytesMut::new();
        let every = Duration::from_millis(self.resync_every.load(Ordering::SeqCst));
        let mut periodic = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
        loop {
            let frame = tokio::select! {
                f = tokio::time::timeout(STREAM_IDLE, body.frame()) => f,
                _ = self.reregister.notified() => return Ok(()),
                _ = self.resync.notified() => {
                    self.fetch_snapshot(false).await?;
                    continue;
                }
                // Section 8 rule 3: a lost delta is repaired within one interval.
                _ = periodic.tick() => {
                    self.fetch_snapshot(true).await?;
                    continue;
                }
            };
            let frame = match frame {
                Err(_) => return Err(ControlError::Unreachable("stream idle".into())),
                Ok(None) => return Ok(()),
                Ok(Some(Err(e))) => return Err(ControlError::Unreachable(e.to_string())),
                Ok(Some(Ok(f))) => f,
            };
            let Some(data) = frame.data_ref() else {
                continue;
            };
            buf.extend_from_slice(data);
            while let Some(end) = find_event_end(&buf) {
                let event = buf.split_to(end.0);
                buf.advance(end.1);
                if let Some(message) = event_data(&event) {
                    self.handle(message).await?;
                }
            }
            if buf.len() > MAX_EVENT_BYTES {
                return Err(ControlError::Body("control event over its size cap".into()));
            }
        }
    }

    async fn handle(&self, data: String) -> Result<(), ControlError> {
        let message: Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "control message is not JSON; ignored");
                return Ok(());
            }
        };
        match message.get("type").and_then(Value::as_str) {
            Some("resync") => {
                self.fetch_snapshot(false).await?;
            }
            Some("route_delta") => match serde_json::from_value::<Delta>(message) {
                Ok(delta) => {
                    if !self.routes.apply_delta(delta) {
                        tracing::info!("route version gap; fetching a snapshot");
                        self.fetch_snapshot(false).await?;
                    }
                }
                Err(e) => tracing::warn!(error = %e, "route_delta refused"),
            },
            Some(_) => {
                let handler = self.others.lock().expect("controller lock").clone();
                match handler {
                    Some(h) => h(message),
                    None => tracing::debug!("control message without a handler; ignored"),
                }
            }
            None => tracing::warn!("control message without a type; ignored"),
        }
        Ok(())
    }

    fn spawn_heartbeat(self: Arc<Self>, every: Duration) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(every);
            tick.tick().await;
            loop {
                tick.tick().await;
                // `sent_at` is required by control-messages.schema.json: without
                // it the control plane refused every heartbeat with 400, so a
                // node counted as healthy only until 30 s after it registered
                // (found by the chaos run of batch F67-ALL).
                let sent_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let mut body = json!({
                    "type": "heartbeat",
                    "schema_version": 0,
                    "node_id": self.client.node_id(),
                    "sent_at": sent_at,
                    "route_version": self.routes.version(),
                    "cells": self.manager.cell_count(),
                });
                let disk = self.disk.lock().expect("controller lock").clone();
                if let (Some(d), Some(obj)) = (disk, body.as_object_mut()) {
                    obj.insert("disk".into(), heartbeat_disk(&d));
                }
                match self
                    .client
                    .post_json(&self.client.node_path("/heartbeat"), &body)
                    .await
                {
                    Ok(a) if a.status == StatusCode::OK => {
                        self.health.recover("control_plane");
                        let ack: Result<Value, _> = a.json().await;
                        let theirs = ack
                            .ok()
                            .and_then(|v| v.get("route_version").and_then(Value::as_u64));
                        if theirs.is_some_and(|v| v > self.routes.version()) {
                            self.resync.notify_one();
                        }
                    }
                    // Section 7: an unknown node registers again.
                    Ok(a) if a.status == StatusCode::CONFLICT => self.reregister.notify_one(),
                    Ok(a) => tracing::warn!(status = a.status.as_u16(), "heartbeat refused"),
                    Err(e) => {
                        self.health.degrade("control_plane", e.to_string());
                        tracing::warn!(error = %e, "heartbeat failed");
                    }
                }
            }
        })
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The end of the first SSE event in `buf`: (event length, separator length).
fn find_event_end(buf: &[u8]) -> Option<(usize, usize)> {
    let lf = buf.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2));
    let crlf = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| (i, 4));
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (a, b) => a.or(b),
    }
}

/// The joined `data:` lines of one event; `None` for a comment-only event.
fn event_data(event: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(event).ok()?;
    let lines: Vec<&str> = text
        .lines()
        .filter_map(|l| l.strip_prefix("data:"))
        .map(|l| l.strip_prefix(' ').unwrap_or(l))
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// `ctx.ai` in gateway mode (#322; deploy-api.md 0.5 section 23): the
/// request goes to the control plane's `POST /v1/ai/chat` with the node
/// token; the provider keys never reach the node.
pub struct AiForward {
    pub client: ControlClient,
}

impl renox_runtime::ops::ai::AiGateway for AiForward {
    fn chat(
        &self,
        body: String,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<String, renox_runtime::ops::ai::GatewayError>>
                + Send,
        >,
    > {
        use renox_runtime::ops::ai::GatewayError;
        let client = self.client.clone();
        Box::pin(async move {
            let answer = client
                .send(
                    ::http::Method::POST,
                    "/v1/ai/chat",
                    Some(body.into_bytes()),
                    &[],
                    std::time::Duration::from_secs(60),
                )
                .await
                .map_err(|e| GatewayError::Unavailable(e.to_string()))?;
            let status = answer.status.as_u16();
            let bytes = answer
                .bytes(4 * 1024 * 1024)
                .await
                .map_err(|e| GatewayError::Unavailable(e.to_string()))?;
            match status {
                200 => Ok(String::from_utf8_lossy(&bytes).into_owned()),
                429 => Err(GatewayError::Quota),
                400 => Err(GatewayError::Invalid(
                    "the gateway refused the request".into(),
                )),
                s => Err(GatewayError::Unavailable(format!("gateway answered {s}"))),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    /// #311 (deploy API 0.4 section 7): the node's four disk levels are the
    /// heartbeat's three, with the watermark crossed and the free bytes.
    #[test]
    fn the_heartbeat_disk_names_the_level_and_the_watermark() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let used = std::sync::Arc::new(AtomicU64::new(10));
        let u = used.clone();
        let d = crate::disk::DiskMonitor::with_probe(
            std::path::Path::new("/data"),
            crate::disk::Watermarks::default(),
            None,
            Box::new(move || {
                let pct = u.load(Ordering::SeqCst);
                Ok(crate::disk::Usage {
                    total: 100_000,
                    available: 100_000 - pct * 1000,
                })
            }),
        );
        let at = |pct: u64| {
            used.store(pct, Ordering::SeqCst);
            d.poll();
            heartbeat_disk(&d)
        };
        assert_eq!(
            at(10),
            json!({ "level": "ok", "free_bytes": 90_000, "watermark": null })
        );
        assert_eq!(
            at(82),
            json!({ "level": "warn", "free_bytes": 18_000, "watermark": 80 })
        );
        assert_eq!(
            at(91),
            json!({ "level": "critical", "free_bytes": 9_000, "watermark": 90 })
        );
        assert_eq!(
            at(96),
            json!({ "level": "critical", "free_bytes": 4_000, "watermark": 95 })
        );
    }

    use super::*;

    #[test]
    fn sse_events_are_split_and_comments_skipped() {
        let raw = b": keep-alive\n\nevent: message\ndata: {\"type\":\"resync\"}\n\npartial";
        let (end, sep) = find_event_end(raw).unwrap();
        assert_eq!(event_data(&raw[..end]), None);
        let rest = &raw[end + sep..];
        let (end, _) = find_event_end(rest).unwrap();
        assert_eq!(
            event_data(&rest[..end]).as_deref(),
            Some("{\"type\":\"resync\"}")
        );
        assert!(find_event_end(b"data: x\n").is_none());
    }
}
