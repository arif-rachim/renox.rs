//! The node's HTTP client for the control API (`docs/contracts/deploy-api.md`
//! sections 7-11): every call carries the node token, JSON bodies are at
//! most 1 MiB, and no response body is read beyond its cap.
//!
//! The token never appears in a log line or an error: requests mark the
//! `Authorization` header sensitive, and [`ControlError`] holds only the
//! path, a status, or the kind of failure.

use std::path::Path;
use std::time::Duration;

use bytes::Bytes;
use http::{HeaderValue, Method, Request, StatusCode, Uri, header};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde::Serialize;
use serde::de::DeserializeOwned;

/// Timeout of one API call (not the stream, not an artifact download).
pub const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// deploy-api.md section 1: JSON bodies are at most 1 MiB.
pub const JSON_LIMIT: usize = 1024 * 1024;

/// Why a call failed. Never contains the token or a response body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlError {
    /// No answer: connection refused, TLS failure, timeout.
    Unreachable(String),
    /// An answer outside the expected statuses.
    Status(u16),
    /// The answer did not parse or was over its cap.
    Body(String),
}

impl ControlError {
    /// Whether the control plane did not answer at all (degraded mode, #98).
    pub fn is_unreachable(&self) -> bool {
        matches!(self, ControlError::Unreachable(_))
    }
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ControlError::Unreachable(e) => write!(f, "control plane unreachable: {e}"),
            ControlError::Status(s) => write!(f, "control plane answered {s}"),
            ControlError::Body(e) => write!(f, "control plane answer refused: {e}"),
        }
    }
}

impl std::error::Error for ControlError {}

/// Reads the node token file: `renox_node_` + 32 base32 characters, mode
/// 0600. The value is returned only to build the `Authorization` header.
pub fn read_node_token(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("node token file: {}", e.kind()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(format!(
                "node token file has mode {mode:o}; it must be 0600"
            ));
        }
    }
    #[cfg(not(unix))]
    let _ = meta;
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("node token file: {}", e.kind()))?;
    let token = text.trim();
    let ok = token.len() == 43
        && token.starts_with("renox_node_")
        && token[11..]
            .bytes()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b));
    if !ok {
        return Err("the node token file does not hold a renox_node_ token".into());
    }
    Ok(token.to_string())
}

type HttpClient = Client<HttpsConnector<HttpConnector>, Full<Bytes>>;

/// A response whose body has not been read yet.
pub struct Answer {
    pub status: StatusCode,
    pub headers: http::HeaderMap,
    pub body: Incoming,
}

impl Answer {
    /// The whole body, at most `limit` bytes.
    pub async fn bytes(self, limit: usize) -> Result<Bytes, ControlError> {
        Limited::new(self.body, limit)
            .collect()
            .await
            .map(|b| b.to_bytes())
            .map_err(|e| ControlError::Body(e.to_string()))
    }

    pub async fn json<T: DeserializeOwned>(self) -> Result<T, ControlError> {
        let bytes = self.bytes(JSON_LIMIT).await?;
        serde_json::from_slice(&bytes).map_err(|e| ControlError::Body(e.to_string()))
    }
}

/// The client of one node. Cheap to clone.
#[derive(Clone)]
pub struct ControlClient {
    base: String,
    authorization: HeaderValue,
    node_id: String,
    http: HttpClient,
}

impl ControlClient {
    /// `base` is the checked `[control] url`.
    pub fn new(base: &str, token: &str, node_id: &str) -> Result<ControlClient, String> {
        let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "the node token is not a valid header value".to_string())?;
        authorization.set_sensitive(true);
        let https = hyper_rustls::HttpsConnectorBuilder::new()
            .with_provider_and_webpki_roots(rustls::crypto::ring::default_provider())
            .map_err(|e| e.to_string())?
            .https_or_http()
            .enable_http1()
            .build();
        Ok(ControlClient {
            base: base.trim_end_matches('/').to_string(),
            authorization,
            node_id: node_id.to_string(),
            http: Client::builder(TokioExecutor::new())
                .pool_idle_timeout(Duration::from_secs(30))
                .build(https),
        })
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    /// `/v1/nodes/<node_id><rest>`.
    pub fn node_path(&self, rest: &str) -> String {
        format!("/v1/nodes/{}{rest}", self.node_id)
    }

    /// Sends one request to the control API with the node token. The body,
    /// if any, is JSON. `timeout` bounds the time to the response head.
    pub async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        extra: &[(header::HeaderName, HeaderValue)],
        timeout: Duration,
    ) -> Result<Answer, ControlError> {
        let uri: Uri = format!("{}{path}", self.base)
            .parse()
            .map_err(|_| ControlError::Unreachable(format!("bad path {path}")))?;
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, self.authorization.clone());
        if body.is_some() {
            req = req.header(header::CONTENT_TYPE, "application/json");
        }
        for (k, v) in extra {
            req = req.header(k, v);
        }
        let req = req
            .body(Full::new(Bytes::from(body.unwrap_or_default())))
            .map_err(|e| ControlError::Unreachable(e.to_string()))?;
        self.exchange(req, timeout).await
    }

    /// GET of an absolute URL without the node token (a presigned
    /// object-storage URL from a 307).
    pub async fn get_external(&self, url: &str, timeout: Duration) -> Result<Answer, ControlError> {
        let uri: Uri = url
            .parse()
            .map_err(|_| ControlError::Body("redirect to an invalid URL".into()))?;
        if !matches!(uri.scheme_str(), Some("https" | "http")) {
            return Err(ControlError::Body("redirect to a non-HTTP URL".into()));
        }
        let req = Request::get(uri)
            .body(Full::new(Bytes::new()))
            .map_err(|e| ControlError::Unreachable(e.to_string()))?;
        self.exchange(req, timeout).await
    }

    async fn exchange(
        &self,
        req: Request<Full<Bytes>>,
        timeout: Duration,
    ) -> Result<Answer, ControlError> {
        let res = tokio::time::timeout(timeout, self.http.request(req))
            .await
            .map_err(|_| ControlError::Unreachable("timed out".into()))?
            .map_err(|e| ControlError::Unreachable(error_chain(&e)))?;
        let (parts, body) = res.into_parts();
        Ok(Answer {
            status: parts.status,
            headers: parts.headers,
            body,
        })
    }

    /// POST a JSON body; `Ok(status)` for any answer.
    pub async fn post_json<T: Serialize>(
        &self,
        path: &str,
        body: &T,
    ) -> Result<Answer, ControlError> {
        let bytes = serde_json::to_vec(body).map_err(|e| ControlError::Body(e.to_string()))?;
        self.send(Method::POST, path, Some(bytes), &[], CALL_TIMEOUT)
            .await
    }

    /// GET and parse a JSON answer that must be 200.
    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, ControlError> {
        let a = self
            .send(Method::GET, path, None, &[], CALL_TIMEOUT)
            .await?;
        if a.status != StatusCode::OK {
            return Err(ControlError::Status(a.status.as_u16()));
        }
        a.json().await
    }
}

/// The error and its sources, without any URL query (presigned URLs carry
/// credentials in the query).
fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        out.push_str(": ");
        out.push_str(&s.to_string());
        source = s.source();
    }
    match out.find('?') {
        Some(i) => out[..i].to_string(),
        None => out,
    }
}
