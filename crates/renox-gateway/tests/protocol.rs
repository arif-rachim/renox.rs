//! Protocol hardening at the gateway (#107), proven with raw TCP clients
//! that send hand-written bytes (not a well-behaved HTTP client). Every
//! refused request is also checked against the fake dispatcher: it never
//! reaches a cell. HTTP/2, TLS and the SNI/`Host` check left the worker with
//! ADR D25 (#418): they end at Cloudflare's edge, and the plain listener
//! refuses h2c and the HTTP/2 preface (below).
//!
//! Rows proven (`docs/24-threat-model.md` section C): "HTTP request
//! smuggling, `Transfer-Encoding` tricks, h2c upgrade", "HTTP/2 rapid reset
//! and stream floods" (the HTTP/2 preface is refused), "Cache poisoning of
//! static assets".

mod common;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use renox_gateway::{Gateway, GatewayConfig, RouteStatus, RouteTable};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
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
