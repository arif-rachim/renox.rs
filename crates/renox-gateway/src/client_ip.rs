//! The client address behind a trusted edge (#414, ADR D25).
//!
//! Behind Cloudflare every request reaches the worker from `cloudflared`,
//! so the socket peer is the edge, not the visitor. The visitor's address
//! comes from `CF-Connecting-IP`, and that header is believed **only** when
//! the socket peer is trusted:
//!
//! - a TCP peer whose address is inside one of
//!   [`ClientIpConfig::trusted_proxies`] (empty by default, so nothing is
//!   trusted unless the operator says so; `renox dev` copies the browser's
//!   headers from loopback and must never be believed);
//! - a unix-socket peer whose uid (`SO_PEERCRED`, read by the kernel, not
//!   by the client) is one of [`ClientIpConfig::trusted_socket_uids`] (the
//!   production layout: `cloudflared` reaches `unix:/run/renox-edge/worker.sock`
//!   as the `renox-tunnel` user).
//!
//! From a trusted peer the header must hold exactly one address; a missing,
//! repeated, multi-valued or malformed header falls back to the peer. Any
//! other peer keeps its own address (a unix peer: [`LOCAL_PEER`]) whatever
//! header it sends. Either way the forwarding headers ([`FORWARDING_HEADERS`])
//! are removed before the request reaches tenant code, which gets the
//! derived address in `x-renox-client-ip` only. Nothing a tenant controls
//! takes part in the decision: the peer comes from the socket and the
//! configuration from `worker.toml`.
//!
//! Proof: `tests/client_ip.rs` (`docs/24-threat-model.md` A, "Forged
//! client-IP header" and "Local process forges the client-IP header").

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::http::{HeaderMap, HeaderName};

/// The address a request from an untrusted unix-socket peer is counted
/// under: a local process, whatever it claims.
pub const LOCAL_PEER: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

/// The header Cloudflare sets with the visitor's address.
pub const CF_CONNECTING_IP: &str = "cf-connecting-ip";

/// Headers a client or an edge uses to name the client or the scheme. They
/// never reach tenant code: the gateway removes them before dispatch, from
/// trusted and untrusted peers alike, so an app cannot be fooled by a
/// spoofed value (it reads `x-renox-client-ip`).
pub const FORWARDING_HEADERS: [&str; 9] = [
    "cf-connecting-ip",
    "cf-connecting-ipv6",
    "true-client-ip",
    "x-real-ip",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-forwarded-port",
    "forwarded",
];

/// An address range, `addr/prefix` (a bare address is a /32 or /128).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IpNet {
    addr: IpAddr,
    prefix: u8,
}

impl IpNet {
    /// Parses `192.0.2.0/24`, `::1/128` or a bare address. Host bits must
    /// be zero, so a typo such as `10.0.0.1/8` is refused, not widened.
    pub fn parse(s: &str) -> Result<Self, String> {
        let s = s.trim();
        let (addr, prefix) = match s.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (s, None),
        };
        let addr: IpAddr = addr
            .parse()
            .map_err(|_| format!("{s:?} is not an IP address or CIDR range"))?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            None => max,
            Some(p) => p
                .parse::<u8>()
                .ok()
                .filter(|p| *p <= max)
                .ok_or_else(|| format!("{s:?}: the prefix must be 0..={max}"))?,
        };
        let net = Self { addr, prefix };
        if net.masked(addr) != addr {
            return Err(format!("{s:?}: host bits are set below /{prefix}"));
        }
        Ok(net)
    }

    fn masked(&self, ip: IpAddr) -> IpAddr {
        match ip {
            IpAddr::V4(v4) => {
                let bits = u32::from(v4);
                let mask = u32::MAX
                    .checked_shl(32 - u32::from(self.prefix))
                    .unwrap_or(0);
                IpAddr::V4((bits & mask).into())
            }
            IpAddr::V6(v6) => {
                let bits = u128::from(v6);
                let mask = u128::MAX
                    .checked_shl(128 - u32::from(self.prefix))
                    .unwrap_or(0);
                IpAddr::V6((bits & mask).into())
            }
        }
    }

    /// Whether `ip` (v4-mapped IPv6 counted as IPv4) is inside the range.
    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = normalize(ip);
        ip.is_ipv4() == self.addr.is_ipv4() && self.masked(ip) == self.addr
    }
}

impl std::fmt::Display for IpNet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.addr, self.prefix)
    }
}

/// Who may set the client address (`[gateway]` of `worker.toml`).
#[derive(Clone, Debug)]
pub struct ClientIpConfig {
    /// TCP peers whose header is believed. Empty: none.
    pub trusted_proxies: Vec<IpNet>,
    /// Unix-socket peers (by uid) whose header is believed. Empty: none.
    pub trusted_socket_uids: Vec<u32>,
    /// The header holding the client address (default `CF-Connecting-IP`).
    pub header: HeaderName,
}

impl Default for ClientIpConfig {
    fn default() -> Self {
        Self {
            trusted_proxies: Vec::new(),
            trusted_socket_uids: Vec::new(),
            header: HeaderName::from_static(CF_CONNECTING_IP),
        }
    }
}

impl ClientIpConfig {
    /// Whether a TCP peer is a trusted proxy.
    pub fn trusts_tcp(&self, peer: IpAddr) -> bool {
        self.trusted_proxies.iter().any(|n| n.contains(peer))
    }

    /// Whether a unix-socket peer with this uid is a trusted proxy. A peer
    /// whose credentials could not be read (`None`) is not.
    pub fn trusts_uid(&self, uid: Option<u32>) -> bool {
        uid.is_some_and(|u| self.trusted_socket_uids.contains(&u))
    }
}

/// The socket peer of a connection, set by the accept loop as a request
/// extension. Tests may insert it by hand (or `ConnectInfo<SocketAddr>`,
/// which counts as [`Peer::Tcp`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Peer {
    Tcp(SocketAddr),
    /// A unix-socket peer; `trusted` was decided from its uid at accept.
    Unix {
        trusted: bool,
    },
}

/// The derived client of one request, a request extension for the cell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClientAddr {
    /// The address limits, client events, logs and meters key on.
    pub ip: IpAddr,
    /// The socket peer is a trusted proxy (whether or not its header was
    /// usable). Decides whether `X-Forwarded-Proto` is believed (#418).
    pub via_trusted_proxy: bool,
    /// A trusted proxy said the client connected over HTTPS
    /// (`X-Forwarded-Proto: https`). Always `false` from untrusted peers.
    pub forwarded_https: bool,
}

/// v4-mapped IPv6 (`::ffff:a.b.c.d`) as IPv4; anything else unchanged.
pub fn normalize(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

/// Derives the client of a request from its socket peer and headers.
pub fn resolve(peer: Peer, headers: &HeaderMap, config: &ClientIpConfig) -> ClientAddr {
    let (own, trusted) = match peer {
        Peer::Tcp(addr) => {
            let ip = normalize(addr.ip());
            (ip, config.trusts_tcp(ip))
        }
        Peer::Unix { trusted } => (LOCAL_PEER, trusted),
    };
    if !trusted {
        return ClientAddr {
            ip: own,
            via_trusted_proxy: false,
            forwarded_https: false,
        };
    }
    ClientAddr {
        ip: single_address(headers, &config.header).unwrap_or(own),
        via_trusted_proxy: true,
        forwarded_https: forwarded_https(headers),
    }
}

/// The one address of `name`: exactly one header line holding exactly one
/// IP address, normalized. Anything else is `None`.
fn single_address(headers: &HeaderMap, name: &HeaderName) -> Option<IpAddr> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    let text = value.to_str().ok()?.trim();
    if text.contains(',') {
        return None;
    }
    text.parse::<IpAddr>().ok().map(normalize)
}

/// `X-Forwarded-Proto: https`, one value, case-insensitive.
fn forwarded_https(headers: &HeaderMap) -> bool {
    let mut values = headers.get_all("x-forwarded-proto").iter();
    match (values.next(), values.next()) {
        (Some(v), None) => v
            .to_str()
            .is_ok_and(|v| v.trim().eq_ignore_ascii_case("https")),
        _ => false,
    }
}

/// Removes [`FORWARDING_HEADERS`] and the configured header.
pub fn strip(headers: &mut HeaderMap, config: &ClientIpConfig) {
    for name in FORWARDING_HEADERS {
        headers.remove(name);
    }
    headers.remove(&config.header);
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn cfg(nets: &[&str]) -> ClientIpConfig {
        ClientIpConfig {
            trusted_proxies: nets.iter().map(|n| IpNet::parse(n).unwrap()).collect(),
            ..ClientIpConfig::default()
        }
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn cidr_parsing_and_membership() {
        let n = IpNet::parse("10.1.0.0/16").unwrap();
        assert!(n.contains("10.1.200.3".parse().unwrap()));
        assert!(!n.contains("10.2.0.1".parse().unwrap()));
        assert!(n.contains("::ffff:10.1.0.9".parse().unwrap()));
        let one = IpNet::parse("::1").unwrap();
        assert_eq!(one.to_string(), "::1/128");
        assert!(one.contains("::1".parse().unwrap()));
        assert!(!one.contains("127.0.0.1".parse().unwrap()));
        assert!(
            IpNet::parse("0.0.0.0/0")
                .unwrap()
                .contains("8.8.8.8".parse().unwrap())
        );
        for bad in ["10.0.0.1/8", "10.0.0.0/33", "nope", "::1/129", "1.2.3.4/x"] {
            assert!(IpNet::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn untrusted_peer_keeps_its_address() {
        let h = headers(&[
            ("cf-connecting-ip", "203.0.113.7"),
            ("x-forwarded-proto", "https"),
        ]);
        let peer = Peer::Tcp("198.51.100.4:4000".parse().unwrap());
        let got = resolve(peer, &h, &cfg(&["127.0.0.1/32"]));
        assert_eq!(got.ip, "198.51.100.4".parse::<IpAddr>().unwrap());
        assert!(!got.via_trusted_proxy && !got.forwarded_https);
        let unix = resolve(Peer::Unix { trusted: false }, &h, &cfg(&[]));
        assert_eq!(unix.ip, LOCAL_PEER);
        assert!(!unix.forwarded_https);
    }

    #[test]
    fn trusted_peer_header_rules() {
        let c = cfg(&["127.0.0.1/32", "::1/128"]);
        let peer = Peer::Tcp("[::ffff:127.0.0.1]:4000".parse().unwrap());
        let ip = |h: &[(&str, &str)]| resolve(peer, &headers(h), &c).ip.to_string();
        assert_eq!(ip(&[("cf-connecting-ip", " 203.0.113.7 ")]), "203.0.113.7");
        assert_eq!(ip(&[("cf-connecting-ip", "2001:db8::5")]), "2001:db8::5");
        assert_eq!(
            ip(&[("cf-connecting-ip", "::ffff:203.0.113.8")]),
            "203.0.113.8"
        );
        // Fallbacks to the peer.
        assert_eq!(ip(&[]), "127.0.0.1");
        assert_eq!(
            ip(&[("cf-connecting-ip", "203.0.113.7, 10.0.0.1")]),
            "127.0.0.1"
        );
        assert_eq!(
            ip(&[
                ("cf-connecting-ip", "203.0.113.7"),
                ("cf-connecting-ip", "203.0.113.9")
            ]),
            "127.0.0.1"
        );
        assert_eq!(ip(&[("cf-connecting-ip", "not-an-ip")]), "127.0.0.1");
        // Only the configured header counts.
        assert_eq!(ip(&[("x-forwarded-for", "203.0.113.7")]), "127.0.0.1");
        let https = resolve(peer, &headers(&[("x-forwarded-proto", "HTTPS")]), &c);
        assert!(https.via_trusted_proxy && https.forwarded_https);
        let unix = resolve(
            Peer::Unix { trusted: true },
            &headers(&[("cf-connecting-ip", "203.0.113.7")]),
            &c,
        );
        assert_eq!(unix.ip.to_string(), "203.0.113.7");
    }

    #[test]
    fn strip_removes_every_forwarding_header() {
        let mut h = headers(&[
            ("cf-connecting-ip", "1.1.1.1"),
            ("x-forwarded-for", "1.1.1.1"),
            ("true-client-ip", "1.1.1.1"),
            ("forwarded", "for=1.1.1.1"),
            ("x-client", "1.1.1.1"),
            ("accept", "*/*"),
        ]);
        let c = ClientIpConfig {
            header: HeaderName::from_static("x-client"),
            ..ClientIpConfig::default()
        };
        strip(&mut h, &c);
        assert_eq!(h.len(), 1);
        assert!(h.contains_key("accept"));
    }
}
