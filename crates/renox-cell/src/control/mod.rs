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
//! | Meters ([`renox_meter::BatchPoster`]) | [`MeterPoster`] |
//! | Artifacts | [`crate::artifact_s3`] |

pub mod degraded;
pub mod health;
pub mod http;
pub mod log_sink;
pub mod routes;
pub mod secrets;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
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
    others: std::sync::Mutex<Option<MessageHandler>>,
    tasks: std::sync::Mutex<Vec<JoinHandle<()>>>,
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
            others: std::sync::Mutex::new(None),
            tasks: std::sync::Mutex::new(Vec::new()),
        })
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
        let body = json!({
            "type": "node_register",
            "schema_version": 0,
            "node_id": self.client.node_id(),
            "worker_version": env!("CARGO_PKG_VERSION"),
            "region": self.region,
            "max_cells": self.max_cells,
        });
        let a = self.client.post_json("/v1/nodes/register", &body).await?;
        if a.status != StatusCode::OK {
            return Err(ControlError::Status(a.status.as_u16()));
        }
        a.json().await
    }

    /// `GET /v1/nodes/{node_id}/routes`, applied.
    pub async fn fetch_snapshot(&self) -> Result<u64, ControlError> {
        let snap: Snapshot = self
            .client
            .get_json(&self.client.node_path("/routes"))
            .await?;
        let version = snap.version;
        self.routes.apply_snapshot(snap);
        Ok(version)
    }

    async fn stream_loop(self: Arc<Self>) {
        let mut backoff = BACKOFF_MIN;
        let mut heartbeat: Option<JoinHandle<()>> = None;
        loop {
            self.registered.store(false, Ordering::SeqCst);
            let result = async {
                let reg = self.register().await?;
                self.registered.store(true, Ordering::SeqCst);
                if let Some(h) = heartbeat.take() {
                    h.abort();
                }
                heartbeat =
                    Some(self.clone().spawn_heartbeat(Duration::from_millis(
                        reg.heartbeat_interval_ms.max(1000),
                    )));
                self.fetch_snapshot().await?;
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
        loop {
            let frame = tokio::select! {
                f = tokio::time::timeout(STREAM_IDLE, body.frame()) => f,
                _ = self.reregister.notified() => return Ok(()),
                _ = self.resync.notified() => {
                    self.fetch_snapshot().await?;
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
                self.fetch_snapshot().await?;
            }
            Some("route_delta") => match serde_json::from_value::<Delta>(message) {
                Ok(delta) => {
                    if !self.routes.apply_delta(delta) {
                        self.fetch_snapshot().await?;
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
                let body = json!({
                    "type": "heartbeat",
                    "schema_version": 0,
                    "node_id": self.client.node_id(),
                    "route_version": self.routes.version(),
                    "cells": self.manager.cell_count(),
                });
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

#[cfg(test)]
mod tests {
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
