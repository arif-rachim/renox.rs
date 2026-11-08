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
use hyper_util::rt::{TokioIo, TokioTimer};
use limits::{BodyCheck, ConnectionLimiter, IdleTimeout, connection_limit_response};
use protocol::Http1Guard;
use tokio::net::TcpListener;
#[cfg(unix)]
use tokio::net::UnixListener;
use tower::ServiceExt;

pub mod client_events;
pub mod client_ip;
pub mod client_script;
pub mod compress;
pub mod limits;
pub mod protocol;
pub mod rate_limit;
pub mod request_id;
pub mod route_table;
pub mod security;
pub mod static_files;
pub mod suspended;
pub mod upgrade;
pub mod well_known;

pub use client_events::{
    ClientEventLimits, ClientEventSink, ClientEventStats, ClientLogLine, DropReason,
};
pub use client_ip::{ClientAddr, ClientIpConfig, IpNet, Peer};
pub use limits::{GatewayLimits, RouteKind};
pub use rate_limit::{RateDecision, RateLimitConfig, RateLimiter};
pub use route_table::{
    HostError, RouteEntry, RouteStatus, RouteTable, RouteTableError, parse_host,
};
pub use static_files::StaticFiles;

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
    /// The client address: the socket peer's, or the trusted edge's
    /// `CF-Connecting-IP` (`client_ip.rs`, #414). IPv4-mapped IPv6 is shown
    /// as IPv4.
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
    /// `/__renox/events` limits (`client_events.rs`).
    pub client_events: ClientEventLimits,
    /// `/.well-known/security.txt` for the platform's own hosts
    /// (`well_known.rs`, #121); `None` serves nothing.
    pub security_txt: Option<Arc<well_known::SecurityTxt>>,
    /// Which socket peers may name the client (`client_ip.rs`, #414).
    pub client_ip: ClientIpConfig,
}

impl GatewayConfig {
    pub fn new(artifact_root: impl Into<PathBuf>) -> Self {
        Self {
            artifact_root: artifact_root.into(),
            wall_clock_limit: Duration::from_secs(30),
            rate_limit: RateLimitConfig::default(),
            limits: GatewayLimits::default(),
            client_events: ClientEventLimits::default(),
            security_txt: None,
            client_ip: ClientIpConfig::default(),
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
    /// Connections closed by the protocol guard (`protocol.rs`): a
    /// malformed or ambiguous HTTP/1 request, h2c or an HTTP/2 preface.
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
    /// Trusted proxies' connections, under their own, larger cap (#414).
    trusted_connections: Arc<ConnectionLimiter>,
    counters: Counters,
    client_events: client_events::ClientEvents,
    cookie_warnings: security::cookies::WarnOnce,
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
        let trusted_connections =
            ConnectionLimiter::new(config.limits.max_connections_per_trusted_peer);
        let client_events = client_events::ClientEvents::new(config.client_events);
        Self {
            inner: Arc::new(Inner {
                config,
                routes,
                statics,
                security,
                limiter,
                connections,
                trusted_connections,
                counters: Counters::default(),
                client_events,
                cookie_warnings: security::cookies::WarnOnce::default(),
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

    /// Accepts plain-HTTP connections (HTTP/1.x only: no h2c, no TLS) on
    /// `listener` until it fails. TLS and HTTP/2 end at Cloudflare's edge
    /// (ADR D25); production listens on a unix socket ([`Gateway::serve_unix`]).
    /// The `renox-worker` binary (#29) calls this; the crate itself has no binary.
    pub async fn serve<D: CellDispatcher>(
        &self,
        listener: TcpListener,
        dispatcher: Arc<D>,
    ) -> std::io::Result<()> {
        accept_loop(listener, self.router(dispatcher), self.conn_settings()).await
    }

    /// Accepts plain-HTTP connections (HTTP/1.x only) on a unix socket
    /// (#414, ADR D25): `cloudflared` reaches it through a `unix:` origin.
    /// A peer whose uid is in [`ClientIpConfig::trusted_socket_uids`] is a
    /// trusted proxy; any other local process is served as [`client_ip::LOCAL_PEER`]
    /// and its forwarding headers are ignored. Unix hosts only (#530).
    #[cfg(unix)]
    pub async fn serve_unix<D: CellDispatcher>(
        &self,
        listener: UnixListener,
        dispatcher: Arc<D>,
    ) -> std::io::Result<()> {
        let router = self.router(dispatcher);
        let settings = self.conn_settings();
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(conn) => conn,
                Err(e) if is_transient_accept_error(&e) => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                }
                Err(e) => return Err(e),
            };
            let uid = stream.peer_cred().ok().map(|c| c.uid());
            let trusted = settings.client_ip.trusts_uid(uid);
            let limiter = if trusted {
                &settings.trusted_connections
            } else {
                &settings.connections
            };
            let guard = limiter.try_acquire(client_ip::LOCAL_PEER);
            let router = router.clone();
            let settings = settings.clone();
            tokio::spawn(async move {
                let Some(_guard) = guard else {
                    reject_connection(stream).await;
                    return;
                };
                let stream = IdleTimeout::new(stream, settings.limits.idle_timeout);
                serve_connection(stream, Peer::Unix { trusted }, router, &settings).await
            });
        }
    }

    fn conn_settings(&self) -> ConnSettings {
        ConnSettings {
            limits: self.inner.config.limits,
            connections: self.inner.connections.clone(),
            trusted_connections: self.inner.trusted_connections.clone(),
            client_ip: Arc::new(self.inner.config.client_ip.clone()),
            refused: self.inner.counters.protocol_refused.clone(),
        }
    }
}

/// What every connection task needs from the gateway.
#[derive(Clone)]
struct ConnSettings {
    limits: GatewayLimits,
    connections: Arc<ConnectionLimiter>,
    trusted_connections: Arc<ConnectionLimiter>,
    client_ip: Arc<ClientIpConfig>,
    refused: Arc<AtomicU64>,
}

async fn accept_loop(
    listener: TcpListener,
    router: Router,
    settings: ConnSettings,
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
        let settings = settings.clone();
        // A trusted proxy carries many clients on its connections: its own,
        // larger cap (#414); every other peer is capped per address.
        let peer_ip = client_ip::normalize(peer.ip());
        let guard = if settings.client_ip.trusts_tcp(peer_ip) {
            settings.trusted_connections.try_acquire(peer_ip)
        } else {
            settings.connections.try_acquire(peer_ip)
        };
        tokio::spawn(async move {
            let Some(_guard) = guard else {
                reject_connection(stream).await;
                return;
            };
            let _ = stream.set_nodelay(true);
            let stream = IdleTimeout::new(stream, settings.limits.idle_timeout);
            serve_connection(stream, Peer::Tcp(peer), router, &settings).await
        });
    }
}

/// Over the per-IP connection cap: a fixed 503 and close, written with a
/// short timeout so a refused client cannot hold the task either.
async fn reject_connection<S: tokio::io::AsyncWrite + Unpin>(mut stream: S) {
    use tokio::io::AsyncWriteExt;
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        stream.write_all(&connection_limit_response()).await?;
        stream.shutdown().await
    })
    .await;
}

/// Serves one plain HTTP/1.x connection (no h2c, no cleartext upgrade, no
/// TLS: ADR D25). The protocol guard from `protocol.rs` sits between the
/// socket and hyper.
async fn serve_connection<I>(io: I, peer: Peer, router: Router, settings: &ConnSettings)
where
    I: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let limits = &settings.limits;
    // #167: set when this connection answers 101; the HTTP/1 guard then
    // stops parsing the bytes that follow as HTTP/1.
    let switch = upgrade::UpgradeSwitch::new();
    let conn_switch = switch.clone();
    let service = hyper::service::service_fn(move |req: Request<_>| {
        let mut req = req.map(Body::new);
        req.extensions_mut().insert(conn_switch.clone());
        req.extensions_mut().insert(peer);
        if let Peer::Tcp(addr) = peer {
            req.extensions_mut().insert(ConnectInfo(addr));
        }
        router.clone().oneshot(req)
    });
    let header_bytes = limits.max_header_bytes.max(8 * 1024);
    let refused = Some(settings.refused.clone());
    let io = TokioIo::new(
        Http1Guard::new(io, header_bytes, refused)
            .with_max_headers(limits.max_headers)
            .with_switch(switch),
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
    // WebSocket upgrades (#281): the cell answers 101 and takes the
    // connection through `upgrade::WsUpgrade`.
    let _ = builder.serve_connection(io, service).with_upgrades().await;
}

fn is_transient_accept_error(e: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    matches!(
        e.kind(),
        ConnectionAborted | ConnectionReset | Interrupted | WouldBlock | OutOfMemory
    ) || e.raw_os_error().is_some_and(is_transient_os_code)
}

// Linux errno values for "out of descriptors or memory, try again later".
#[cfg(unix)]
fn is_transient_os_code(code: i32) -> bool {
    const ENFILE: i32 = 23;
    const EMFILE: i32 = 24;
    const ENOBUFS: i32 = 105;
    const ENOMEM: i32 = 12;
    matches!(code, ENFILE | EMFILE | ENOBUFS | ENOMEM)
}

// Winsock error codes for the same condition, and for a connection reset
// while it sat in the accept queue (#530).
#[cfg(windows)]
fn is_transient_os_code(code: i32) -> bool {
    const WSAEMFILE: i32 = 10024;
    const WSAENOBUFS: i32 = 10055;
    const WSAECONNRESET: i32 = 10054;
    matches!(code, WSAEMFILE | WSAENOBUFS | WSAECONNRESET)
}

// Other targets: only the error kinds above count.
#[cfg(not(any(unix, windows)))]
fn is_transient_os_code(_code: i32) -> bool {
    false
}

async fn handle<D: CellDispatcher>(
    State(state): State<AppState<D>>,
    req: Request<Body>,
) -> Result<Response<Body>, Infallible> {
    let request_id = request_id::new_request_id();
    // HTTPS as the visitor saw it: a trusted proxy's `X-Forwarded-Proto:
    // https` (#418). The worker itself serves no TLS (ADR D25).
    let https = client_addr(&req, &state.gateway.inner.config.client_ip).forwarded_https;
    let switch = req.extensions().get::<upgrade::UpgradeSwitch>().cloned();
    let nonce = security::new_nonce();
    let mut used: Option<Arc<security::DeploymentInfo>> = None;
    // #295: the root span of the request's trace. Ids and the status only:
    // never the path, a header, or the query (renox-cell `src/telemetry/`).
    let span = tracing::info_span!(
        "gateway.request",
        request_id = %request_id,
        tenant_id = tracing::field::Empty,
        status = tracing::field::Empty,
        trace_id = tracing::field::Empty,
    );
    let mut response = tracing::Instrument::instrument(
        route(&state, req, &request_id, &nonce, &mut used),
        span.clone(),
    )
    .await;
    span.record("status", response.status().as_u16());
    // #167: a 101 hands the connection over; set before hyper writes it,
    // so the client's first frame is never parsed as an HTTP/1 head.
    if response.status() == StatusCode::SWITCHING_PROTOCOLS
        && let Some(s) = &switch
    {
        s.set();
    }
    let cfg = used.as_ref().map(|i| &i.security);
    finish_response(response.headers_mut(), &request_id, https, cfg, &nonce);
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
    let client = client_addr(&req, &inner.config.client_ip);
    let client_ip = client.ip;

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
    // The platform's own security.txt, whether or not the host is routed.
    if req.uri().path() == well_known::SECURITY_TXT_PATH
        && let Some(txt) = &inner.config.security_txt
        && txt.serves(&host)
    {
        return txt.response(req.method());
    }
    let Some(entry) = inner.routes.lookup(&host) else {
        // #325: a suspended hostname gets the neutral page, never a cell.
        if let Some(s) = inner.routes.suspended(&host) {
            return suspended::response(s.display_name.as_deref(), request_id, req.headers());
        }
        counters.unknown_host.fetch_add(1, Ordering::Relaxed);
        return plain(StatusCode::NOT_FOUND, "Not found");
    };
    // The deployment's `security` settings: they decide the response
    // headers from here on, and preflights are answered here (#47).
    let info = inner.security.get(&entry.deployment_hash).await;
    *used = Some(info.clone());

    // Platform paths: answered here, before preflights and route matching;
    // a tenant route under `/__renox/` is never reached (`client-events.md`
    // section 2).
    if req.uri().path().starts_with(PLATFORM_PREFIX) {
        return platform_path(state, req, &entry, &host, &info, client).await;
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

    // A WebSocket handshake (#281): checked here, decided by the cell (the
    // route kind, `Origin`, the principal, the caps), which answers 101
    // with the `WsUpgrade` it finds in the request.
    let mut req = req;
    let ws = if upgrade::is_ws_request(&req) {
        match upgrade::WsUpgrade::from_request(&mut req) {
            Ok(u) => Some(u),
            Err(e) => return upgrade::refusal(e),
        }
    } else {
        None
    };

    // F1 has only function routes; the webhook limit applies once a route
    // kind for it exists in the manifest. A `PUT` to `/_files/` is a signed
    // upload (`artifact.md` 1.7): bounded by the per-file maximum, then by the
    // signed `max` in the cell.
    let kind = RouteKind::of_request(req.method(), req.uri().path());
    let limit = inner.config.limits.body_limit(kind, None);
    let checked = if kind == RouteKind::Upload {
        limits::check_upload_body(req, limit).await
    } else {
        limits::check_body(req, limit).await
    };
    let mut req = match checked {
        BodyCheck::Ok(req) => req,
        BodyCheck::TooLarge { headers, .. } => {
            counters.body_too_large.fetch_add(1, Ordering::Relaxed);
            return limits::body_too_large(request_id, &headers);
        }
        BodyCheck::Unreadable => return plain(StatusCode::BAD_REQUEST, "Bad request"),
    };

    tracing::Span::current().record("tenant_id", entry.tenant_id.as_str());
    let ctx = RequestCtx {
        tenant_id: entry.tenant_id.clone(),
        deployment_hash: entry.deployment_hash.clone(),
        request_id: request_id.to_owned(),
        deadline: Instant::now() + inner.config.wall_clock_limit,
        client_ip,
        csp_nonce: nonce.to_owned(),
    };
    prepare_request_headers(
        req.headers_mut(),
        request_id,
        client_ip,
        &inner.config.client_ip,
    );
    req.extensions_mut().insert(client);
    if let Some(ws) = ws {
        req.extensions_mut().insert(ws);
    }
    counters.dispatched.fetch_add(1, Ordering::Relaxed);
    let mut resp = state.dispatcher.dispatch(ctx, req).await;
    security::cors::apply(&info.security.cors, &request_headers, resp.headers_mut());
    // #207: no tenant cookie may reach another tenant's host.
    let rewrites = security::cookies::apply(resp.headers_mut(), &host);
    log_cookie_rewrites(&inner.cookie_warnings, &entry, &rewrites);
    resp
}

/// One `warn` per cell (deployment) and cookie name, with the name and the
/// removed domain only: cookie values never reach the log.
fn log_cookie_rewrites(
    once: &security::cookies::WarnOnce,
    entry: &RouteEntry,
    rewrites: &[security::cookies::Rewrite],
) {
    use security::cookies::Rewrite;
    for r in rewrites {
        match r {
            Rewrite::DomainRemoved { name, domain } => {
                if once.first(&entry.deployment_hash, name) {
                    tracing::warn!(
                        tenant_id = %entry.tenant_id,
                        deployment_hash = %entry.deployment_hash,
                        cookie = %name,
                        removed_domain = %domain,
                        "tenant Set-Cookie Domain removed; the cookie is host-only"
                    );
                }
            }
            Rewrite::Dropped => {
                if once.first(&entry.deployment_hash, "") {
                    tracing::warn!(
                        tenant_id = %entry.tenant_id,
                        deployment_hash = %entry.deployment_hash,
                        "malformed tenant Set-Cookie dropped"
                    );
                }
            }
        }
    }
}

/// Paths the gateway answers itself, for every app.
pub const PLATFORM_PREFIX: &str = "/__renox/";

async fn platform_path<D: CellDispatcher>(
    state: &AppState<D>,
    req: Request<Body>,
    entry: &RouteEntry,
    host: &str,
    info: &security::DeploymentInfo,
    client: ClientAddr,
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
            let target = client_events::Target {
                tenant_id: &entry.tenant_id,
                deployment_hash: &entry.deployment_hash,
                known_hashes: &known,
                enabled: info.client_events,
                host,
                https: client.forwarded_https,
                client_ip: client.ip,
            };
            inner.client_events.handle(target, req).await
        }
        client_script::SCRIPT_PATH => client_script::serve(req.method(), req.headers()),
        _ => plain(StatusCode::NOT_FOUND, "Not found"),
    }
}

/// The request's client (#414): from the [`Peer`] the accept loop set (or
/// a test's `ConnectInfo`), and the trusted edge's header if the peer is
/// one. No peer at all (a router driven by hand): the unspecified address.
fn client_addr(req: &Request<Body>, config: &ClientIpConfig) -> ClientAddr {
    let peer = req.extensions().get::<Peer>().copied().or_else(|| {
        req.extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(addr)| Peer::Tcp(*addr))
    });
    match peer {
        Some(peer) => client_ip::resolve(peer, req.headers(), config),
        None => ClientAddr {
            ip: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            via_trusted_proxy: false,
            forwarded_https: false,
        },
    }
}

/// The request's hostname: the URI authority (absolute-form HTTP/1.1) if
/// present, else the `Host` header. A request
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

/// Removes hop-by-hop headers (including those named in `Connection`), the
/// forwarding headers of `client_ip.rs` (from every peer, #414) and every
/// client-sent `x-renox-*` header except [`CSRF_HEADER`], then sets the two
/// headers tenant code may trust (`ops.md` section 6).
fn prepare_request_headers(
    headers: &mut HeaderMap,
    request_id: &str,
    client_ip: IpAddr,
    config: &ClientIpConfig,
) {
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
    client_ip::strip(headers, config);
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

/// `Strict-Transport-Security` on responses to requests that reached the
/// edge over HTTPS (`docs/04-isolation-security.md`, "HSTS").
pub const HSTS: &str = "max-age=31536000; includeSubDomains";

/// The protection headers (#47): the deployment's settings when the request
/// reached one, else the defaults (unknown host, bad request, rate limited).
/// `https`: a trusted proxy said the visitor used HTTPS (#418, ADR D25);
/// then HSTS and CSP `upgrade-insecure-requests` are sent. Never on plain
/// HTTP from an untrusted peer, so a `renox dev` listener never sends them.
fn finish_response(
    headers: &mut HeaderMap,
    request_id: &str,
    https: bool,
    cfg: Option<&security::SecurityConfig>,
    nonce: &str,
) {
    let defaults = security::SecurityConfig::default();
    security::apply_headers(headers, cfg.unwrap_or(&defaults), nonce, https);
    if https {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static(HSTS),
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
