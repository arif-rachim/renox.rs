//! Input limits applied before dispatch, so a hostile client never reaches a
//! tenant isolate (`docs/23-failure-modes.md` section 2: "Malformed `Host`,
//! header too large, too many headers", "Request body over limit",
//! "Slowloris / idle connections").
//!
//! | Limit | Where | Over the limit |
//! | --- | --- | --- |
//! | `max_header_bytes` | `Http1Guard` and hyper read buffer (HTTP/1.1), `SETTINGS_MAX_HEADER_LIST_SIZE` (HTTP/2) | 431 with a request id, connection closed |
//! | `max_headers` | `Http1Guard` and hyper parser (HTTP/1.1) | 431 with a request id, connection closed |
//! | `max_body_bytes_*` | [`check_body`] before dispatch | 413 `RENOX_BODY_TOO_LARGE` |
//! | `header_read_timeout` | hyper (HTTP/1.1 request head), TLS handshake | connection closed |
//! | `idle_timeout` | [`IdleTimeout`] around the socket | connection closed |
//! | `max_connections_per_ip` | [`ConnectionLimiter`] at accept | 503 and close (plain HTTP), close (TLS) |
//! | `protocol.h2_max_resets_per_ip_per_second` | [`IpResetLimiter`], counted by `H2FloodBudget` | HTTP/2 connection closed |

use std::collections::HashMap;
use std::io;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::Body;
use axum::http::{HeaderMap, Request, Response, StatusCode, header};
use http_body_util::{BodyExt, LengthLimitError, Limited};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::{Instant, Sleep};

use crate::protocol::SlidingWindow;

/// Gateway input limits, configured from the worker config (#29).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GatewayLimits {
    /// Request line plus headers, in bytes (HTTP/1.1); header list size
    /// (HTTP/2). hyper's floor is 8 KiB.
    pub max_header_bytes: usize,
    /// Number of request headers (HTTP/1.1).
    pub max_headers: usize,
    /// Body limit for function routes.
    pub max_body_bytes_default: u64,
    /// Body limit for webhook routes. No F1 route kind maps to it yet; the
    /// route kind arrives with the manifest change that adds it.
    pub max_body_bytes_webhook: u64,
    /// Time a client has to send a complete request head (and, on TLS, to
    /// complete the handshake).
    pub header_read_timeout: Duration,
    /// A connection with no bytes read or written for this long is closed.
    pub idle_timeout: Duration,
    /// Open connections per client IP (IPv6 by /64).
    pub max_connections_per_ip: usize,
}

impl Default for GatewayLimits {
    fn default() -> Self {
        Self {
            max_header_bytes: 16 * 1024,
            max_headers: 100,
            max_body_bytes_default: 1024 * 1024,
            max_body_bytes_webhook: 5 * 1024 * 1024,
            header_read_timeout: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(60),
            max_connections_per_ip: 100,
        }
    }
}

/// Route kinds with their own body limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteKind {
    Function,
    Webhook,
}

impl GatewayLimits {
    /// The body limit for a route kind, lowered by an app override if one
    /// is given. An override can never raise the platform limit.
    pub fn body_limit(&self, kind: RouteKind, app_override: Option<u64>) -> u64 {
        let platform = match kind {
            RouteKind::Function => self.max_body_bytes_default,
            RouteKind::Webhook => self.max_body_bytes_webhook,
        };
        app_override.map_or(platform, |o| o.min(platform))
    }
}

/// Outcome of [`check_body`].
pub enum BodyCheck {
    /// Within the limit; the request to dispatch (its body may have been
    /// buffered, at most `limit` bytes).
    Ok(Request<Body>),
    /// Over the limit: answer 413 without calling the cell. `received` is
    /// the declared length, or `limit + 1` for a body of unknown length.
    TooLarge {
        limit: u64,
        received: u64,
        headers: HeaderMap,
    },
    /// The body stream failed (client reset, malformed chunking).
    Unreadable,
}

/// Enforces the body limit before dispatch, without buffering past it.
///
/// - A declared length (`Content-Length`, or a known size) over the limit is
///   refused before any body byte is read.
/// - A body of unknown length (chunked, HTTP/2 without `content-length`) is
///   read up to `limit` bytes; one byte more and the request is refused. The
///   cell therefore only ever sees bodies within the limit.
pub async fn check_body(req: Request<Body>, limit: u64) -> BodyCheck {
    let hint = axum::body::HttpBody::size_hint(req.body());
    if let Some(len) = hint.exact() {
        return if len > limit {
            BodyCheck::TooLarge {
                limit,
                received: len,
                headers: req.into_parts().0.headers,
            }
        } else {
            BodyCheck::Ok(req)
        };
    }
    let (parts, body) = req.into_parts();
    let limit_usize = usize::try_from(limit).unwrap_or(usize::MAX);
    match Limited::new(body, limit_usize).collect().await {
        Ok(collected) => {
            BodyCheck::Ok(Request::from_parts(parts, Body::from(collected.to_bytes())))
        }
        Err(e) if e.is::<LengthLimitError>() => BodyCheck::TooLarge {
            limit,
            received: limit.saturating_add(1),
            headers: parts.headers,
        },
        Err(_) => BodyCheck::Unreadable,
    }
}

/// A platform error response in the format of `docs/contracts/errors.md`
/// section 1: JSON for API clients, the plain default page when the client
/// prefers HTML (the route kind is not known at the gateway).
pub fn platform_error(
    status: StatusCode,
    code: &'static str,
    message: &'static str,
    request_id: &str,
    request_headers: &HeaderMap,
) -> Response<Body> {
    let builder = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store");
    if prefers_html(request_headers) {
        let page = default_page_html(status.as_u16(), message, request_id);
        builder
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Body::from(page))
            .expect("valid response")
    } else {
        let body = serde_json::json!({
            "error": { "code": code, "request_id": request_id, "message": message }
        });
        builder
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .body(Body::from(body.to_string()))
            .expect("valid response")
    }
}

/// The platform default error page (`errors.md` section 1): status,
/// message, request id, no tenant content. The gateway's HTML errors use it,
/// and the cell uses it when a deployment has no error template or the
/// template fails (#93).
pub fn default_page_html(status: u16, message: &str, request_id: &str) -> String {
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>{status}</title></head>\
         <body><h1>{status}</h1><p>{}</p><p>Request id: <code>{}</code></p></body></html>\n",
        esc(message),
        esc(request_id),
    )
}

/// Whether `Accept` ranks `text/html` above `application/json`.
fn prefers_html(headers: &HeaderMap) -> bool {
    let mut html = 0.0f32;
    let mut json = 0.0f32;
    for value in headers.get_all(header::ACCEPT) {
        let Ok(value) = value.to_str() else { continue };
        for item in value.split(',') {
            let mut parts = item.split(';');
            let media = parts.next().unwrap_or("").trim().to_ascii_lowercase();
            let q = parts
                .filter_map(|p| p.trim().strip_prefix("q="))
                .find_map(|q| q.parse::<f32>().ok())
                .unwrap_or(1.0);
            match media.as_str() {
                "text/html" => html = html.max(q),
                "application/json" => json = json.max(q),
                _ => {}
            }
        }
    }
    html > json
}

/// Counts open connections per client IP.
#[derive(Debug)]
pub struct ConnectionLimiter {
    max: usize,
    counts: Mutex<HashMap<IpAddr, usize>>,
}

/// Held for the lifetime of a connection; releases its slot on drop.
#[derive(Debug)]
pub struct ConnectionGuard {
    limiter: Arc<ConnectionLimiter>,
    key: IpAddr,
}

impl ConnectionLimiter {
    pub fn new(max: usize) -> Arc<Self> {
        Arc::new(Self {
            max,
            counts: Mutex::new(HashMap::new()),
        })
    }

    /// A slot for a new connection from `ip`, or `None` at the cap.
    pub fn try_acquire(self: &Arc<Self>, ip: IpAddr) -> Option<ConnectionGuard> {
        let key = crate::rate_limit::bucket_key(ip);
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        let count = counts.entry(key).or_insert(0);
        if *count >= self.max {
            return None;
        }
        *count += 1;
        Some(ConnectionGuard {
            limiter: self.clone(),
            key,
        })
    }

    /// Open connections from `ip`.
    pub fn open(&self, ip: IpAddr) -> usize {
        let key = crate::rate_limit::bucket_key(ip);
        let counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        counts.get(&key).copied().unwrap_or(0)
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        let mut counts = self
            .limiter
            .counts
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(count) = counts.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&self.key);
            }
        }
    }
}

/// HTTP/2 stream resets per client IP (IPv6 by /64), summed over all of its
/// connections (#166): one [`SlidingWindow`] per IP, kept while the IP has
/// an open HTTP/2 connection or a reset within the last second, so closing
/// and reopening connections does not start a fresh budget.
#[derive(Debug)]
pub struct IpResetLimiter {
    max: u32,
    state: Mutex<IpResetState>,
}

#[derive(Debug)]
struct IpResetState {
    entries: HashMap<IpAddr, IpResetEntry>,
    /// Sweep idle entries when the map grows past this.
    sweep_at: usize,
}

#[derive(Debug)]
struct IpResetEntry {
    connections: usize,
    window: SlidingWindow,
}

/// One HTTP/2 connection's handle on its IP's reset budget; released on
/// drop.
#[derive(Debug)]
pub struct IpResetSlot {
    limiter: Arc<IpResetLimiter>,
    key: IpAddr,
}

const IP_RESET_SWEEP_MIN: usize = 1024;

impl IpResetLimiter {
    pub fn new(max_per_second: u32) -> Arc<Self> {
        Arc::new(Self {
            max: max_per_second,
            state: Mutex::new(IpResetState {
                entries: HashMap::new(),
                sweep_at: IP_RESET_SWEEP_MIN,
            }),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, IpResetState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A handle for a new HTTP/2 connection from `ip`.
    pub fn slot(self: &Arc<Self>, ip: IpAddr) -> IpResetSlot {
        let key = crate::rate_limit::bucket_key(ip);
        let now = std::time::Instant::now();
        let mut state = self.lock();
        if state.entries.len() >= state.sweep_at {
            // Entries without connections and without a recent reset carry
            // no budget; the map stays bounded by the open connections plus
            // the IPs that reset a stream in the last second.
            state
                .entries
                .retain(|_, e| e.connections > 0 || !e.window.is_idle(now));
            state.sweep_at = (state.entries.len() * 2).max(IP_RESET_SWEEP_MIN);
        }
        let max = self.max;
        state
            .entries
            .entry(key)
            .or_insert_with(|| IpResetEntry {
                connections: 0,
                window: SlidingWindow::new(max, now),
            })
            .connections += 1;
        IpResetSlot {
            limiter: self.clone(),
            key,
        }
    }

    /// IPs with state (open HTTP/2 connections or recent resets).
    pub fn tracked(&self) -> usize {
        self.lock().entries.len()
    }
}

impl IpResetSlot {
    /// Resets this IP may still have now.
    pub fn remaining(&self, now: std::time::Instant) -> usize {
        let mut state = self.limiter.lock();
        state
            .entries
            .get_mut(&self.key)
            .map_or(usize::MAX, |e| e.window.remaining(now))
    }

    /// Records one reset for this IP; `false` over the budget.
    pub fn hit(&self, now: std::time::Instant) -> bool {
        let mut state = self.limiter.lock();
        state
            .entries
            .get_mut(&self.key)
            .is_none_or(|e| e.window.hit(now))
    }
}

impl Drop for IpResetSlot {
    fn drop(&mut self) {
        let now = std::time::Instant::now();
        let mut state = self.limiter.lock();
        if let Some(e) = state.entries.get_mut(&self.key) {
            e.connections -= 1;
            if e.connections == 0 && e.window.is_idle(now) {
                state.entries.remove(&self.key);
            }
        }
    }
}

/// The response written on a connection refused at the per-IP cap, with its
/// own request id.
pub fn connection_limit_response() -> Vec<u8> {
    crate::request_id::raw_response("503 Service Unavailable", &[("retry-after", "1")])
}

/// Closes a connection that moves no bytes in either direction for
/// `timeout`. The timer is only checked while the connection is waiting on
/// the socket, so a request that is being handled by the cell is bounded by
/// its deadline, not by this timeout.
#[derive(Debug)]
pub struct IdleTimeout<I> {
    inner: I,
    timeout: Duration,
    sleep: Pin<Box<Sleep>>,
}

impl<I> IdleTimeout<I> {
    pub fn new(inner: I, timeout: Duration) -> Self {
        Self {
            inner,
            timeout,
            sleep: Box::pin(tokio::time::sleep(timeout)),
        }
    }

    pub fn get_ref(&self) -> &I {
        &self.inner
    }

    fn touch(&mut self) {
        let deadline = Instant::now() + self.timeout;
        self.sleep.as_mut().reset(deadline);
    }

    fn expired(&mut self, cx: &mut Context<'_>) -> bool {
        self.sleep.as_mut().poll(cx).is_ready()
    }
}

fn idle_error() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "idle timeout")
}

impl<I: AsyncRead + Unpin> AsyncRead for IdleTimeout<I> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_read(cx, buf) {
            Poll::Ready(r) => {
                this.touch();
                Poll::Ready(r)
            }
            Poll::Pending if this.expired(cx) => Poll::Ready(Err(idle_error())),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<I: AsyncWrite + Unpin> AsyncWrite for IdleTimeout<I> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_write(cx, data) {
            Poll::Ready(r) => {
                this.touch();
                Poll::Ready(r)
            }
            Poll::Pending if this.expired(cx) => Poll::Ready(Err(idle_error())),
            Poll::Pending => Poll::Pending,
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_write_vectored(cx, bufs) {
            Poll::Ready(r) => {
                this.touch();
                Poll::Ready(r)
            }
            Poll::Pending if this.expired(cx) => Poll::Ready(Err(idle_error())),
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

/// The 413 `RENOX_BODY_TOO_LARGE` response for [`BodyCheck::TooLarge`].
pub fn body_too_large(request_id: &str, request_headers: &HeaderMap) -> Response<Body> {
    platform_error(
        StatusCode::PAYLOAD_TOO_LARGE,
        "RENOX_BODY_TOO_LARGE",
        "The request body is too large.",
        request_id,
        request_headers,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_only_lower_the_limit() {
        let l = GatewayLimits::default();
        assert_eq!(l.body_limit(RouteKind::Function, None), 1024 * 1024);
        assert_eq!(l.body_limit(RouteKind::Webhook, None), 5 * 1024 * 1024);
        assert_eq!(l.body_limit(RouteKind::Function, Some(10)), 10);
        assert_eq!(
            l.body_limit(RouteKind::Function, Some(u64::MAX)),
            1024 * 1024
        );
    }

    #[test]
    fn accept_preference() {
        let mut h = HeaderMap::new();
        assert!(!prefers_html(&h));
        h.insert(
            header::ACCEPT,
            "text/html,application/xhtml+xml,*/*;q=0.8".parse().unwrap(),
        );
        assert!(prefers_html(&h));
        h.insert(
            header::ACCEPT,
            "application/json, text/html;q=0.5".parse().unwrap(),
        );
        assert!(!prefers_html(&h));
    }

    #[test]
    fn connection_slots_are_released() {
        let l = ConnectionLimiter::new(2);
        let ip: IpAddr = "192.0.2.1".parse().unwrap();
        let a = l.try_acquire(ip).unwrap();
        let _b = l.try_acquire(ip).unwrap();
        assert!(l.try_acquire(ip).is_none());
        assert!(l.try_acquire("192.0.2.2".parse().unwrap()).is_some());
        drop(a);
        assert_eq!(l.open(ip), 1);
        assert!(l.try_acquire(ip).is_some());
    }

    #[test]
    fn ip_reset_state_outlives_a_reconnect_then_goes() {
        let l = IpResetLimiter::new(2);
        let ip: IpAddr = "2001:db8::1".parse().unwrap();
        let now = std::time::Instant::now();
        let a = l.slot(ip);
        assert!(a.hit(now) && a.hit(now));
        drop(a);
        // Same /64, new connection: the budget is still spent.
        let b = l.slot("2001:db8::2".parse().unwrap());
        assert!(!b.hit(now));
        assert_eq!(l.tracked(), 1);
        drop(b);
        // A closed connection without recent resets leaves nothing behind.
        for i in 0..IP_RESET_SWEEP_MIN as u32 {
            drop(l.slot(IpAddr::from(std::net::Ipv4Addr::from(i))));
        }
        assert!(l.tracked() <= 2, "{}", l.tracked());
    }
}
