//! Response headers (`docs/04-isolation-security.md`, "Web-layer
//! protections" table; `artifact.md` section 3, "Security"). The same rules
//! are printed by `renox check --security` (`cli/src/check/security.ts`);
//! `tests/security.rs` and that file's tests share the expected strings.

use axum::http::{HeaderMap, HeaderValue};

use super::config::SecurityConfig;

/// Where CSP violation reports go (`docs/contracts/client-events.md`).
pub const CSP_REPORT_PATH: &str = "/__renox/events?kind=csp";

/// Features the platform denies unless `headers.permissions_allow` lists them.
pub const DENIED_FEATURES: [&str; 3] = ["camera", "microphone", "geolocation"];

/// A fresh per-request nonce: 128 random bits, base64.
pub fn new_nonce() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("the OS random source is available");
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b)
}

fn directive(out: &mut Vec<String>, name: &str, base: &[&str], extra: &[String]) {
    let mut parts: Vec<String> = vec![name.to_string()];
    parts.extend(base.iter().map(|s| s.to_string()));
    parts.extend(extra.iter().cloned());
    out.push(parts.join(" "));
}

/// The CSP value. `tls` adds `upgrade-insecure-requests` (never on the
/// plain-HTTP `renox dev` listener, where it would break `localhost`).
pub fn csp_value(cfg: &SecurityConfig, nonce: &str, tls: bool) -> String {
    let csp = &cfg.csp;
    let n = format!("'nonce-{nonce}'");
    let mut d = vec!["default-src 'self'".to_string()];
    directive(&mut d, "script-src", &["'self'", &n], &csp.script_src);
    directive(&mut d, "style-src", &["'self'", &n], &csp.style_src);
    for (name, extra) in [
        ("img-src", &csp.img_src),
        ("connect-src", &csp.connect_src),
        ("frame-src", &csp.frame_src),
        ("font-src", &csp.font_src),
    ] {
        if !extra.is_empty() {
            directive(&mut d, name, &["'self'"], extra);
        }
    }
    d.push("object-src 'none'".into());
    d.push("base-uri 'self'".into());
    d.push("form-action 'self'".into());
    d.push("frame-ancestors 'none'".into());
    if tls {
        d.push("upgrade-insecure-requests".into());
    }
    d.push(format!("report-uri {CSP_REPORT_PATH}"));
    d.join("; ")
}

/// `Permissions-Policy`: the denied features as `()`, allowed ones `(self)`.
pub fn permissions_policy(cfg: &SecurityConfig) -> String {
    let allow = &cfg.headers.permissions_allow;
    let mut parts: Vec<String> = DENIED_FEATURES
        .iter()
        .filter(|f| !allow.iter().any(|a| a == *f))
        .map(|f| format!("{f}=()"))
        .collect();
    parts.extend(allow.iter().map(|f| format!("{f}=(self)")));
    parts.join(", ")
}

/// Every protection header, in order, for one response. Not configurable:
/// `X-Content-Type-Options`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`
/// (and HSTS, which the caller adds on TLS).
pub fn header_set(cfg: &SecurityConfig, nonce: &str, tls: bool) -> Vec<(&'static str, String)> {
    let csp_name = if cfg.csp.report_only {
        "content-security-policy-report-only"
    } else {
        "content-security-policy"
    };
    vec![
        (csp_name, csp_value(cfg, nonce, tls)),
        ("x-content-type-options", "nosniff".into()),
        ("x-frame-options", "DENY".into()),
        ("referrer-policy", cfg.headers.referrer_policy.clone()),
        ("permissions-policy", permissions_policy(cfg)),
        ("cross-origin-opener-policy", "same-origin".into()),
    ]
}

/// Sets the protection headers on a response, replacing any value tenant
/// code set for these names (and the CSP header of the other mode).
pub fn apply(headers: &mut HeaderMap, cfg: &SecurityConfig, nonce: &str, tls: bool) {
    headers.remove("content-security-policy");
    headers.remove("content-security-policy-report-only");
    for (name, value) in header_set(cfg, nonce, tls) {
        if let Ok(v) = HeaderValue::from_str(&value) {
            headers.insert(name, v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::config::DeploymentInfo;

    /// The default header table (docs/04, "Web-layer protections").
    #[test]
    fn default_headers_match_the_table() {
        let cfg = SecurityConfig::default();
        let set = header_set(&cfg, "N0nce", false);
        assert_eq!(
            set,
            vec![
                (
                    "content-security-policy",
                    "default-src 'self'; script-src 'self' 'nonce-N0nce'; style-src 'self' 'nonce-N0nce'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; report-uri /__renox/events?kind=csp".to_string()
                ),
                ("x-content-type-options", "nosniff".into()),
                ("x-frame-options", "DENY".into()),
                ("referrer-policy", "strict-origin-when-cross-origin".into()),
                ("permissions-policy", "camera=(), microphone=(), geolocation=()".into()),
                ("cross-origin-opener-policy", "same-origin".into()),
            ]
        );
        assert!(csp_value(&cfg, "x", true).contains("; upgrade-insecure-requests;"));
    }

    #[test]
    fn configured_sources_and_report_only() {
        let info = DeploymentInfo::parse(
            r#"{"artifact":{"version":1},"security":{"csp":{"script_src":["https://js.stripe.com"],"img_src":["data:"],"report_only":true},"headers":{"referrer_policy":"no-referrer","permissions_allow":["camera","payment"]}}}"#,
        )
        .unwrap();
        let set = header_set(&info.security, "n", false);
        assert_eq!(set[0].0, "content-security-policy-report-only");
        assert!(
            set[0]
                .1
                .contains("script-src 'self' 'nonce-n' https://js.stripe.com;")
        );
        assert!(set[0].1.contains("img-src 'self' data:;"));
        assert_eq!(set[3].1, "no-referrer");
        assert_eq!(
            set[4].1,
            "microphone=(), geolocation=(), camera=(self), payment=(self)"
        );
        let a = new_nonce();
        assert_eq!(a.len(), 24);
        assert_ne!(a, new_nonce());
    }
}
