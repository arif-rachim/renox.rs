//! WebSocket upgrades through the gateway (#281; `docs/contracts/ops.md`
//! 1.5.0 section 18): the gateway checks the handshake, hands the request
//! to the cell with a `WsUpgrade`, and the cell's 101 switches the
//! connection. A refused handshake never reaches the cell.

mod common;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use common::*;
use renox_gateway::upgrade::WsUpgrade;
use renox_gateway::{CellDispatcher, Gateway, GatewayConfig, RequestCtx, RouteStatus, RouteTable};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// A cell that answers `/ws` with a 101 and then sends one text frame
/// `hello`, echoing every client text frame back after it; every other
/// request gets 200 `plain`.
#[derive(Default)]
struct WsCell {
    /// `(path, had a WsUpgrade, had an Upgrade header)` per request.
    seen: Mutex<Vec<(String, bool, bool)>>,
}

impl CellDispatcher for WsCell {
    async fn dispatch(&self, _ctx: RequestCtx, mut req: Request<Body>) -> Response<Body> {
        let upgrade = req.extensions_mut().remove::<WsUpgrade>();
        self.seen.lock().unwrap().push((
            req.uri().path().to_string(),
            upgrade.is_some(),
            req.headers().contains_key("upgrade"),
        ));
        match upgrade {
            Some(u) if req.uri().path() == "/ws" => {
                let response = u.accept();
                tokio::spawn(async move {
                    let Some(mut io) = u.upgraded().await else {
                        return;
                    };
                    let _ = io.write_all(&[0x81, 5, b'h', b'e', b'l', b'l', b'o']).await;
                    // Echo client text frames (masked, < 126 bytes).
                    let mut head = [0u8; 2];
                    while io.read_exact(&mut head).await.is_ok() {
                        let len = (head[1] & 0x7f) as usize;
                        let mut mask = [0u8; 4];
                        let mut payload = vec![0u8; len];
                        if io.read_exact(&mut mask).await.is_err()
                            || io.read_exact(&mut payload).await.is_err()
                        {
                            return;
                        }
                        for (i, b) in payload.iter_mut().enumerate() {
                            *b ^= mask[i % 4];
                        }
                        let mut out = vec![0x81, len as u8];
                        out.extend_from_slice(&payload);
                        if io.write_all(&out).await.is_err() {
                            return;
                        }
                    }
                });
                response
            }
            _ => Response::new(Body::from("plain")),
        }
    }
}

async fn start() -> (SocketAddr, Arc<WsCell>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let routes = Arc::new(RouteTable::new());
    routes
        .upsert(entry("a.test", "t_a", HASH_A, RouteStatus::Active))
        .unwrap();
    let gw = Gateway::new(GatewayConfig::new(dir.path()), routes);
    let cell = Arc::new(WsCell::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let dispatcher = cell.clone();
    tokio::spawn(async move { gw.serve(listener, dispatcher).await });
    (addr, cell, dir)
}

fn handshake(path: &str, version: &str, key: &str) -> String {
    format!(
        "GET {path} HTTP/1.1\r\nHost: a.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: {version}\r\nSec-WebSocket-Key: {key}\r\n\r\n"
    )
}

/// Reads one response head; returns it and what followed it.
async fn read_head(s: &mut TcpStream) -> (String, Vec<u8>) {
    let mut buf = Vec::new();
    loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf[i + 4..].to_vec();
            return (String::from_utf8_lossy(&buf[..i + 4]).into_owned(), rest);
        }
        let mut chunk = [0u8; 4096];
        let n = tokio::time::timeout(Duration::from_secs(10), s.read(&mut chunk))
            .await
            .expect("a response")
            .unwrap();
        assert!(n > 0, "closed: {}", String::from_utf8_lossy(&buf));
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// The handshake through the gateway: 101 with the RFC 6455 accept key,
/// the cell got the `WsUpgrade` without the hop-by-hop `Upgrade` header,
/// and the cell's first frame reaches the client after the 101.
#[tokio::test]
async fn the_cell_answers_101_and_writes_after_it() {
    let (addr, cell, _dir) = start().await;
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(handshake("/ws", "13", "dGhlIHNhbXBsZSBub25jZQ==").as_bytes())
        .await
        .unwrap();
    let (head, mut rest) = read_head(&mut s).await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    let lower = head.to_ascii_lowercase();
    assert!(
        lower.contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo="),
        "{head}"
    );
    assert!(lower.contains("upgrade: websocket"), "{head}");
    while rest.len() < 7 {
        let mut chunk = [0u8; 64];
        let n = s.read(&mut chunk).await.unwrap();
        assert!(n > 0);
        rest.extend_from_slice(&chunk[..n]);
    }
    assert_eq!(&rest[..7], &[0x81, 5, b'h', b'e', b'l', b'l', b'o']);
    let seen = cell.seen.lock().unwrap().clone();
    assert_eq!(seen, vec![("/ws".to_string(), true, false)]);
}

/// A malformed handshake is refused at the gateway: version other than 13
/// is 426 with `Sec-WebSocket-Version: 13`, a bad key 400; the cell is
/// never called.
#[tokio::test]
async fn a_malformed_handshake_never_reaches_the_cell() {
    let (addr, cell, _dir) = start().await;
    for (version, key, status) in [
        ("12", "dGhlIHNhbXBsZSBub25jZQ==", "426"),
        ("13", "short", "400"),
    ] {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(handshake("/ws", version, key).as_bytes())
            .await
            .unwrap();
        let (head, _) = read_head(&mut s).await;
        assert!(head.starts_with(&format!("HTTP/1.1 {status}")), "{head}");
        if status == "426" {
            assert!(
                head.to_ascii_lowercase()
                    .contains("sec-websocket-version: 13"),
                "{head}"
            );
        }
    }
    assert!(cell.seen.lock().unwrap().is_empty());
}

/// A cell that does not upgrade answers normally; the request still carried
/// the `WsUpgrade` (the cell decides).
#[tokio::test]
async fn a_cell_may_decline_the_upgrade() {
    let (addr, cell, _dir) = start().await;
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(handshake("/plain", "13", "dGhlIHNhbXBsZSBub25jZQ==").as_bytes())
        .await
        .unwrap();
    let (head, _) = read_head(&mut s).await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert_eq!(StatusCode::OK.as_u16(), 200);
    let seen = cell.seen.lock().unwrap().clone();
    assert_eq!(seen, vec![("/plain".to_string(), true, false)]);
}

/// One masked client text frame (< 126 bytes).
fn client_frame(payload: &[u8]) -> Vec<u8> {
    let mask = [7u8, 1, 9, 3];
    let mut f = vec![0x81, 0x80 | payload.len() as u8];
    f.extend_from_slice(&mask);
    f.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    f
}

/// #167: after the 101 the HTTP/1 guard hands the connection over, so the
/// client's frames (bytes that are no HTTP/1 head) reach the cell and the
/// echo comes back; before the fix the guard refused the first frame and
/// closed the connection.
#[tokio::test]
async fn frames_after_the_101_pass_the_guard() {
    let (addr, _cell, _dir) = start().await;
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(handshake("/ws", "13", "dGhlIHNhbXBsZSBub25jZQ==").as_bytes())
        .await
        .unwrap();
    let (head, mut rest) = read_head(&mut s).await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    for word in ["ping one", "GET / HTTP/1.1", "\r\n\r\n"] {
        s.write_all(&client_frame(word.as_bytes())).await.unwrap();
    }
    let want: Vec<u8> = [&b"hello"[..], b"ping one", b"GET / HTTP/1.1", b"\r\n\r\n"]
        .iter()
        .flat_map(|p| {
            let mut f = vec![0x81, p.len() as u8];
            f.extend_from_slice(p);
            f
        })
        .collect();
    while rest.len() < want.len() {
        let mut chunk = [0u8; 256];
        let n = tokio::time::timeout(Duration::from_secs(10), s.read(&mut chunk))
            .await
            .expect("echo")
            .unwrap();
        assert!(
            n > 0,
            "closed after {} bytes: the guard parsed a frame as HTTP/1",
            rest.len()
        );
        rest.extend_from_slice(&chunk[..n]);
    }
    assert_eq!(rest, want);
}

/// #167: a request carrying `Upgrade: websocket` that the cell answers
/// without a 101 leaves the connection under the guard: the next head is
/// still checked (a smuggling attempt is refused) after a valid one passes.
#[tokio::test]
async fn an_upgrade_answered_without_101_stays_checked() {
    let (addr, cell, _dir) = start().await;
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(handshake("/plain", "13", "dGhlIHNhbXBsZSBub25jZQ==").as_bytes())
        .await
        .unwrap();
    let (head, rest) = read_head(&mut s).await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    // The body of that 200 ("plain") follows the head; read it off.
    let mut body = vec![0u8; 5 - rest.len()];
    s.read_exact(&mut body).await.unwrap();
    // A second, valid request on the same connection is served.
    s.write_all(b"GET /next HTTP/1.1\r\nHost: a.test\r\n\r\n")
        .await
        .unwrap();
    let (head, rest) = read_head(&mut s).await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    let mut body = vec![0u8; 5 - rest.len()];
    s.read_exact(&mut body).await.unwrap();
    // A third with two Content-Length headers is refused by the guard.
    s.write_all(b"POST /smuggle HTTP/1.1\r\nHost: a.test\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nxx")
        .await
        .unwrap();
    let mut rest = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut rest)).await;
    let text = String::from_utf8_lossy(&rest);
    assert!(
        !text.starts_with("HTTP/1.1 200"),
        "smuggled request served: {text}"
    );
    let paths: Vec<String> = cell
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|(p, _, _)| p.clone())
        .collect();
    assert_eq!(
        paths,
        vec!["/plain".to_string(), "/next".to_string()],
        "the refused head never reached the cell"
    );
}
