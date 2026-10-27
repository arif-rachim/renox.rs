//! Outbound network policy for tenant `fetch` (`docs/contracts/ops.md` section 2).
//!
//! Pure functions with no V8 dependency, so they are unit-tested in the
//! non-V8 test target (`cargo test -p renox-runtime --no-default-features`):
//!
//! - [`Allowlist`]: parses `manifest.permissions.network[]` entries and
//!   decides whether a URL's scheme, host, and port are allowed;
//! - [`blocked_reason`]: the blocked address ranges, one table with a comment
//!   per range;
//! - [`check_addresses`]: applies the ranges to every resolved address
//!   (failing closed when any one is blocked);
//! - [`redirect_target`]: the per-hop rules for a 3xx `Location`.
//!
//! The order of checks is the contract's "Order of checks (every hop)":
//! allowlist (scheme, host, port) first, then DNS in Rust, then every
//! resolved address against the ranges, then connect to one of the checked
//! addresses (`fetch_connector.rs`, #108).

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;

use url::{Host, Url};

/// Why a request was refused. The string form is the contract's `reason`
/// (`ops.md` section 2, `RENOX_FETCH_BLOCKED`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockReason {
    /// Host (or IP literal) not on the allowlist.
    NotAllowlisted,
    /// Scheme other than `https`, or `http` for a host not declared with `http://`.
    Scheme,
    /// Port not allowed by the matching entry.
    Port,
    /// A resolved address (or a name that always means one, such as
    /// `localhost`) is in a blocked range.
    BlockedAddress,
    /// More than [`MAX_REDIRECTS`] redirect hops.
    RedirectLimit,
    /// `CONNECT` or `TRACE`.
    Method,
}

impl BlockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            BlockReason::NotAllowlisted => "not_allowlisted",
            BlockReason::Scheme => "scheme",
            BlockReason::Port => "port",
            BlockReason::BlockedAddress => "blocked_address",
            BlockReason::RedirectLimit => "redirect_limit",
            BlockReason::Method => "method",
        }
    }
}

/// Maximum number of redirect hops a single `fetch` follows.
pub const MAX_REDIRECTS: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Http,
    Https,
}

impl Scheme {
    pub fn default_port(self) -> u16 {
        match self {
            Scheme::Http => 80,
            Scheme::Https => 443,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HostPattern {
    /// `api.stripe.com`: that host only.
    Exact(String),
    /// `*.tabby.ai`: any subdomain at any depth, never the apex. Stores the
    /// suffix with its leading dot (`.tabby.ai`).
    Wildcard(String),
    /// `203.0.113.7` or `[2001:db8::1]`: that literal only.
    Ip(IpAddr),
}

/// One parsed allowlist entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowEntry {
    /// `Http` only when the entry is written `http://host`; plain HTTP is
    /// then allowed for that host (`docs/24-threat-model.md`, TLS row).
    scheme: Scheme,
    host: HostPattern,
    /// `None`: the scheme's default port only.
    port: Option<u16>,
}

/// An entry of `permissions.network[]` that cannot be parsed. Deployment
/// fails closed (`artifact.md` V9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidEntry {
    pub entry: String,
    pub reason: &'static str,
}

impl std::fmt::Display for InvalidEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid network entry {:?}: {}", self.entry, self.reason)
    }
}

impl std::error::Error for InvalidEntry {}

impl AllowEntry {
    pub fn parse(raw: &str) -> Result<AllowEntry, InvalidEntry> {
        let bad = |reason| InvalidEntry {
            entry: raw.to_string(),
            reason,
        };
        let (scheme, rest) = match raw.strip_prefix("http://") {
            Some(rest) => (Scheme::Http, rest),
            None if raw.contains("://") => return Err(bad("only the http:// prefix is allowed")),
            None => (Scheme::Https, raw),
        };
        if rest.is_empty()
            || rest.contains(['/', '?', '#', '@', '\\'])
            || rest.contains(char::is_whitespace)
        {
            return Err(bad(
                "an entry is a host with an optional port, nothing else",
            ));
        }
        let (wildcard, host_port) = match rest.strip_prefix("*.") {
            Some(r) => (true, r),
            None => (false, rest),
        };
        if host_port.contains('*') {
            return Err(bad(
                "a wildcard is allowed only as the first label (*.example.com)",
            ));
        }
        // Let the URL parser do IDNA, lower-casing, IP literal parsing, and
        // port parsing, exactly as it will for the request URL.
        let url =
            Url::parse(&format!("http://{host_port}/")).map_err(|_| bad("not a valid host"))?;
        // The URL parser drops a scheme-default port (`:80` here), so take
        // an explicit port from the text itself: `example.com:80` means
        // https on port 80, not https on 443.
        let explicit = match host_port.rsplit_once(']') {
            Some((_, rest)) => rest.strip_prefix(':'),
            None if host_port.matches(':').count() == 1 => host_port.rsplit_once(':').map(|p| p.1),
            None => None,
        };
        let port = match explicit {
            Some(p) => Some(p.parse::<u16>().map_err(|_| bad("invalid port"))?),
            None => url.port(),
        };
        if port == Some(0) {
            return Err(bad("port 0"));
        }
        if host_port.ends_with(':') {
            return Err(bad("empty port"));
        }
        let host = match url.host() {
            Some(Host::Domain(d)) => {
                let d = d.trim_end_matches('.').to_string();
                if d.is_empty() || !d.contains('.') && wildcard {
                    return Err(bad("a wildcard needs a domain with at least two labels"));
                }
                if wildcard {
                    HostPattern::Wildcard(format!(".{d}"))
                } else {
                    HostPattern::Exact(d)
                }
            }
            Some(Host::Ipv4(ip)) if !wildcard => HostPattern::Ip(IpAddr::V4(ip)),
            Some(Host::Ipv6(ip)) if !wildcard => HostPattern::Ip(IpAddr::V6(ip)),
            _ => return Err(bad("not a valid host")),
        };
        Ok(AllowEntry { scheme, host, port })
    }

    fn matches_host(&self, host: &TargetHost) -> bool {
        match (&self.host, host) {
            (HostPattern::Exact(e), TargetHost::Domain(d)) => e == d,
            (HostPattern::Wildcard(suffix), TargetHost::Domain(d)) => {
                d.len() > suffix.len() && d.ends_with(suffix.as_str())
            }
            (HostPattern::Ip(e), TargetHost::Ip(ip)) => e == ip,
            _ => false,
        }
    }

    /// Does this entry allow `scheme` on `port`? An `http://` entry allows
    /// both schemes (declaring plain HTTP does not forbid HTTPS); an `https`
    /// entry allows only `https`.
    fn allows(&self, scheme: Scheme, port: u16) -> Result<(), BlockReason> {
        if scheme == Scheme::Http && self.scheme != Scheme::Http {
            return Err(BlockReason::Scheme);
        }
        let allowed_port = self.port.unwrap_or(scheme.default_port());
        if port != allowed_port {
            return Err(BlockReason::Port);
        }
        Ok(())
    }
}

/// The host part of a request URL after normalisation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetHost {
    /// Lower-case ASCII (IDNA A-labels), no trailing dot.
    Domain(String),
    Ip(IpAddr),
}

impl TargetHost {
    /// The host as it appears in error details and logs. Never a resolved
    /// address: for a domain, this is the domain.
    pub fn display(&self) -> String {
        match self {
            TargetHost::Domain(d) => d.clone(),
            TargetHost::Ip(ip) => ip.to_string(),
        }
    }
}

/// What a URL resolved to once it passed the allowlist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub scheme: Scheme,
    pub host: TargetHost,
    pub port: u16,
}

/// A refusal with the host it concerns (`details.host`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blocked {
    pub host: String,
    pub reason: BlockReason,
}

/// Parsed `manifest.permissions.network[]`.
#[derive(Debug, Clone, Default)]
pub struct Allowlist {
    entries: Vec<AllowEntry>,
}

impl Allowlist {
    pub fn parse<S: AsRef<str>>(raw: &[S]) -> Result<Allowlist, InvalidEntry> {
        let entries = raw
            .iter()
            .map(|e| AllowEntry::parse(e.as_ref()))
            .collect::<Result<_, _>>()?;
        Ok(Allowlist { entries })
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Step 1 of every hop: scheme, host, and port must match an entry.
    pub fn check_url(&self, url: &Url) -> Result<Target, Blocked> {
        let host_display = url
            .host_str()
            .unwrap_or("")
            .trim_end_matches('.')
            .to_string();
        let blocked = |reason| Blocked {
            host: host_display.clone(),
            reason,
        };
        let scheme = match url.scheme() {
            "https" => Scheme::Https,
            "http" => Scheme::Http,
            _ => return Err(blocked(BlockReason::Scheme)),
        };
        if !url.username().is_empty() || url.password().is_some() {
            // Credentials in the URL would be sent to whatever host the
            // userinfo trick points at; refuse them outright.
            return Err(blocked(BlockReason::NotAllowlisted));
        }
        let host = match url.host() {
            Some(Host::Domain(d)) => {
                TargetHost::Domain(d.trim_end_matches('.').to_ascii_lowercase())
            }
            Some(Host::Ipv4(ip)) => TargetHost::Ip(IpAddr::V4(ip)),
            Some(Host::Ipv6(ip)) => TargetHost::Ip(IpAddr::V6(ip)),
            None => return Err(blocked(BlockReason::NotAllowlisted)),
        };
        if let TargetHost::Domain(d) = &host
            && is_blocked_name(d)
        {
            return Err(blocked(BlockReason::BlockedAddress));
        }
        if let TargetHost::Ip(ip) = &host {
            // A listed literal is still checked against the ranges.
            if blocked_reason(*ip).is_some() && self.entries.iter().any(|e| e.matches_host(&host)) {
                return Err(blocked(BlockReason::BlockedAddress));
            }
        }
        let port = url.port().unwrap_or(scheme.default_port());
        let mut first_err = None;
        for entry in self.entries.iter().filter(|e| e.matches_host(&host)) {
            match entry.allows(scheme, port) {
                Ok(()) => return Ok(Target { scheme, host, port }),
                Err(reason) => {
                    first_err.get_or_insert(reason);
                }
            }
        }
        Err(blocked(first_err.unwrap_or(BlockReason::NotAllowlisted)))
    }
}

/// Names that always mean a blocked address, whatever DNS says.
fn is_blocked_name(domain: &str) -> bool {
    domain == "localhost"
        || domain.ends_with(".localhost")
        || domain == "metadata.google.internal"
        || domain == "metadata"
}

/// One blocked range: network, prefix length, and why it is blocked.
struct Range4(Ipv4Addr, u8, &'static str);
struct Range6(Ipv6Addr, u8, &'static str);

/// Blocked IPv4 ranges (`ops.md` section 2, "Blocked ranges";
/// `docs/04-isolation-security.md`, "SSRF to metadata / internal services").
const BLOCKED_V4: &[Range4] = &[
    Range4(
        Ipv4Addr::new(0, 0, 0, 0),
        8,
        "\"this network\" (RFC 791); 0.0.0.0 reaches the local host on Linux",
    ),
    Range4(Ipv4Addr::new(10, 0, 0, 0), 8, "private (RFC 1918)"),
    Range4(
        Ipv4Addr::new(100, 64, 0, 0),
        10,
        "shared address space / CGNAT (RFC 6598); includes the Alibaba Cloud metadata endpoint 100.100.100.200",
    ),
    Range4(Ipv4Addr::new(127, 0, 0, 0), 8, "loopback"),
    Range4(
        Ipv4Addr::new(169, 254, 0, 0),
        16,
        "link-local; includes the cloud metadata endpoint 169.254.169.254 (AWS, GCP, Azure, ...)",
    ),
    Range4(Ipv4Addr::new(172, 16, 0, 0), 12, "private (RFC 1918)"),
    Range4(
        Ipv4Addr::new(192, 0, 0, 0),
        24,
        "IETF protocol assignments (RFC 6890)",
    ),
    Range4(
        Ipv4Addr::new(192, 0, 2, 0),
        24,
        "documentation TEST-NET-1 (RFC 5737)",
    ),
    Range4(Ipv4Addr::new(192, 168, 0, 0), 16, "private (RFC 1918)"),
    Range4(Ipv4Addr::new(198, 18, 0, 0), 15, "benchmarking (RFC 2544)"),
    Range4(
        Ipv4Addr::new(198, 51, 100, 0),
        24,
        "documentation TEST-NET-2 (RFC 5737)",
    ),
    Range4(
        Ipv4Addr::new(203, 0, 113, 0),
        24,
        "documentation TEST-NET-3 (RFC 5737)",
    ),
    Range4(Ipv4Addr::new(224, 0, 0, 0), 4, "multicast"),
    Range4(Ipv4Addr::new(240, 0, 0, 0), 4, "reserved (RFC 1112)"),
    Range4(Ipv4Addr::new(255, 255, 255, 255), 32, "limited broadcast"),
];

/// Blocked IPv6 ranges. Addresses that embed an IPv4 address (mapped,
/// compatible, NAT64, 6to4) are first reduced to that IPv4 address by
/// [`embedded_v4`] and checked against [`BLOCKED_V4`].
const BLOCKED_V6: &[Range6] = &[
    Range6(Ipv6Addr::UNSPECIFIED, 128, "unspecified (::)"),
    Range6(Ipv6Addr::LOCALHOST, 128, "loopback (::1)"),
    Range6(
        Ipv6Addr::new(0x0100, 0, 0, 0, 0, 0, 0, 0),
        64,
        "discard-only (RFC 6666)",
    ),
    Range6(
        Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0),
        23,
        "IETF protocol assignments (RFC 2928), includes Teredo 2001::/32",
    ),
    Range6(
        Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 0),
        32,
        "documentation (RFC 3849)",
    ),
    Range6(
        Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0),
        7,
        "unique local (RFC 4193); includes the AWS metadata endpoint fd00:ec2::254",
    ),
    Range6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10, "link-local"),
    Range6(
        Ipv6Addr::new(0xfec0, 0, 0, 0, 0, 0, 0, 0),
        10,
        "site-local (deprecated, RFC 3879; still routed internally by some stacks)",
    ),
    Range6(Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8, "multicast"),
];

fn in_v4(ip: Ipv4Addr, net: Ipv4Addr, prefix: u8) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    u32::from(ip) & mask == u32::from(net) & mask
}

fn in_v6(ip: Ipv6Addr, net: Ipv6Addr, prefix: u8) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    };
    u128::from(ip) & mask == u128::from(net) & mask
}

/// The IPv4 address an IPv6 address carries, for the forms that route to it:
/// IPv4-mapped `::ffff:a.b.c.d`, IPv4-compatible `::a.b.c.d`, NAT64
/// `64:ff9b::/96` and `64:ff9b:1::/48` (low 32 bits), and 6to4 `2002::/16`
/// (bits 16..48).
pub fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let bits = u128::from(ip);
    let low32 = Ipv4Addr::from((bits & 0xffff_ffff) as u32);
    if let Some(v4) = ip.to_ipv4_mapped() {
        return Some(v4);
    }
    // IPv4-compatible (deprecated, RFC 4291): ::a.b.c.d, excluding :: and ::1.
    if bits >> 32 == 0 && bits > 1 {
        return Some(low32);
    }
    if in_v6(ip, Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, 0, 0), 96)
        || in_v6(ip, Ipv6Addr::new(0x64, 0xff9b, 1, 0, 0, 0, 0, 0), 48)
    {
        return Some(low32);
    }
    if in_v6(ip, Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16) {
        return Some(Ipv4Addr::from(((bits >> 80) & 0xffff_ffff) as u32));
    }
    None
}

/// `Some(why)` when `ip` must never be connected to from tenant code.
pub fn blocked_reason(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v4) => BLOCKED_V4.iter().find(|r| in_v4(v4, r.0, r.1)).map(|r| r.2),
        IpAddr::V6(v6) => {
            if let Some(v4) = embedded_v4(v6) {
                return blocked_reason(IpAddr::V4(v4));
            }
            BLOCKED_V6.iter().find(|r| in_v6(v6, r.0, r.1)).map(|r| r.2)
        }
    }
}

/// Extra addresses blocked per node: the node's own public addresses and
/// the control plane's (`ops.md` section 2, last paragraph). Configured by
/// the cell, never by tenants.
#[derive(Debug, Clone, Default)]
pub struct ExtraBlocked(pub Vec<IpAddr>);

/// Step 2 of every hop: every resolved address must be allowed. Fails
/// closed: one blocked address refuses the whole set, so the outcome does
/// not depend on which address a connection attempt would pick.
pub fn check_addresses(addrs: &[IpAddr], extra: &ExtraBlocked) -> Result<(), BlockReason> {
    if addrs.is_empty() {
        return Err(BlockReason::BlockedAddress);
    }
    for ip in addrs {
        if blocked_reason(*ip).is_some() || extra.0.contains(ip) {
            return Err(BlockReason::BlockedAddress);
        }
        if let IpAddr::V6(v6) = ip
            && let Some(v4) = embedded_v4(*v6)
            && extra.0.contains(&IpAddr::V4(v4))
        {
            return Err(BlockReason::BlockedAddress);
        }
    }
    Ok(())
}

/// The checked socket addresses for a target, in resolver order, with the
/// target port. These are the only addresses the connector may use.
pub fn socket_addrs(addrs: &[IpAddr], port: u16) -> Vec<SocketAddr> {
    addrs.iter().map(|ip| SocketAddr::new(*ip, port)).collect()
}

/// Resolves a host name to addresses. The runtime uses hickory with the
/// system configuration; tests inject a fake or point hickory at a stub.
pub trait Resolve: Send + Sync {
    fn lookup<'a>(
        &'a self,
        host: &'a str,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send + 'a>>;
}

/// Why [`resolve_and_check`] refused a target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveError {
    /// The name did not resolve (or resolved to nothing).
    Dns,
    /// An address is in a blocked range.
    Blocked(BlockReason),
}

/// Step 2 of a hop: resolve the target **once** and check every address.
/// The returned socket addresses are the only ones the connector may use
/// (`fetch_connector::connect`), so the check is bound to the socket that
/// is opened (#108, DNS rebinding). IP literals skip DNS but not the ranges.
pub async fn resolve_and_check(
    resolver: &dyn Resolve,
    extra: &ExtraBlocked,
    target: &Target,
) -> Result<Vec<SocketAddr>, ResolveError> {
    let ips = match &target.host {
        TargetHost::Ip(ip) => vec![*ip],
        TargetHost::Domain(d) => resolver.lookup(d).await.map_err(|_| ResolveError::Dns)?,
    };
    if ips.is_empty() {
        return Err(ResolveError::Dns);
    }
    check_addresses(&ips, extra).map_err(ResolveError::Blocked)?;
    Ok(socket_addrs(&ips, target.port))
}

/// Is this method refused outright? (`ops.md` section 2, `FetchRequest.method`).
pub fn method_blocked(method: &str) -> bool {
    method.eq_ignore_ascii_case("CONNECT") || method.eq_ignore_ascii_case("TRACE")
}

/// What to do with the request body and credentials on a redirect hop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedirectHop {
    pub url: Url,
    /// `307` and `308` keep the method and body; the others turn into a
    /// bodiless `GET` (`303` always, `301`/`302` for non-`GET`/`HEAD`, as
    /// browsers do).
    pub keep_body: bool,
    pub method: String,
    /// The origin (scheme, host, port) changed: `Authorization`, `Cookie`,
    /// and `Proxy-Authorization` are dropped.
    pub strip_credentials: bool,
}

/// A refused redirect hop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedirectError {
    /// `Location` missing or not a URL: `RENOX_FETCH_FAILED` reason `redirect`.
    BadLocation,
    /// Hop limit or policy: `RENOX_FETCH_BLOCKED`.
    Blocked(Blocked),
}

/// Step 4: build the next hop from a 3xx response. `hop` is the 1-based
/// index of the hop being created. The caller then runs steps 1-3 again on
/// the returned URL (`Allowlist::check_url`, DNS, `check_addresses`).
pub fn redirect_target(
    current: &Url,
    method: &str,
    status: u16,
    location: Option<&str>,
    hop: usize,
    allowlist: &Allowlist,
) -> Result<RedirectHop, RedirectError> {
    let location = location.ok_or(RedirectError::BadLocation)?;
    let next = current
        .join(location)
        .map_err(|_| RedirectError::BadLocation)?;
    if hop > MAX_REDIRECTS {
        return Err(RedirectError::Blocked(Blocked {
            host: next.host_str().unwrap_or("").to_string(),
            reason: BlockReason::RedirectLimit,
        }));
    }
    // https -> http only to a host declared with http://; check_url enforces
    // that because only http:// entries allow the http scheme.
    allowlist.check_url(&next).map_err(RedirectError::Blocked)?;
    let keep_body = status == 307 || status == 308;
    let new_method = if keep_body
        || ((status == 301 || status == 302) && (method == "GET" || method == "HEAD"))
    {
        method.to_string()
    } else if status == 303 && method == "HEAD" {
        "HEAD".to_string()
    } else {
        "GET".to_string()
    };
    let strip_credentials = current.origin() != next.origin();
    Ok(RedirectHop {
        url: next,
        keep_body,
        method: new_method,
        strip_credentials,
    })
}

/// Is `status` a redirect that `redirect: "follow"` follows?
pub fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// Request headers dropped when the origin changes on a redirect.
pub const CREDENTIAL_HEADERS: &[&str] = &["authorization", "cookie", "proxy-authorization"];

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn list(entries: &[&str]) -> Allowlist {
        Allowlist::parse(entries).unwrap()
    }

    fn reason(l: &Allowlist, u: &str) -> Option<&'static str> {
        l.check_url(&url(u)).err().map(|b| b.reason.as_str())
    }

    #[test]
    fn exact_host_matches_only_itself() {
        let l = list(&["api.stripe.com"]);
        assert_eq!(reason(&l, "https://api.stripe.com/v1"), None);
        assert_eq!(reason(&l, "https://API.Stripe.COM./v1"), None);
        assert_eq!(
            reason(&l, "https://evil.api.stripe.com/"),
            Some("not_allowlisted")
        );
        assert_eq!(reason(&l, "https://stripe.com/"), Some("not_allowlisted"));
        assert_eq!(
            reason(&l, "https://api.stripe.com.evil.io/"),
            Some("not_allowlisted")
        );
    }

    /// #27: `*.example.com` matches `a.b.example.com` but not `example.com`.
    #[test]
    fn wildcard_matches_subdomains_at_any_depth_but_not_apex() {
        let l = list(&["*.example.com"]);
        assert_eq!(reason(&l, "https://a.example.com/"), None);
        assert_eq!(reason(&l, "https://a.b.example.com/"), None);
        assert_eq!(reason(&l, "https://example.com/"), Some("not_allowlisted"));
        assert_eq!(
            reason(&l, "https://badexample.com/"),
            Some("not_allowlisted")
        );
    }

    #[test]
    fn idna_hosts_are_compared_as_a_labels() {
        let l = list(&["bücher.example"]);
        assert_eq!(reason(&l, "https://xn--bcher-kva.example/"), None);
        assert_eq!(reason(&l, "https://BÜCHER.example/"), None);
    }

    #[test]
    fn scheme_rules() {
        let l = list(&["api.example.com", "http://legacy.example.com"]);
        assert_eq!(reason(&l, "http://api.example.com/"), Some("scheme"));
        assert_eq!(reason(&l, "http://legacy.example.com/"), None);
        // Declaring plain HTTP does not forbid HTTPS to the same host.
        assert_eq!(reason(&l, "https://legacy.example.com/"), None);
        assert_eq!(reason(&l, "ftp://api.example.com/"), Some("scheme"));
        assert_eq!(reason(&l, "file:///etc/passwd"), Some("scheme"));
    }

    /// Review finding: an explicit default port in an entry is kept.
    #[test]
    fn explicit_default_port_is_kept() {
        let l = list(&["plain80.example.com:80", "http://tls443.example.com:443"]);
        assert_eq!(reason(&l, "https://plain80.example.com:80/"), None);
        assert_eq!(reason(&l, "https://plain80.example.com/"), Some("port"));
        assert_eq!(reason(&l, "http://tls443.example.com:443/"), None);
        assert_eq!(reason(&l, "http://tls443.example.com/"), Some("port"));
    }

    #[test]
    fn port_rules() {
        let l = list(&["api.example.com", "graph.example.com:8443"]);
        assert_eq!(reason(&l, "https://api.example.com:443/"), None);
        assert_eq!(reason(&l, "https://api.example.com:8443/"), Some("port"));
        assert_eq!(reason(&l, "https://api.example.com:80/"), Some("port"));
        assert_eq!(reason(&l, "https://graph.example.com:8443/"), None);
        assert_eq!(reason(&l, "https://graph.example.com/"), Some("port"));
    }

    /// #27: `localhost` and `*.localhost` are blocked even when listed.
    #[test]
    fn localhost_is_blocked_even_if_listed() {
        let l = list(&[
            "localhost",
            "http://localhost:8080",
            "a.localhost",
            "metadata.google.internal",
        ]);
        // A wildcard over a single label is not a valid entry at all.
        assert!(AllowEntry::parse("*.localhost").is_err());
        assert_eq!(reason(&l, "https://localhost/"), Some("blocked_address"));
        assert_eq!(
            reason(&l, "http://localhost:8080/"),
            Some("blocked_address")
        );
        assert_eq!(reason(&l, "https://a.localhost/"), Some("blocked_address"));
        assert_eq!(reason(&l, "https://LOCALHOST./"), Some("blocked_address"));
        assert_eq!(
            reason(&l, "https://metadata.google.internal/"),
            Some("blocked_address")
        );
    }

    /// #27: `fetch("http://169.254.169.254/")` is blocked, listed or not.
    #[test]
    fn metadata_ip_literal_is_blocked() {
        assert_eq!(
            reason(&list(&[]), "http://169.254.169.254/"),
            Some("not_allowlisted")
        );
        let l = list(&[
            "http://169.254.169.254",
            "[fd00:ec2::254]",
            "100.100.100.200",
        ]);
        assert_eq!(
            reason(&l, "http://169.254.169.254/latest/meta-data/"),
            Some("blocked_address")
        );
        assert_eq!(
            reason(&l, "https://[fd00:ec2::254]/"),
            Some("blocked_address")
        );
        assert_eq!(
            reason(&l, "https://100.100.100.200/"),
            Some("blocked_address")
        );
    }

    #[test]
    fn listed_public_ip_literal_is_allowed() {
        let l = list(&["93.184.216.34", "[2606:2800:220:1::1]"]);
        assert_eq!(reason(&l, "https://93.184.216.34/"), None);
        assert_eq!(reason(&l, "https://[2606:2800:220:1::1]/"), None);
        assert_eq!(
            reason(&l, "https://93.184.216.35/"),
            Some("not_allowlisted")
        );
    }

    #[test]
    fn obfuscated_ip_literals_are_normalised_by_the_url_parser() {
        // Decimal, octal, and hex forms of 127.0.0.1 all parse to the same Ipv4.
        let l = list(&["127.0.0.1"]);
        for u in [
            "https://2130706433/",
            "https://0x7f.0.0.1/",
            "https://0177.0.0.1/",
            "https://127.1/",
        ] {
            assert_eq!(reason(&l, u), Some("blocked_address"), "{u}");
        }
    }

    #[test]
    fn credentials_in_url_are_refused() {
        let l = list(&["api.example.com"]);
        assert_eq!(
            reason(&l, "https://user:pw@api.example.com/"),
            Some("not_allowlisted")
        );
    }

    #[test]
    fn invalid_entries_are_rejected() {
        for e in [
            "*",
            "*.com.*",
            "a.*.example.com",
            "ftp://x.example",
            "https://x.example",
            "x.example/path",
            "*.",
            "",
            "x.example:",
            "x.example:0",
            "*.1.2.3.4",
        ] {
            assert!(AllowEntry::parse(e).is_err(), "{e:?} should be invalid");
        }
        for e in [
            "api.stripe.com",
            "*.tabby.ai",
            "graph.facebook.com:443",
            "http://legacy.example.com",
            "http://legacy.example.com:8080",
            "93.184.216.34",
            "[2606:2800:220:1::1]:8443",
        ] {
            assert!(AllowEntry::parse(e).is_ok(), "{e:?} should be valid");
        }
    }

    #[test]
    fn empty_allowlist_blocks_everything() {
        let l = list(&[]);
        assert!(l.is_empty());
        assert_eq!(reason(&l, "https://example.com/"), Some("not_allowlisted"));
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    /// `docs/24-threat-model.md` section B, SSRF row: every range in the
    /// contract's table is blocked.
    #[test]
    fn every_contract_range_is_blocked() {
        let blocked = [
            "0.0.0.0",
            "0.255.255.255",
            "10.0.0.5",
            "10.255.255.255",
            "100.64.0.1",
            "100.100.100.200",
            "100.127.255.255",
            "127.0.0.1",
            "127.255.255.254",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.19.255.255",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "239.255.255.255",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "100::1",
            "2001::1",
            "2001:1ff::1",
            "2001:db8::1",
            "fc00::1",
            "fd00:ec2::254",
            "fe80::1",
            "febf::1",
            "ff02::1",
        ];
        for a in blocked {
            assert!(blocked_reason(ip(a)).is_some(), "{a} should be blocked");
        }
    }

    #[test]
    fn public_addresses_pass() {
        for a in [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.216.34",
            "100.63.255.255",
            "100.128.0.0",
            "172.15.255.255",
            "172.32.0.0",
            "192.169.0.1",
            "198.17.255.255",
            "198.20.0.0",
            "223.255.255.255",
            "2606:4700:4700::1111",
            "2a00:1450:4001::1",
            "2001:200::1",
        ] {
            assert!(blocked_reason(ip(a)).is_none(), "{a} should be allowed");
        }
    }

    /// #27 / #108: v4-mapped, v4-compatible, NAT64, and 6to4 forms are
    /// checked as the IPv4 address they embed.
    #[test]
    fn embedded_v4_forms_are_checked_as_v4() {
        for a in [
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.5",
            "::ffff:169.254.169.254",
            "::127.0.0.1",
            "::10.1.2.3",
            "64:ff9b::7f00:1",
            "64:ff9b::a00:5",
            "64:ff9b::169.254.169.254",
            "64:ff9b:1::a00:5",
            "2002:7f00:1::1",
            "2002:a9fe:a9fe::",
        ] {
            assert!(blocked_reason(ip(a)).is_some(), "{a} should be blocked");
        }
        for a in ["::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"] {
            assert!(blocked_reason(ip(a)).is_none(), "{a} should be allowed");
        }
    }

    #[test]
    fn check_addresses_fails_closed_on_any_blocked_address() {
        let none = ExtraBlocked::default();
        assert_eq!(check_addresses(&[ip("93.184.216.34")], &none), Ok(()));
        assert_eq!(
            check_addresses(&[ip("93.184.216.34"), ip("10.0.0.5")], &none),
            Err(BlockReason::BlockedAddress)
        );
        assert_eq!(
            check_addresses(&[], &none),
            Err(BlockReason::BlockedAddress)
        );
        let extra = ExtraBlocked(vec![ip("93.184.216.34")]);
        assert_eq!(
            check_addresses(&[ip("93.184.216.34")], &extra),
            Err(BlockReason::BlockedAddress)
        );
        assert_eq!(
            check_addresses(&[ip("::ffff:93.184.216.34")], &extra),
            Err(BlockReason::BlockedAddress)
        );
    }

    #[test]
    fn methods() {
        assert!(method_blocked("CONNECT"));
        assert!(method_blocked("trace"));
        assert!(!method_blocked("GET"));
    }

    #[test]
    fn redirects_are_rechecked_against_the_allowlist() {
        let l = list(&["a.example.com", "b.example.com", "http://plain.example.com"]);
        let cur = url("https://a.example.com/x");
        // Same origin keeps credentials; 302 on POST becomes GET.
        let hop = redirect_target(&cur, "POST", 302, Some("/y"), 1, &l).unwrap();
        assert_eq!(hop.url.as_str(), "https://a.example.com/y");
        assert!(!hop.strip_credentials);
        assert!(!hop.keep_body);
        assert_eq!(hop.method, "GET");
        // 307 keeps method and body; a cross-host hop strips credentials.
        let hop =
            redirect_target(&cur, "POST", 307, Some("https://b.example.com/z"), 2, &l).unwrap();
        assert!(hop.keep_body && hop.strip_credentials);
        assert_eq!(hop.method, "POST");
        // Not on the list.
        let err =
            redirect_target(&cur, "GET", 302, Some("https://c.example.com/"), 1, &l).unwrap_err();
        assert_eq!(
            err,
            RedirectError::Blocked(Blocked {
                host: "c.example.com".into(),
                reason: BlockReason::NotAllowlisted
            })
        );
        // To a loopback literal.
        let err = redirect_target(&cur, "GET", 302, Some("http://127.0.0.1/"), 1, &l).unwrap_err();
        assert!(matches!(
            err,
            RedirectError::Blocked(Blocked {
                reason: BlockReason::NotAllowlisted,
                ..
            })
        ));
        // https -> http only to a host declared with http://.
        let err =
            redirect_target(&cur, "GET", 302, Some("http://b.example.com/"), 1, &l).unwrap_err();
        assert!(matches!(
            err,
            RedirectError::Blocked(Blocked {
                reason: BlockReason::Scheme,
                ..
            })
        ));
        assert!(
            redirect_target(&cur, "GET", 302, Some("http://plain.example.com/"), 1, &l).is_ok()
        );
        // Hop limit.
        let err =
            redirect_target(&cur, "GET", 302, Some("/again"), MAX_REDIRECTS + 1, &l).unwrap_err();
        assert!(matches!(
            err,
            RedirectError::Blocked(Blocked {
                reason: BlockReason::RedirectLimit,
                ..
            })
        ));
        // Missing Location.
        assert_eq!(
            redirect_target(&cur, "GET", 302, None, 1, &l),
            Err(RedirectError::BadLocation)
        );
    }
}
