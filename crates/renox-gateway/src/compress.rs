//! Response compression for dynamic responses (#159; README, "Compression").
//!
//! The cell calls [`negotiate`] on the request and [`apply`] on the response
//! before it writes the meter record, so `egress_bytes` counts the bytes
//! sent (`docs/contracts/meter.md`: body bytes, headers excluded). The
//! gateway's static files are not compressed here (#107: no `Vary` from
//! request headers on static assets).
//!
//! What is compressed: `text/*` and JSON (`application/json`,
//! `application/*+json`) bodies of at least [`MIN_BYTES`], with brotli or
//! gzip as `Accept-Encoding` allows. Every response of those types gets
//! `Vary: Accept-Encoding`, compressed or not, so a cache never serves one
//! variant for the other.
//!
//! What is never compressed (BREACH, `docs/24-threat-model.md`, "End user"):
//! a response carrying the [`NoCompress`] extension, which the cell (or the
//! runtime) sets on responses that reflect a secret next to request input.
//! It is a response extension, never a header, so tenant code can neither
//! set nor see it. Also left alone: responses that already have a
//! `Content-Encoding`, `Cache-Control: no-transform`, partial content, and
//! bodies that would not get smaller.

use std::io::Write;

use axum::http::header::{
    CACHE_CONTROL, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, VARY,
};
use axum::http::{HeaderMap, HeaderValue, Response, StatusCode};
use bytes::Bytes;

/// Smallest body that is compressed.
pub const MIN_BYTES: usize = 1024;

/// Brotli quality for dynamic responses: fast, still well ahead of gzip.
const BROTLI_QUALITY: u32 = 4;
const BROTLI_WINDOW: u32 = 22;

/// A content coding the gateway produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Br,
    Gzip,
}

impl Encoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Encoding::Br => "br",
            Encoding::Gzip => "gzip",
        }
    }
}

/// Marks a response that must not be compressed (BREACH). Set it with
/// `response.extensions_mut().insert(NoCompress)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoCompress;

/// The coding to use for a request, from its `Accept-Encoding` (RFC 9110
/// section 12.5.3): the highest q-value among `br` and `gzip` (`x-gzip` and
/// `*` count), `br` on a tie, none when both are absent or `q=0`.
pub fn negotiate(headers: &HeaderMap) -> Option<Encoding> {
    let mut br: Option<f32> = None;
    let mut gzip: Option<f32> = None;
    let mut star: Option<f32> = None;
    for value in headers.get_all(axum::http::header::ACCEPT_ENCODING) {
        let Ok(value) = value.to_str() else { continue };
        for item in value.split(',') {
            let mut parts = item.split(';');
            let coding = parts.next().unwrap_or("").trim().to_ascii_lowercase();
            let mut q = 1.0f32;
            for p in parts {
                let p = p.trim();
                if let Some(v) = p.strip_prefix("q=").or_else(|| p.strip_prefix("Q=")) {
                    q = v.trim().parse().unwrap_or(0.0);
                }
            }
            if !(0.0..=1.0).contains(&q) {
                q = 0.0;
            }
            let slot = match coding.as_str() {
                "br" => &mut br,
                "gzip" | "x-gzip" => &mut gzip,
                "*" => &mut star,
                _ => continue,
            };
            *slot = Some(slot.map_or(q, |old: f32| old.max(q)));
        }
    }
    let br = br.or(star).unwrap_or(0.0);
    let gzip = gzip.or(star).unwrap_or(0.0);
    if br <= 0.0 && gzip <= 0.0 {
        None
    } else if br >= gzip {
        Some(Encoding::Br)
    } else {
        Some(Encoding::Gzip)
    }
}

/// Is this a type the gateway compresses (`text/*`, JSON)?
fn compressible_type(headers: &HeaderMap) -> bool {
    let Some(ct) = headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let mime = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    mime.starts_with("text/")
        || mime == "application/json"
        || (mime.starts_with("application/") && mime.ends_with("+json"))
}

fn has_no_transform(headers: &HeaderMap) -> bool {
    headers.get_all(CACHE_CONTROL).iter().any(|v| {
        v.to_str().is_ok_and(|s| {
            s.split(',')
                .any(|d| d.trim().eq_ignore_ascii_case("no-transform"))
        })
    })
}

/// Add `Accept-Encoding` to `Vary` unless it is there (or `Vary: *`).
fn add_vary(headers: &mut HeaderMap) {
    let present = headers.get_all(VARY).iter().any(|v| {
        v.to_str().is_ok_and(|s| {
            s.split(',').any(|f| {
                let f = f.trim();
                f == "*" || f.eq_ignore_ascii_case("accept-encoding")
            })
        })
    });
    if !present {
        headers.append(VARY, HeaderValue::from_static("accept-encoding"));
    }
}

fn encode(body: &[u8], encoding: Encoding) -> std::io::Result<Vec<u8>> {
    match encoding {
        Encoding::Gzip => {
            let mut e = flate2::write::GzEncoder::new(
                Vec::with_capacity(body.len() / 2),
                flate2::Compression::default(),
            );
            e.write_all(body)?;
            e.finish()
        }
        Encoding::Br => {
            let mut out = Vec::with_capacity(body.len() / 2);
            {
                let mut w =
                    brotli::CompressorWriter::new(&mut out, 4096, BROTLI_QUALITY, BROTLI_WINDOW);
                w.write_all(body)?;
                w.flush()?;
            }
            Ok(out)
        }
    }
}

/// Compress `response` with `encoding` when the rules above allow it, and
/// add `Vary: Accept-Encoding` to every response whose type is compressed.
/// A strong `ETag` becomes weak on a compressed body (RFC 9110 section
/// 8.8.1: the bytes differ).
pub fn apply(mut response: Response<Bytes>, encoding: Option<Encoding>) -> Response<Bytes> {
    let headers = response.headers();
    if !compressible_type(headers)
        || headers.contains_key(CONTENT_ENCODING)
        || headers.contains_key(CONTENT_RANGE)
        || has_no_transform(headers)
        || response.extensions().get::<NoCompress>().is_some()
    {
        return response;
    }
    let status = response.status();
    if status == StatusCode::PARTIAL_CONTENT
        || status == StatusCode::NO_CONTENT
        || status == StatusCode::NOT_MODIFIED
        || status.is_informational()
    {
        return response;
    }
    add_vary(response.headers_mut());
    let Some(encoding) = encoding else {
        return response;
    };
    if response.body().len() < MIN_BYTES {
        return response;
    }
    let Ok(compressed) = encode(response.body(), encoding) else {
        return response;
    };
    if compressed.len() >= response.body().len() {
        return response;
    }
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_ENCODING,
        HeaderValue::from_static(encoding.as_str()),
    );
    headers.insert(CONTENT_LENGTH, HeaderValue::from(compressed.len()));
    if let Some(etag) = headers.get(ETAG).and_then(|v| v.to_str().ok())
        && etag.starts_with('"')
        && let Ok(weak) = HeaderValue::from_str(&format!("W/{etag}"))
    {
        headers.insert(ETAG, weak);
    }
    *response.body_mut() = Bytes::from(compressed);
    response
}
