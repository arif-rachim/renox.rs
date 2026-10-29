//! Tenant `Set-Cookie` rewrite (#207; `docs/24-threat-model.md` C,
//! "Cookie tossing between tenants"). A cookie whose `Domain=` names the
//! platform apex or any parent of the request host is sent by the browser
//! to every other tenant under that parent, so one tenant could plant or
//! overwrite another's session or CSRF cookie. Until `renox.app` is on the
//! Public Suffix List (`ops/psl/README.md`), and for custom domains after
//! that, the gateway enforces it on every tenant response:
//!
//! - `Domain=` equal to the request host (leading dot ignored, any case) is
//!   kept: the browser accepts it only on that host and its subdomains.
//! - Any other `Domain=` (the apex, a parent, another tenant's host, a
//!   subdomain, an empty value) is removed, so the cookie becomes host-only.
//! - A malformed `Set-Cookie` (no `name=`, an empty or non-token name,
//!   control characters) is dropped, never forwarded.
//!
//! Responses are rewritten, never refused; `docs/contracts/errors.md` is
//! unchanged. Values never leave this module: the caller logs only what
//! [`Rewrite`] carries (cookie name, removed domain).

use std::collections::HashSet;
use std::sync::Mutex;

use axum::http::{HeaderMap, HeaderValue, header};

/// What [`apply`] did to one `Set-Cookie` header it changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rewrite {
    /// The `Domain=` attribute was removed; the cookie is host-only now.
    DomainRemoved { name: String, domain: String },
    /// The header was malformed and dropped.
    Dropped,
}

/// Rewrites every `Set-Cookie` in `headers` for a response to `host` (the
/// request host as routed: lowercase, no port, no trailing dot). Returns
/// what changed, in header order; unchanged cookies are not listed.
pub fn apply(headers: &mut HeaderMap, host: &str) -> Vec<Rewrite> {
    if !headers.contains_key(header::SET_COOKIE) {
        return Vec::new();
    }
    let mut changes = Vec::new();
    let mut kept = Vec::new();
    for value in headers.get_all(header::SET_COOKIE) {
        match rewrite_one(value.as_bytes(), host) {
            None => changes.push(Rewrite::Dropped),
            Some(one) => {
                if one.removed.is_empty() {
                    kept.push(value.clone());
                    continue;
                }
                for domain in one.removed {
                    changes.push(Rewrite::DomainRemoved {
                        name: one.name.clone(),
                        domain,
                    });
                }
                // Built from the bytes of a valid header value, minus whole
                // attributes, so it is a valid header value too.
                match HeaderValue::from_bytes(&one.value) {
                    Ok(v) => kept.push(v),
                    Err(_) => changes.push(Rewrite::Dropped),
                }
            }
        }
    }
    if changes.is_empty() {
        return changes;
    }
    headers.remove(header::SET_COOKIE);
    for v in kept {
        headers.append(header::SET_COOKIE, v);
    }
    changes
}

struct One {
    name: String,
    value: Vec<u8>,
    removed: Vec<String>,
}

/// One `Set-Cookie` value: `None` when malformed.
fn rewrite_one(raw: &[u8], host: &str) -> Option<One> {
    // CTLs other than HTAB are not allowed anywhere in a cookie line
    // (RFC 6265 section 4.1.1); a browser would reject or truncate it.
    if raw.iter().any(|&b| (b < 0x20 && b != b'\t') || b == 0x7f) {
        return None;
    }
    let mut parts = raw.split(|&b| b == b';');
    let pair = parts.next()?;
    let eq = pair.iter().position(|&b| b == b'=')?;
    let name = trim(&pair[..eq]);
    if name.is_empty() || !name.iter().all(|&b| is_token(b)) {
        return None;
    }
    let name = String::from_utf8(name.to_vec()).ok()?;

    let mut value = trim(pair).to_vec();
    let mut removed = Vec::new();
    for attr in parts {
        let attr = trim(attr);
        if attr.is_empty() {
            continue;
        }
        let (key, val) = match attr.iter().position(|&b| b == b'=') {
            Some(i) => (trim(&attr[..i]), trim(&attr[i + 1..])),
            None => (attr, &[][..]),
        };
        if key.eq_ignore_ascii_case(b"domain") && !domain_allowed(val, host) {
            removed.push(log_domain(val));
            continue;
        }
        value.extend_from_slice(b"; ");
        value.extend_from_slice(attr);
    }
    Some(One {
        name,
        value,
        removed,
    })
}

/// Only the request host itself. A browser ignores the leading dot and
/// compares case-insensitively; anything else (the apex, a parent, a
/// sibling, a subdomain, a trailing dot, non-ASCII) is removed.
fn domain_allowed(domain: &[u8], host: &str) -> bool {
    let domain = domain.strip_prefix(b".").unwrap_or(domain);
    !domain.is_empty() && domain.eq_ignore_ascii_case(host.as_bytes())
}

/// The removed domain as it goes into the log: printable ASCII only, at
/// most a hostname's length. It is tenant input, never a cookie value.
fn log_domain(domain: &[u8]) -> String {
    domain
        .iter()
        .take(253)
        .map(|&b| if b.is_ascii_graphic() { b as char } else { '?' })
        .collect()
}

fn trim(b: &[u8]) -> &[u8] {
    let start = b.iter().position(|c| !matches!(c, b' ' | b'\t'));
    let end = b.iter().rposition(|c| !matches!(c, b' ' | b'\t'));
    match (start, end) {
        (Some(s), Some(e)) => &b[s..=e],
        _ => &[],
    }
}

/// RFC 7230 `tchar`.
fn is_token(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

/// Remembers which (deployment, cookie name) pairs were already logged, so
/// the gateway warns once per cell and cookie, not once per response.
/// Bounded: when full it forgets everything and may warn again.
#[derive(Debug, Default)]
pub struct WarnOnce {
    seen: Mutex<HashSet<(String, String)>>,
}

const WARN_ONCE_CAP: usize = 4096;

impl WarnOnce {
    /// `true` the first time `(deployment, key)` is seen.
    pub fn first(&self, deployment: &str, key: &str) -> bool {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if seen.len() >= WARN_ONCE_CAP {
            seen.clear();
        }
        seen.insert((deployment.to_owned(), key.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "shop.renox.app";

    fn one(raw: &str) -> Option<(String, Vec<String>)> {
        rewrite_one(raw.as_bytes(), HOST).map(|o| (String::from_utf8(o.value).unwrap(), o.removed))
    }

    #[test]
    fn apex_parent_and_other_hosts_are_removed() {
        for d in [
            "renox.app",
            ".renox.app",
            "RENOX.APP",
            "other.renox.app",
            "a.shop.renox.app",
            "shop.renox.app.",
            "app",
            "",
        ] {
            let (v, removed) = one(&format!("sid=abc; Path=/; Domain={d}; Secure")).unwrap();
            assert_eq!(v, "sid=abc; Path=/; Secure", "{d}");
            assert_eq!(removed, vec![d.to_owned()]);
        }
    }

    #[test]
    fn the_request_host_is_kept_as_is() {
        for d in ["shop.renox.app", ".shop.renox.app", "Shop.Renox.App"] {
            let raw = format!("sid=abc; Domain={d}; HttpOnly");
            let (v, removed) = one(&raw).unwrap();
            assert_eq!(v, raw);
            assert!(removed.is_empty());
        }
    }

    /// A browser uses the last `Domain` attribute: every disallowed one goes.
    #[test]
    fn every_domain_attribute_is_checked() {
        let (v, removed) = one("a=1; Domain=shop.renox.app; domain=renox.app").unwrap();
        assert_eq!(v, "a=1; Domain=shop.renox.app");
        assert_eq!(removed, vec!["renox.app".to_owned()]);
    }

    #[test]
    fn malformed_cookies_are_rejected() {
        for raw in [
            "",
            "noequals",
            "=value",
            " =value",
            "na me=v",
            "na(me)=v",
            "a=b\u{1}c",
        ] {
            assert!(one(raw).is_none(), "{raw:?}");
        }
        // An empty value and quoted values are fine.
        assert!(one("a=").is_some());
        assert!(one("a=\"q\"").is_some());
    }

    #[test]
    fn log_domain_is_printable_and_bounded() {
        assert_eq!(log_domain(b"ren\xffox app"), "ren?ox?app");
        assert_eq!(log_domain(&[b'a'; 400]).len(), 253);
    }

    #[test]
    fn warn_once_per_deployment_and_key() {
        let w = WarnOnce::default();
        assert!(w.first("h1", "sid"));
        assert!(!w.first("h1", "sid"));
        assert!(w.first("h1", "csrf"));
        assert!(w.first("h2", "sid"));
    }
}
