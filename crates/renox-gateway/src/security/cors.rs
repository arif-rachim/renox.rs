//! CORS (`docs/04-isolation-security.md`: closed by default, only the app's
//! own origins; `[security.cors]` lists more). Same-origin requests need no
//! CORS headers, so "closed" means: no `Access-Control-*` header for any
//! origin not listed. `*` is never sent.

use axum::http::{HeaderMap, HeaderValue, Method, header};

use super::config::Cors;

/// The listed `Origin` of a request, if any.
fn listed<'a>(cfg: &Cors, headers: &'a HeaderMap) -> Option<&'a str> {
    let origin = headers.get(header::ORIGIN)?.to_str().ok()?;
    cfg.origins.iter().any(|o| o == origin).then_some(origin)
}

/// What a preflight (`OPTIONS` with `Access-Control-Request-Method`) gets.
#[derive(Debug, PartialEq, Eq)]
pub enum Preflight {
    /// Not a preflight: route the request as usual.
    No,
    /// 204 with these headers.
    Allowed(Vec<(header::HeaderName, String)>),
    /// 403, no CORS headers: the origin is not listed, or the method or a
    /// requested header is not allowed.
    Refused,
}

pub fn preflight(cfg: &Cors, method: &Method, headers: &HeaderMap) -> Preflight {
    if method != Method::OPTIONS {
        return Preflight::No;
    }
    let Some(wanted) = headers
        .get(header::ACCESS_CONTROL_REQUEST_METHOD)
        .and_then(|v| v.to_str().ok())
    else {
        return Preflight::No;
    };
    let Some(origin) = listed(cfg, headers) else {
        return Preflight::Refused;
    };
    if !cfg.methods.iter().any(|m| m == wanted) {
        return Preflight::Refused;
    }
    let requested: Vec<String> = headers
        .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(',')
                .map(|h| h.trim().to_ascii_lowercase())
                .filter(|h| !h.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if requested.iter().any(|h| !cfg.headers.contains(h)) {
        return Preflight::Refused;
    }
    let mut out = vec![
        (header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.to_string()),
        (header::ACCESS_CONTROL_ALLOW_METHODS, cfg.methods.join(", ")),
        (header::ACCESS_CONTROL_MAX_AGE, cfg.max_age_s.to_string()),
        (header::VARY, "Origin".to_string()),
    ];
    if !cfg.headers.is_empty() {
        out.push((header::ACCESS_CONTROL_ALLOW_HEADERS, cfg.headers.join(", ")));
    }
    if cfg.credentials {
        out.push((header::ACCESS_CONTROL_ALLOW_CREDENTIALS, "true".into()));
    }
    Preflight::Allowed(out)
}

/// The CORS headers of an actual response: the gateway removes every
/// `Access-Control-*` header tenant code set, then adds the configured ones
/// when the request's origin is listed.
pub fn apply(cfg: &Cors, request: &HeaderMap, response: &mut HeaderMap) {
    let names: Vec<header::HeaderName> = response
        .keys()
        .filter(|k| k.as_str().starts_with("access-control-"))
        .cloned()
        .collect();
    for n in names {
        response.remove(n);
    }
    let Some(origin) = listed(cfg, request) else {
        return;
    };
    if let Ok(v) = HeaderValue::from_str(origin) {
        response.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
        response.append(header::VARY, HeaderValue::from_static("Origin"));
        if cfg.credentials {
            response.insert(
                header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
                HeaderValue::from_static("true"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cors() -> Cors {
        Cors {
            origins: vec!["https://partner.example".into()],
            headers: vec!["content-type".into()],
            credentials: true,
            ..Cors::default()
        }
    }

    fn req(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    #[test]
    fn preflight_listed_passes_unlisted_fails() {
        let ok = preflight(
            &cors(),
            &Method::OPTIONS,
            &req(&[
                ("origin", "https://partner.example"),
                ("access-control-request-method", "POST"),
                ("access-control-request-headers", "Content-Type"),
            ]),
        );
        match ok {
            Preflight::Allowed(h) => {
                assert!(h.contains(&(
                    header::ACCESS_CONTROL_ALLOW_ORIGIN,
                    "https://partner.example".into()
                )));
                assert!(h.contains(&(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, "true".into())));
            }
            other => panic!("{other:?}"),
        }
        for bad in [
            req(&[
                ("origin", "https://evil.example"),
                ("access-control-request-method", "POST"),
            ]),
            req(&[
                ("origin", "https://partner.example"),
                ("access-control-request-method", "DELETE"),
            ]),
            req(&[
                ("origin", "https://partner.example"),
                ("access-control-request-method", "POST"),
                ("access-control-request-headers", "x-secret"),
            ]),
        ] {
            assert_eq!(
                preflight(&cors(), &Method::OPTIONS, &bad),
                Preflight::Refused
            );
        }
        // Closed by default: no origin is listed.
        assert_eq!(
            preflight(
                &Cors::default(),
                &Method::OPTIONS,
                &req(&[
                    ("origin", "https://partner.example"),
                    ("access-control-request-method", "GET")
                ])
            ),
            Preflight::Refused
        );
        assert_eq!(
            preflight(&cors(), &Method::OPTIONS, &req(&[])),
            Preflight::No
        );
    }

    #[test]
    fn responses_get_headers_only_for_listed_origins() {
        let mut resp = req(&[("access-control-allow-origin", "*")]);
        apply(
            &cors(),
            &req(&[("origin", "https://evil.example")]),
            &mut resp,
        );
        assert!(
            resp.get("access-control-allow-origin").is_none(),
            "tenant's * removed"
        );
        apply(
            &cors(),
            &req(&[("origin", "https://partner.example")]),
            &mut resp,
        );
        assert_eq!(
            resp["access-control-allow-origin"],
            "https://partner.example"
        );
        assert_eq!(resp["access-control-allow-credentials"], "true");
    }
}
