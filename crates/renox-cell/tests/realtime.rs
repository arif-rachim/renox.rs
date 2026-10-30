//! Issue #281 end to end in the cell (V8-linked): `ws` and `sse` routes,
//! `open` / `message` / `close` in the isolate, `ctx.realtime` ops, the
//! `realtime.subscribe` policy check, fan-out without the isolate, the caps,
//! the inbound frame limit, and the connection's meter record
//! (`docs/contracts/ops.md` 1.5.0 section 18).
//!
//! The WebSocket handshake goes through a minimal hyper server here that
//! does what the gateway does (`renox_gateway::upgrade`); the gateway path
//! itself is `crates/renox-gateway/tests/upgrade.rs`.
//!
//! Proves `docs/23-failure-modes.md` F5 "WebSocket message flood / oversized
//! frame" (1009 end to end) and `docs/24-threat-model.md` "Realtime fan-out
//! amplification" (caps refuse the upgrade; a publish reaches subscribers
//! without entering the isolate).

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::BodyExt;
use renox_cell::cell::LocalSecrets;
use renox_cell::manager::StaticTiers;
use renox_cell::pages::PlatformKey;
use renox_cell::{CellManager, LocalArtifactStore, ManagerConfig, TierName, Tiers};
use renox_gateway::upgrade::{WsUpgrade, is_ws_request, refusal};
use renox_gateway::{CellDispatcher, RequestCtx};
use renox_meter::{Meter, MeterBatch, MeterConfig, MeterRecord, Sink, SinkError};
use renox_runtime::{Runtime, RuntimeConfig};
use renox_template::{CompileOptions, Compiler, TemplateProject};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-realtime-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const AUTH: &str = r#"
export async function principal(ctx) {
  const m = /(?:^|;\s*)uid=([a-z_0-9]+)/.exec(ctx.headers.get("cookie") ?? "");
  return m ? { id: m[1], attrs: { org: "o_1" } } : null;
}
"#;

const CHAT: &str = r#"
export const ws = {
  async open(ctx) {
    await ctx.realtime.subscribe(ctx.conn, "room:" + ctx.params.room);
    await ctx.realtime.send(ctx.conn, "welcome " + (ctx.principal?.id ?? "anon"));
  },
  async message(ctx) {
    if (ctx.data === "boom") throw new Error("message failed");
    await ctx.realtime.publish("room:" + ctx.params.room, { fragment: "partials/msg", data: { text: ctx.data } });
  },
  async close(ctx) {
    await ctx.db.execute("insert into app__closes (conn, code) values (?, ?)", [ctx.conn.id, ctx.close.code]);
  },
};
"#;

const SPY: &str = r#"
export const ws = {
  async open(ctx) {
    await ctx.realtime.subscribe(ctx.conn, "user:u_bob:inbox");
  },
};
"#;

const GUARDED: &str = r#"
export const ws = { async open(ctx) { await ctx.realtime.send(ctx.conn, "in"); } };
"#;

const FEED: &str = r#"
export const sse = {
  async open(ctx) { await ctx.realtime.subscribe(ctx.conn, "room:1"); },
};
"#;

const PUBLISH: &str = r#"
export async function POST(ctx) {
  const n = await ctx.realtime.publish("room:1", { text: "from action", event: "note" });
  return Response.json({ n });
}
"#;

const POLICIES: &str = r#"
permit (principal, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "room:*" };
permit (principal is Renox::User, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "user:*:inbox" && resource.segments.contains(principal.id) };
permit (principal in Renox::Role::"moderator", action == Renox::Action::"room.join", resource);
"#;

fn sha(s: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn auth_module() -> serde_json::Value {
    let perms = serde_json::json!({ "tables": "auth__*", "network": [], "secrets": [], "slots": [], "hooks": [] });
    serde_json::json!({
        "name": "auth", "version": "1.0.0", "hash": "0".repeat(64), "source": "path:modules/auth",
        "mount": "/auth", "isolation": "shared", "dependencies": [], "config": {},
        "permissions": perms, "approved": perms, "exports": { "services": ["principal"] },
    })
}

fn artifact(store: &Path) -> String {
    let mut project = TemplateProject::new();
    project.insert("partials/msg.html", r#"<p class="msg">{{ text }}</p>"#);
    let compiled = Compiler::new(CompileOptions::default())
        .compile(&project)
        .unwrap_or_else(|d| panic!("{d:?}"));
    let tmp = scratch("artifact");
    for (rel, src) in compiled.files() {
        let p = tmp.join("templates").join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let code = [
        ("functions/ws/chat/[room]", CHAT),
        ("functions/ws/spy", SPY),
        ("functions/ws/guarded", GUARDED),
        ("functions/sse/feed", FEED),
        ("functions/publish", PUBLISH),
        ("modules/auth/services", AUTH),
    ];
    for (id, src) in &code {
        let p = tmp.join("code").join(format!("{id}.js"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let sql = "create table app__closes (conn text, code integer);\n";
    std::fs::create_dir_all(tmp.join("migrations/app")).unwrap();
    std::fs::write(tmp.join("migrations/app/001_init.sql"), sql).unwrap();
    std::fs::write(
        tmp.join("migrations/checksums.json"),
        serde_json::json!({ "version": 0, "files": { "app/001_init.sql": sha(sql) } }).to_string(),
    )
    .unwrap();
    std::fs::create_dir_all(tmp.join("policies/app")).unwrap();
    std::fs::write(tmp.join("policies/app/default.cedar"), POLICIES).unwrap();
    let entry: BTreeMap<String, String> = code
        .iter()
        .map(|(id, _)| (id.to_string(), format!("{id}.js")))
        .collect();
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "chat", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": entry },
        "routes": [
            { "kind": "ws", "path": "/ws/chat/:room", "module": "functions/ws/chat/[room]" },
            { "kind": "ws", "path": "/ws/spy", "module": "functions/ws/spy" },
            { "kind": "ws", "path": "/ws/guarded", "module": "functions/ws/guarded", "guard": { "action": "room.join" } },
            { "kind": "sse", "path": "/sse/feed", "module": "functions/sse/feed" },
            { "kind": "function", "method": "POST", "path": "/publish", "module": "functions/publish", "export": "POST" },
        ],
        "templates": compiled.manifest_entries(),
        "permissions": { "network": [], "secrets": [] },
        "authz": { "actions": ["room.join"] },
        "security": { "cors": { "origins": ["https://partner.example"], "credentials": true } },
        "modules": [auth_module()],
    });
    std::fs::write(
        tmp.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let hash = renox_runtime::manifest::content_hash(&tmp).unwrap();
    let dst = store.join(&hash);
    std::fs::rename(&tmp, &dst).unwrap();
    hash
}

/// The meter records, as the batching task hands them over.
#[derive(Clone, Default)]
struct Records(Arc<Mutex<Vec<MeterRecord>>>);

impl Sink for Records {
    async fn write_batch(&self, batch: &MeterBatch) -> Result<(), SinkError> {
        self.0.lock().unwrap().extend(batch.records.iter().cloned());
        Ok(())
    }
}

impl Records {
    fn all(&self) -> Vec<MeterRecord> {
        self.0.lock().unwrap().clone()
    }

    async fn wait_for(&self, what: &str, f: impl Fn(&MeterRecord) -> bool) -> MeterRecord {
        let t0 = Instant::now();
        loop {
            if let Some(r) = self.all().into_iter().find(&f) {
                return r;
            }
            assert!(t0.elapsed() < Duration::from_secs(10), "no record: {what}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

struct Node {
    manager: CellManager,
    hash: String,
    data: PathBuf,
    records: Records,
    addr: SocketAddr,
}

/// A hyper server that does the gateway's part of the handshake and hands
/// every request to the cell.
async fn node() -> Node {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let data = scratch("data");
    let artifacts = scratch("artifacts");
    let hash = artifact(&artifacts);
    let records = Records::default();
    let mut config = MeterConfig::new("t_rt@test", "test", &data);
    config.flush_interval = Duration::from_millis(20);
    let meter = Meter::start(config, records.clone());
    let manager = CellManager::new(
        Runtime::new(RuntimeConfig::default()),
        meter,
        ManagerConfig {
            data_dir: data.clone(),
            artifacts: Arc::new(LocalArtifactStore::new(&artifacts)),
            idle_timeout: Duration::from_secs(600),
            tiers: Tiers::default(),
            deployments: Arc::new(StaticTiers {
                default_tier: TierName::Free,
                tenant_tiers: BTreeMap::new(),
            }),
            secrets: Arc::new(LocalSecrets {
                data_dir: data.clone(),
            }),
            platform_key: PlatformKey::random(),
        },
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (m, h) = (manager.clone(), hash.clone());
    tokio::spawn(async move {
        loop {
            let Ok((stream, peer)) = listener.accept().await else {
                return;
            };
            let (m, h) = (m.clone(), h.clone());
            tokio::spawn(async move {
                let svc =
                    hyper::service::service_fn(move |req: http::Request<hyper::body::Incoming>| {
                        let (m, h) = (m.clone(), h.clone());
                        async move {
                            let mut req = req.map(axum::body::Body::new);
                            if is_ws_request(&req) {
                                match WsUpgrade::from_request(&mut req) {
                                    Ok(u) => {
                                        req.extensions_mut().insert(u);
                                    }
                                    Err(e) => return Ok::<_, Infallible>(refusal(e)),
                                }
                            }
                            let ctx = RequestCtx {
                                tenant_id: "t_rt".into(),
                                deployment_hash: h,
                                request_id: format!("req_{}", N.fetch_add(1, Ordering::SeqCst)),
                                deadline: Instant::now() + Duration::from_secs(30),
                                client_ip: peer.ip(),
                                csp_nonce: "n".into(),
                            };
                            Ok::<_, Infallible>(m.dispatch(ctx, req).await)
                        }
                    });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), svc)
                    .with_upgrades()
                    .await;
            });
        }
    });
    Node {
        manager,
        hash,
        data,
        records,
        addr,
    }
}

impl Node {
    /// A request straight to the cell (no network).
    async fn send(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
    ) -> http::Response<axum::body::Body> {
        let ctx = RequestCtx {
            tenant_id: "t_rt".into(),
            deployment_hash: self.hash.clone(),
            request_id: format!("req_{}", N.fetch_add(1, Ordering::SeqCst)),
            deadline: Instant::now() + Duration::from_secs(30),
            client_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            csp_nonce: "n".into(),
        };
        let mut b = http::Request::builder()
            .method(method)
            .uri(format!("https://chat.renox.app{path}"))
            .header("host", "chat.renox.app");
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        self.manager
            .dispatch(ctx, b.body(axum::body::Body::empty()).unwrap())
            .await
    }

    async fn publish(&self) -> u64 {
        let res = self.send("POST", "/publish", &[]).await;
        assert_eq!(res.status(), 200);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        v["n"].as_u64().unwrap()
    }

    fn closes(&self) -> Vec<(String, i64)> {
        let db = renox_data::TenantDb::open(
            self.data.join("t_rt").join("app.db"),
            renox_data::DbOptions::default(),
        )
        .unwrap();
        db.query("select conn, code from app__closes", &[])
            .unwrap()
            .iter()
            .map(|r| match (r.get("conn"), r.get("code")) {
                (Some(renox_data::Value::Text(c)), Some(renox_data::Value::Integer(n))) => {
                    (c.clone(), *n)
                }
                other => panic!("{other:?}"),
            })
            .collect()
    }
}

/// A minimal WebSocket client: masked client frames, unmasked server frames.
struct Ws {
    s: TcpStream,
    buf: Vec<u8>,
}

impl Ws {
    /// A same-origin browser upgrade. `Err((status, head))` when the
    /// server did not switch protocols.
    async fn connect(
        addr: SocketAddr,
        path: &str,
        cookie: Option<&str>,
    ) -> Result<Ws, (u16, String)> {
        Ws::connect_from(addr, path, cookie, Some("https://chat.renox.app")).await
    }

    /// An upgrade with the given `Origin` header (none when `None`).
    async fn connect_from(
        addr: SocketAddr,
        path: &str,
        cookie: Option<&str>,
        origin: Option<&str>,
    ) -> Result<Ws, (u16, String)> {
        let mut s = TcpStream::connect(addr).await.unwrap();
        let cookie = cookie
            .map(|c| format!("Cookie: {c}\r\n"))
            .unwrap_or_default();
        let origin = origin
            .map(|o| format!("Origin: {o}\r\n"))
            .unwrap_or_default();
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: chat.renox.app\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n{origin}{cookie}\r\n"
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let head_end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
            let mut chunk = [0u8; 4096];
            let n = tokio::time::timeout(Duration::from_secs(10), s.read(&mut chunk))
                .await
                .expect("handshake answer")
                .unwrap();
            assert!(
                n > 0,
                "closed during the handshake: {}",
                String::from_utf8_lossy(&buf)
            );
            buf.extend_from_slice(&chunk[..n]);
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let status: u16 = head[9..12].parse().unwrap();
        if status != 101 {
            return Err((status, head));
        }
        assert!(
            head.to_ascii_lowercase()
                .contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo="),
            "{head}"
        );
        Ok(Ws {
            s,
            buf: buf[head_end..].to_vec(),
        })
    }

    async fn send_frame(&mut self, opcode: u8, payload: &[u8]) {
        let mask = [0x11u8, 0x22, 0x33, 0x44];
        let mut f = vec![0x80 | opcode];
        match payload.len() {
            n if n < 126 => f.push(0x80 | n as u8),
            n if n < 65536 => {
                f.push(0x80 | 126);
                f.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                f.push(0x80 | 127);
                f.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        f.extend_from_slice(&mask);
        f.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        let _ = self.s.write_all(&f).await;
    }

    async fn text(&mut self, t: &str) {
        self.send_frame(0x1, t.as_bytes()).await;
    }

    async fn fill(&mut self, n: usize) -> bool {
        while self.buf.len() < n {
            let mut chunk = [0u8; 8192];
            match tokio::time::timeout(Duration::from_secs(10), self.s.read(&mut chunk)).await {
                Ok(Ok(0)) | Ok(Err(_)) => return false,
                Ok(Ok(k)) => self.buf.extend_from_slice(&chunk[..k]),
                Err(_) => panic!("no frame within 10 s"),
            }
        }
        true
    }

    /// The next data or close frame: `(opcode, payload)`; pings are skipped.
    async fn next(&mut self) -> Option<(u8, Vec<u8>)> {
        loop {
            if !self.fill(2).await {
                return None;
            }
            let opcode = self.buf[0] & 0x0f;
            let (len, at) = match self.buf[1] & 0x7f {
                126 => {
                    self.fill(4).await;
                    (u16::from_be_bytes([self.buf[2], self.buf[3]]) as usize, 4)
                }
                127 => {
                    self.fill(10).await;
                    (
                        u64::from_be_bytes(self.buf[2..10].try_into().unwrap()) as usize,
                        10,
                    )
                }
                n => (n as usize, 2),
            };
            if !self.fill(at + len).await {
                return None;
            }
            let payload = self.buf[at..at + len].to_vec();
            self.buf.drain(..at + len);
            if opcode == 0x9 || opcode == 0xA {
                continue;
            }
            return Some((opcode, payload));
        }
    }

    async fn next_text(&mut self) -> String {
        let (op, p) = self.next().await.expect("a frame");
        assert_eq!(
            op,
            0x1,
            "text frame, got {op} {:?}",
            String::from_utf8_lossy(&p)
        );
        String::from_utf8(p).unwrap()
    }

    /// Waits for the close frame; its code.
    async fn close_code(&mut self) -> u16 {
        loop {
            match self.next().await {
                Some((0x8, p)) if p.len() >= 2 => return u16::from_be_bytes([p[0], p[1]]),
                Some((0x8, _)) => return 1005,
                Some(_) => continue,
                None => return 1006,
            }
        }
    }
}

/// `open` subscribes and sends, `message` publishes a `fragment` rendered by
/// the cell, `close` runs with the close code; one meter record per
/// connection with the realtime fields.
#[tokio::test]
async fn ws_round_trip_with_open_message_close() {
    let n = node().await;
    let mut ws = Ws::connect(n.addr, "/ws/chat/7", Some("uid=u_alice"))
        .await
        .unwrap();
    assert_eq!(ws.next_text().await, "welcome u_alice");
    ws.text("hello").await;
    assert_eq!(
        ws.next_text().await,
        r#"<p class="msg" dir="auto">hello</p>"#
    );
    // A throw in `message` drops the message, the connection stays.
    ws.text("boom").await;
    ws.text("again").await;
    assert_eq!(
        ws.next_text().await,
        r#"<p class="msg" dir="auto">again</p>"#
    );
    ws.send_frame(0x8, &1000u16.to_be_bytes()).await;
    assert_eq!(ws.close_code().await, 1000);
    let r = n
        .records
        .wait_for("WS record", |r| r.route == "WS /ws/chat/:room")
        .await;
    assert_eq!(r.http_status, 101);
    assert!(r.realtime_conn_seconds.is_some_and(|s| s > 0.0), "{r:?}");
    // 3 frames received, 3 messages delivered (welcome, 2 fragments).
    assert_eq!(r.realtime_messages, Some(6), "{r:?}");
    assert!(r.render_fuel > 0, "the fragments' render: {r:?}");
    assert!(
        r.authz_evals.is_some_and(|e| e >= 1),
        "the subscribe check: {r:?}"
    );
    let t0 = Instant::now();
    while n.closes().is_empty() {
        assert!(t0.elapsed() < Duration::from_secs(5), "close never ran");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(n.closes()[0].1, 1000);
}

/// A denied `guard` answers 403 before the handshake: no upgrade, no hub
/// connection, a `forbidden` record.
#[tokio::test]
async fn a_denied_guard_refuses_the_upgrade() {
    let n = node().await;
    let err = Ws::connect(n.addr, "/ws/guarded", Some("uid=u_alice"))
        .await
        .err()
        .expect("no 101");
    assert_eq!(err.0, 403, "{}", err.1);
    let r = n
        .records
        .wait_for("forbidden", |r| r.route == "WS /ws/guarded")
        .await;
    assert_eq!(r.status, renox_meter::MeterStatus::Forbidden);
    assert_eq!(n.manager.realtime_stats("t_rt").unwrap().opened, 0);
}

/// Cross-site WebSocket hijacking (`docs/24-threat-model.md` A, "Cross-site
/// WebSocket hijacking"): an upgrade from another site, or a cookie-bearing
/// one with no `Origin`, is refused with 403 before the handshake and opens
/// no hub connection; a CORS origin of `renox.toml` is let through.
#[tokio::test]
async fn a_cross_origin_upgrade_with_a_cookie_is_refused() {
    let n = node().await;
    for origin in [Some("https://evil.example"), Some("null"), None] {
        let err = Ws::connect_from(n.addr, "/ws/chat/7", Some("uid=u_alice"), origin)
            .await
            .err()
            .expect("no 101");
        assert_eq!(err.0, 403, "{origin:?}: {}", err.1);
    }
    assert_eq!(n.manager.realtime_stats("t_rt").unwrap().opened, 0);
    let mut ws = Ws::connect_from(
        n.addr,
        "/ws/chat/7",
        Some("uid=u_alice"),
        Some("https://partner.example"),
    )
    .await
    .expect("an allowed CORS origin upgrades");
    assert_eq!(ws.next().await.unwrap().1, b"welcome u_alice");
    // No cookie, no ambient credential: a non-browser client without Origin.
    let mut anon = Ws::connect_from(n.addr, "/ws/chat/7", None, None)
        .await
        .expect("no cookie, no Origin: allowed");
    assert_eq!(anon.next().await.unwrap().1, b"welcome anon");
}

/// `open` subscribing to another user's topic: the policy denies, the
/// connection closes with 1008, and nothing was subscribed
/// (`docs/24-threat-model.md`, "Subscribing to another user's topic").
#[tokio::test]
async fn a_denied_subscribe_in_open_closes_with_1008() {
    let n = node().await;
    let mut ws = Ws::connect(n.addr, "/ws/spy", Some("uid=u_alice"))
        .await
        .unwrap();
    assert_eq!(ws.close_code().await, 1008);
    let stats = n.manager.realtime_stats("t_rt").unwrap();
    // The op denied before the hub was asked: no subscription, no message,
    // and the platform's close is counted with its reason.
    assert_eq!(stats.closes.get("forbidden"), Some(&1), "{stats:?}");
    assert_eq!(stats.messages_out, 0, "{stats:?}");
    // Bob may subscribe to his own inbox.
    let mut bob = Ws::connect(n.addr, "/ws/spy", Some("uid=u_bob"))
        .await
        .unwrap();
    bob.send_frame(0x8, &1000u16.to_be_bytes()).await;
    assert_eq!(bob.close_code().await, 1000);
}

/// A publish from an action reaches every subscriber, WebSocket and SSE,
/// and the fan-out never enters the isolate: the only new record is the
/// action's own.
#[tokio::test]
async fn a_publish_from_an_action_reaches_two_connections_without_the_isolate() {
    let n = node().await;
    let mut a = Ws::connect(n.addr, "/ws/chat/1", Some("uid=u_alice"))
        .await
        .unwrap();
    let mut b = Ws::connect(n.addr, "/ws/chat/1", Some("uid=u_bob"))
        .await
        .unwrap();
    assert_eq!(a.next_text().await, "welcome u_alice");
    assert_eq!(b.next_text().await, "welcome u_bob");
    // An SSE subscriber of the same topic.
    let res = n
        .send("GET", "/sse/feed", &[("accept", "text/event-stream")])
        .await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "text/event-stream");
    let mut body = res.into_body();
    // Wait until the SSE `open` subscribed (its record is written at the end).
    let t0 = Instant::now();
    while n.manager.realtime_stats("t_rt").unwrap().live < 3 {
        assert!(t0.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let before = n.records.all().len();
    assert_eq!(n.publish().await, 3);
    assert_eq!(a.next_text().await, "from action");
    assert_eq!(b.next_text().await, "from action");
    let mut sse = String::new();
    while !sse.contains("data: from action") {
        let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
            .await
            .expect("an SSE chunk")
            .unwrap()
            .unwrap();
        if let Ok(d) = frame.into_data() {
            sse.push_str(&String::from_utf8_lossy(&d));
        }
    }
    assert!(sse.contains("event: note"), "{sse}");
    n.records
        .wait_for("POST record", |r| r.route == "POST /publish")
        .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let new: Vec<String> = n.records.all()[before..]
        .iter()
        .map(|r| r.route.clone())
        .collect();
    assert_eq!(
        new,
        vec!["POST /publish".to_string()],
        "fan-out ran no tenant code"
    );
    drop(body);
}

/// The per-tenant cap (100 on the free tier) refuses the 101st upgrade
/// with 503 `RENOX_REALTIME_LIMIT`, `Retry-After: 5`, and a `busy` record.
#[tokio::test]
async fn the_tenant_cap_refuses_the_upgrade() {
    let n = node().await;
    let mut open = Vec::new();
    for i in 0..100 {
        // 10 users x 10 connections: under the per-user cap.
        let cookie = format!("uid=u_{}", i % 10);
        let mut ws = Ws::connect(n.addr, "/ws/chat/1", Some(&cookie))
            .await
            .unwrap();
        ws.next_text().await;
        open.push(ws);
    }
    let err = Ws::connect(n.addr, "/ws/chat/1", Some("uid=u_x"))
        .await
        .err()
        .expect("refused");
    assert_eq!(err.0, 503, "{}", err.1);
    let head = err.1.to_ascii_lowercase();
    assert!(head.contains("retry-after: 5"), "{head}");
    let r = n
        .records
        .wait_for("busy", |r| r.status == renox_meter::MeterStatus::Busy)
        .await;
    assert_eq!(r.http_status, 503);
    let stats = n.manager.realtime_stats("t_rt").unwrap();
    assert_eq!(stats.refused.get("tenant"), Some(&1), "{stats:?}");
}

/// A frame over 64 KB closes the connection with 1009 and runs `close`
/// (`docs/23-failure-modes.md`, "WebSocket message flood / oversized frame").
#[tokio::test]
async fn an_oversized_frame_closes_with_1009() {
    let n = node().await;
    let mut ws = Ws::connect(n.addr, "/ws/chat/2", Some("uid=u_alice"))
        .await
        .unwrap();
    ws.next_text().await;
    ws.send_frame(0x1, &vec![b'a'; 64 * 1024 + 1]).await;
    assert_eq!(ws.close_code().await, 1009);
    let t0 = Instant::now();
    while n.closes().is_empty() {
        assert!(t0.elapsed() < Duration::from_secs(5), "close never ran");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(n.closes()[0].1, 1009);
}

/// A plain GET to a `ws` route (no upgrade) is 405, as is a POST.
#[tokio::test]
async fn a_plain_request_to_a_realtime_route_is_405() {
    let n = node().await;
    assert_eq!(n.send("GET", "/ws/chat/1", &[]).await.status(), 405);
    assert_eq!(n.send("POST", "/sse/feed", &[]).await.status(), 405);
    assert_eq!(n.send("GET", "/sse/feed", &[]).await.status(), 405);
}
