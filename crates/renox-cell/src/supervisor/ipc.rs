//! Supervisor ↔ child (#254): HTTP/1 over a Unix socket in the node's run
//! dir, one socket per child (`<run_dir>/children/<tenant>.sock`, the dir
//! mode 0700). One connection per request; bodies stream both ways.
//!
//! The gateway's [`RequestCtx`] travels in `x-renox-ipc-*` headers, which
//! no client can set: the gateway strips every client-sent `x-renox-*`
//! header before dispatch. `x-renox-ipc-kind` marks the supervisor's own
//! calls (`prepare`, `shutdown`, `test-fork`); a request without it is a
//! tenant request.

use std::net::IpAddr;
use std::path::Path;
use std::time::{Duration, Instant};

use axum::body::Body;
use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Request, Response, StatusCode, header};
use hyper_util::rt::TokioIo;
use renox_gateway::RequestCtx;
use tokio::net::UnixStream;

pub const H_KIND: &str = "x-renox-ipc-kind";
pub const H_TENANT: &str = "x-renox-ipc-tenant";
pub const H_DEPLOYMENT: &str = "x-renox-ipc-deployment";
pub const H_REQUEST_ID: &str = "x-renox-ipc-request-id";
pub const H_DEADLINE_MS: &str = "x-renox-ipc-deadline-ms";
pub const H_CLIENT_IP: &str = "x-renox-ipc-client-ip";
pub const H_NONCE: &str = "x-renox-ipc-csp-nonce";

/// The code a child answers for a tenant that is not its own (403). It
/// never reaches a tenant: the supervisor forwards only the child's tenant.
pub const TENANT_MISMATCH: &str = "RENOX_TENANT_MISMATCH";

/// Puts `ctx` on the request's headers.
pub fn encode_ctx(headers: &mut HeaderMap, ctx: &RequestCtx) {
    let remaining = ctx.deadline.saturating_duration_since(Instant::now());
    let pairs = [
        (H_TENANT, ctx.tenant_id.clone()),
        (H_DEPLOYMENT, ctx.deployment_hash.clone()),
        (H_REQUEST_ID, ctx.request_id.clone()),
        (H_DEADLINE_MS, remaining.as_millis().to_string()),
        (H_CLIENT_IP, ctx.client_ip.to_string()),
        (H_NONCE, ctx.csp_nonce.clone()),
    ];
    for (name, value) in pairs {
        if let Ok(v) = HeaderValue::from_str(&value) {
            headers.insert(name, v);
        }
    }
}

/// Takes `ctx` off the request's headers (removing them). `None` when one
/// is missing or malformed.
pub fn decode_ctx(headers: &mut HeaderMap) -> Option<RequestCtx> {
    let mut take = |name: &str| -> Option<String> {
        headers
            .remove(name)
            .and_then(|v| v.to_str().ok().map(str::to_string))
    };
    let tenant_id = take(H_TENANT)?;
    let deployment_hash = take(H_DEPLOYMENT)?;
    let request_id = take(H_REQUEST_ID)?;
    let ms: u64 = take(H_DEADLINE_MS)?.parse().ok()?;
    let client_ip: IpAddr = take(H_CLIENT_IP)?.parse().ok()?;
    let csp_nonce = take(H_NONCE).unwrap_or_default();
    Some(RequestCtx {
        tenant_id,
        deployment_hash,
        request_id,
        deadline: Instant::now() + Duration::from_millis(ms),
        client_ip,
        csp_nonce,
    })
}

/// Why a call to a child failed.
#[derive(Debug)]
pub enum IpcError {
    Connect(std::io::Error),
    Http(String),
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IpcError::Connect(e) => write!(f, "connect to the child: {e}"),
            IpcError::Http(e) => write!(f, "child request: {e}"),
        }
    }
}

/// Sends one request to the child behind `socket`. The response body
/// streams from the child.
pub async fn send(socket: &Path, req: Request<Body>) -> Result<Response<Body>, IpcError> {
    let stream = UnixStream::connect(socket)
        .await
        .map_err(IpcError::Connect)?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| IpcError::Http(e.to_string()))?;
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            tracing::debug!(error = %e, "child connection ended");
        }
    });
    let mut req = req;
    req.headers_mut()
        .insert(header::HOST, HeaderValue::from_static("child"));
    let resp = sender
        .send_request(req)
        .await
        .map_err(|e| IpcError::Http(e.to_string()))?;
    Ok(resp.map(Body::new))
}

/// A supervisor call of `kind` with a JSON body.
pub async fn call(
    socket: &Path,
    kind: &str,
    body: Vec<u8>,
) -> Result<(StatusCode, Bytes), IpcError> {
    let req = Request::builder()
        .method("PUT")
        .uri("/")
        .header(H_KIND, kind)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .map_err(|e| IpcError::Http(e.to_string()))?;
    let resp = send(socket, req).await?;
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
        .await
        .map_err(|e| IpcError::Http(e.to_string()))?;
    Ok((status, bytes))
}

/// A JSON error answer of the child (`errors.md` section 1 shape).
pub fn error(status: StatusCode, code: &str, message: &str) -> Response<Body> {
    let body = serde_json::json!({ "error": { "code": code, "message": message } });
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("static response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctx_round_trips_through_headers() {
        let ctx = RequestCtx {
            tenant_id: "t_a".into(),
            deployment_hash: "a".repeat(64),
            request_id: "01JBQ3Z7MA0000000000000001".into(),
            deadline: Instant::now() + Duration::from_secs(30),
            client_ip: "203.0.113.7".parse().unwrap(),
            csp_nonce: "n0nce".into(),
        };
        let mut h = HeaderMap::new();
        encode_ctx(&mut h, &ctx);
        let back = decode_ctx(&mut h).unwrap();
        assert_eq!(back.tenant_id, "t_a");
        assert_eq!(back.client_ip, ctx.client_ip);
        assert_eq!(back.csp_nonce, "n0nce");
        let left = back.deadline.saturating_duration_since(Instant::now());
        assert!(left > Duration::from_secs(29) && left <= Duration::from_secs(30));
        // The headers are taken off, so the tenant never sees them.
        assert!(h.is_empty());
        assert!(decode_ctx(&mut HeaderMap::new()).is_none());
    }
}
