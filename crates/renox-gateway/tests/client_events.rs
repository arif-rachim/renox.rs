//! #126: `/__renox/events`, `/__renox/client.js`, and `x-renox-request-id`
//! on every response kind (`docs/contracts/client-events.md`; failure modes
//! "Browser error", "Script blocked by CSP", "Client-event flood (bug or
//! abuse)" in `docs/23-failure-modes.md`). Every test that sends a request
//! under `/__renox/` also checks the fake dispatcher saw no call: the
//! endpoint never touches a cell or an isolate.

mod common;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use common::*;
use renox_gateway::client_script;
use renox_gateway::{
    ClientEventLimits, ClientEventSink, ClientLogLine, DropReason, Gateway, GatewayConfig,
    GatewayLimits, REQUEST_ID_HEADER, RouteStatus, RouteTable,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tower::ServiceExt;

const EXAMPLES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/contracts/examples/client-events"
);

#[derive(Default)]
struct CaptureSink {
    lines: Mutex<Vec<ClientLogLine>>,
}

impl ClientEventSink for CaptureSink {
    fn write(&self, line: ClientLogLine) {
        self.lines.lock().unwrap().push(line);
    }
}

impl CaptureSink {
    fn take(&self) -> Vec<ClientLogLine> {
        std::mem::take(&mut self.lines.lock().unwrap())
    }
}

struct Setup {
    gw: Gateway,
    app: Router,
    cell: Arc<FakeDispatcher>,
    sink: Arc<CaptureSink>,
    _dir: tempfile::TempDir,
}

fn setup_with(
    config: impl FnOnce(&mut GatewayConfig),
    manifest: Option<serde_json::Value>,
) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let table = RouteTable::new();
    table
        .upsert(entry("a.test", "t_a", HASH_A, RouteStatus::Active))
        .unwrap();
    if let Some(m) = manifest {
        std::fs::create_dir_all(dir.path().join(HASH_A)).unwrap();
        std::fs::write(dir.path().join(HASH_A).join("manifest.json"), m.to_string()).unwrap();
    }
    let mut c = GatewayConfig::new(dir.path());
    config(&mut c);
    let gw = Gateway::new(c, Arc::new(table));
    let sink = Arc::new(CaptureSink::default());
    assert!(gw.set_client_event_sink(sink.clone()));
    let cell = FakeDispatcher::new();
    let app = gw.router(cell.clone());
    Setup {
        gw,
        app,
        cell,
        sink,
        _dir: dir,
    }
}

fn setup() -> Setup {
    setup_with(|_| {}, None)
}

fn example(name: &str) -> serde_json::Value {
    let text = std::fs::read_to_string(Path::new(EXAMPLES).join(name)).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// The mixed example without its `js.console.error` events (dev only: the
/// production gateway drops a batch carrying one).
fn production_batch() -> serde_json::Value {
    let mut batch = example("client-events.mixed-batch.valid.json");
    batch["events"]
        .as_array_mut()
        .unwrap()
        .retain(|e| e["kind"] != "js.console.error");
    batch
}

fn post(path: &str, content_type: &str, body: impl Into<Body>) -> Request<Body> {
    let mut req = Request::builder()
        .method("POST")
        .uri(path)
        .header("host", "a.test")
        .header("content-type", content_type)
        .header(
            "user-agent",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        )
        .body(body.into())
        .unwrap();
    req.extensions_mut().insert(axum::extract::ConnectInfo(
        "192.0.2.10:50000".parse::<SocketAddr>().unwrap(),
    ));
    req
}

fn post_events(body: &serde_json::Value) -> Request<Body> {
    post(
        "/__renox/events",
        "text/plain;charset=UTF-8",
        body.to_string(),
    )
}

async fn send(s: &Setup, req: Request<Body>) -> Response<Body> {
    s.app.clone().oneshot(req).await.unwrap()
}

fn assert_204(resp: &Response<Body>) {
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    assert_eq!(resp.headers()["cache-control"], "no-store");
    assert_eq!(resp.headers()[REQUEST_ID_HEADER].len(), 26);
    assert!(resp.headers().get("access-control-allow-origin").is_none());
}

/// A valid batch → one tenant log line per event with `tenant_id`,
/// `source: "client"`, `kind`, and the event's request id; 204; no cell.
#[tokio::test]
async fn valid_batch_is_logged_per_event() {
    let s = setup();
    let batch = production_batch();
    let resp = send(&s, post_events(&batch)).await;
    assert_204(&resp);
    let lines = s.sink.take();
    let events = batch["events"].as_array().unwrap();
    assert_eq!(lines.len(), events.len());
    for (line, event) in lines.iter().zip(events) {
        assert_eq!(line.tenant_id, "t_a");
        assert_eq!(line.fields["source"], "client");
        assert_eq!(line.fields["kind"], event["kind"]);
        assert_eq!(line.fields["client_ts"], event["ts"]);
        assert_eq!(line.fields["detail"], event["detail"]);
        assert_eq!(
            line.request_id.as_deref(),
            event["request_id"].as_str(),
            "the event's request id, not the beacon's"
        );
        // A deployment hash the host does not route to falls back to the
        // active one.
        assert_eq!(line.deployment_hash, HASH_A);
        let kind = event["kind"].as_str().unwrap();
        let expected = if kind.starts_with("realtime.") {
            "warn"
        } else {
            "error"
        };
        assert_eq!(line.level, expected, "{kind}");
    }
    assert_eq!(s.gw.stats().client_events.accepted, events.len() as u64);
    assert_eq!(s.cell.count(), 0);
}

/// Every valid example of one kind is accepted; the deployment named by an
/// event is kept when the host routes to it.
#[tokio::test]
async fn every_kind_example_is_accepted() {
    let s = setup();
    let mut n = 0;
    for entry in std::fs::read_dir(EXAMPLES).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        if !name.starts_with("client-events.") || !name.ends_with(".valid.json") {
            continue;
        }
        // Dev only (and the mixed batch carries it): dropped in production.
        if name.contains("js.console.error") || name.contains("mixed") {
            continue;
        }
        let mut batch = example(&name);
        for e in batch["events"].as_array_mut().unwrap() {
            e["deployment"] = HASH_A.into();
        }
        assert_204(&send(&s, post_events(&batch)).await);
        let lines = s.sink.take();
        assert!(!lines.is_empty(), "{name}");
        assert!(lines.iter().all(|l| l.deployment_hash == HASH_A));
        n += 1;
    }
    assert!(n >= 10, "{n} examples");
    assert_eq!(s.cell.count(), 0);
}

/// Invalid examples, a wrong version, unknown fields, `js.console.error`
/// (dev only), and a foreign `Origin` → 204 and `invalid`; nothing logged
/// but the summary.
#[tokio::test]
async fn invalid_bodies_are_dropped() {
    let s = setup();
    let mut sent = 0;
    for name in [
        "client-events.absolute-url.invalid.json",
        "client-events.cookie-field.invalid.json",
        "client-events.detail-missing-field.invalid.json",
        "client-events.empty-batch.invalid.json",
        "client-events.extra-over-1kb.invalid.json",
        "client-events.frame-with-source.invalid.json",
        "client-events.long-string.invalid.json",
        "client-events.missing-kind.invalid.json",
        "client-events.resource-url-with-query.invalid.json",
        "client-events.unknown-kind.invalid.json",
        "client-events.url-with-fragment.invalid.json",
        "client-events.js.console.error.valid.json",
    ] {
        assert_204(&send(&s, post_events(&example(name))).await);
        sent += 1;
    }
    let mut v1 = example("client-events.js.error.valid.json");
    v1["v"] = 1.into();
    assert_204(&send(&s, post_events(&v1)).await);
    assert_204(&send(&s, post("/__renox/events", "application/json", "{not json")).await);
    let mut foreign = post_events(&example("client-events.js.error.valid.json"));
    foreign
        .headers_mut()
        .insert("origin", "https://evil.example".parse().unwrap());
    assert_204(&send(&s, foreign).await);
    sent += 3;
    let stats = s.gw.stats().client_events;
    assert_eq!(stats.dropped_invalid, sent);
    assert_eq!(stats.accepted, 0);
    let lines = s.sink.take();
    assert_eq!(lines.len(), 1, "one summary line for the minute");
    assert_eq!(lines[0].fields["code"], "RENOX_CLIENT_EVENTS_DROPPED");
    assert_eq!(lines[0].fields["reason"], "invalid");
    assert_eq!(lines[0].fields["dropped"], 1);
    assert_eq!(s.cell.count(), 0);
}

/// Rule CE1: a body over 32 KB → 204 and `body_size`, declared or not; 21
/// events → `batch_size`.
#[tokio::test]
async fn oversized_body_and_batch_are_dropped() {
    let s = setup();
    let big = example("client-events.body-over-32kb.invalid.json").to_string();
    assert!(big.len() > 32 * 1024);
    assert_204(&send(&s, post("/__renox/events", "application/json", big.clone())).await);
    // Unknown length (streamed): the gateway stops reading at the limit.
    let chunks = futures_util::stream::iter(
        big.into_bytes()
            .chunks(4096)
            .map(|c| Ok::<_, std::io::Error>(c.to_vec()))
            .collect::<Vec<_>>(),
    );
    let mut req = post(
        "/__renox/events",
        "application/json",
        Body::from_stream(chunks),
    );
    req.headers_mut().remove("content-length");
    assert_204(&send(&s, req).await);
    assert_204(
        &send(
            &s,
            post_events(&example("client-events.too-many-events.invalid.json")),
        )
        .await,
    );
    let stats = s.gw.stats().client_events;
    assert_eq!(stats.dropped(DropReason::BodySize), 2);
    assert_eq!(stats.dropped(DropReason::BatchSize), 1);
    assert_eq!(stats.accepted, 0);
    assert_eq!(s.cell.count(), 0);
}

/// 60 requests per minute per IP per tenant; the 61st → 204 and `ip_rate`.
#[tokio::test]
async fn per_ip_rate_limit() {
    let s = setup();
    let batch = example("client-events.js.error.valid.json");
    for _ in 0..61 {
        assert_204(&send(&s, post_events(&batch)).await);
    }
    let stats = s.gw.stats().client_events;
    assert_eq!(stats.accepted, 60);
    assert_eq!(stats.dropped(DropReason::IpRate), 1);
    let lines = s.sink.take();
    let summary = lines.last().unwrap();
    assert_eq!(summary.fields["reason"], "ip_rate");
    assert!(
        lines
            .iter()
            .all(|l| !serde_json::Value::Object(l.fields.clone())
                .to_string()
                .contains("192.0.2.10")),
        "the client IP is never logged"
    );
    assert_eq!(s.cell.count(), 0);
}

/// Over the per-tenant minute count, one event in ten is kept (`sampled`);
/// past the daily cap nothing is (`daily_cap`).
#[tokio::test]
async fn tenant_sampling_and_daily_cap() {
    let s = setup_with(
        |c| {
            c.client_events = ClientEventLimits {
                events_per_tenant_per_min: 20,
                events_per_tenant_per_day: 25,
                ..ClientEventLimits::default()
            }
        },
        None,
    );
    let batch = production_batch();
    assert_eq!(batch["events"].as_array().unwrap().len(), 18);
    for _ in 0..3 {
        assert_204(&send(&s, post_events(&batch)).await);
    }
    let stats = s.gw.stats().client_events;
    // 20 under the count, then the 10th, 20th, and 30th of the 34 over it.
    assert_eq!(stats.accepted, 23);
    assert_eq!(stats.dropped(DropReason::Sampled), 31);
    assert_eq!(stats.dropped(DropReason::DailyCap), 0);
    for _ in 0..3 {
        assert_204(&send(&s, post_events(&batch)).await);
    }
    // Two more are kept (the 40th and 50th over) and 14 sampled, then the
    // daily cap (25 kept events) drops the remaining 38.
    let stats = s.gw.stats().client_events;
    assert_eq!(stats.accepted, 25);
    assert_eq!(stats.dropped(DropReason::Sampled), 31 + 14);
    assert_eq!(stats.dropped(DropReason::DailyCap), 38);
    assert_eq!(s.cell.count(), 0);
}

/// `application/csp-report` and `application/reports+json` bodies become
/// `csp.violation` lines: URLs reduced, `original-policy` dropped, `ua`
/// from `User-Agent`, report-only at `warn`.
#[tokio::test]
async fn csp_reports_are_normalised() {
    let s = setup();
    let body = example("csp-report.report-uri.valid.json")["body"].clone();
    assert_204(
        &send(
            &s,
            post(
                "/__renox/events?kind=csp",
                "application/csp-report",
                body.to_string(),
            ),
        )
        .await,
    );
    let body = example("reports-json.report-to.valid.json")["body"].clone();
    assert_204(
        &send(
            &s,
            post(
                "/__renox/events?kind=csp",
                "application/reports+json",
                body.to_string(),
            ),
        )
        .await,
    );
    let lines = s.sink.take();
    assert_eq!(lines.len(), 2);
    let a = &lines[0];
    assert_eq!(a.fields["kind"], "csp.violation");
    assert_eq!(a.fields["source"], "client");
    assert_eq!(a.fields["url"], "/products/42");
    assert_eq!(a.fields["ua"], "chrome");
    assert_eq!(a.request_id, None);
    assert_eq!(a.level, "error");
    assert_eq!(
        a.fields["detail"],
        serde_json::json!({
            "blocked_uri": "https://evil.example.net/x.js",
            "violated_directive": "script-src-elem",
            "effective_directive": "script-src-elem",
            "source_file": "https://shop.renox.app/products/42",
            "line": 3,
            "column": 1,
            "disposition": "enforce",
        })
    );
    let text = serde_json::Value::Object(a.fields.clone()).to_string();
    assert!(!text.contains("original"), "{text}");
    let b = &lines[1];
    assert_eq!(b.fields["detail"]["blocked_uri"], "inline");
    assert_eq!(b.fields["detail"]["disposition"], "report");
    assert_eq!(b.level, "warn");
    assert_ne!(
        a.fields["session_fingerprint"], b.fields["session_fingerprint"],
        "a fresh fingerprint per report"
    );
    // A report of another type, or a malformed one, is invalid.
    for name in [
        "reports-json.other-type.invalid.json",
        "csp-report.missing-directive.invalid.json",
    ] {
        let body = example(name)["body"].clone();
        assert_204(
            &send(
                &s,
                post(
                    "/__renox/events?kind=csp",
                    "application/json",
                    body.to_string(),
                ),
            )
            .await,
        );
    }
    assert_eq!(s.gw.stats().client_events.dropped_invalid, 2);
    assert_eq!(s.cell.count(), 0);
}

/// `client.events = false` in the manifest → everything dropped
/// (`disabled`), still 204, nothing in the tenant log.
#[tokio::test]
async fn disabled_endpoint_drops_everything() {
    let s = setup_with(
        |_| {},
        Some(serde_json::json!({ "artifact": { "version": 1 }, "client": { "events": false } })),
    );
    assert_204(
        &send(
            &s,
            post_events(&example("client-events.js.error.valid.json")),
        )
        .await,
    );
    let stats = s.gw.stats().client_events;
    assert_eq!(stats.dropped(DropReason::Disabled), 1);
    assert_eq!(stats.accepted, 0);
    assert!(s.sink.take().is_empty());
    assert_eq!(s.cell.count(), 0);
}

/// Methods other than POST → 405 with `Allow: POST`; unknown platform
/// paths → 404; a tenant route under `/__renox/` is never reached.
#[tokio::test]
async fn platform_paths_never_reach_the_cell() {
    let s = setup();
    let get = request("a.test", "/__renox/events");
    let resp = send(&s, get).await;
    assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(resp.headers()["allow"], "POST");
    let resp = send(&s, request("a.test", "/__renox/anything")).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert_eq!(resp.headers()[REQUEST_ID_HEADER].len(), 26);
    assert_eq!(s.cell.count(), 0);
}

/// The client script: content-hash `ETag`, `immutable`, 304 on a match.
#[tokio::test]
async fn client_script_is_served_with_its_hash() {
    let s = setup();
    let resp = send(&s, request("a.test", &client_script::script_src())).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let etag = resp.headers()["etag"].to_str().unwrap().to_owned();
    assert_eq!(etag, format!("\"{}\"", client_script::script_hash()));
    assert_eq!(
        resp.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(
        resp.headers()["content-type"],
        "text/javascript; charset=utf-8"
    );
    assert!(resp.headers()["content-security-policy"].to_str().is_ok());
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(&body[..], client_script::SCRIPT);
    let mut again = request("a.test", "/__renox/client.js");
    again
        .headers_mut()
        .insert("if-none-match", etag.parse().unwrap());
    assert_eq!(send(&s, again).await.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(s.cell.count(), 0);
}

/// Pages and errors carry `report-to` and the `Reporting-Endpoints` header
/// that names the events endpoint.
#[tokio::test]
async fn csp_reporting_headers() {
    let s = setup();
    let resp = send(&s, request("a.test", "/page")).await;
    let csp = resp.headers()["content-security-policy"].to_str().unwrap();
    assert!(csp.ends_with("; report-uri /__renox/events?kind=csp; report-to renox-csp"));
    assert_eq!(
        resp.headers()["reporting-endpoints"],
        "renox-csp=\"/__renox/events?kind=csp\""
    );
    let s = setup_with(
        |_| {},
        Some(
            serde_json::json!({ "artifact": { "version": 1 }, "security": { "csp": { "report_only": true } } }),
        ),
    );
    let resp = send(&s, request("a.test", "/page")).await;
    assert!(
        resp.headers()["content-security-policy-report-only"]
            .to_str()
            .unwrap()
            .contains("report-to renox-csp")
    );
    assert!(resp.headers().get("reporting-endpoints").is_some());
}

// --- x-renox-request-id on every response kind ---------------------------

async fn start(
    config: impl FnOnce(&mut GatewayConfig),
) -> (SocketAddr, Arc<FakeDispatcher>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    write_public(dir.path(), HASH_A, &[("logo.txt", b"logo", "text/plain")]);
    let routes = Arc::new(RouteTable::new());
    routes
        .upsert(entry("a.test", "t_a", HASH_A, RouteStatus::Active))
        .unwrap();
    let mut c = GatewayConfig::new(dir.path());
    c.rate_limit.burst = 10_000;
    config(&mut c);
    let gw = Gateway::new(c, routes);
    let cell = FakeDispatcher::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let dispatcher = cell.clone();
    tokio::spawn(async move { gw.serve(listener, dispatcher).await });
    (addr, cell, dir)
}

async fn read_all(stream: &mut TcpStream) -> String {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, stream.read(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
            Ok(Ok(n)) => out.extend_from_slice(&buf[..n]),
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn exchange(addr: SocketAddr, raw: &[u8]) -> String {
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(raw).await.unwrap();
    read_all(&mut s).await
}

/// The status line and the request id header of a raw response.
fn status_and_id(out: &str) -> (String, String) {
    let status = out.lines().next().unwrap_or("").to_owned();
    let id = out
        .lines()
        .take_while(|l| !l.is_empty())
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("x-renox-request-id: ")
                .map(str::to_owned)
        })
        .unwrap_or_default();
    (status, id)
}

/// 200 (cell), static, 404 (unknown host), 413, 400 (protocol guard), 431
/// (head too large, too many headers), 204 (events), and 503 (connection
/// cap) all carry a 26-character request id, each a different one.
#[tokio::test]
async fn request_id_on_every_response_kind() {
    let (addr, cell, _dir) = start(|c| {
        c.limits = GatewayLimits {
            max_connections_per_ip: 3,
            ..GatewayLimits::default()
        }
    })
    .await;
    let close = "Connection: close\r\n";
    let big = "a".repeat(20 * 1024);
    let mut many = String::new();
    for i in 0..200 {
        many.push_str(&format!("X-H{i}: v\r\n"));
    }
    let events = example("client-events.js.error.valid.json").to_string();
    let cases: Vec<(&str, String)> = vec![
        (
            "200",
            format!("GET /fn HTTP/1.1\r\nHost: a.test\r\n{close}\r\n"),
        ),
        (
            "200",
            format!("GET /logo.txt HTTP/1.1\r\nHost: a.test\r\n{close}\r\n"),
        ),
        (
            "404",
            format!("GET / HTTP/1.1\r\nHost: nobody.test\r\n{close}\r\n"),
        ),
        (
            "413",
            format!("POST /fn HTTP/1.1\r\nHost: a.test\r\nContent-Length: 2000000\r\n{close}\r\n"),
        ),
        (
            "400",
            "GET / HTTP/1.1\r\nHost: a.test\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n"
                .to_string(),
        ),
        (
            "431",
            format!("GET / HTTP/1.1\r\nHost: a.test\r\nX-Big: {big}\r\n\r\n"),
        ),
        (
            "431",
            format!("GET / HTTP/1.1\r\nHost: a.test\r\n{many}\r\n"),
        ),
        (
            "204",
            format!(
                "POST /__renox/events HTTP/1.1\r\nHost: a.test\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n{close}\r\n{events}",
                events.len()
            ),
        ),
    ];
    let mut ids = std::collections::HashSet::new();
    for (status, raw) in &cases {
        let out = exchange(addr, raw.as_bytes()).await;
        let (line, id) = status_and_id(&out);
        assert!(
            line.starts_with(&format!("HTTP/1.1 {status}")),
            "{line:?} for {status}"
        );
        assert_eq!(id.len(), 26, "request id on {status}: {out:?}");
        assert!(ids.insert(id));
    }
    // The cell saw only the two routed requests (one cell, one static).
    assert_eq!(cell.count(), 1);

    // 503 at the per-IP connection cap.
    let mut held = Vec::new();
    for _ in 0..3 {
        held.push(TcpStream::connect(addr).await.unwrap());
    }
    let mut extra = TcpStream::connect(addr).await.unwrap();
    let out = read_all(&mut extra).await;
    let (line, id) = status_and_id(&out);
    assert!(line.starts_with("HTTP/1.1 503"), "{out:?}");
    assert_eq!(id.len(), 26);
    assert!(ids.insert(id));
}

/// 429 from the per-IP rate limiter carries the id too.
#[tokio::test]
async fn request_id_on_429() {
    let (addr, _cell, _dir) = start(|c| {
        c.rate_limit.burst = 1;
        c.rate_limit.requests_per_second = 0.001;
    })
    .await;
    let raw = b"GET /fn HTTP/1.1\r\nHost: a.test\r\nConnection: close\r\n\r\n";
    let first = exchange(addr, raw).await;
    assert!(first.starts_with("HTTP/1.1 200"), "{first:?}");
    let out = exchange(addr, raw).await;
    let (line, id) = status_and_id(&out);
    assert!(line.starts_with("HTTP/1.1 429"), "{out:?}");
    assert_eq!(id.len(), 26);
}
