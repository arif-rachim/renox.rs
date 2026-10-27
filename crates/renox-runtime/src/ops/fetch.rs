//! `op_renox_fetch`, `op_fetch_body_read`, `op_fetch_body_close`
//! (`docs/contracts/ops.md` section 2): the only outbound network path of
//! tenant code. Backs the global `fetch` and `ctx.fetch`.
//!
//! Every hop runs the contract's order of checks: allowlist (scheme, host,
//! port) → DNS resolved here, every address checked → connect to one of the
//! checked addresses with the original `Host` and SNI → on a 3xx, the same
//! checks for the `Location` target. The whole fetch, including body reads,
//! is bounded by the request deadline, and the bytes on the wire count
//! against the request's egress limit.

use std::borrow::Cow;
use std::cell::RefCell;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::Instant;

use bytes::Bytes;
use deno_core::error::AnyError;
use deno_core::{
    ByteString, CancelFuture, CancelHandle, JsBuffer, OpState, Resource, ResourceId, ToJsBuffer,
    op2,
};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use url::Url;

use crate::ops::net_policy::{
    Allowlist, BlockReason, Blocked, CREDENTIAL_HEADERS, ExtraBlocked, RedirectError, Scheme,
    Target, TargetHost, check_addresses, is_redirect, method_blocked, redirect_target,
};
use crate::ops::request::{RequestState, live_request, op_error};
use crate::runtime::{LogLine, LogSink};

/// Concurrent fetches per request (`ops.md` section 2, "Limits").
pub const MAX_CONCURRENT_FETCHES: u32 = 16;
/// Request headers per fetch.
pub const MAX_HEADERS: usize = 64;
/// Total request header bytes per fetch.
pub const MAX_HEADER_BYTES: usize = 16 * 1024;

// ---------------------------------------------------------------------------
// DNS

/// Resolves a host name to addresses. The runtime uses hickory with the
/// system configuration; tests inject a fake or point hickory at a stub.
pub trait Resolve: Send + Sync {
    fn lookup<'a>(
        &'a self,
        host: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = std::io::Result<Vec<IpAddr>>> + Send + 'a>>;
}

/// hickory-resolver, without the hosts file (it maps names the operator
/// chose, not the tenant) and with A and AAAA queried, so every address is
/// checked.
pub struct HickoryResolver(hickory_resolver::TokioResolver);

impl HickoryResolver {
    /// System nameservers (`/etc/resolv.conf`).
    pub fn system() -> std::io::Result<HickoryResolver> {
        let (config, opts) = hickory_resolver::system_conf::read_system_conf()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(Self::with(config, opts))
    }

    /// One nameserver over UDP (and TCP for truncated answers).
    pub fn nameserver(addr: SocketAddr) -> HickoryResolver {
        use hickory_resolver::config::{NameServerConfigGroup, ResolverConfig};
        let group = NameServerConfigGroup::from_ips_clear(&[addr.ip()], addr.port(), true);
        Self::with(
            ResolverConfig::from_parts(None, vec![], group),
            Default::default(),
        )
    }

    fn with(
        config: hickory_resolver::config::ResolverConfig,
        mut opts: hickory_resolver::config::ResolverOpts,
    ) -> HickoryResolver {
        use hickory_resolver::config::{LookupIpStrategy, ResolveHosts};
        opts.use_hosts_file = ResolveHosts::Never;
        opts.ip_strategy = LookupIpStrategy::Ipv4AndIpv6;
        // Each hop resolves exactly once and connects to what it checked; a
        // cache would only add a second source of truth.
        opts.cache_size = 0;
        HickoryResolver(hickory_resolver::TokioResolver::tokio(config, opts))
    }
}

impl Resolve for HickoryResolver {
    fn lookup<'a>(
        &'a self,
        host: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = std::io::Result<Vec<IpAddr>>> + Send + 'a>> {
        Box::pin(async move {
            // A trailing dot makes the name absolute: no search domains.
            let fqdn = format!("{host}.");
            let lookup = self
                .0
                .lookup_ip(fqdn.as_str())
                .await
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            Ok(lookup.iter().collect())
        })
    }
}

/// Process-wide fetch configuration (operator side; tenants have no say).
#[derive(Clone)]
pub struct FetchConfig {
    pub resolver: Arc<dyn Resolve>,
    /// The node's own public addresses and the control plane's.
    pub extra_blocked: ExtraBlocked,
    /// Trust anchors added to the webpki roots (an operator's egress CA).
    /// There is no way to disable verification.
    pub extra_root_certs: Vec<rustls::pki_types::CertificateDer<'static>>,
    /// Test-only: connect to the right-hand address when the vetted address
    /// is the left-hand one. Compiled only with the `test-hooks` feature.
    #[cfg(feature = "test-hooks")]
    pub connect_override: std::collections::HashMap<SocketAddr, SocketAddr>,
}

impl FetchConfig {
    pub fn with_resolver(resolver: Arc<dyn Resolve>) -> FetchConfig {
        FetchConfig {
            resolver,
            extra_blocked: ExtraBlocked::default(),
            extra_root_certs: Vec::new(),
            #[cfg(feature = "test-hooks")]
            connect_override: Default::default(),
        }
    }

    fn tls(&self) -> Arc<rustls::ClientConfig> {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        for c in &self.extra_root_certs {
            let _ = roots.add(c.clone());
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let cfg = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("ring supports the default protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        Arc::new(cfg)
    }
}

impl Default for FetchConfig {
    fn default() -> Self {
        match HickoryResolver::system() {
            Ok(r) => FetchConfig::with_resolver(Arc::new(r)),
            // No resolv.conf: every lookup fails (fail closed).
            Err(_) => FetchConfig::with_resolver(Arc::new(NoResolver)),
        }
    }
}

struct NoResolver;

impl Resolve for NoResolver {
    fn lookup<'a>(
        &'a self,
        _host: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = std::io::Result<Vec<IpAddr>>> + Send + 'a>> {
        Box::pin(async { Err(std::io::Error::other("no resolver configured")) })
    }
}

// ---------------------------------------------------------------------------
// Per-isolate and per-request state

/// What `op_renox_fetch` needs from the isolate, put into its `OpState` at creation.
pub(crate) struct FetchEnv {
    pub allowlist: Allowlist,
    pub config: FetchConfig,
    pub tls: Arc<rustls::ClientConfig>,
    pub tenant_id: String,
    pub deployment_hash: String,
    pub log_sink: Arc<dyn LogSink>,
}

impl FetchEnv {
    pub fn new(
        allowlist: Allowlist,
        config: FetchConfig,
        tenant_id: String,
        deployment_hash: String,
        log_sink: Arc<dyn LogSink>,
    ) -> FetchEnv {
        let tls = config.tls();
        FetchEnv {
            allowlist,
            config,
            tls,
            tenant_id,
            deployment_hash,
            log_sink,
        }
    }
}

/// Bytes on the wire of all fetches of one request, against its limit.
#[derive(Debug)]
pub(crate) struct EgressCounter {
    pub sent: AtomicU64,
    pub received: AtomicU64,
    pub limit: u64,
    /// Set when a read or write was refused because the limit was reached.
    tripped: std::sync::atomic::AtomicBool,
}

impl EgressCounter {
    pub fn new(limit: u64) -> EgressCounter {
        EgressCounter {
            sent: AtomicU64::new(0),
            received: AtomicU64::new(0),
            limit,
            tripped: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn total(&self) -> u64 {
        self.sent.load(Ordering::Relaxed) + self.received.load(Ordering::Relaxed)
    }

    /// Bytes still allowed.
    fn remaining(&self) -> u64 {
        self.limit.saturating_sub(self.total())
    }

    pub fn exceeded(&self) -> bool {
        self.tripped.load(Ordering::Relaxed) || self.total() > self.limit
    }

    fn trip(&self) -> std::io::Error {
        self.tripped.store(true, Ordering::Relaxed);
        std::io::Error::other("egress limit")
    }
}

/// An I/O stream that counts bytes against an [`EgressCounter`]. Each read
/// and write is capped at the bytes still allowed, so a large body stops
/// exactly at the limit instead of one socket buffer later.
struct CountingIo<T> {
    inner: T,
    counter: Arc<EgressCounter>,
}

impl<T: AsyncRead + Unpin> AsyncRead for CountingIo<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let remaining = self.counter.remaining();
        if remaining == 0 {
            return Poll::Ready(Err(self.counter.trip()));
        }
        let cap = (buf.remaining() as u64).min(remaining).min(64 * 1024) as usize;
        let mut tmp = [0u8; 64 * 1024];
        let mut limited = ReadBuf::new(&mut tmp[..cap]);
        let r = Pin::new(&mut self.inner).poll_read(cx, &mut limited);
        if let Poll::Ready(Ok(())) = &r {
            let n = limited.filled().len();
            buf.put_slice(limited.filled());
            self.counter.received.fetch_add(n as u64, Ordering::Relaxed);
        }
        r
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for CountingIo<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let remaining = self.counter.remaining();
        if remaining == 0 {
            return Poll::Ready(Err(self.counter.trip()));
        }
        let cap = (data.len() as u64).min(remaining) as usize;
        let r = Pin::new(&mut self.inner).poll_write(cx, &data[..cap]);
        if let Poll::Ready(Ok(n)) = &r {
            self.counter.sent.fetch_add(*n as u64, Ordering::Relaxed);
        }
        r
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

trait Io: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}

// ---------------------------------------------------------------------------
// Errors

/// Why a fetch failed; mapped to the contract's codes and reasons.
#[derive(Debug)]
pub(crate) enum FetchFailure {
    Blocked {
        host: String,
        reason: BlockReason,
        hop: usize,
    },
    Failed {
        host: String,
        reason: &'static str,
    },
    EgressLimit {
        host: String,
        limit: u64,
    },
    Deadline,
}

impl FetchFailure {
    fn into_error(self) -> AnyError {
        match self {
            FetchFailure::Blocked { host, reason, hop } => op_error(
                "RENOX_FETCH_BLOCKED",
                serde_json::json!({ "host": host, "reason": reason.as_str(), "hop": hop }),
                "The request was blocked by the outbound network policy.",
            ),
            FetchFailure::Failed { host, reason } => op_error(
                "RENOX_FETCH_FAILED",
                serde_json::json!({ "host": host, "reason": reason }),
                "The outbound request failed.",
            ),
            FetchFailure::EgressLimit { host, limit } => op_error(
                "RENOX_FETCH_EGRESS_LIMIT",
                serde_json::json!({ "host": host, "limitBytes": limit }),
                "The request's outbound byte limit was reached.",
            ),
            FetchFailure::Deadline => op_error(
                "RENOX_DEADLINE",
                serde_json::Value::Null,
                "The request's deadline passed.",
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// One hop

/// Step 2: resolve in Rust and check every address. IP literals skip DNS
/// but not the ranges.
async fn resolve_and_check(
    env_resolver: &Arc<dyn Resolve>,
    extra: &ExtraBlocked,
    target: &Target,
    hop: usize,
) -> Result<Vec<SocketAddr>, FetchFailure> {
    let host = target.host.display();
    let ips = match &target.host {
        TargetHost::Ip(ip) => vec![*ip],
        TargetHost::Domain(d) => {
            env_resolver
                .lookup(d)
                .await
                .map_err(|_| FetchFailure::Failed {
                    host: host.clone(),
                    reason: "dns",
                })?
        }
    };
    if ips.is_empty() {
        return Err(FetchFailure::Failed {
            host,
            reason: "dns",
        });
    }
    check_addresses(&ips, extra).map_err(|reason| FetchFailure::Blocked {
        host: host.clone(),
        reason,
        hop,
    })?;
    Ok(ips
        .into_iter()
        .map(|ip| SocketAddr::new(ip, target.port))
        .collect())
}

/// Step 3: connect to one of the checked addresses, in resolver order, and
/// never to anything else. TLS with SNI = the URL host.
async fn connect(
    env: &FetchEnv,
    addrs: &[SocketAddr],
    target: &Target,
    counter: Arc<EgressCounter>,
) -> Result<Box<dyn Io>, FetchFailure> {
    let host = target.host.display();
    let mut tcp = None;
    for addr in addrs {
        #[cfg(feature = "test-hooks")]
        let addr = env.config.connect_override.get(addr).unwrap_or(addr);
        if let Ok(s) = TcpStream::connect(addr).await {
            tcp = Some(s);
            break;
        }
    }
    let tcp = tcp.ok_or_else(|| FetchFailure::Failed {
        host: host.clone(),
        reason: "connect",
    })?;
    let _ = tcp.set_nodelay(true);
    let io: Box<dyn Io> = match target.scheme {
        Scheme::Http => Box::new(tcp),
        Scheme::Https => {
            let name = match &target.host {
                TargetHost::Domain(d) => rustls::pki_types::ServerName::try_from(d.clone()),
                TargetHost::Ip(ip) => Ok(rustls::pki_types::ServerName::IpAddress((*ip).into())),
            }
            .map_err(|_| FetchFailure::Failed {
                host: host.clone(),
                reason: "tls",
            })?;
            let connector = tokio_rustls::TlsConnector::from(env.tls.clone());
            // Count the TLS handshake bytes too: wrap below TLS.
            let counted = CountingIo {
                inner: tcp,
                counter: counter.clone(),
            };
            let tls = connector
                .connect(name, counted)
                .await
                .map_err(|_| FetchFailure::Failed {
                    host: host.clone(),
                    reason: "tls",
                })?;
            return Ok(Box::new(tls));
        }
    };
    Ok(Box::new(CountingIo { inner: io, counter }))
}

/// A response whose body is still on the wire.
pub(crate) struct HopResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(ByteString, ByteString)>,
    pub body: Incoming,
    conn: tokio::task::JoinHandle<()>,
}

const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
];

#[allow(clippy::too_many_arguments)]
async fn send_hop(
    env: &FetchEnv,
    addrs: &[SocketAddr],
    target: &Target,
    url: &Url,
    method: &str,
    headers: &[(ByteString, ByteString)],
    body: &Option<Bytes>,
    counter: Arc<EgressCounter>,
) -> Result<HopResponse, FetchFailure> {
    let host = target.host.display();
    let failed = |reason| FetchFailure::Failed {
        host: host.clone(),
        reason,
    };
    let io = connect(env, addrs, target, counter.clone()).await?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(io))
        .await
        .map_err(|_| failed("connect"))?;
    let conn = tokio::spawn(async move {
        let _ = conn.await;
    });
    let path = match url.query() {
        Some(q) => format!("{}?{}", url.path(), q),
        None => url.path().to_string(),
    };
    let authority = match (url.port(), &target.host) {
        (Some(p), TargetHost::Ip(IpAddr::V6(v6))) => format!("[{v6}]:{p}"),
        (None, TargetHost::Ip(IpAddr::V6(v6))) => format!("[{v6}]"),
        (Some(p), _) => format!("{}:{p}", target.host.display()),
        (None, _) => target.host.display(),
    };
    let mut b = http::Request::builder()
        .method(method)
        .uri(path)
        .header(http::header::HOST, authority);
    for (k, v) in headers {
        let name = String::from_utf8_lossy(k).to_ascii_lowercase();
        if HOP_BY_HOP.contains(&name.as_str()) {
            continue;
        }
        b = b.header(k.as_slice(), v.as_slice());
    }
    let req = b
        .body(Full::new(body.clone().unwrap_or_default()))
        .map_err(|_| failed("headers"))?;
    let resp = sender.send_request(req).await.map_err(|_| {
        if counter.exceeded() {
            FetchFailure::EgressLimit {
                host: host.clone(),
                limit: counter.limit,
            }
        } else {
            failed("reset")
        }
    })?;
    let status = resp.status();
    let headers = resp
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                ByteString::from(k.as_str().as_bytes().to_vec()),
                ByteString::from(v.as_bytes().to_vec()),
            )
        })
        .collect();
    Ok(HopResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body: resp.into_body(),
        conn,
    })
}

fn header_value<'a>(headers: &'a [(ByteString, ByteString)], name: &str) -> Option<Cow<'a, str>> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name.as_bytes()))
        .map(|(_, v)| String::from_utf8_lossy(v))
}

/// The redirect loop: run one hop per URL, re-checking the policy every
/// time, until a non-redirect response (or `manual`/`error` mode).
pub(crate) struct FetchResult {
    pub final_url: Url,
    pub redirected: bool,
    pub response: HopResponse,
}

async fn fetch_with_policy(
    env: &FetchEnv,
    req: FetchRequest,
    counter: Arc<EgressCounter>,
) -> Result<FetchResult, FetchFailure> {
    let mut url = Url::parse(&req.url).map_err(|_| FetchFailure::Blocked {
        host: String::new(),
        reason: BlockReason::Scheme,
        hop: 0,
    })?;
    let mut method = req.method.to_ascii_uppercase();
    let mut headers = req.headers;
    let mut body: Option<Bytes> = req.body.map(|b| Bytes::copy_from_slice(&b));
    let host0 = url.host_str().unwrap_or("").to_string();
    if method_blocked(&method) {
        return Err(FetchFailure::Blocked {
            host: host0,
            reason: BlockReason::Method,
            hop: 0,
        });
    }
    let header_bytes: usize = headers.iter().map(|(k, v)| k.len() + v.len()).sum();
    if headers.len() > MAX_HEADERS || header_bytes > MAX_HEADER_BYTES {
        return Err(FetchFailure::Failed {
            host: host0,
            reason: "headers",
        });
    }
    let mut hop = 0usize;
    loop {
        // Step 1.
        let target = env
            .allowlist
            .check_url(&url)
            .map_err(|Blocked { host, reason }| FetchFailure::Blocked { host, reason, hop })?;
        // Step 2.
        let addrs = resolve_and_check(
            &env.config.resolver,
            &env.config.extra_blocked,
            &target,
            hop,
        )
        .await?;
        // Step 3.
        let response = send_hop(
            env,
            &addrs,
            &target,
            &url,
            &method,
            &headers,
            &body,
            counter.clone(),
        )
        .await?;
        if !is_redirect(response.status) || req.redirect == "manual" {
            return Ok(FetchResult {
                final_url: url,
                redirected: hop > 0,
                response,
            });
        }
        if req.redirect == "error" {
            response.conn.abort();
            return Err(FetchFailure::Failed {
                host: target.host.display(),
                reason: "redirect",
            });
        }
        // Step 4.
        let location = header_value(&response.headers, "location").map(|l| l.into_owned());
        response.conn.abort();
        hop += 1;
        let next = redirect_target(
            &url,
            &method,
            response.status,
            location.as_deref(),
            hop,
            &env.allowlist,
        )
        .map_err(|e| match e {
            RedirectError::BadLocation => FetchFailure::Failed {
                host: target.host.display(),
                reason: "redirect",
            },
            RedirectError::Blocked(Blocked { host, reason }) => {
                FetchFailure::Blocked { host, reason, hop }
            }
        })?;
        if !next.keep_body {
            body = None;
            headers.retain(|(k, _)| {
                !k.eq_ignore_ascii_case(b"content-type")
                    && !k.eq_ignore_ascii_case(b"content-encoding")
            });
        }
        if next.strip_credentials {
            headers.retain(|(k, _)| {
                !CREDENTIAL_HEADERS
                    .iter()
                    .any(|c| k.eq_ignore_ascii_case(c.as_bytes()))
            });
        }
        method = next.method;
        url = next.url;
    }
}

// ---------------------------------------------------------------------------
// Ops

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchRequest {
    method: String,
    url: String,
    headers: Vec<(ByteString, ByteString)>,
    body: Option<JsBuffer>,
    redirect: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchResponseHead {
    status: u16,
    status_text: String,
    headers: Vec<(ByteString, ByteString)>,
    url: String,
    redirected: bool,
    body: Option<ResourceId>,
}

/// A response body being read by tenant code.
pub(crate) struct FetchBody {
    body: RefCell<Option<Incoming>>,
    conn: tokio::task::JoinHandle<()>,
    host: String,
    token: u32,
}

impl Resource for FetchBody {
    fn name(&self) -> Cow<'_, str> {
        "renoxFetchBody".into()
    }

    fn close(self: Rc<Self>) {
        self.conn.abort();
        self.body.borrow_mut().take();
    }
}

fn log_blocked(env: &FetchEnv, request_id: Option<String>, host: &str, reason: &str) {
    let mut fields = serde_json::Map::new();
    fields.insert("code".into(), "RENOX_FETCH_BLOCKED".into());
    fields.insert("host".into(), host.into());
    fields.insert("reason".into(), reason.into());
    env.log_sink.log(LogLine {
        level: "warn",
        tenant_id: env.tenant_id.clone(),
        deployment_hash: env.deployment_hash.clone(),
        request_id,
        message: "fetch blocked".into(),
        fields,
    });
}

/// Run `fut` until the request's deadline or cancellation.
async fn bounded<T>(
    fut: impl std::future::Future<Output = Result<T, FetchFailure>>,
    deadline: Instant,
    cancel: Rc<CancelHandle>,
) -> Result<T, FetchFailure> {
    let timed = tokio::time::timeout_at(deadline.into(), fut);
    match timed.or_cancel(cancel).await {
        Ok(Ok(r)) => r,
        Ok(Err(_elapsed)) => Err(FetchFailure::Deadline),
        Err(_cancelled) => Err(FetchFailure::Deadline),
    }
}

/// Close a resource without holding the table borrow across `close`.
fn close_rid(state: &mut OpState, rid: ResourceId) {
    if let Ok(r) = state.resource_table.take_any(rid) {
        r.close();
    }
}

#[op2(async)]
#[serde]
pub(crate) async fn op_renox_fetch(
    state: Rc<RefCell<OpState>>,
    token: u32,
    #[serde] req: FetchRequest,
) -> Result<FetchResponseHead, AnyError> {
    let (request, env) = {
        let s = state.borrow();
        let request = live_request(&s, token)?;
        let env = s.borrow::<Rc<FetchEnv>>().clone();
        (request, env)
    };
    let (deadline, cancel, counter, request_id) = {
        let mut r = request.borrow_mut();
        if r.fetches_in_flight >= MAX_CONCURRENT_FETCHES {
            let host = Url::parse(&req.url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_default();
            return Err(FetchFailure::Failed {
                host,
                reason: "concurrency",
            }
            .into_error());
        }
        r.fetches_in_flight += 1;
        (
            r.deadline,
            r.cancel.clone(),
            r.egress.clone(),
            r.request_id.clone(),
        )
    };
    let result = bounded(
        fetch_with_policy(&env, req, counter.clone()),
        deadline,
        cancel,
    )
    .await;
    request.borrow_mut().fetches_in_flight -= 1;
    let result = result.map_err(|f| match f {
        FetchFailure::Failed { host, .. } if counter.exceeded() => FetchFailure::EgressLimit {
            host,
            limit: counter.limit,
        },
        other => other,
    });
    match result {
        Ok(FetchResult {
            final_url,
            redirected,
            response,
        }) => {
            let host = final_url.host_str().unwrap_or("").to_string();
            let rid = state.borrow_mut().resource_table.add(FetchBody {
                body: RefCell::new(Some(response.body)),
                conn: response.conn,
                host,
                token,
            });
            request.borrow_mut().fetch_bodies.push(rid);
            Ok(FetchResponseHead {
                status: response.status,
                status_text: response.status_text,
                headers: response.headers,
                url: final_url.to_string(),
                redirected,
                body: Some(rid),
            })
        }
        Err(failure) => {
            if let FetchFailure::Blocked { host, reason, .. } = &failure {
                request.borrow_mut().fetch_blocked += 1;
                log_blocked(&env, Some(request_id), host, reason.as_str());
            }
            Err(failure.into_error())
        }
    }
}

/// Next chunk of a response body; `null` at the end.
#[op2(async)]
#[serde]
pub(crate) async fn op_fetch_body_read(
    state: Rc<RefCell<OpState>>,
    token: u32,
    #[smi] rid: ResourceId,
) -> Result<Option<ToJsBuffer>, AnyError> {
    let (request, resource) = {
        let s = state.borrow();
        let request = live_request(&s, token)?;
        let resource = s.resource_table.get::<FetchBody>(rid)?;
        (request, resource)
    };
    if resource.token != token {
        return Err(crate::ops::request::no_request());
    }
    let (deadline, cancel, counter) = {
        let r = request.borrow();
        (r.deadline, r.cancel.clone(), r.egress.clone())
    };
    let host = resource.host.clone();
    let read = async {
        let Some(mut body) = resource.body.borrow_mut().take() else {
            return Ok(None);
        };
        let out = loop {
            match body.frame().await {
                None => break Ok(None),
                Some(Ok(frame)) => {
                    if let Ok(data) = frame.into_data() {
                        if data.is_empty() {
                            continue;
                        }
                        break Ok(Some(data.to_vec()));
                    }
                }
                Some(Err(_)) => {
                    break Err(if counter.exceeded() {
                        FetchFailure::EgressLimit {
                            host: host.clone(),
                            limit: counter.limit,
                        }
                    } else {
                        FetchFailure::Failed {
                            host: host.clone(),
                            reason: "reset",
                        }
                    });
                }
            }
        };
        if matches!(out, Ok(Some(_))) {
            *resource.body.borrow_mut() = Some(body);
        }
        out
    };
    match bounded(read, deadline, cancel).await {
        Ok(Some(chunk)) => Ok(Some(chunk.into())),
        Ok(None) => {
            close_rid(&mut state.borrow_mut(), rid);
            Ok(None)
        }
        Err(f) => {
            close_rid(&mut state.borrow_mut(), rid);
            Err(f.into_error())
        }
    }
}

/// Close a response body the tenant no longer reads.
#[op2(fast)]
pub(crate) fn op_fetch_body_close(state: &mut OpState, #[smi] rid: ResourceId) {
    close_rid(state, rid);
}

/// Called when a request ends: close every body it still holds.
pub(crate) fn close_request_bodies(state: &mut OpState, request: &RequestState) {
    for rid in &request.fetch_bodies {
        close_rid(state, *rid);
    }
}
