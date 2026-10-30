//! The `Origin` check of WebSocket and SSE upgrades (#118;
//! `docs/24-threat-model.md` A, "Cross-site WebSocket hijacking"). A browser
//! sends the session cookie on a cross-site WebSocket upgrade, so without
//! this check any site could open an authenticated socket to a tenant app.
//! The cell asks it before the realtime layer runs: a refusal is a 403 and
//! the isolate is never touched.
//!
//! - A present `Origin` must name the request's own host (any scheme: `renox
//!   dev` serves `http://localhost`) or be one of the app's `[security.cors]
//!   origins`, exactly. `null` and anything that is not `scheme://host[:port]`
//!   are refused.
//! - An absent `Origin`: browsers always send it on a WebSocket upgrade, so a
//!   WebSocket upgrade without it that carries a cookie is refused; one
//!   without a cookie (a non-browser client, no ambient credential) passes.
//!   On SSE, browsers omit it for same-origin GETs and CORS already keeps a
//!   cross-site page from reading the stream, so an absent one passes.

/// Why an upgrade was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginRefusal {
    /// A WebSocket upgrade with a cookie and no `Origin`.
    Missing,
    /// `null`, or not `scheme://host[:port]`.
    Malformed,
    /// Another site.
    Mismatch,
}

impl OriginRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            OriginRefusal::Missing => "origin_missing",
            OriginRefusal::Malformed => "origin_malformed",
            OriginRefusal::Mismatch => "origin_mismatch",
        }
    }
}

/// The transport being upgraded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Upgrade {
    Ws,
    Sse,
}

/// `scheme://host[:port]` of an `Origin`, lower-cased; `None` when it is not one.
fn parse(origin: &str) -> Option<(String, String)> {
    let o = origin.trim();
    let (scheme, rest) = o.split_once("://")?;
    if !matches!(scheme, "http" | "https")
        || rest.is_empty()
        || rest.contains(['/', '?', '#', '@', ' '])
    {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), rest.to_ascii_lowercase()))
}

/// Checks one upgrade. `host` is the request's `Host`; `allowed` the app's
/// `[security.cors] origins` (a `*` there allows nothing here: a socket
/// carries credentials).
pub fn check(
    kind: Upgrade,
    origin: Option<&str>,
    host: &str,
    allowed: &[String],
    has_cookie: bool,
) -> Result<(), OriginRefusal> {
    let Some(origin) = origin else {
        return if kind == Upgrade::Ws && has_cookie {
            Err(OriginRefusal::Missing)
        } else {
            Ok(())
        };
    };
    let Some((scheme, authority)) = parse(origin) else {
        return Err(OriginRefusal::Malformed);
    };
    if authority == host.trim().to_ascii_lowercase() {
        return Ok(());
    }
    let full = format!("{scheme}://{authority}");
    if allowed
        .iter()
        .filter(|a| a.as_str() != "*")
        .any(|a| a.trim().trim_end_matches('/').eq_ignore_ascii_case(&full))
    {
        return Ok(());
    }
    Err(OriginRefusal::Mismatch)
}
