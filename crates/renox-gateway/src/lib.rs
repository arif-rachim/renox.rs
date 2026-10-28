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
use limits::{BodyCheck, ConnectionLimiter, IdleTimeout, connection_limit_response};
use protocol::{H2ResetBudget, Http1Guard};
use tokio::net::TcpListener;
use tower::ServiceExt;

pub mod client_events;
pub mod client_script;
pub mod compress;
pub mod host_check;
pub mod limits;
pub mod protocol;
pub mod rate_limit;
pub mod request_id;
pub mod route_table;
pub mod security;
pub mod static_files;
pub mod tls;

pub use client_events::{
    ClientEventLimits, ClientEventSink, ClientEventStats, ClientLogLine, DropReason,
};
pub use host_check::TlsSni;
pub use limits::{GatewayLimits, RouteKind};
pub use protocol::ProtocolLimits;
pub use rate_limit::{RateDecision, RateLimitConfig, RateLimiter};
pub use route_table::{
    HostError, RouteEntry, RouteStatus, RouteTable, RouteTableError, parse_host,
};
pub use static_files::StaticFiles;
pub use tls::{CertStore, LoadReport, TlsConfig, TlsConnection, TlsError};

/// Request id header set by the gateway on the request to the cell and on
/// every response (`docs/contracts/ops.md` section 6, `errors.md` section 1;
/// `request_id.rs`).
pub use request_id::REQUEST_ID_HEADER;
/// Client IP header set by the gateway on the request to the cell.
pub const CLIENT_IP_HEADER: &str = "x-renox-client-ip";
/// The one client `x-renox-*` header that reaches the cell: the CSRF token
/// htmx sends on page actions (`ops.md` section 14). The cell checks it and
/// removes it before tenant code runs (`crates/renox-cell/src/pages`).
pub const CSRF_HEADER: &str = "x-renox-csrf";

/// Default security headers on every response
/// (`docs/04-isolation-security.md`, "Clickjacking" and "Other headers"
/// rows): the values [`security::headers::header_set`] gives a deployment
/// without a `security` object, CSP aside (its value carries the request's
/// nonce). The gateway overwrites any value the tenant handler set; from F2
/// `renox.toml [security.headers]` configures `Referrer-Policy` and
/// `Permissions-Policy` (#47), never handler code.
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
    /// This request's CSP nonce (#47): the renderer puts it on every
    /// `<script>`/`<style>`, the gateway sends it in the CSP header.
    pub csp_nonce: String,
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
    /// HTTP/2 stream and reset limits (`protocol.rs`).
    pub protocol: ProtocolLimits,
    /// `/__renox/events` limits (`client_events.rs`).
    pub client_events: ClientEventLimits,
}

impl GatewayConfig {
    pub fn new(artifact_root: impl Into<PathBuf>) -> Self {
        Self {
            artifact_root: artifact_root.into(),
            wall_clock_limit: Duration::from_secs(30),
            rate_limit: RateLimitConfig::default(),
            limits: GatewayLimits::default(),
            protocol: ProtocolLimits::default(),
            client_events: ClientEventLimits::default(),
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
    /// Requests answered 421 `RENOX_HOST_MISMATCH` (SNI vs `Host`).
    pub host_mismatch: u64,
    /// Connections closed by the protocol guards (`protocol.rs`): a
    /// malformed or ambiguous HTTP/1 request, or the HTTP/2 reset budget.
    pub protocol_refused: u64,
    /// `/__renox/events`: accepted events and drops per reason.
    pub client_events: ClientEventStats,
}

#[derive(Debug, Default)]
struct Counters {
    dispatched: AtomicU64,
    static_hits: AtomicU64,
    unknown_host: AtomicU64,
    bad_host: AtomicU64,
    rate_limited: AtomicU64,
    body_too_large: AtomicU64,
    host_mismatch: AtomicU64,
    /// Shared with the connection guards.
    protocol_refused: Arc<AtomicU64>,
}

#[derive(Debug)]
struct Inner {
    config: GatewayConfig,
    routes: Arc<RouteTable>,
    statics: StaticFiles,
    security: security::SecurityStore,
    limiter: RateLimiter,
    connections: Arc<ConnectionLimiter>,
    counters: Counters,
    client_events: client_events::ClientEvents,
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
        let security = security::SecurityStore::new(config.artifact_root.clone());
        let limiter = RateLimiter::new(config.rate_limit);
        let connections = ConnectionLimiter::new(config.limits.max_connections_per_ip);
        let client_events = client_events::ClientEvents::new(config.client_events);
        Self {
            inner: Arc::new(Inner {
                config,
                routes,
                statics,
                security,
                limiter,
                connections,
                counters: Counters::default(),
                client_events,
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

    /// Per-deployment `security` settings (#47), read once per hash.
    pub fn security(&self) -> &security::SecurityStore {
        &self.inner.security
    }

    /// Attaches the tenant log sink for `/__renox/events`; without one,
    /// events are validated and counted but written nowhere. Only the first
    /// call has an effect (returns `false` after that).
    pub fn set_client_event_sink(&self, sink: Arc<dyn ClientEventSink>) -> bool {
        self.inner.client_events.set_sink(sink)
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
            host_mismatch: c.host_mismatch.load(Ordering::Relaxed),
            protocol_refused: c.protocol_refused.load(Ordering::Relaxed),
            client_events: self.inner.client_events.stats(),
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

    /// Accepts plain-HTTP connections (HTTP/1.x only: no h2c) on `listener`
    /// until it fails. The `renox-worker` binary (#29) calls
    /// this; the crate itself has no binary.
    pub async fn serve<D: CellDispatcher>(
        &self,
        listener: TcpListener,
        dispatcher: Arc<D>,
    ) -> std::io::Result<()> {
        accept_loop(
            listener,
            self.router(dispatcher),
            self.conn_settings(),
            None,
        )
        .await
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
        accept_loop(
            listener,
            self.router(dispatcher),
            self.conn_settings(),
            Some(acceptor),
        )
        .await
    }

    fn conn_settings(&self) -> ConnSettings {
        ConnSettings {
            limits: self.inner.config.limits,
            protocol: self.inner.config.protocol,
            connections: self.inner.connections.clone(),
            refused: self.inner.counters.protocol_refused.clone(),
        }
    }
}

/// What every connection task needs from the gateway.
#[derive(Clone)]
struct ConnSettings {
    limits: GatewayLimits,
    protocol: ProtocolLimits,
    connections: Arc<ConnectionLimiter>,
    refused: Arc<AtomicU64>,
}

async fn accept_loop(
    listener: TcpListener,
    router: Router,
    settings: ConnSettings,
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
        let settings = settings.clone();
        let guard = settings.connections.try_acquire(peer.ip());
        tokio::spawn(async move {
            let Some(_guard) = guard else {
                if tls.is_none() {
                    reject_connection(stream).await;
                }
                return;
            };
            let _ = stream.set_nodelay(true);
            let limits = settings.limits;
            let stream = IdleTimeout::new(stream, limits.idle_timeout);
            match tls {
                None => serve_connection(stream, peer, router, &settings, None).await,
                Some(acceptor) => {
                    // The handshake gets the same budget as a request head,
                    // so a client cannot hold a socket by stalling it.
                    let Ok(Ok(stream)) =
                        tokio::time::timeout(limits.header_read_timeout, acceptor.accept(stream))
                            .await
                    else {
                        return;
                    };
                    let session = stream.get_ref().1;
                    let tls = TlsInfo {
                        alpn: session.alpn_protocol().map(<[u8]>::to_vec),
                        sni: session.server_name().map(str::to_owned),
                    };
                    serve_connection(stream, peer, router, &settings, Some(tls)).await
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
        stream.write_all(&connection_limit_response()).await?;
        stream.shutdown().await
    })
    .await;
}

/// What the TLS handshake decided for a connection.
struct TlsInfo {
    alpn: Option<Vec<u8>>,
    sni: Option<String>,
}

/// Serves one connection. `tls` is `None` for plain HTTP (HTTP/1.x only:
/// no h2c, no cleartext upgrade), or the TLS session's ALPN protocol
/// (`h2` → HTTP/2, anything else → HTTP/1.1) and SNI name. Choosing the
/// protocol up front, instead of sniffing the first bytes, means the header
/// read timeout runs from the first byte. Each protocol's guard from
/// `protocol.rs` sits between the socket and hyper.
async fn serve_connection<I>(
    io: I,
    peer: SocketAddr,
    router: Router,
    settings: &ConnSettings,
    tls: Option<TlsInfo>,
) where
    I: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let limits = &settings.limits;
    let protocol = &settings.protocol;
    let is_tls = tls.is_some();
    let (alpn, sni) = tls.map_or((None, None), |t| (t.alpn, t.sni));
    let service = hyper::service::service_fn(move |req: Request<_>| {
        let mut req = req.map(Body::new);
        req.extensions_mut().insert(ConnectInfo(peer));
        if is_tls {
            req.extensions_mut().insert(TlsConnection);
        }
        if let Some(sni) = &sni {
            req.extensions_mut().insert(TlsSni(sni.clone()));
        }
        router.clone().oneshot(req)
    });
    let header_bytes = limits.max_header_bytes.max(8 * 1024);
    let refused = Some(settings.refused.clone());
    if alpn.as_deref() == Some(b"h2") {
        let io = TokioIo::new(H2ResetBudget::new(
            io,
            protocol.h2_max_resets_per_second,
            refused,
        ));
        let mut builder = hyper::server::conn::http2::Builder::new(TokioExecutor::new());
        builder
            .timer(TokioTimer::new())
            .max_header_list_size(u32::try_from(header_bytes).unwrap_or(u32::MAX))
            .max_concurrent_streams(protocol.h2_max_concurrent_streams)
            .max_pending_accept_reset_streams(protocol.h2_max_pending_accept_reset_streams)
            .max_local_error_reset_streams(protocol.h2_max_local_error_reset_streams)
            .keep_alive_interval(Some(protocol.h2_keep_alive_interval))
            .keep_alive_timeout(protocol.h2_keep_alive_timeout);
        let _ = builder.serve_connection(io, service).await;
    } else {
        let io = TokioIo::new(
            Http1Guard::new(io, header_bytes, refused).with_max_headers(limits.max_headers),
        );
        let mut builder = hyper::server::conn::http1::Builder::new();
        builder
            .timer(TokioTimer::new())
            .header_read_timeout(limits.header_read_timeout)
            .max_buf_size(header_bytes)
            .max_headers(limits.max_headers)
            .half_close(false)
            .pipeline_flush(false)
            .allow_multiple_spaces_in_request_line_delimiters(false)
            .ignore_invalid_headers(false);
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
    let request_id = request_id::new_request_id();
    let tls = req.extensions().get::<TlsConnection>().is_some();
    let nonce = security::new_nonce();
    let mut used: Option<Arc<security::DeploymentInfo>> = None;
    let mut response = route(&state, req, &request_id, &nonce, &mut used).await;
    let cfg = used.as_ref().map(|i| &i.security);
    finish_response(response.headers_mut(), &request_id, tls, cfg, &nonce);
    Ok(response)
}

async fn route<D: CellDispatcher>(
    state: &AppState<D>,
    req: Request<Body>,
    request_id: &str,
    nonce: &str,
    used: &mut Option<Arc<security::DeploymentInfo>>,
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
    let sni = req.extensions().get::<TlsSni>().map(|s| s.0.as_str());
    if !host_check::consistent(&inner.routes, sni, &host) {
        counters.host_mismatch.fetch_add(1, Ordering::Relaxed);
        return limits::platform_error(
            StatusCode::MISDIRECTED_REQUEST,
            host_check::HOST_MISMATCH_CODE,
            host_check::HOST_MISMATCH_MESSAGE,
            request_id,
            req.headers(),
        );
    }

    // The deployment's `security` settings: they decide the response
    // headers from here on, and preflights are answered here (#47).
    let info = inner.security.get(&entry.deployment_hash).await;
    *used = Some(info.clone());

    // Platform paths: answered here, before preflights and route matching;
    // a tenant route under `/__renox/` is never reached (`client-events.md`
    // section 2).
    if req.uri().path().starts_with(PLATFORM_PREFIX) {
        return platform_path(state, req, &entry, &host, &info, client_ip).await;
    }
    match security::cors::preflight(&info.security.cors, req.method(), req.headers()) {
        security::cors::Preflight::No => {}
        security::cors::Preflight::Allowed(headers) => {
            let mut b = Response::builder().status(StatusCode::NO_CONTENT);
            for (k, v) in headers {
                b = b.header(k, v);
            }
            return b.body(Body::empty()).expect("valid response");
        }
        security::cors::Preflight::Refused => {
            return plain(StatusCode::FORBIDDEN, "CORS request refused");
        }
    }
    let request_headers = req.headers().clone();

    if let Some(mut resp) = inner
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
        security::cors::apply(&info.security.cors, &request_headers, resp.headers_mut());
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
        csp_nonce: nonce.to_owned(),
    };
    prepare_request_headers(req.headers_mut(), request_id, client_ip);
    counters.dispatched.fetch_add(1, Ordering::Relaxed);
    let mut resp = state.dispatcher.dispatch(ctx, req).await;
    security::cors::apply(&info.security.cors, &request_headers, resp.headers_mut());
    resp
}

/// Paths the gateway answers itself, for every app.
pub const PLATFORM_PREFIX: &str = "/__renox/";

async fn platform_path<D: CellDispatcher>(
    state: &AppState<D>,
    req: Request<Body>,
    entry: &RouteEntry,
    host: &str,
    info: &security::DeploymentInfo,
    client_ip: IpAddr,
) -> Response<Body> {
    let inner = &state.gateway.inner;
    match req.uri().path() {
        client_events::EVENTS_PATH => {
            let known: Vec<String> = inner
                .routes
                .entries(host)
                .into_iter()
                .map(|e| e.deployment_hash)
                .collect();
            let tls = req.extensions().get::<TlsConnection>().is_some();
            let target = client_events::Target {
                tenant_id: &entry.tenant_id,
                deployment_hash: &entry.deployment_hash,
                known_hashes: &known,
                enabled: info.client_events,
                host,
                tls,
                client_ip,
            };
            inner.client_events.handle(target, req).await
        }
        client_script::SCRIPT_PATH => client_script::serve(req.method(), req.headers()),
        _ => plain(StatusCode::NOT_FOUND, "Not found"),
    }
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
/// absolute-form HTTP/1.1) if present, else the `Host` header. A request
/// carrying both, naming different hosts, disagrees with itself and is
/// refused.
fn request_host(req: &Request<Body>) -> Result<String, HostError> {
    let mut hosts = req.headers().get_all(header::HOST).iter();
    let header_host = match hosts.next() {
        Some(h) => Some(parse_host(h.to_str().map_err(|_| HostError::Invalid)?)?),
        None => None,
    };
    if hosts.next().is_some() {
        return Err(HostError::Invalid);
    }
    match (req.uri().authority(), header_host) {
        (Some(authority), header_host) => {
            let host = parse_host(authority.as_str())?;
            match header_host {
                Some(h) if h != host => Err(HostError::Invalid),
                _ => Ok(host),
            }
        }
        (None, Some(h)) => Ok(h),
        (None, None) => Err(HostError::Missing),
    }
}

/// Removes hop-by-hop headers (including those named in `Connection`) and
/// every client-sent `x-renox-*` header except [`CSRF_HEADER`], then sets the two headers tenant
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
        .filter(|k| k.as_str().starts_with("x-renox-") && k.as_str() != CSRF_HEADER)
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

/// The protection headers (#47): the deployment's settings when the request
/// reached one, else the defaults (unknown host, bad request, rate limited).
fn finish_response(
    headers: &mut HeaderMap,
    request_id: &str,
    tls: bool,
    cfg: Option<&security::SecurityConfig>,
    nonce: &str,
) {
    let defaults = security::SecurityConfig::default();
    security::apply_headers(headers, cfg.unwrap_or(&defaults), nonce, tls);
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
