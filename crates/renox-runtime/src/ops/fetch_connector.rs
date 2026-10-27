//! The connection half of tenant `fetch` (#108): DNS resolution, the
//! connection to an **already-checked** address, TLS, and egress counting.
//! No V8 here, so these pieces are tested on their own
//! (`tests/fetch_rebinding.rs`).
//!
//! The rule this file enforces (`docs/24-threat-model.md` section B, "DNS
//! rebinding"): a host name is resolved exactly once per hop, every answer
//! is checked (`net_policy::resolve_and_check`), and the socket is opened
//! to one of those checked addresses, in resolver order, with no happy
//! eyeballs and no second lookup by any HTTP client. A DNS server that
//! answers a public address first and a private one later can therefore
//! never steer the connection. TLS is rustls with the webpki roots (plus
//! operator-supplied anchors); there is no way to turn verification off.

use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

/// One connect attempt per resolved address; the whole fetch is still
/// bounded by the request deadline.
pub const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

use crate::ops::net_policy::{
    BlockReason, ExtraBlocked, Resolve, ResolveError, Scheme, Target, TargetHost, resolve_and_check,
};

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

    /// The TLS client configuration: webpki roots plus `extra_root_certs`.
    pub fn tls(&self) -> Arc<rustls::ClientConfig> {
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

/// Bytes on the wire of all fetches of one request, against its limit.
#[derive(Debug)]
pub struct EgressCounter {
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

pub trait Io: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}

/// Why a fetch failed; mapped to the contract's codes and reasons.
#[derive(Debug)]
pub enum FetchFailure {
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

/// Steps 1-2 of a hop after the allowlist: resolve once, check every
/// address, map failures to the contract's reasons.
pub async fn resolve_checked(
    config: &FetchConfig,
    target: &Target,
    hop: usize,
) -> Result<Vec<SocketAddr>, FetchFailure> {
    resolve_and_check(config.resolver.as_ref(), &config.extra_blocked, target)
        .await
        .map_err(|e| match e {
            ResolveError::Dns => FetchFailure::Failed {
                host: target.host.display(),
                reason: "dns",
            },
            ResolveError::Blocked(reason) => FetchFailure::Blocked {
                host: target.host.display(),
                reason,
                hop,
            },
        })
}

/// Step 3: connect to one of the checked addresses, in resolver order, and
/// never to anything else: the connector takes socket addresses, not a
/// host name, so no second resolution can happen. TLS with SNI = the URL
/// host and certificate verification always on.
pub async fn connect(
    config: &FetchConfig,
    tls: &Arc<rustls::ClientConfig>,
    addrs: &[SocketAddr],
    target: &Target,
    counter: Arc<EgressCounter>,
) -> Result<Box<dyn Io>, FetchFailure> {
    let host = target.host.display();
    let mut tcp = None;
    for addr in addrs {
        #[cfg(feature = "test-hooks")]
        let addr = config.connect_override.get(addr).unwrap_or(addr);
        #[cfg(not(feature = "test-hooks"))]
        let _ = config;
        // Sequential, one address at a time, each with its own timeout, so
        // a black-holed first address does not use up the deadline.
        if let Ok(Ok(s)) = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
            tcp = Some(s);
            break;
        }
    }
    let tcp = tcp.ok_or_else(|| FetchFailure::Failed {
        host: host.clone(),
        reason: "connect",
    })?;
    let _ = tcp.set_nodelay(true);
    // Count below TLS, so handshake bytes count too.
    let counted = CountingIo {
        inner: tcp,
        counter,
    };
    match target.scheme {
        Scheme::Http => Ok(Box::new(counted)),
        Scheme::Https => {
            let name = match &target.host {
                TargetHost::Domain(d) => rustls::pki_types::ServerName::try_from(d.clone()),
                TargetHost::Ip(ip) => Ok(rustls::pki_types::ServerName::IpAddress((*ip).into())),
            }
            .map_err(|_| FetchFailure::Failed {
                host: host.clone(),
                reason: "tls",
            })?;
            let connector = tokio_rustls::TlsConnector::from(tls.clone());
            let stream =
                connector
                    .connect(name, counted)
                    .await
                    .map_err(|_| FetchFailure::Failed {
                        host: host.clone(),
                        reason: "tls",
                    })?;
            Ok(Box::new(stream))
        }
    }
}
