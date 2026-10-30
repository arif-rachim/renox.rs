//! WebSocket upgrades on HTTP/1.1 (#281; `docs/contracts/ops.md` 1.5.0
//! section 18; RFC 6455 section 4).
//!
//! The gateway checks the handshake headers and hands the request to the
//! cell with a [`WsUpgrade`] extension. The cell decides (route kind `ws`,
//! `Origin`, principal, `guard`, caps): it answers with
//! [`WsUpgrade::accept`] (101) and then takes the connection with
//! [`WsUpgrade::upgraded`], or answers anything else, in which case the
//! connection stays HTTP/1 and the protocol guard keeps checking it (#167).
//! HTTP/2 extended CONNECT (RFC 8441) is not offered.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode, Version, header};
use base64::Engine as _;
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::TokioIo;
use sha1::{Digest, Sha1};

/// RFC 6455 section 1.3.
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// The HTTP/1 connection's switch: set when a 101 is about to be written,
/// so the protocol guard stops parsing what follows as HTTP/1 (#167).
#[derive(Clone, Debug, Default)]
pub struct UpgradeSwitch(pub(crate) Arc<AtomicBool>);

impl UpgradeSwitch {
    pub fn new() -> UpgradeSwitch {
        UpgradeSwitch::default()
    }

    pub fn set(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_set(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// A WebSocket handshake the gateway accepted, in the request's
/// extensions. Cloning shares the one pending upgrade.
#[derive(Clone)]
pub struct WsUpgrade {
    accept: String,
    protocols: Option<HeaderValue>,
    on_upgrade: Arc<std::sync::Mutex<Option<OnUpgrade>>>,
}

impl std::fmt::Debug for WsUpgrade {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WsUpgrade").finish_non_exhaustive()
    }
}

/// Why a request that asks for an upgrade was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandshakeError {
    /// Not `GET` over HTTP/1.1.
    Method,
    /// `Sec-WebSocket-Version` other than 13 (answered 426 with the version).
    Version,
    /// `Sec-WebSocket-Key` missing or not 16 bytes of base64.
    Key,
    /// The connection cannot be upgraded (HTTP/2, or hyper gave no handle).
    NotUpgradable,
}

/// `Sec-WebSocket-Accept` for a key (RFC 6455 section 4.2.2).
pub fn accept_key(key: &str) -> String {
    let mut h = Sha1::new();
    h.update(key.as_bytes());
    h.update(WS_GUID.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(h.finalize())
}

fn has_token(headers: &HeaderMap, name: header::HeaderName, token: &str) -> bool {
    headers.get_all(name).iter().any(|v| {
        v.to_str()
            .is_ok_and(|s| s.split(',').any(|t| t.trim().eq_ignore_ascii_case(token)))
    })
}

/// Whether the request asks for a WebSocket upgrade (`Connection: upgrade`
/// and `Upgrade: websocket`).
pub fn is_ws_request<B>(req: &Request<B>) -> bool {
    has_token(req.headers(), header::CONNECTION, "upgrade")
        && has_token(req.headers(), header::UPGRADE, "websocket")
}

impl WsUpgrade {
    /// Checks the handshake of an upgrade request and takes hyper's upgrade
    /// handle out of it. Call before the hop-by-hop headers are removed.
    pub fn from_request(req: &mut Request<Body>) -> Result<WsUpgrade, HandshakeError> {
        if req.method() != Method::GET || req.version() != Version::HTTP_11 {
            return Err(HandshakeError::Method);
        }
        let headers = req.headers();
        if headers
            .get("sec-websocket-version")
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            != Some("13")
        {
            return Err(HandshakeError::Version);
        }
        let key = headers
            .get("sec-websocket-key")
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|k| {
                base64::engine::general_purpose::STANDARD
                    .decode(k)
                    .is_ok_and(|b| b.len() == 16)
            })
            .ok_or(HandshakeError::Key)?;
        let accept = accept_key(key);
        let protocols = headers.get("sec-websocket-protocol").cloned();
        let on_upgrade = req
            .extensions_mut()
            .remove::<OnUpgrade>()
            .ok_or(HandshakeError::NotUpgradable)?;
        Ok(WsUpgrade {
            accept,
            protocols,
            on_upgrade: Arc::new(std::sync::Mutex::new(Some(on_upgrade))),
        })
    }

    /// The offered subprotocols (`Sec-WebSocket-Protocol`), as sent.
    pub fn protocols(&self) -> Option<&HeaderValue> {
        self.protocols.as_ref()
    }

    /// The `101 Switching Protocols` that completes the handshake.
    pub fn accept(&self) -> Response<Body> {
        Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(header::CONNECTION, "upgrade")
            .header(header::UPGRADE, "websocket")
            .header("sec-websocket-accept", &self.accept)
            .body(Body::empty())
            .expect("valid response")
    }

    /// The upgraded connection, once the 101 was written. `None` when the
    /// client went away or the handle was already taken.
    pub async fn upgraded(&self) -> Option<TokioIo<hyper::upgrade::Upgraded>> {
        let pending = self.on_upgrade.lock().expect("upgrade lock").take()?;
        pending.await.ok().map(TokioIo::new)
    }
}

/// The answer to a refused handshake.
pub fn refusal(e: HandshakeError) -> Response<Body> {
    let mut b = Response::builder();
    b = match e {
        HandshakeError::Version => b
            .status(StatusCode::UPGRADE_REQUIRED)
            .header("sec-websocket-version", "13"),
        HandshakeError::Method => b
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "GET"),
        HandshakeError::Key | HandshakeError::NotUpgradable => b.status(StatusCode::BAD_REQUEST),
    };
    b.body(Body::from("WebSocket handshake refused"))
        .expect("valid response")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6455 section 1.3's example.
    #[test]
    fn accept_key_matches_the_rfc() {
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn upgrade_tokens() {
        let r = Request::builder()
            .header("connection", "keep-alive, Upgrade")
            .header("upgrade", "WebSocket")
            .body(())
            .unwrap();
        assert!(is_ws_request(&r));
        let r = Request::builder()
            .header("upgrade", "websocket")
            .body(())
            .unwrap();
        assert!(!is_ws_request(&r));
    }
}
