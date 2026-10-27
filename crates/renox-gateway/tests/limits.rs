//! Input limits at the gateway (#88), proven with raw TCP clients against
//! `Gateway::serve`. Every test also checks that the fake dispatcher saw no
//! call for the rejected request: a hostile client never reaches a cell.

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::*;
use renox_gateway::{Gateway, GatewayConfig, GatewayLimits, RouteStatus, RouteTable};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tower::ServiceExt;

fn gateway_with(limits: GatewayLimits, root: &std::path::Path) -> Gateway {
    let routes = Arc::new(RouteTable::new());
    routes
        .upsert(entry("a.test", "t_a", HASH_A, RouteStatus::Active))
        .unwrap();
    let mut config = GatewayConfig::new(root);
    config.limits = limits;
    // Keep the rate limiter out of the way of the connection tests.
    config.rate_limit.burst = 10_000;
    Gateway::new(config, routes)
}

async fn start(limits: GatewayLimits) -> (SocketAddr, Arc<FakeDispatcher>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let gw = gateway_with(limits, dir.path());
    let cell = FakeDispatcher::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let dispatcher = cell.clone();
    tokio::spawn(async move { gw.serve(listener, dispatcher).await });
    (addr, cell, dir)
}

/// Reads until EOF, a reset, or 15 s; returns what arrived.
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

/// `docs/23-failure-modes.md` section 2, "header too large": a 20 KB header
/// → 431, connection closed, no cell touched.
#[tokio::test]
async fn header_over_16kb_is_431() {
    let (addr, cell, _dir) = start(GatewayLimits::default()).await;
    let mut s = TcpStream::connect(addr).await.unwrap();
    let big = "a".repeat(20 * 1024);
    let req = format!("GET / HTTP/1.1\r\nHost: a.test\r\nX-Big: {big}\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let out = read_all(&mut s).await;
    assert!(out.starts_with("HTTP/1.1 431"), "{out:?}");
    assert_eq!(cell.count(), 0);
}

/// `docs/23-failure-modes.md` section 2, "too many headers": 200 headers → 431.
#[tokio::test]
async fn two_hundred_headers_is_431() {
    let (addr, cell, _dir) = start(GatewayLimits::default()).await;
    let mut s = TcpStream::connect(addr).await.unwrap();
    let mut req = String::from("GET / HTTP/1.1\r\nHost: a.test\r\n");
    for i in 0..200 {
        req.push_str(&format!("X-H{i}: v\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let out = read_all(&mut s).await;
    assert!(out.starts_with("HTTP/1.1 431"), "{out:?}");
    assert_eq!(cell.count(), 0);

    // 99 headers plus Host is within the limit.
    let mut s = TcpStream::connect(addr).await.unwrap();
    let mut req = String::from("GET / HTTP/1.1\r\nHost: a.test\r\nConnection: close\r\n");
    for i in 0..98 {
        req.push_str(&format!("X-H{i}: v\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let out = read_all(&mut s).await;
    assert!(out.starts_with("HTTP/1.1 200"), "{out:?}");
}

/// `docs/23-failure-modes.md` section 2, "Request body over limit": a 2 MB
/// body on a function route → 413 `RENOX_BODY_TOO_LARGE` before any body byte
/// is read, and the dispatcher is never called.
#[tokio::test]
async fn two_mb_body_is_413_and_never_dispatched() {
    let (addr, cell, _dir) = start(GatewayLimits::default()).await;
    let mut s = TcpStream::connect(addr).await.unwrap();
    let req = "POST /api/upload HTTP/1.1\r\nHost: a.test\r\nContent-Type: application/octet-stream\r\nContent-Length: 2097152\r\n\r\n";
    s.write_all(req.as_bytes()).await.unwrap();
    let out = read_all(&mut s).await;
    assert!(out.starts_with("HTTP/1.1 413"), "{out:?}");
    let lower = out.to_ascii_lowercase();
    assert!(lower.contains("content-type: application/json"), "{out}");
    assert!(lower.contains("cache-control: no-store"), "{out}");
    assert!(lower.contains("x-renox-request-id: "), "{out}");
    assert!(out.contains("\"code\":\"RENOX_BODY_TOO_LARGE\""), "{out}");
    assert!(
        out.contains("\"message\":\"The request body is too large.\""),
        "{out}"
    );
    assert_eq!(cell.count(), 0);
}

/// `docs/23-failure-modes.md` section 2, "Slowloris": a client that sends one
/// byte per second is closed at the header read timeout.
#[tokio::test]
async fn one_byte_per_second_is_closed_at_the_header_timeout() {
    let limits = GatewayLimits {
        header_read_timeout: Duration::from_secs(2),
        ..GatewayLimits::default()
    };
    let (addr, cell, _dir) = start(limits).await;
    let s = TcpStream::connect(addr).await.unwrap();
    let (mut rd, mut wr) = s.into_split();
    let started = Instant::now();
    let writer = tokio::spawn(async move {
        for b in b"GET / HTTP/1.1\r\nHost: a.test\r\nX-Slow: aaaaaaaaaaaaaaaa\r\n\r\n" {
            if wr.write_all(&[*b]).await.is_err() {
                return;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    let mut buf = [0u8; 1024];
    let closed = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match rd.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    })
    .await;
    let elapsed = started.elapsed();
    writer.abort();
    assert!(closed.is_ok(), "connection still open after 10 s");
    assert!(
        elapsed >= Duration::from_millis(1500) && elapsed < Duration::from_secs(5),
        "closed after {elapsed:?}"
    );
    assert_eq!(cell.count(), 0);
}

/// `docs/23-failure-modes.md` section 2, "idle connections": a keep-alive
/// connection that moves no bytes is closed at the idle timeout.
#[tokio::test]
async fn idle_connection_is_closed_at_the_idle_timeout() {
    let limits = GatewayLimits {
        idle_timeout: Duration::from_secs(1),
        ..GatewayLimits::default()
    };
    let (addr, cell, _dir) = start(limits).await;
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(b"GET / HTTP/1.1\r\nHost: a.test\r\n\r\n")
        .await
        .unwrap();
    let mut buf = [0u8; 4096];
    let n = s.read(&mut buf).await.unwrap();
    assert!(buf[..n].starts_with(b"HTTP/1.1 200"));
    let started = Instant::now();
    let out = read_all(&mut s).await;
    let elapsed = started.elapsed();
    assert!(out.is_empty() || out.ends_with("tenant=t_a"), "{out:?}");
    assert!(
        elapsed >= Duration::from_millis(500) && elapsed < Duration::from_secs(4),
        "closed after {elapsed:?}"
    );
    assert_eq!(cell.count(), 1);
}

/// `docs/23-failure-modes.md` section 2, "max connections per IP": 101 idle
/// connections from one IP → the 101st is refused with 503, and a slot is
/// free again once a connection closes.
#[tokio::test]
async fn connection_101_from_one_ip_is_rejected() {
    let (addr, cell, _dir) = start(GatewayLimits::default()).await;
    let mut open = Vec::new();
    for _ in 0..100 {
        open.push(TcpStream::connect(addr).await.unwrap());
    }
    let mut extra = TcpStream::connect(addr).await.unwrap();
    let out = read_all(&mut extra).await;
    assert!(out.starts_with("HTTP/1.1 503"), "{out:?}");
    assert_eq!(cell.count(), 0);

    // The 100 held connections are still served.
    let s = open.last_mut().unwrap();
    s.write_all(b"GET / HTTP/1.1\r\nHost: a.test\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let out = read_all(s).await;
    assert!(out.starts_with("HTTP/1.1 200"), "{out:?}");
    open.pop();

    // A slot was released: a new connection is accepted.
    let mut again = None;
    for _ in 0..50 {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(b"GET / HTTP/1.1\r\nHost: a.test\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let out = read_all(&mut s).await;
        if out.starts_with("HTTP/1.1 200") {
            again = Some(out);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(again.is_some(), "no slot was released");
}

/// A chunked body (unknown length) is read only up to the limit; one byte
/// more → 413 and no dispatch. Under the limit the cell gets the whole body.
#[tokio::test]
async fn chunked_body_is_cut_at_the_limit() {
    let dir = tempfile::tempdir().unwrap();
    let limits = GatewayLimits {
        max_body_bytes_default: 1000,
        ..GatewayLimits::default()
    };
    let gw = gateway_with(limits, dir.path());
    let cell = FakeDispatcher::new();
    let app = gw.router(cell.clone());

    let stream_body = |chunks: usize| {
        let chunks = (0..chunks).map(|_| Ok::<_, std::io::Error>(vec![b'x'; 100]));
        Body::from_stream(futures_util::stream::iter(chunks))
    };
    let mut req = request("a.test", "/api/upload");
    *req.method_mut() = axum::http::Method::POST;
    *req.body_mut() = stream_body(11);
    req.headers_mut()
        .insert("accept", "text/html".parse().unwrap());
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        resp.headers()["content-type"],
        "text/html; charset=utf-8",
        "HTML default page when the client prefers HTML"
    );
    assert_eq!(cell.count(), 0);
    assert_eq!(gw.stats().body_too_large, 1);

    let mut req: Request<Body> = request("a.test", "/api/upload");
    *req.method_mut() = axum::http::Method::POST;
    *req.body_mut() = stream_body(10);
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers()["x-body-len"], "1000");
    assert_eq!(cell.count(), 1);
}
