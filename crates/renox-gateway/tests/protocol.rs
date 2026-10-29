//! Protocol hardening at the gateway (#107, and the HTTP/2 flood budgets of
//! #166), proven with raw TCP clients that send hand-written bytes (not a
//! well-behaved HTTP client), an `h2` client and hand-written HTTP/2 frames
//! for HTTP/2, and a `rustls` client for SNI. Every refused request is
//! also checked against the fake dispatcher: it never reaches a cell.
//!
//! Rows proven (`docs/24-threat-model.md` section C): "HTTP request
//! smuggling, `Transfer-Encoding` tricks, h2c upgrade", "HTTP/2 rapid reset
//! and stream floods" (with the control-frame floods of #166), "Host/SNI
//! confusion", "Cache poisoning of static assets".

mod common;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::{Request, StatusCode};
use common::*;
use renox_gateway::{
    CertStore, Gateway, GatewayConfig, ProtocolLimits, RouteStatus, RouteTable, TlsConfig,
};
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tower::ServiceExt;

fn gateway(root: &Path) -> Gateway {
    let routes = Arc::new(RouteTable::new());
    for (host, tenant, hash) in [
        ("a.test", "t_a", HASH_A),
        ("www.a.test", "t_a", HASH_A),
        ("b.test", "t_b", HASH_B),
    ] {
        routes
            .upsert(entry(host, tenant, hash, RouteStatus::Active))
            .unwrap();
    }
    let mut config = GatewayConfig::new(root);
    // Keep the per-IP rate limiter out of the way of the floods below.
    config.rate_limit.burst = 100_000;
    config.rate_limit.requests_per_second = 100_000.0;
    Gateway::new(config, routes)
}

struct Server {
    addr: SocketAddr,
    cell: Arc<FakeDispatcher>,
    gateway: Gateway,
    _dir: tempfile::TempDir,
}

async fn start_plain() -> Server {
    let dir = tempfile::tempdir().unwrap();
    let gw = gateway(dir.path());
    let cell = FakeDispatcher::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (server, dispatcher) = (gw.clone(), cell.clone());
    tokio::spawn(async move { server.serve(listener, dispatcher).await });
    Server {
        addr,
        cell,
        gateway: gw,
        _dir: dir,
    }
}

/// Reads until EOF, a reset, or 10 s; returns what arrived.
async fn read_all<S: AsyncRead + Unpin>(stream: &mut S) -> String {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, stream.read(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
            Ok(Ok(n)) => out.extend_from_slice(&buf[..n]),
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Sends `bytes` on a new connection and returns everything the server sent
/// until it closed the connection.
async fn exchange(addr: SocketAddr, bytes: &[u8]) -> String {
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(bytes).await.unwrap();
    read_all(&mut s).await
}

/// A refused request: a bare `400` (or nothing) and the connection closed
/// by the server (`read_all` returned before its 10 s timeout).
fn assert_refused(out: &str, what: &str) {
    assert!(
        out.is_empty() || out.starts_with("HTTP/1.1 400 "),
        "{what}: {out:?}"
    );
    assert!(!out.contains("tenant="), "{what} reached the cell: {out:?}");
}

/// Smuggling row: every ambiguous framing from the issue, sent as raw bytes.
/// Each answer is 400 and the connection is closed; no request is
/// dispatched, including the smuggled one hidden in the body.
#[tokio::test]
async fn ambiguous_http1_framing_is_refused_before_dispatch() {
    let server = start_plain().await;
    let cases: &[(&str, &[u8])] = &[
        (
            "CL.TE",
            b"POST /api HTTP/1.1\r\nHost: a.test\r\nContent-Length: 6\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nG",
        ),
        (
            "TE.CL",
            b"POST /api HTTP/1.1\r\nHost: a.test\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n5c\r\nGPOST /api HTTP/1.1\r\nHost: b.test\r\nContent-Length: 15\r\n\r\nx=1\r\n0\r\n\r\n",
        ),
        (
            "duplicate Content-Length (equal)",
            b"POST /api HTTP/1.1\r\nHost: a.test\r\nContent-Length: 3\r\nContent-Length: 3\r\n\r\nabc",
        ),
        (
            "duplicate Content-Length (different)",
            b"POST /api HTTP/1.1\r\nHost: a.test\r\nContent-Length: 3\r\nContent-Length: 30\r\n\r\nabc",
        ),
        (
            "Transfer-Encoding: chunked, identity",
            b"POST /api HTTP/1.1\r\nHost: a.test\r\nTransfer-Encoding: chunked, identity\r\n\r\n0\r\n\r\n",
        ),
        (
            "Transfer-Encoding: identity",
            b"POST /api HTTP/1.1\r\nHost: a.test\r\nTransfer-Encoding: identity\r\n\r\nabc",
        ),
        (
            "Transfer-Encoding with a space before the colon",
            b"POST /api HTTP/1.1\r\nHost: a.test\r\nTransfer-Encoding : chunked\r\nContent-Length: 3\r\n\r\nabc",
        ),
        (
            "header line ending in a bare LF",
            b"GET /api HTTP/1.1\r\nHost: a.test\nX-Smuggle: 1\r\n\r\n",
        ),
        (
            "request line ending in a bare LF",
            b"GET /api HTTP/1.1\nHost: a.test\r\n\r\n",
        ),
        (
            "obsolete line folding",
            b"GET /api HTTP/1.1\r\nHost: a.test\r\nX-Folded: a\r\n b\r\n\r\n",
        ),
        (
            "NUL in a header value",
            b"GET /api HTTP/1.1\r\nHost: a.test\r\nX-Nul: a\x00b\r\n\r\n",
        ),
        (
            "control character in the request target",
            b"GET /api\x01 HTTP/1.1\r\nHost: a.test\r\n\r\n",
        ),
        (
            "two spaces in the request line",
            b"GET  /api HTTP/1.1\r\nHost: a.test\r\n\r\n",
        ),
        (
            "bare CR inside the head",
            b"GET /api HTTP/1.1\r\nHost: a.test\rX: y\r\n\r\n",
        ),
        (
            "malformed chunk size",
            b"POST /api HTTP/1.1\r\nHost: a.test\r\nTransfer-Encoding: chunked\r\n\r\n0x5\r\nhello\r\n0\r\n\r\n",
        ),
        (
            "CONNECT",
            b"CONNECT b.test:443 HTTP/1.1\r\nHost: b.test:443\r\n\r\n",
        ),
    ];
    for (what, bytes) in cases {
        let out = exchange(server.addr, bytes).await;
        assert_refused(&out, what);
        // A bad head is answered 400; a bad chunk comes after the head was
        // accepted (a response may be in flight), so it only closes.
        if !what.contains("chunk") {
            assert!(out.starts_with("HTTP/1.1 400 "), "{what}: {out:?}");
        }
    }
    assert_eq!(server.cell.count(), 0);
    assert_eq!(server.gateway.stats().protocol_refused, cases.len() as u64);
}

/// Smuggling row, "no cleartext upgrade": an `Upgrade: h2c` request and the
/// HTTP/2 prior-knowledge preface on the plain listener are both refused.
#[tokio::test]
async fn h2c_upgrade_and_prior_knowledge_are_refused() {
    let server = start_plain().await;
    let upgrade = b"GET /api HTTP/1.1\r\nHost: a.test\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\n\r\n";
    let out = exchange(server.addr, upgrade).await;
    assert!(out.starts_with("HTTP/1.1 400 "), "{out:?}");

    let preface = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n\x00\x00\x00\x04\x00\x00\x00\x00\x00";
    let out = exchange(server.addr, preface).await;
    assert_refused(&out, "h2c prior knowledge");
    assert_eq!(server.cell.count(), 0);
}

/// A smuggled head after a legitimate request on a keep-alive connection
/// closes the connection without a response: only the first request is
/// dispatched.
#[tokio::test]
async fn bad_head_after_a_good_request_closes_the_connection() {
    let server = start_plain().await;
    let mut s = TcpStream::connect(server.addr).await.unwrap();
    s.write_all(b"POST /api HTTP/1.1\r\nHost: a.test\r\nContent-Length: 3\r\n\r\nabc")
        .await
        .unwrap();
    let mut buf = [0u8; 4096];
    let n = s.read(&mut buf).await.unwrap();
    assert!(buf[..n].starts_with(b"HTTP/1.1 200 "));
    s.write_all(b"GET /api HTTP/1.1\nHost: b.test\r\n\r\n")
        .await
        .unwrap();
    let out = read_all(&mut s).await;
    assert_eq!(out, "", "no response for the smuggled request");
    assert_eq!(server.cell.count(), 1);
}

/// The guard follows the body framing: pipelined keep-alive requests with a
/// `Content-Length` body, a chunked body with an extension and trailers, and
/// a body-less request are all served on one connection.
#[tokio::test]
async fn well_formed_pipelined_requests_are_still_served() {
    let server = start_plain().await;
    let mut s = TcpStream::connect(server.addr).await.unwrap();
    s.write_all(
        b"POST /api/1 HTTP/1.1\r\nHost: a.test\r\nContent-Length: 5\r\n\r\nhello\
          POST /api/2 HTTP/1.1\r\nHost: a.test\r\nTransfer-Encoding: chunked\r\n\r\n3;ext=1\r\nabc\r\n0\r\nX-Trailer: t\r\n\r\n\
          GET /api/3 HTTP/1.1\r\nHost: b.test\r\nConnection: close\r\n\r\n",
    )
    .await
    .unwrap();
    let out = read_all(&mut s).await;
    assert_eq!(out.matches("HTTP/1.1 200 ").count(), 3, "{out}");
    assert!(
        out.contains("x-body-len: 5") && out.contains("x-body-len: 3"),
        "{out}"
    );
    assert_eq!(server.cell.count(), 3);
    assert_eq!(server.gateway.stats().protocol_refused, 0);
}

/// Adversarial review of #107: a chunk extension longer than the guard's
/// line buffer must not switch the guard off for the rest of the
/// connection, so the smuggled head after it never reaches the cell.
#[tokio::test]
async fn overlong_chunk_extension_does_not_disable_the_guard() {
    let server = start_plain().await;
    let ext = "e".repeat(20 * 1024);
    let req = format!(
        "POST /api HTTP/1.1\r\nHost: a.test\r\nTransfer-Encoding: chunked\r\n\r\n\
         1;{ext}\r\na\r\n0\r\n\r\nGET /api HTTP/1.1\nHost: b.test\r\n\r\n"
    );
    let out = exchange(server.addr, req.as_bytes()).await;
    assert!(!out.contains("tenant=t_b"), "{out:?}");
    assert_eq!(server.cell.count(), 0);
}

// ---------------------------------------------------------------------------
// TLS: SNI/Host and HTTP/2
// ---------------------------------------------------------------------------

struct TlsServer {
    server: Server,
    connector_h1: TlsConnector,
    connector_h2: TlsConnector,
}

/// A TLS gateway with one certificate covering `a.test`, `www.a.test`, and
/// `b.test` (as a shared certificate or connection coalescing would).
async fn start_tls(protocol: ProtocolLimits) -> TlsServer {
    let dir = tempfile::tempdir().unwrap();
    let certs_dir = dir.path().join("certs");
    let rcgen::CertifiedKey { cert, signing_key } = rcgen::generate_simple_self_signed(vec![
        "a.test".to_owned(),
        "www.a.test".to_owned(),
        "b.test".to_owned(),
    ])
    .unwrap();
    for host in ["a.test", "www.a.test", "b.test"] {
        let path = certs_dir.join(host);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("fullchain.pem"), cert.pem()).unwrap();
        std::fs::write(path.join("privkey.pem"), signing_key.serialize_pem()).unwrap();
    }
    let (store, report) = CertStore::load(&TlsConfig {
        cert_dir: certs_dir,
    })
    .unwrap();
    assert!(report.failed.is_empty(), "{:?}", report.failed);

    let routes = gateway(dir.path()).routes().clone();
    let mut config = GatewayConfig::new(dir.path());
    config.rate_limit.burst = 100_000;
    config.rate_limit.requests_per_second = 100_000.0;
    config.protocol = protocol;
    let gw = Gateway::new(config, routes);
    let cell = FakeDispatcher::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (server, dispatcher) = (gw.clone(), cell.clone());
    tokio::spawn(async move { server.serve_tls(listener, store, dispatcher).await });

    let connector = |alpn: &[u8]| {
        let mut roots = RootCertStore::empty();
        roots.add(cert.der().clone()).unwrap();
        let mut config =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth();
        config.alpn_protocols = vec![alpn.to_vec()];
        TlsConnector::from(Arc::new(config))
    };
    TlsServer {
        connector_h1: connector(b"http/1.1"),
        connector_h2: connector(b"h2"),
        server: Server {
            addr,
            cell,
            gateway: gw,
            _dir: dir,
        },
    }
}

async fn tls_connect(
    addr: SocketAddr,
    connector: &TlsConnector,
    sni: &str,
) -> tokio_rustls::client::TlsStream<TcpStream> {
    let tcp = TcpStream::connect(addr).await.unwrap();
    connector
        .connect(ServerName::try_from(sni.to_owned()).unwrap(), tcp)
        .await
        .unwrap()
}

async fn h1_get<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S, host: &str) -> String {
    let req = format!("GET /api HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    read_all(stream).await
}

/// Host/SNI confusion row: TLS for `a.test` (tenant A), `Host: b.test`
/// (tenant B) → 421 `RENOX_HOST_MISMATCH`, not dispatched. Another hostname
/// of the same tenant on the same connection is served.
#[tokio::test]
async fn sni_for_one_tenant_and_host_for_another_is_421() {
    let tls = start_tls(ProtocolLimits::default()).await;
    let s = &tls.server;

    let mut conn = tls_connect(s.addr, &tls.connector_h1, "a.test").await;
    let out = h1_get(&mut conn, "b.test").await;
    assert!(out.starts_with("HTTP/1.1 421 "), "{out}");
    assert!(out.contains("\"code\":\"RENOX_HOST_MISMATCH\""), "{out}");
    // The fixed message of the `errors.md` row.
    assert!(
        out.contains("\"message\":\"The request was sent to the wrong host.\""),
        "{out}"
    );
    assert!(
        out.to_ascii_lowercase().contains("x-renox-request-id: "),
        "{out}"
    );
    assert_eq!(s.cell.count(), 0);
    assert_eq!(s.gateway.stats().host_mismatch, 1);

    let mut conn = tls_connect(s.addr, &tls.connector_h1, "a.test").await;
    let out = h1_get(&mut conn, "www.a.test").await;
    assert!(out.starts_with("HTTP/1.1 200 "), "{out}");
    assert!(out.contains("tenant=t_a"), "{out}");

    let mut conn = tls_connect(s.addr, &tls.connector_h1, "b.test").await;
    let out = h1_get(&mut conn, "b.test").await;
    assert!(out.contains("tenant=t_b"), "{out}");
    assert_eq!(s.cell.count(), 2);
}

/// Same row over HTTP/2: `:authority` is checked against the SNI like `Host`.
#[tokio::test]
async fn h2_authority_for_another_tenant_is_421() {
    let tls = start_tls(ProtocolLimits::default()).await;
    let s = &tls.server;
    let conn = tls_connect(s.addr, &tls.connector_h2, "a.test").await;
    let (client, connection) = h2::client::handshake(conn).await.unwrap();
    tokio::spawn(connection);
    let mut client = client.ready().await.unwrap();

    for (authority, want) in [("b.test", 421), ("www.a.test", 200)] {
        let req = Request::get(format!("https://{authority}/api"))
            .body(())
            .unwrap();
        let (resp, _) = client.send_request(req, true).unwrap();
        let resp = resp.await.unwrap();
        assert_eq!(resp.status().as_u16(), want, "{authority}");
        client = client.ready().await.unwrap();
    }
    assert_eq!(s.cell.count(), 1);
}

/// Resident set size of this process, in bytes (Linux).
fn rss_bytes() -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    let kb: u64 = status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|v| v.trim().trim_end_matches("kB").trim().parse().ok())
        .unwrap();
    kb * 1024
}

/// Opens up to 1,000 streams on one HTTP/2 connection, resetting each one
/// right after its `HEADERS`. Returns once the server closed the connection
/// (panics after 10 s): the number of resets the client sent.
async fn rapid_reset(tls: &TlsServer) -> usize {
    let conn = tls_connect(tls.server.addr, &tls.connector_h2, "a.test").await;
    let (mut client, connection) = h2::client::handshake(conn).await.unwrap();
    let connection = tokio::spawn(connection);
    let mut sent = 0;
    for _ in 0..1000 {
        client = match client.ready().await {
            Ok(c) => c,
            Err(_) => break,
        };
        let req = Request::get("https://a.test/api").body(()).unwrap();
        let Ok((_resp, mut stream)) = client.send_request(req, false) else {
            break;
        };
        stream.send_reset(h2::Reason::CANCEL);
        sent += 1;
    }
    let closed = tokio::time::timeout(Duration::from_secs(10), connection).await;
    assert!(closed.is_ok(), "connection still open after {sent} resets");
    sent
}

/// HTTP/2 rapid reset row: a client opens 1,000 streams and resets each one
/// immediately. With the default limits the connection is closed (by the
/// gateway's reset budget or by hyper's pending-accept reset limit, whichever
/// trips first), at most budget + 1 streams reach the dispatcher, and the
/// process RSS grows by less than 10 MB.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h2_rapid_reset_closes_the_connection_within_the_budget() {
    let _rss = RSS_LOCK.lock().await;
    let protocol = ProtocolLimits::default();
    let tls = start_tls(protocol).await;
    let s = &tls.server;

    // Warm up the TLS and HTTP/2 paths so one-time allocations are not
    // counted against the attack.
    {
        let conn = tls_connect(s.addr, &tls.connector_h2, "a.test").await;
        let (client, connection) = h2::client::handshake(conn).await.unwrap();
        tokio::spawn(connection);
        let mut client = client.ready().await.unwrap();
        let (resp, _) = client
            .send_request(Request::get("https://a.test/api").body(()).unwrap(), true)
            .unwrap();
        assert_eq!(resp.await.unwrap().status(), StatusCode::OK);
    }
    let dispatched_before = s.cell.count();
    let rss_before = rss_bytes();

    rapid_reset(&tls).await;
    let dispatched = s.cell.count() - dispatched_before;
    assert!(
        dispatched <= protocol.h2_max_resets_per_second as usize + 1,
        "{dispatched} streams dispatched"
    );
    let grown = rss_bytes().saturating_sub(rss_before);
    assert!(grown < 10 * 1024 * 1024, "RSS grew by {grown} bytes");

    // The gateway still serves new connections.
    let mut conn = tls_connect(s.addr, &tls.connector_h1, "a.test").await;
    assert!(
        h1_get(&mut conn, "a.test")
            .await
            .starts_with("HTTP/1.1 200 ")
    );
}

/// HTTP/2 rapid reset row, the gateway's own budget alone: with hyper's
/// pending-accept limit out of the way, the `RST_STREAM` counter closes the
/// connection after `h2_max_resets_per_second` resets.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h2_reset_budget_alone_closes_the_connection() {
    let protocol = ProtocolLimits {
        h2_max_resets_per_second: 50,
        h2_max_pending_accept_reset_streams: 100_000,
        ..ProtocolLimits::default()
    };
    let tls = start_tls(protocol).await;
    let sent = rapid_reset(&tls).await;
    assert!(sent > 50, "only {sent} resets sent");
    // The counter is bumped before the server drops the socket; allow the
    // client to see the close first.
    let deadline = Instant::now() + Duration::from_secs(2);
    while tls.server.gateway.stats().protocol_refused == 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(tls.server.gateway.stats().protocol_refused, 1);
    assert!(tls.server.cell.count() <= 51, "{}", tls.server.cell.count());
}

/// HTTP/2 stream flood row: the server advertises
/// `SETTINGS_MAX_CONCURRENT_STREAMS` = 128.
#[tokio::test]
async fn h2_advertises_max_concurrent_streams() {
    let tls = start_tls(ProtocolLimits::default()).await;
    let conn = tls_connect(tls.server.addr, &tls.connector_h2, "a.test").await;
    let (client, connection) = h2::client::handshake(conn).await.unwrap();
    tokio::spawn(connection);
    let client = client.ready().await.unwrap();
    // The SETTINGS frame arrives with the handshake response; one request
    // round trip guarantees it was processed.
    let mut client = client;
    let (resp, _) = client
        .send_request(Request::get("https://a.test/api").body(()).unwrap(), true)
        .unwrap();
    resp.await.unwrap();
    assert_eq!(client.current_max_send_streams(), 128);
}

// ---------------------------------------------------------------------------
// HTTP/2 flood budgets beyond RST_STREAM (#166), with hand-written frames
// ---------------------------------------------------------------------------

/// Serialises the tests that measure RSS, so one flood's allocations are not
/// counted against another.
static RSS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const FRAME_DATA: u8 = 0x0;
const FRAME_HEADERS: u8 = 0x1;
const FRAME_PRIORITY: u8 = 0x2;
const FRAME_RST_STREAM: u8 = 0x3;
const FRAME_SETTINGS: u8 = 0x4;
const FRAME_PING: u8 = 0x6;
const FRAME_GOAWAY: u8 = 0x7;
const FRAME_WINDOW_UPDATE: u8 = 0x8;
const FRAME_CONTINUATION: u8 = 0x9;
const END_HEADERS: u8 = 0x4;
const ENHANCE_YOUR_CALM: u32 = 0xb;

fn raw_frame(kind: u8, flags: u8, stream: u32, payload: &[u8]) -> Vec<u8> {
    let len = (payload.len() as u32).to_be_bytes();
    let mut f = vec![len[1], len[2], len[3], kind, flags];
    f.extend(stream.to_be_bytes());
    f.extend(payload);
    f
}

/// `GET https://a.test/` in HPACK, static-table indexes only.
fn get_block() -> Vec<u8> {
    let mut b = vec![0x82, 0x87, 0x84, 0x01, 6];
    b.extend(b"a.test");
    b
}

/// A request whose body never comes (no `END_STREAM`): the stream stays
/// open and the gateway waits for the body before any dispatch.
fn open_stream(stream: u32) -> Vec<u8> {
    raw_frame(FRAME_HEADERS, END_HEADERS, stream, &get_block())
}

/// A frame the server sent, as the raw client saw it.
#[derive(Debug)]
struct ServerFrame {
    kind: u8,
    /// Error code of a `RST_STREAM` or `GOAWAY`.
    code: u32,
}

/// What the raw client saw before the server closed the connection.
struct Seen {
    frames: Vec<ServerFrame>,
    /// The server closed the connection within 10 s.
    closed: bool,
}

impl Seen {
    fn count(&self, kind: u8, code: impl Fn(u32) -> bool) -> usize {
        self.frames
            .iter()
            .filter(|f| f.kind == kind && code(f.code))
            .count()
    }
}

/// An HTTP/2 client that writes hand-written frames over TLS (ALPN `h2`)
/// and records every frame the server sends until it closes the connection.
struct RawH2 {
    write: tokio::io::WriteHalf<tokio_rustls::client::TlsStream<TcpStream>>,
    reader: tokio::task::JoinHandle<Seen>,
}

impl RawH2 {
    async fn connect(tls: &TlsServer) -> RawH2 {
        let conn = tls_connect(tls.server.addr, &tls.connector_h2, "a.test").await;
        let (mut read, mut write) = tokio::io::split(conn);
        let mut hello = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".to_vec();
        hello.extend(raw_frame(FRAME_SETTINGS, 0, 0, &[]));
        write.write_all(&hello).await.unwrap();
        let reader = tokio::spawn(async move {
            let mut frames = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                let mut head = [0u8; 9];
                match tokio::time::timeout(left, read.read_exact(&mut head)).await {
                    Err(_) => {
                        return Seen {
                            frames,
                            closed: false,
                        };
                    }
                    Ok(Err(_)) => {
                        return Seen {
                            frames,
                            closed: true,
                        };
                    }
                    Ok(Ok(_)) => {}
                }
                let len = u32::from_be_bytes([0, head[0], head[1], head[2]]) as usize;
                let mut payload = vec![0; len];
                if read.read_exact(&mut payload).await.is_err() {
                    return Seen {
                        frames,
                        closed: true,
                    };
                }
                let code = match head[3] {
                    FRAME_RST_STREAM if len == 4 => {
                        u32::from_be_bytes(payload[..4].try_into().unwrap())
                    }
                    FRAME_GOAWAY if len >= 8 => {
                        u32::from_be_bytes(payload[4..8].try_into().unwrap())
                    }
                    _ => 0,
                };
                frames.push(ServerFrame {
                    kind: head[3],
                    code,
                });
            }
        });
        RawH2 { write, reader }
    }

    /// Writes `bytes`; `false` once the server has closed the connection.
    async fn send(&mut self, bytes: &[u8]) -> bool {
        self.write.write_all(bytes).await.is_ok() && self.write.flush().await.is_ok()
    }

    /// Writes each batch until the server closes the connection, then waits
    /// for the reader.
    async fn flood(mut self, batches: impl IntoIterator<Item = Vec<u8>>) -> Seen {
        for batch in batches {
            if !self.send(&batch).await {
                break;
            }
        }
        self.reader.await.unwrap()
    }
}

/// Waits up to 2 s for the server-side counter: it is bumped before the
/// socket is dropped, but the client can see the close first.
async fn wait_refused(gateway: &Gateway, want: u64) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while gateway.stats().protocol_refused < want && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(gateway.stats().protocol_refused, want);
}

/// Opens one stream and runs a simple request, so one-time TLS and HTTP/2
/// allocations are not counted against a flood.
async fn warm_up(tls: &TlsServer) {
    let conn = tls_connect(tls.server.addr, &tls.connector_h2, "a.test").await;
    let (client, connection) = h2::client::handshake(conn).await.unwrap();
    tokio::spawn(connection);
    let mut client = client.ready().await.unwrap();
    let (resp, _) = client
        .send_request(Request::get("https://a.test/api").body(()).unwrap(), true)
        .unwrap();
    assert_eq!(resp.await.unwrap().status(), StatusCode::OK);
}

/// HTTP/2 rapid reset and stream floods row (#166 finding 1): the reset
/// budget is per client IP as well as per connection. Two connections from
/// one IP, each under the per-connection budget, together go over the
/// per-IP budget; the second connection is closed. Nothing is dispatched
/// (no request body ever arrives).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h2_resets_across_connections_hit_the_per_ip_budget() {
    let protocol = ProtocolLimits {
        h2_max_resets_per_second: 50,
        h2_max_resets_per_ip_per_second: 60,
        h2_max_pending_accept_reset_streams: 100_000,
        ..ProtocolLimits::default()
    };
    let tls = start_tls(protocol).await;
    let resets = |count: u32| {
        let mut b = Vec::new();
        for i in 0..count {
            let id = 2 * i + 1;
            b.extend(open_stream(id));
            b.extend(raw_frame(FRAME_RST_STREAM, 0, id, &8u32.to_be_bytes()));
        }
        b
    };

    let mut first = RawH2::connect(&tls).await;
    assert!(first.send(&resets(40)).await);
    let second = RawH2::connect(&tls).await;
    let seen = second.flood([resets(40)]).await;
    assert!(seen.closed, "second connection still open");
    wait_refused(&tls.server.gateway, 1).await;
    // The first connection is under both budgets and still open.
    assert!(first.send(&raw_frame(FRAME_PING, 0, 0, &[0; 8])).await);
    assert!(!first.reader.is_finished());
    assert_eq!(tls.server.cell.count(), 0);
}

/// HTTP/2 rapid reset and stream floods row (#166 finding 2,
/// "MadeYouReset"): the client never sends `RST_STREAM`; it sends a frame
/// that makes the server reset the stream (a `WINDOW_UPDATE` that overflows
/// the stream's send window, `FLOW_CONTROL_ERROR`). Those server resets cost
/// the same budget: the connection is closed after
/// `h2_max_resets_per_second` of them, long before h2's lifetime limit
/// (`h2_max_local_error_reset_streams`, set out of the way here), and RSS
/// stays bounded.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h2_server_provoked_resets_close_the_connection() {
    let _rss = RSS_LOCK.lock().await;
    let protocol = ProtocolLimits {
        h2_max_resets_per_second: 20,
        h2_max_local_error_reset_streams: 100_000,
        h2_max_pending_accept_reset_streams: 100_000,
        ..ProtocolLimits::default()
    };
    let tls = start_tls(protocol).await;
    warm_up(&tls).await;
    let rss_before = rss_bytes();

    let raw = RawH2::connect(&tls).await;
    let batches = (0..1000u32).map(|i| {
        let id = 2 * i + 1;
        let mut b = open_stream(id);
        b.extend(raw_frame(
            FRAME_WINDOW_UPDATE,
            0,
            id,
            &0x7fff_ffffu32.to_be_bytes(),
        ));
        b
    });
    let seen = raw.flood(batches).await;
    assert!(seen.closed, "connection still open");
    let provoked = seen.count(FRAME_RST_STREAM, |c| ![0x0, 0x2, 0x8].contains(&c));
    assert!(provoked > 0, "no server reset seen: {:?}", seen.frames);
    // The reset over the budget is never written.
    assert!(provoked <= 20, "{provoked} server resets");
    wait_refused(&tls.server.gateway, 1).await;
    assert_eq!(
        tls.server.cell.count(),
        1,
        "only the warm-up was dispatched"
    );
    let grown = rss_bytes().saturating_sub(rss_before);
    assert!(grown < 10 * 1024 * 1024, "RSS grew by {grown} bytes");
}

/// One control-frame flood with the default limits: `prefix`, then 10,000
/// frames of one kind, sent as fast as the socket takes them. The
/// connection is closed by the control-frame budget (2,000 frames burst),
/// nothing is dispatched, and RSS grows by less than 10 MB.
async fn control_flood(what: &str, prefix: Vec<u8>, frame: Vec<u8>) {
    let _rss = RSS_LOCK.lock().await;
    let tls = start_tls(ProtocolLimits::default()).await;
    warm_up(&tls).await;
    let dispatched = tls.server.cell.count();
    let rss_before = rss_bytes();

    let raw = RawH2::connect(&tls).await;
    let batch: Vec<u8> = frame.repeat(500);
    let batches = std::iter::once(prefix).chain(std::iter::repeat_n(batch, 20));
    let seen = raw.flood(batches).await;
    assert!(seen.closed, "{what}: connection still open");
    wait_refused(&tls.server.gateway, 1).await;
    assert_eq!(tls.server.cell.count(), dispatched, "{what}");
    let grown = rss_bytes().saturating_sub(rss_before);
    assert!(
        grown < 10 * 1024 * 1024,
        "{what}: RSS grew by {grown} bytes"
    );
}

/// HTTP/2 rapid reset and stream floods row, control frames (#166 finding
/// 3): `PING` (CVE-2019-9512).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h2_ping_flood_closes_the_connection() {
    control_flood("PING", vec![], raw_frame(FRAME_PING, 0, 0, &[7; 8])).await;
}

/// HTTP/2 rapid reset and stream floods row, control frames: empty `SETTINGS` (CVE-2019-9515).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h2_settings_flood_closes_the_connection() {
    control_flood("SETTINGS", vec![], raw_frame(FRAME_SETTINGS, 0, 0, &[])).await;
}

/// HTTP/2 rapid reset and stream floods row, control frames: connection-level `WINDOW_UPDATE` of one
/// byte each (CVE-2019-9517 style).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h2_window_update_flood_closes_the_connection() {
    let frame = raw_frame(FRAME_WINDOW_UPDATE, 0, 0, &1u32.to_be_bytes());
    control_flood("WINDOW_UPDATE", vec![], frame).await;
}

/// HTTP/2 rapid reset and stream floods row, control frames: `PRIORITY` frames on idle streams
/// (CVE-2019-9513).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h2_priority_flood_closes_the_connection() {
    let frame = raw_frame(FRAME_PRIORITY, 0, 3, &[0, 0, 0, 0, 16]);
    control_flood("PRIORITY", vec![], frame).await;
}

/// A flood that h2 0.4.20 refuses itself, before the gateway's budgets:
/// `prefix`, then 10,000 copies of `frame`. The connection gets `GOAWAY
/// ENHANCE_YOUR_CALM` and is closed, nothing is dispatched, and RSS grows
/// by less than 10 MB. These tests pin h2's behaviour: if an h2 upgrade
/// drops a limit, they fail.
async fn h2_refused_flood(what: &str, prefix: Vec<u8>, frame: Vec<u8>) {
    let _rss = RSS_LOCK.lock().await;
    let tls = start_tls(ProtocolLimits::default()).await;
    warm_up(&tls).await;
    let rss_before = rss_bytes();

    let raw = RawH2::connect(&tls).await;
    let batches = std::iter::once(prefix).chain(std::iter::repeat_n(frame.repeat(500), 20));
    let seen = raw.flood(batches).await;
    assert!(seen.closed, "{what}: connection still open");
    assert_eq!(
        seen.count(FRAME_GOAWAY, |c| c == ENHANCE_YOUR_CALM),
        1,
        "{what}: {:?}",
        seen.frames
    );
    // h2's limit, not the gateway's budgets.
    assert_eq!(tls.server.gateway.stats().protocol_refused, 0, "{what}");
    assert_eq!(
        tls.server.cell.count(),
        1,
        "{what}: only the warm-up was dispatched"
    );
    let grown = rss_bytes().saturating_sub(rss_before);
    assert!(
        grown < 10 * 1024 * 1024,
        "{what}: RSS grew by {grown} bytes"
    );
}

/// HTTP/2 rapid reset and stream floods row, control frames: `CONTINUATION`
/// (CVE-2024-27316 class). h2 refuses a header block of more than
/// `max(5, 1.25 × header list size / frame size)` frames.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h2_continuation_flood_is_refused_by_h2() {
    let block = get_block();
    let mut start = raw_frame(FRAME_HEADERS, 0, 1, &block[..1]);
    start.extend(raw_frame(FRAME_CONTINUATION, 0, 1, &block[1..2]));
    let frame = raw_frame(FRAME_CONTINUATION, 0, 1, &[]);
    h2_refused_flood("CONTINUATION", start, frame).await;
}

/// HTTP/2 rapid reset and stream floods row, control frames: empty `DATA`
/// frames on an open stream (CVE-2019-9518). h2 refuses more than 100 empty
/// non-final `DATA` frames per connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h2_empty_data_flood_is_refused_by_h2() {
    let frame = raw_frame(FRAME_DATA, 0, 1, &[]);
    h2_refused_flood("empty DATA", open_stream(1), frame).await;
}

/// The budgets do not fire on normal traffic: 300 requests on one
/// connection, each with a body sent in several `DATA` frames, all answered.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h2_normal_traffic_stays_within_the_budgets() {
    let tls = start_tls(ProtocolLimits::default()).await;
    let conn = tls_connect(tls.server.addr, &tls.connector_h2, "a.test").await;
    let (client, connection) = h2::client::handshake(conn).await.unwrap();
    tokio::spawn(connection);
    let mut client = client.ready().await.unwrap();
    for _ in 0..300 {
        let req = Request::post("https://a.test/api").body(()).unwrap();
        let (resp, mut body) = client.send_request(req, false).unwrap();
        for chunk in [&b"a"[..], b"b", b"c"] {
            body.send_data(bytes::Bytes::from_static(chunk), false)
                .unwrap();
        }
        body.send_data(bytes::Bytes::new(), true).unwrap();
        assert_eq!(resp.await.unwrap().status(), StatusCode::OK);
        client = client.ready().await.unwrap();
    }
    assert_eq!(tls.server.gateway.stats().protocol_refused, 0);
    assert_eq!(tls.server.cell.count(), 300);
}

// ---------------------------------------------------------------------------
// Static assets: cache key
// ---------------------------------------------------------------------------

/// Cache poisoning row: a static response depends only on the deployment
/// (content hash, from the hostname's route entry) and the path. Request
/// headers that a cache would not key on (`Accept-Encoding`,
/// `X-Forwarded-Host`, `X-Original-URL`, a second casing of `Host`) never
/// change it, and no `Vary` is set.
#[tokio::test]
async fn static_response_ignores_unkeyed_headers() {
    let dir = tempfile::tempdir().unwrap();
    write_public(
        dir.path(),
        HASH_A,
        &[("app.3f2a9c1b.js", b"console.log(1)", "text/javascript")],
    );
    write_public(
        dir.path(),
        HASH_B,
        &[("app.3f2a9c1b.js", b"console.log(2)", "text/javascript")],
    );
    let gw = gateway(dir.path());
    let router = gw.router(FakeDispatcher::new());

    let fetch = |host: &str, extra: &[(&str, &str)]| {
        let mut req = request(host, "/app.3f2a9c1b.js");
        for (k, v) in extra {
            let name = axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap();
            req.headers_mut().insert(name, v.parse().unwrap());
        }
        let router = router.clone();
        async move {
            let resp = router.oneshot(req).await.unwrap();
            let headers = resp.headers().clone();
            let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap();
            (headers, body)
        }
    };

    let (base_headers, base_body) = fetch("a.test", &[]).await;
    assert_eq!(&base_body[..], b"console.log(1)");
    assert!(base_headers.get("vary").is_none());
    for extra in [
        &[("accept-encoding", "br, gzip")][..],
        &[("x-forwarded-host", "b.test")],
        &[
            ("x-original-url", "/other.js"),
            ("x-rewrite-url", "/other.js"),
        ],
        &[("x-forwarded-proto", "http"), ("forwarded", "host=b.test")],
    ] {
        let (headers, body) = fetch("A.TEST", extra).await;
        assert_eq!(body, base_body, "{extra:?}");
        assert!(headers.get("vary").is_none(), "{extra:?}");
        assert_eq!(headers.get("etag"), base_headers.get("etag"), "{extra:?}");
        assert_eq!(
            headers.get("content-type"),
            base_headers.get("content-type")
        );
    }
    // Another tenant's hostname gets its own deployment's file.
    let (_, body) = fetch("b.test", &[("x-forwarded-host", "a.test")]).await;
    assert_eq!(&body[..], b"console.log(2)");
}
