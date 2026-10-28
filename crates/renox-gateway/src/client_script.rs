//! `/__renox/client.js`: the platform client script (`client-events.md`,
//! #127), served by the gateway for every app. The file is built from
//! `sdk/client/` and committed under `crates/renox-gateway/assets/`, so a
//! Rust build never needs Bun; a CLI test checks the committed file matches
//! the build.
//!
//! Pages reference it as [`script_src`], which carries the content hash, so
//! the response can be `immutable`: a new script is a new URL.

use std::sync::OnceLock;

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, Response, StatusCode, header};
use sha2::{Digest, Sha256};

/// The script's path.
pub const SCRIPT_PATH: &str = "/__renox/client.js";

/// The built script.
pub const SCRIPT: &[u8] = include_bytes!("../assets/renox-client.js");

/// SHA-256 of [`SCRIPT`], hex.
pub fn script_hash() -> &'static str {
    static H: OnceLock<String> = OnceLock::new();
    H.get_or_init(|| {
        Sha256::digest(SCRIPT)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    })
}

/// The `src` pages use: the path with the first 16 hex characters of the
/// hash as `?v=`.
pub fn script_src() -> String {
    format!("{SCRIPT_PATH}?v={}", &script_hash()[..16])
}

fn etag() -> String {
    format!("\"{}\"", script_hash())
}

/// `GET`/`HEAD` → the script (`304` on a matching `If-None-Match`); any
/// other method → 405.
pub fn serve(method: &Method, request: &HeaderMap) -> Response<Body> {
    if method != Method::GET && method != Method::HEAD {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "GET, HEAD")
            .body(Body::empty())
            .expect("valid response");
    }
    let etag = etag();
    let matches = request
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|t| t.trim() == etag || t.trim() == "*");
    let builder = Response::builder()
        .header(header::ETAG, HeaderValue::from_str(&etag).expect("hex"))
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable");
    if matches {
        return builder
            .status(StatusCode::NOT_MODIFIED)
            .body(Body::empty())
            .expect("valid response");
    }
    builder
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
        .header(header::CONTENT_LENGTH, SCRIPT.len())
        .body(if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(SCRIPT)
        })
        .expect("valid response")
}
