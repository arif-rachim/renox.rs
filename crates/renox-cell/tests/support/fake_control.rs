//! A minimal control plane for worker tests that must run in CI's rust job,
//! which has neither Postgres nor Bun (`support/control_stack.rs` needs
//! both). It speaks the node side of `docs/contracts/deploy-api.md`
//! sections 6-10 with plain HTTP/1.1 (`Connection: close`): registration,
//! heartbeats, the route snapshot, the SSE stream, artifacts, prepare
//! results, and the ingest endpoints. Tests set its state
//! and push messages onto the stream; it records every request line.

#![allow(dead_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

#[derive(Default)]
pub struct State {
    /// `$defs/route_snapshot` entries and version.
    pub route_version: u64,
    pub entries: Vec<Value>,
    /// hash → tar bytes.
    pub artifacts: HashMap<String, Vec<u8>>,
    pub prepare_results: Vec<Value>,
    pub registrations: Vec<Value>,
    pub heartbeats: Vec<Value>,
    /// `<METHOD> <path>` of every request.
    pub requests: Vec<String>,
}

#[derive(Clone)]
pub struct FakeControl {
    pub addr: SocketAddr,
    pub state: Arc<Mutex<State>>,
    events: broadcast::Sender<Option<String>>,
}

impl FakeControl {
    pub async fn start() -> FakeControl {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (events, _) = broadcast::channel(64);
        let me = FakeControl {
            addr,
            state: Arc::new(Mutex::new(State::default())),
            events,
        };
        let server = me.clone();
        tokio::spawn(async move {
            loop {
                let Ok((s, _)) = listener.accept().await else {
                    continue;
                };
                let server = server.clone();
                tokio::spawn(async move {
                    let _ = server.serve(s).await;
                });
            }
        });
        me
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Sends one control message to every open stream.
    pub fn send(&self, message: Value) {
        let _ = self.events.send(Some(message.to_string()));
    }

    /// Ends every open stream: the nodes reconnect.
    pub fn drop_streams(&self) {
        let _ = self.events.send(None);
    }

    pub fn requests(&self) -> Vec<String> {
        self.state.lock().unwrap().requests.clone()
    }

    async fn serve(&self, mut s: TcpStream) -> std::io::Result<()> {
        let mut buf = Vec::new();
        let head_end = loop {
            let mut chunk = [0u8; 4096];
            let n = s.read(&mut chunk).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i;
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let mut lines = head.lines();
        let request_line = lines.next().unwrap_or_default().to_string();
        let mut parts = request_line.split(' ');
        let method = parts.next().unwrap_or_default().to_string();
        let path = parts.next().unwrap_or_default().to_string();
        let length: usize = lines
            .filter_map(|l| l.split_once(':'))
            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.trim().parse().ok())
            .unwrap_or(0);
        let mut body = buf[head_end + 4..].to_vec();
        while body.len() < length {
            let mut chunk = [0u8; 4096];
            let n = s.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
        }
        let json_body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        self.state
            .lock()
            .unwrap()
            .requests
            .push(format!("{method} {path}"));
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let (status, content_type, payload): (u16, &str, Vec<u8>) =
            match (method.as_str(), segments.as_slice()) {
                ("POST", ["v1", "nodes", "register"]) => {
                    let mut st = self.state.lock().unwrap();
                    st.registrations.push(json_body);
                    let reply = json!({
                        "type": "node_registered", "schema_version": 0,
                        "heartbeat_interval_ms": 1000, "unhealthy_after_ms": 30000,
                        "resync_interval_ms": 60000, "route_version": st.route_version,
                    });
                    (200, "application/json", reply.to_string().into_bytes())
                }
                ("POST", ["v1", "nodes", _, "heartbeat"]) => {
                    let mut st = self.state.lock().unwrap();
                    st.heartbeats.push(json_body);
                    let reply = json!({ "route_version": st.route_version });
                    (200, "application/json", reply.to_string().into_bytes())
                }
                ("GET", ["v1", "nodes", _, "routes"]) => {
                    let st = self.state.lock().unwrap();
                    let reply = json!({
                        "type": "route_snapshot", "schema_version": 0,
                        "version": st.route_version, "entries": st.entries,
                    });
                    (200, "application/json", reply.to_string().into_bytes())
                }
                ("GET", ["v1", "nodes", _, "stream"]) => return self.stream(s).await,
                ("GET", ["v1", "nodes", _, "artifacts", hash]) => {
                    match self.state.lock().unwrap().artifacts.get(*hash) {
                        Some(t) => (200, "application/x-tar", t.clone()),
                        None => (404, "application/json", b"{}".to_vec()),
                    }
                }
                ("POST", ["v1", "nodes", _, "prepare-results"]) => {
                    self.state.lock().unwrap().prepare_results.push(json_body);
                    (200, "application/json", b"{}".to_vec())
                }
                ("POST", ["v1", "ingest", _]) => (202, "application/json", b"{}".to_vec()),
                _ => (404, "application/json", b"{}".to_vec()),
            };
        let head = format!(
            "HTTP/1.1 {status} X\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n",
            payload.len()
        );
        s.write_all(head.as_bytes()).await?;
        s.write_all(&payload).await?;
        s.shutdown().await
    }

    /// `resync` first, then every message sent, a keep-alive every 10 s.
    async fn stream(&self, mut s: TcpStream) -> std::io::Result<()> {
        let mut rx = self.events.subscribe();
        s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\nconnection: close\r\n\r\n")
            .await?;
        let version = self.state.lock().unwrap().route_version;
        let first = json!({ "type": "resync", "schema_version": 0, "route_version": version });
        s.write_all(format!("event: message\ndata: {first}\n\n").as_bytes())
            .await?;
        loop {
            tokio::select! {
                m = rx.recv() => match m {
                    Ok(Some(data)) => s.write_all(format!("event: message\ndata: {data}\n\n").as_bytes()).await?,
                    Ok(None) | Err(broadcast::error::RecvError::Closed) => return s.shutdown().await,
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                },
                _ = tokio::time::sleep(Duration::from_secs(10)) => s.write_all(b": keep-alive\n\n").await?,
            }
        }
    }
}

/// A `route_entry` for node `node_id`.
pub fn entry(
    hostname: &str,
    tenant_id: &str,
    app: &str,
    hash: &str,
    node_id: &str,
    version: u64,
) -> Value {
    json!({
        "hostname": hostname, "tenant_id": tenant_id, "app": app,
        "deployment_hash": hash, "status": "active", "updated_at": 1,
        "version": version, "tier": "paid", "node_id": node_id, "secrets_version": 0,
    })
}
