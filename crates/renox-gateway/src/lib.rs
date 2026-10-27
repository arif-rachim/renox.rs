//! Renox gateway (P3): hostname → tenant → deployment routing, static files
//! from `public/`, per-IP rate limiting, and default security headers.
//!
//! The gateway never knows about isolates. Everything that is not a static
//! file is handed to a [`CellDispatcher`] together with a [`RequestCtx`];
//! the cell (`crates/renox-cell`, #29) implements the trait. This crate is a
//! leaf: it depends on no other `renox-*` crate and does not link V8.
//!
//! Sources: `docs/03-architecture.md` (Gateway row, "Request path"),
//! `docs/contracts/artifact.md` sections 4–5, `docs/contracts/ops.md`
//! section 6 (request envelope), `docs/04-isolation-security.md`
//! ("Web-layer protections").

use std::convert::Infallible;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode, header};
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use limits::{BodyCheck, CONNECTION_LIMIT_RESPONSE, ConnectionLimiter, IdleTimeout};
use tokio::net::TcpListener;
use tower::ServiceExt;

pub mod limits;
pub mod rate_limit;
pub mod route_table;
pub mod static_files;
pub mod tls;

pub use limits::{GatewayLimits, RouteKind};
pub use rate_limit::{RateDecision, RateLimitConfig, RateLimiter};
pub use route_table::{
    HostError, RouteEntry, RouteStatus, RouteTable, RouteTableError, parse_host,
};
pub use static_files::StaticFiles;
pub use tls::{CertStore, LoadReport, TlsConfig, TlsConnection, TlsError};

/// Request id header set by the gateway on the request to the cell and on
/// every response (`docs/contracts/ops.md` section 6, `errors.md` section 1).
pub const REQUEST_ID_HEADER: &str = "x-renox-request-id";
/// Client IP header set by the gateway on the request to the cell.
pub const CLIENT_IP_HEADER: &str = "x-renox-client-ip";

/// Default security headers on every response
/// (`docs/04-isolation-security.md`, "Clickjacking" and "Other headers"
/// rows). CSP and CSRF are F2 (#47). The gateway overwrites any value the
/// tenant handler set: in F1 these are not configurable, and from F2 they
/// are configured in `renox.toml [security.headers]`, never by handler code.
pub const SECURITY_HEADERS: [(&str, &str); 5] = [
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "strict-origin-when-cross-origin"),
    ("x-frame-options", "DENY"),
    (
        "permissions-policy",
        "camera=(), microphone=(), geolocation=()",
    ),
    ("cross-origin-opener-policy", "same-origin"),
];

/// Hop-by-hop headers removed before the request reaches the cell (RFC 9110
/// section 7.6.1; `ops.md` section 6).
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "upgrade",
];

/// What the gateway knows about a request when it hands it to the cell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestCtx {
    /// From the route table entry; never from request input.
    pub tenant_id: String,
    /// The artifact hash of the active deployment for the hostname.
    pub deployment_hash: String,
    /// ULID assigned by the gateway, also in `x-renox-request-id`.
    pub request_id: String,
    /// `now + wall-clock limit` when the gateway accepted the request. The
    /// cell, ops, queries, and fetches all use this one deadline
    /// (`docs/03-architecture.md`, "Deadlines").
    pub deadline: Instant,
    /// The TCP peer address (IPv4-mapped IPv6 shown as IPv4).
    pub client_ip: IpAddr,
}

/// Implemented by the cell (#29). The gateway calls it for every request
/// that is routed to a deployment and is not a static file.
///
/// The request carries the original method, URI, and body, with hop-by-hop
/// and client-sent `x-renox-*` headers removed and `x-renox-request-id` and
/// `x-renox-client-ip` set. The returned response gets the default security
/// headers and `x-renox-request-id` added by the gateway.
pub trait CellDispatcher: Send + Sync + 'static {
    fn dispatch(
        &self,
        ctx: RequestCtx,
        req: Request<Body>,
    ) -> impl Future<Output = Response<Body>> + Send;
}

/// Gateway configuration (from the worker config, #29).
#[derive(Clone, Debug)]
pub struct GatewayConfig {
    /// Directory holding artifact directories named by their hash.
    pub artifact_root: PathBuf,
    /// Wall-clock limit per request, used for [`RequestCtx::deadline`]. The
    /// route table carries no tier in F1, so this is the free-tier default.
    pub wall_clock_limit: Duration,
    /// Per-IP token bucket.
    pub rate_limit: RateLimitConfig,
    /// Header, body, timeout, and connection limits (`limits.rs`).
    pub limits: GatewayLimits,
}

impl GatewayConfig {
    pub fn new(artifact_root: impl Into<PathBuf>) -> Self {
        Self {
            artifact_root: artifact_root.into(),
            wall_clock_limit: Duration::from_secs(30),
            rate_limit: RateLimitConfig::default(),
            limits: GatewayLimits::default(),
        }
    }
}

/// Counters, for the operator. Static hits are counted here and are not
/// metered to the tenant quota.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GatewayStats {
    pub dispatched: u64,
    pub static_hits: u64,
    pub unknown_host: u64,
    pub bad_host: u64,
    pub rate_limited: u64,
    pub body_too_large: u64,
}

#[derive(Debug, Default)]
struct Counters {
    dispatched: AtomicU64,
    static_hits: AtomicU64,
    unknown_host: AtomicU64,
    bad_host: AtomicU64,
    rate_limited: AtomicU64,
    body_too_large: AtomicU64,
}

#[derive(Debug)]
struct Inner {
    config: GatewayConfig,
    routes: Arc<RouteTable>,
    statics: StaticFiles,
    limiter: RateLimiter,
    connections: Arc<ConnectionLimiter>,
    counters: Counters,
}

/// The gateway. Cheap to clone; clones share the route table and state.
#[derive(Clone, Debug)]
pub struct Gateway {
    inner: Arc<Inner>,
}

struct AppState<D> {
    gateway: Gateway,
    dispatcher: Arc<D>,
}

impl<D> Clone for AppState<D> {
    fn clone(&self) -> Self {
        Self {
            gateway: self.gateway.clone(),
            dispatcher: self.dispatcher.clone(),
        }
    }
}

impl Gateway {
    pub fn new(config: GatewayConfig, routes: Arc<RouteTable>) -> Self {
        let statics = StaticFiles::new(config.artifact_root.clone());
        let limiter = RateLimiter::new(config.rate_limit);
        let connections = ConnectionLimiter::new(config.limits.max_connections_per_ip);
        Self {
            inner: Arc::new(Inner {
                config,
                routes,
                statics,
                limiter,
                connections,
                counters: Counters::default(),
            }),
        }
    }

    /// The route table; the worker updates it in place (upsert, remove,
    /// reload on `SIGHUP`).
    pub fn routes(&self) -> &Arc<RouteTable> {
        &self.inner.routes
    }

    pub fn config(&self) -> &GatewayConfig {
        &self.inner.config
    }

    /// The static file cache, so the worker can forget evicted deployments.
    pub fn static_files(&self) -> &StaticFiles {
        &self.inner.statics
    }

    pub fn stats(&self) -> GatewayStats {
        let c = &self.inner.counters;
        GatewayStats {
            dispatched: c.dispatched.load(Ordering::Relaxed),
            static_hits: c.static_hits.load(Ordering::Relaxed),
            unknown_host: c.unknown_host.load(Ordering::Relaxed),
            bad_host: c.bad_host.load(Ordering::Relaxed),
            rate_limited: c.rate_limited.load(Ordering::Relaxed),
            body_too_large: c.body_too_large.load(Ordering::Relaxed),
        }
    }

    /// The gateway as an axum `Router`. The client address is read from the
    /// `ConnectInfo<SocketAddr>` request extension, which [`Gateway::serve`]
    /// sets per connection (tests insert it by hand).
    pub fn router<D: CellDispatcher>(&self, dispatcher: Arc<D>) -> Router {
        Router::new().fallback(handle::<D>).with_state(AppState {
            gateway: self.clone(),
            dispatcher,
        })
    }

    /// Accepts plain-HTTP connections (HTTP/1.1 and h2c prior knowledge)
    /// on `listener` until it fails. The `renox-worker` binary (#29) calls
    /// this; the crate itself has no binary.
    pub async fn serve<D: CellDispatcher>(
        &self,
        listener: TcpListener,
        dispatcher: Arc<D>,
    ) -> std::io::Result<()> {
        let limits = self.inner.config.limits;
        let connections = self.inner.connections.clone();
        accept_loop(listener, self.router(dispatcher), limits, connections, None).await
    }

    /// Accepts TLS connections on `listener`, choosing the certificate by
    /// SNI from `certs` (see [`tls`]). `certs.reload()` takes effect for new
    /// handshakes without dropping established connections. Responses on
    /// these connections carry `Strict-Transport-Security`.
    pub async fn serve_tls<D: CellDispatcher>(
        &self,
        listener: TcpListener,
        certs: Arc<CertStore>,
        dispatcher: Arc<D>,
    ) -> std::io::Result<()> {
        let acceptor = tokio_rustls::TlsAcceptor::from(certs.server_config());
        let limits = self.inner.config.limits;
        let connections = self.inner.connections.clone();
        accept_loop(
            listener,
            self.router(dispatcher),
            limits,
            connections,
            Some(acceptor),
        )
        .await
    }
}

async fn accept_loop(
    listener: TcpListener,
    router: Router,
    limits: GatewayLimits,
    connections: Arc<ConnectionLimiter>,
    tls: Option<tokio_rustls::TlsAcceptor>,
) -> std::io::Result<()> {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) if is_transient_accept_error(&e) => {
                tokio::time::sleep(Duration::from_millis(10)).await;
                continue;
            }
            Err(e) => return Err(e),
        };
        let router = router.clone();
        let tls = tls.clone();
        let guard = connections.try_acquire(peer.ip());
        tokio::spawn(async move {
            let Some(_guard) = guard else {
                if tls.is_none() {
                    reject_connection(stream).await;
                }
                return;
            };
            let _ = stream.set_nodelay(true);
            let stream = IdleTimeout::new(stream, limits.idle_timeout);
            match tls {
                None => serve_connection(stream, peer, router, &limits, None).await,
                Some(acceptor) => {
                    // The handshake gets the same budget as a request head,
                    // so a client cannot hold a socket by stalling it.
                    let Ok(Ok(stream)) =
                        tokio::time::timeout(limits.header_read_timeout, acceptor.accept(stream))
                            .await
                    else {
                        return;
                    };
                    let alpn = stream.get_ref().1.alpn_protocol().map(<[u8]>::to_vec);
                    serve_connection(stream, peer, router, &limits, Some(alpn)).await
                }
            }
        });
    }
}

/// Over the per-IP connection cap: a fixed 503 and close, written with a
/// short timeout so a refused client cannot hold the task either.
async fn reject_connection(mut stream: tokio::net::TcpStream) {
    use tokio::io::AsyncWriteExt;
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        stream.write_all(CONNECTION_LIMIT_RESPONSE).await?;
        stream.shutdown().await
    })
    .await;
}

/// Serves one connection. `tls` is `None` for plain HTTP (HTTP/1.1 only:
/// no h2c, no cleartext upgrade), or the ALPN protocol negotiated on TLS
/// (`h2` → HTTP/2, anything else → HTTP/1.1). Choosing the protocol up
/// front, instead of sniffing the first bytes, means the header read
/// timeout runs from the first byte.
async fn serve_connection<I>(
    io: I,
    peer: SocketAddr,
    router: Router,
    limits: &GatewayLimits,
    tls: Option<Option<Vec<u8>>>,
) where
    I: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let is_tls = tls.is_some();
    let service = hyper::service::service_fn(move |req: Request<_>| {
        let mut req = req.map(Body::new);
        req.extensions_mut().insert(ConnectInfo(peer));
        if is_tls {
            req.extensions_mut().insert(TlsConnection);
        }
        router.clone().oneshot(req)
    });
    let io = TokioIo::new(io);
    let header_bytes = limits.max_header_bytes.max(8 * 1024);
    if tls.flatten().as_deref() == Some(b"h2") {
        let mut builder = hyper::server::conn::http2::Builder::new(TokioExecutor::new());
        builder
            .timer(TokioTimer::new())
            .max_header_list_size(u32::try_from(header_bytes).unwrap_or(u32::MAX))
            .keep_alive_interval(Some(limits.idle_timeout / 2))
            .keep_alive_timeout(Duration::from_secs(20));
        let _ = builder.serve_connection(io, service).await;
    } else {
        let mut builder = hyper::server::conn::http1::Builder::new();
        builder
            .timer(TokioTimer::new())
            .header_read_timeout(limits.header_read_timeout)
            .max_buf_size(header_bytes)
            .max_headers(limits.max_headers);
        let _ = builder.serve_connection(io, service).await;
    }
}

fn is_transient_accept_error(e: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    matches!(
        e.kind(),
        ConnectionAborted | ConnectionReset | Interrupted | WouldBlock | OutOfMemory
    ) || matches!(e.raw_os_error(), Some(ENFILE | EMFILE | ENOBUFS | ENOMEM))
}

// Linux errno values for "out of descriptors or memory, try again later".
const ENFILE: i32 = 23;
const EMFILE: i32 = 24;
const ENOBUFS: i32 = 105;
const ENOMEM: i32 = 12;

async fn handle<D: CellDispatcher>(
    State(state): State<AppState<D>>,
    req: Request<Body>,
) -> Result<Response<Body>, Infallible> {
    let request_id = ulid::Ulid::generate().to_string();
    let tls = req.extensions().get::<TlsConnection>().is_some();
    let mut response = route(&state, req, &request_id).await;
    finish_response(response.headers_mut(), &request_id, tls);
    Ok(response)
}

async fn route<D: CellDispatcher>(
    state: &AppState<D>,
    req: Request<Body>,
    request_id: &str,
) -> Response<Body> {
    let inner = &state.gateway.inner;
    let counters = &inner.counters;
    let client_ip = client_ip(&req);

    if let RateDecision::Limited { retry_after_secs } = inner.limiter.check(client_ip) {
        counters.rate_limited.fetch_add(1, Ordering::Relaxed);
        // No body: under a flood every byte counts, and the status says it all.
        return Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .header(header::RETRY_AFTER, retry_after_secs)
            .body(Body::empty())
            .expect("valid response");
    }

    let host = match request_host(&req) {
        Ok(h) => h,
        Err(_) => {
            counters.bad_host.fetch_add(1, Ordering::Relaxed);
            return plain(StatusCode::BAD_REQUEST, "Bad request");
        }
    };
    let Some(entry) = inner.routes.lookup(&host) else {
        counters.unknown_host.fetch_add(1, Ordering::Relaxed);
        return plain(StatusCode::NOT_FOUND, "Not found");
    };

    if let Some(resp) = inner
        .statics
        .serve(
            &entry.deployment_hash,
            req.method(),
            req.uri().path(),
            req.headers(),
        )
        .await
    {
        counters.static_hits.fetch_add(1, Ordering::Relaxed);
        return resp;
    }

    // F1 has only function routes; the webhook limit applies once a route
    // kind for it exists in the manifest.
    let limit = inner.config.limits.body_limit(RouteKind::Function, None);
    let mut req = match limits::check_body(req, limit).await {
        BodyCheck::Ok(req) => req,
        BodyCheck::TooLarge { headers, .. } => {
            counters.body_too_large.fetch_add(1, Ordering::Relaxed);
            return limits::body_too_large(request_id, &headers);
        }
        BodyCheck::Unreadable => return plain(StatusCode::BAD_REQUEST, "Bad request"),
    };

    let ctx = RequestCtx {
        tenant_id: entry.tenant_id,
        deployment_hash: entry.deployment_hash,
        request_id: request_id.to_owned(),
        deadline: Instant::now() + inner.config.wall_clock_limit,
        client_ip,
    };
    prepare_request_headers(req.headers_mut(), request_id, client_ip);
    counters.dispatched.fetch_add(1, Ordering::Relaxed);
    state.dispatcher.dispatch(ctx, req).await
}

fn client_ip(req: &Request<Body>) -> IpAddr {
    let ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

/// The request's hostname: the URI authority (HTTP/2 `:authority`,
/// absolute-form HTTP/1.1) if present, else the `Host` header.
fn request_host(req: &Request<Body>) -> Result<String, HostError> {
    if let Some(authority) = req.uri().authority() {
        return parse_host(authority.as_str());
    }
    let mut hosts = req.headers().get_all(header::HOST).iter();
    let host = hosts.next().ok_or(HostError::Missing)?;
    if hosts.next().is_some() {
        return Err(HostError::Invalid);
    }
    parse_host(host.to_str().map_err(|_| HostError::Invalid)?)
}

/// Removes hop-by-hop headers (including those named in `Connection`) and
/// every client-sent `x-renox-*` header, then sets the two headers tenant
/// code may trust (`ops.md` section 6).
fn prepare_request_headers(headers: &mut HeaderMap, request_id: &str, client_ip: IpAddr) {
    let named: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|t| HeaderName::from_bytes(t.trim().as_bytes()).ok())
        .collect();
    for name in named {
        headers.remove(name);
    }
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
    let renox: Vec<HeaderName> = headers
        .keys()
        .filter(|k| k.as_str().starts_with("x-renox-"))
        .cloned()
        .collect();
    for name in renox {
        headers.remove(name);
    }
    headers.insert(
        REQUEST_ID_HEADER,
        HeaderValue::from_str(request_id).expect("ULID is a valid header value"),
    );
    headers.insert(
        CLIENT_IP_HEADER,
        HeaderValue::from_str(&client_ip.to_string()).expect("IP is a valid header value"),
    );
}

fn finish_response(headers: &mut HeaderMap, request_id: &str, tls: bool) {
    for (name, value) in SECURITY_HEADERS {
        headers.insert(name, HeaderValue::from_static(value));
    }
    // HSTS only on TLS responses: on plain HTTP browsers ignore it, and it
    // must never be sent by a `renox dev` plain-HTTP listener.
    if tls {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static(tls::HSTS),
        );
    } else {
        headers.remove(header::STRICT_TRANSPORT_SECURITY);
    }
    headers.insert(
        REQUEST_ID_HEADER,
        HeaderValue::from_str(request_id).expect("ULID is a valid header value"),
    );
}

fn plain(status: StatusCode, text: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(text))
        .expect("valid response")
}
