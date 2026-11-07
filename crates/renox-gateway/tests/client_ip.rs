//! The client address behind a trusted edge (#414, ADR D25), proven over
//! real sockets: TCP with `trusted_proxies`, and the production layout, a
//! unix socket whose trusted peer is chosen by uid (`SO_PEERCRED`).
//!
//! `docs/24-threat-model.md` A, "Forged client-IP header" and "Local
//! process forges the client-IP header".

#![cfg(unix)]

mod common;

use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use common::*;
use renox_gateway::{
    ClientIpConfig, Gateway, GatewayConfig, GatewayLimits, IpNet, RouteStatus, RouteTable,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream};

const FORGED: &str = "203.0.113.66";

fn gateway(root: &Path, client_ip: ClientIpConfig, f: impl FnOnce(&mut GatewayConfig)) -> Gateway {
    let routes = Arc::new(RouteTable::new());
    routes
        .upsert(entry("a.test", "t_a", HASH_A, RouteStatus::Active))
        .unwrap();
    let mut config = GatewayConfig::new(root);
    config.client_ip = client_ip;
    config.rate_limit.burst = 10_000;
    f(&mut config);
    Gateway::new(config, routes)
}

fn trusting(nets: &[&str]) -> ClientIpConfig {
    ClientIpConfig {
        trusted_proxies: nets.iter().map(|n| IpNet::parse(n).unwrap()).collect(),
        ..ClientIpConfig::default()
    }
}

/// This process's uid: the owner of `/proc/self`.
fn own_uid() -> u32 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata("/proc/self").unwrap().uid()
}

async fn tcp(
    client_ip: ClientIpConfig,
    f: impl FnOnce(&mut GatewayConfig),
) -> (std::net::SocketAddr, Arc<FakeDispatcher>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let gw = gateway(dir.path(), client_ip, f);
    let cell = FakeDispatcher::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let d = cell.clone();
    tokio::spawn(async move { gw.serve(listener, d).await });
    (addr, cell, dir)
}

async fn unix(
    client_ip: ClientIpConfig,
) -> (std::path::PathBuf, Arc<FakeDispatcher>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let gw = gateway(dir.path(), client_ip, |_| {});
    let cell = FakeDispatcher::new();
    let path = dir.path().join("worker.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let d = cell.clone();
    tokio::spawn(async move { gw.serve_unix(listener, d).await });
    (path, cell, dir)
}

/// One request with `extra` header lines on a fresh connection; the
/// response head and body.
async fn send<S: AsyncRead + AsyncWrite + Unpin>(mut s: S, extra: &str) -> String {
    let req = format!("GET /x HTTP/1.1\r\nHost: a.test\r\nConnection: close\r\n{extra}\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), s.read_to_end(&mut out)).await;
    String::from_utf8_lossy(&out).into_owned()
}

const FORWARDING: &str = "CF-Connecting-IP: 203.0.113.66\r\nX-Forwarded-For: 203.0.113.66\r\nX-Forwarded-Proto: https\r\nTrue-Client-IP: 203.0.113.66\r\nX-Real-IP: 203.0.113.66\r\nForwarded: for=203.0.113.66\r\n";

/// No forwarding header reaches tenant code, from any peer; tenant code
/// sees the derived address in `x-renox-client-ip` only.
fn assert_stripped(cell: &FakeDispatcher, want_ip: &str) {
    let (ctx, req) = cell.last();
    assert_eq!(ctx.client_ip.to_string(), want_ip);
    let h = req.headers();
    assert_eq!(h["x-renox-client-ip"], want_ip);
    for name in [
        "cf-connecting-ip",
        "x-forwarded-for",
        "x-forwarded-proto",
        "true-client-ip",
        "x-real-ip",
        "forwarded",
    ] {
        assert!(!h.contains_key(name), "{name} reached the cell");
    }
}

/// `docs/24-threat-model.md` A, "Forged client-IP header": a TCP peer
/// outside `trusted_proxies` keeps its socket address whatever it sends,
/// and the header is removed before dispatch. With the default (empty)
/// list loopback is not trusted either: `renox dev` copies the browser's
/// headers from loopback.
#[tokio::test]
async fn a_forged_header_from_an_untrusted_tcp_peer_is_ignored_and_stripped() {
    for cfg in [ClientIpConfig::default(), trusting(&["10.0.0.0/8"])] {
        let (addr, cell, _dir) = tcp(cfg, |_| {}).await;
        let out = send(TcpStream::connect(addr).await.unwrap(), FORWARDING).await;
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        // No HSTS from a peer that is not the edge.
        assert!(
            !out.to_ascii_lowercase()
                .contains("strict-transport-security"),
            "{out}"
        );
        assert_stripped(&cell, "127.0.0.1");
    }
}

/// From a trusted TCP peer the header names the client, and is still
/// removed before dispatch.
#[tokio::test]
async fn a_trusted_tcp_peer_names_the_client() {
    let (addr, cell, _dir) = tcp(trusting(&["127.0.0.1/32", "::1/128"]), |_| {}).await;
    let out = send(TcpStream::connect(addr).await.unwrap(), FORWARDING).await;
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert_stripped(&cell, FORGED);
    // v6 and v4-mapped values.
    for (value, want) in [
        ("2001:db8::7", "2001:db8::7"),
        ("::ffff:198.51.100.9", "198.51.100.9"),
    ] {
        let out = send(
            TcpStream::connect(addr).await.unwrap(),
            &format!("CF-Connecting-IP: {value}\r\n"),
        )
        .await;
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert_stripped(&cell, want);
    }
    // Malformed, multi-value and repeated headers fall back to the peer.
    for extra in [
        "CF-Connecting-IP: nonsense\r\n",
        "CF-Connecting-IP: 203.0.113.66, 198.51.100.1\r\n",
        "CF-Connecting-IP: 203.0.113.66\r\nCF-Connecting-IP: 198.51.100.1\r\n",
        "X-Forwarded-For: 203.0.113.66\r\n",
    ] {
        let out = send(TcpStream::connect(addr).await.unwrap(), extra).await;
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert_stripped(&cell, "127.0.0.1");
    }
}

/// From a trusted peer the per-IP token bucket keys on the header: two
/// visitors behind one edge have one bucket each, and a visitor over its
/// bucket does not throttle the other.
#[tokio::test]
async fn the_rate_limiter_keys_on_the_trusted_header() {
    let (addr, cell, _dir) = tcp(trusting(&["127.0.0.1/32"]), |c| {
        c.rate_limit.burst = 1;
        c.rate_limit.requests_per_second = 0.001;
    })
    .await;
    let one = "CF-Connecting-IP: 198.51.100.1\r\n";
    let two = "CF-Connecting-IP: 198.51.100.2\r\n";
    assert!(
        send(TcpStream::connect(addr).await.unwrap(), one)
            .await
            .starts_with("HTTP/1.1 200")
    );
    assert!(
        send(TcpStream::connect(addr).await.unwrap(), one)
            .await
            .starts_with("HTTP/1.1 429")
    );
    assert!(
        send(TcpStream::connect(addr).await.unwrap(), two)
            .await
            .starts_with("HTTP/1.1 200")
    );
    assert_eq!(cell.count(), 2);
}

/// A trusted proxy is not capped like one client: past
/// `max_connections_per_ip` open connections from the edge still get in,
/// up to `max_connections_per_trusted_peer`.
#[tokio::test]
async fn a_trusted_peer_has_its_own_connection_cap() {
    let limits = |c: &mut GatewayConfig| {
        c.limits = GatewayLimits {
            max_connections_per_ip: 2,
            max_connections_per_trusted_peer: 4,
            ..GatewayLimits::default()
        }
    };
    let (addr, _cell, _dir) = tcp(trusting(&["127.0.0.1/32"]), limits).await;
    let mut held = Vec::new();
    for _ in 0..4 {
        held.push(TcpStream::connect(addr).await.unwrap());
    }
    // Let the accept loop register the four.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let out = send(TcpStream::connect(addr).await.unwrap(), "").await;
    assert!(out.starts_with("HTTP/1.1 503"), "{out}");
    drop(held);

    // Untrusted, the per-IP cap of 2 applies.
    let (addr, _cell, _dir) = tcp(ClientIpConfig::default(), limits).await;
    let held: Vec<_> = futures_util::future::join_all((0..2).map(|_| TcpStream::connect(addr)))
        .await
        .into_iter()
        .map(Result::unwrap)
        .collect();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let out = send(TcpStream::connect(addr).await.unwrap(), "").await;
    assert!(out.starts_with("HTTP/1.1 503"), "{out}");
    drop(held);
}

/// The production layout: `cloudflared` on the worker's unix socket,
/// trusted by uid. The test process is the trusted user here.
#[tokio::test]
async fn the_trusted_socket_user_names_the_client() {
    let cfg = ClientIpConfig {
        trusted_socket_uids: vec![own_uid()],
        ..ClientIpConfig::default()
    };
    let (path, cell, _dir) = unix(cfg).await;
    let out = send(UnixStream::connect(&path).await.unwrap(), FORWARDING).await;
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert_stripped(&cell, FORGED);
    let (ctx, _) = cell.last();
    assert_eq!(ctx.client_ip, FORGED.parse::<IpAddr>().unwrap());
}

/// `docs/24-threat-model.md` A, "Local process forges the client-IP
/// header": a local process that reaches the worker's socket under a uid
/// other than `cloudflared`'s (a tenant child process, another service) is
/// not a trusted peer. Its `CF-Connecting-IP` (and every other forwarding
/// header) is ignored and removed before dispatch; it is counted as a
/// local peer, so it cannot pick a rate-limit bucket, a client-event origin
/// or a log address. Here the trusted uid is one the test process does not
/// have, so the test's own socket is "another uid".
#[tokio::test]
async fn a_forged_header_from_another_local_uid_is_ignored_and_stripped() {
    let other = own_uid().wrapping_add(1);
    let cfg = ClientIpConfig {
        trusted_socket_uids: vec![other],
        // Even a TCP rule that trusts loopback does not apply to the socket.
        trusted_proxies: vec![IpNet::parse("127.0.0.1/32").unwrap()],
        ..ClientIpConfig::default()
    };
    let (path, cell, _dir) = unix(cfg).await;
    let out = send(UnixStream::connect(&path).await.unwrap(), FORWARDING).await;
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert!(
        !out.to_ascii_lowercase()
            .contains("strict-transport-security"),
        "{out}"
    );
    assert_stripped(&cell, "127.0.0.1");
    // And with no trusted user configured at all.
    let (path, cell, _dir) = unix(ClientIpConfig::default()).await;
    let out = send(UnixStream::connect(&path).await.unwrap(), FORWARDING).await;
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert_stripped(&cell, "127.0.0.1");
}
