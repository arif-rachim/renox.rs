//! `/_img/<key>` and `/_files/<key>` (`docs/contracts/ops.md` 1.7.0 section
//! 21; #321): served by the cell from the tenant's file store, never by
//! the isolate.
//!
//! | Step | Here |
//! | --- | --- |
//! | Lookup | the `renox__files` row of the key (platform handle) |
//! | Access | `public`, or `exp` + `sig` signing `/_files/<key>` ([`CellStorage::verify`]) |
//! | Width | rounded to the nearest of `[storage.images] widths`, never above the original |
//! | Format | `f=auto`: AVIF, then WebP from `Accept`, else the original's (JPEG or PNG) |
//! | Variant | `tenants/<id>/variants/<sha256>-w<w>-<fmt>`: looked up first, written once |
//! | Transform | decode, resize, encode on the blocking pool (platform CPU); EXIF and GPS are dropped because nothing but pixels is re-encoded |
//! | Rate | per tenant, 20 transforms per second, a burst of 100 (*proposed*): 429 `RENOX_IMAGE_RATE` |
//!
//! A cache hit never decodes; only a miss counts against the rate and is metered
//! (`image` record, `IMG <w>w <fmt>`).

use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use renox_data::Value;
use renox_runtime::ops::db::DbHandle;
use renox_runtime::ops::storage::object_key;

use crate::storage::CellStorage;

/// `[storage.images] widths` when the manifest has none (`artifact.md` 1.4).
pub const DEFAULT_WIDTHS: &[u32] = &[200, 400, 800, 1600];
/// Transforms per second and burst per tenant (*proposed*, ops.md section 21).
pub const RATE_PER_SECOND: f64 = 20.0;
pub const RATE_BURST: f64 = 100.0;

/// The output format of a variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Avif,
    Webp,
    Jpeg,
    Png,
}

impl Format {
    pub fn as_str(self) -> &'static str {
        match self {
            Format::Avif => "avif",
            Format::Webp => "webp",
            Format::Jpeg => "jpeg",
            Format::Png => "png",
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Format::Avif => "image/avif",
            Format::Webp => "image/webp",
            Format::Jpeg => "image/jpeg",
            Format::Png => "image/png",
        }
    }
}

/// `w` rounded to the nearest allowed width (ties go up), at most the original's.
pub fn round_width(w: u32, widths: &[u32], original: u32) -> u32 {
    let widths = if widths.is_empty() {
        DEFAULT_WIDTHS
    } else {
        widths
    };
    let mut best = widths[0];
    for &c in widths {
        if c.abs_diff(w) < best.abs_diff(w) || (c.abs_diff(w) == best.abs_diff(w) && c > best) {
            best = c;
        }
    }
    best.min(original.max(1))
}

/// The format `f` asks for, given the request's `Accept` and the original's type.
pub fn pick_format(f: Option<&str>, accept: &str, original: &str) -> Result<Format, &'static str> {
    let fallback = if original == "image/png" {
        Format::Png
    } else {
        Format::Jpeg
    };
    match f.unwrap_or("auto") {
        "auto" => Ok(if accept.contains("image/avif") {
            Format::Avif
        } else if accept.contains("image/webp") {
            Format::Webp
        } else {
            fallback
        }),
        "avif" => Ok(Format::Avif),
        "webp" => Ok(Format::Webp),
        "jpeg" | "jpg" => Ok(Format::Jpeg),
        "png" => Ok(Format::Png),
        _ => Err("f"),
    }
}

/// Resize and encode. Pixels only: EXIF, XMP, ICC and GPS never reach the variant.
pub fn transform(original: &[u8], width: u32, format: Format) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(original).map_err(|e| e.to_string())?;
    let (w, h) = (img.width().max(1), img.height().max(1));
    let width = width.min(w).max(1);
    let height = ((u64::from(h) * u64::from(width)) / u64::from(w)).max(1) as u32;
    let img = if width == w {
        img
    } else {
        img.resize_exact(width, height, image::imageops::FilterType::Triangle)
    };
    let mut out = Vec::new();
    match format {
        Format::Avif => {
            let enc = image::codecs::avif::AvifEncoder::new_with_speed_quality(&mut out, 10, 70);
            img.to_rgba8()
                .write_with_encoder(enc)
                .map_err(|e| e.to_string())?;
        }
        Format::Webp => {
            let enc = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
            img.to_rgba8()
                .write_with_encoder(enc)
                .map_err(|e| e.to_string())?;
        }
        Format::Jpeg => {
            let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82);
            img.to_rgb8()
                .write_with_encoder(enc)
                .map_err(|e| e.to_string())?;
        }
        Format::Png => {
            let enc = image::codecs::png::PngEncoder::new(&mut out);
            img.to_rgba8()
                .write_with_encoder(enc)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(out)
}

/// A token bucket per cell (one tenant's deployment).
pub struct Rate {
    state: Mutex<(f64, Instant)>,
    per_second: f64,
    burst: f64,
}

impl Default for Rate {
    fn default() -> Self {
        Rate::new(RATE_PER_SECOND, RATE_BURST)
    }
}

impl Rate {
    pub fn new(per_second: f64, burst: f64) -> Rate {
        Rate {
            state: Mutex::new((burst, Instant::now())),
            per_second,
            burst,
        }
    }

    /// `Ok` and one token taken, or the seconds until one is free.
    pub fn take(&self) -> Result<(), u64> {
        let mut s = self.state.lock().expect("rate lock");
        let now = Instant::now();
        let refill = now.duration_since(s.1).as_secs_f64() * self.per_second;
        s.0 = (s.0 + refill).min(self.burst);
        s.1 = now;
        if s.0 >= 1.0 {
            s.0 -= 1.0;
            Ok(())
        } else {
            Err(((1.0 - s.0) / self.per_second.max(f64::MIN_POSITIVE))
                .ceil()
                .clamp(1.0, 3600.0) as u64)
        }
    }
}

/// What the cell needs to serve `/_img` and `/_files` for one deployment.
pub struct Files {
    pub storage: Arc<CellStorage>,
    pub db: DbHandle,
    pub tenant_id: String,
    pub widths: Vec<u32>,
    pub rate: Rate,
}

/// One served answer, and an image variant the manager meters.
pub struct Served {
    pub response: http::Response<Bytes>,
    /// `(route, stored bytes)` when a variant was created.
    pub created: Option<(String, u64)>,
}

/// The paths the cell answers before route matching.
pub fn handles(path: &str) -> bool {
    path.starts_with("/_img/") || path.starts_with("/_files/")
}

fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn error(status: u16, code: &str, request_id: &str, retry: Option<u64>) -> Served {
    let body = serde_json::json!({ "error": { "code": code, "message": match code {
        "RENOX_IMAGE_RATE" => "Too many image transforms. Try again shortly.",
        "RENOX_STORAGE_NOT_FOUND" => "No stored file has this key.",
        "RENOX_VALIDATION" => "The request is not valid.",
        _ => "The request could not be served.",
    }, "request_id": request_id } });
    let mut b = http::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store");
    if let Some(r) = retry {
        b = b.header("retry-after", r.to_string());
    }
    Served {
        response: b
            .body(Bytes::from(body.to_string()))
            .expect("valid response"),
        created: None,
    }
}

struct Row {
    content_type: String,
    sha256: String,
    width: Option<u32>,
    public: bool,
}

async fn row(db: &DbHandle, key: &str) -> Option<Row> {
    let key = key.to_string();
    let r = db
        .call(move |db| {
            db.with_policy(None, || {
                db.query_one(
                    "select * from renox__files where key = ?",
                    &[Value::Text(key)],
                )
            })
        })
        .await
        .ok()?
        .ok()?
        .ok()??;
    let text = |c: &str| match r.get(c) {
        Some(Value::Text(s)) => s.clone(),
        _ => String::new(),
    };
    let int = |c: &str| match r.get(c) {
        Some(Value::Integer(n)) => Some(*n),
        _ => None,
    };
    Some(Row {
        content_type: text("content_type"),
        sha256: text("sha256"),
        width: int("width").map(|n| n as u32),
        public: int("public") == Some(1),
    })
}

async fn stored_total(db: &DbHandle) -> u64 {
    db.call(|db| {
        db.with_policy(None, || {
            db.query_one("select coalesce(sum(bytes), 0) as n from renox__files", &[])
        })
    })
    .await
    .ok()
    .and_then(|r| r.ok())
    .and_then(|r| r.ok())
    .flatten()
    .and_then(|r| match r.get("n") {
        Some(Value::Integer(n)) => Some(*n as u64),
        _ => None,
    })
    .unwrap_or(0)
}

/// Serves one `/_img/…` or `/_files/…` request.
pub async fn serve(files: &Files, parts: &http::request::Parts, request_id: &str) -> Served {
    let path = parts.uri.path();
    let (image, key) = match (path.strip_prefix("/_img/"), path.strip_prefix("/_files/")) {
        (Some(k), _) => (true, k),
        (_, Some(k)) => (false, k),
        _ => return error(404, "RENOX_NOT_FOUND", request_id, None),
    };
    let key = percent_decode(key);
    if parts.method != http::Method::GET && parts.method != http::Method::HEAD {
        return error(405, "RENOX_METHOD_NOT_ALLOWED", request_id, None);
    }
    let query: std::collections::HashMap<String, String> = parts
        .uri
        .query()
        .map(|q| form_urlencoded::parse(q.as_bytes()).into_owned().collect())
        .unwrap_or_default();
    let Some(file) = row(&files.db, &key).await else {
        return error(404, "RENOX_STORAGE_NOT_FOUND", request_id, None);
    };
    // A private file needs a signature of `/_files/<key>` that has not expired.
    if !file.public {
        let exp = query
            .get("exp")
            .and_then(|e| e.parse::<u64>().ok())
            .unwrap_or(0);
        let sig = query.get("sig").map(String::as_str).unwrap_or("");
        if !files
            .storage
            .verify(&format!("/_files/{key}"), exp, sig, now_s())
        {
            return error(404, "RENOX_STORAGE_NOT_FOUND", request_id, None);
        }
    }
    let cache = if file.public {
        "public, max-age=31536000, immutable".to_string()
    } else {
        "private, max-age=300".to_string()
    };
    if !image {
        let Ok(Some(bytes)) = files
            .storage
            .store()
            .get(object_key(&files.tenant_id, &key))
            .await
        else {
            return error(404, "RENOX_STORAGE_NOT_FOUND", request_id, None);
        };
        let mut b = http::Response::builder()
            .status(200)
            .header("content-type", file.content_type.as_str())
            .header("x-content-type-options", "nosniff")
            .header("etag", format!("\"{}\"", file.sha256))
            .header(
                "cache-control",
                if file.public {
                    "public, max-age=300"
                } else {
                    "private, no-store"
                },
            );
        if file.content_type == "image/svg+xml" {
            // A sanitised SVG still never runs script on the app's origin.
            b = b.header(
                "content-security-policy",
                "sandbox; default-src 'none'; style-src 'unsafe-inline'",
            );
        }
        if !file.content_type.starts_with("image/") {
            b = b.header("content-disposition", "attachment");
        }
        return Served {
            response: b
                .body(if parts.method == http::Method::HEAD {
                    Bytes::new()
                } else {
                    bytes
                })
                .expect("valid response"),
            created: None,
        };
    }
    let original_type = file.content_type.as_str();
    if !matches!(
        original_type,
        "image/jpeg" | "image/png" | "image/webp" | "image/avif" | "image/gif"
    ) {
        return error(400, "RENOX_VALIDATION", request_id, None);
    }
    for (k, allowed) in [
        ("fit", &["cover", "contain"][..]),
        ("focus", &["center", "face"][..]),
    ] {
        if let Some(v) = query.get(k)
            && !allowed.contains(&v.as_str())
        {
            return error(400, "RENOX_VALIDATION", request_id, None);
        }
    }
    let asked = query
        .get("w")
        .and_then(|w| w.parse::<u32>().ok())
        .unwrap_or(u32::MAX);
    let width = round_width(asked, &files.widths, file.width.unwrap_or(u32::MAX));
    let accept = parts
        .headers
        .get(http::header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let Ok(format) = pick_format(query.get("f").map(String::as_str), accept, original_type) else {
        return error(400, "RENOX_VALIDATION", request_id, None);
    };
    let variant = format!(
        "tenants/{}/variants/{}-w{width}-{}",
        files.tenant_id,
        file.sha256,
        format.as_str()
    );
    let respond = |bytes: Bytes| {
        http::Response::builder()
            .status(200)
            .header("content-type", format.content_type())
            .header("cache-control", cache.as_str())
            .header(
                "etag",
                format!("\"{}-w{width}-{}\"", file.sha256, format.as_str()),
            )
            .header("vary", "Accept")
            .header("x-content-type-options", "nosniff")
            .body(if parts.method == http::Method::HEAD {
                Bytes::new()
            } else {
                bytes
            })
            .expect("valid response")
    };
    if let Ok(Some(hit)) = files.storage.store().get(variant.clone()).await {
        return Served {
            response: respond(hit),
            created: None,
        };
    }
    if let Err(retry) = files.rate.take() {
        return error(429, "RENOX_IMAGE_RATE", request_id, Some(retry));
    }
    let Ok(Some(original)) = files
        .storage
        .store()
        .get(object_key(&files.tenant_id, &key))
        .await
    else {
        return error(404, "RENOX_STORAGE_NOT_FOUND", request_id, None);
    };
    let out = tokio::task::spawn_blocking(move || transform(&original, width, format)).await;
    let Ok(Ok(out)) = out else {
        tracing::warn!(tenant_id = %files.tenant_id, request_id, "image transform failed");
        return error(422, "RENOX_VALIDATION", request_id, None);
    };
    let out = Bytes::from(out);
    if let Err(e) = files
        .storage
        .store()
        .put(variant, out.clone(), format.content_type().into())
        .await
    {
        tracing::warn!(tenant_id = %files.tenant_id, request_id, error = %e, "image variant not stored");
    }
    // Variants are stored bytes of the tenant too (meter.md 0.4).
    let total = stored_total(&files.db).await + out.len() as u64;
    Served {
        response: respond(out),
        created: Some((format!("IMG {width}w {}", format.as_str()), total)),
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) =
                u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widths_round_to_the_nearest_allowed_and_never_upscale() {
        assert_eq!(round_width(390, &[], 4000), 400);
        assert_eq!(round_width(300, &[], 4000), 400);
        assert_eq!(round_width(5000, &[], 4000), 1600);
        assert_eq!(round_width(800, &[], 500), 500);
        assert_eq!(round_width(700, &[320, 640, 1280], 4000), 640);
    }

    #[test]
    fn auto_picks_avif_then_webp_then_the_original() {
        assert_eq!(
            pick_format(None, "image/avif,image/webp,*/*", "image/jpeg"),
            Ok(Format::Avif)
        );
        assert_eq!(
            pick_format(Some("auto"), "image/webp,*/*", "image/jpeg"),
            Ok(Format::Webp)
        );
        assert_eq!(pick_format(None, "*/*", "image/png"), Ok(Format::Png));
        assert_eq!(pick_format(None, "*/*", "image/jpeg"), Ok(Format::Jpeg));
        assert_eq!(pick_format(Some("gif"), "*/*", "image/jpeg"), Err("f"));
    }

    #[test]
    fn the_rate_refuses_past_the_burst() {
        let r = Rate::default();
        for _ in 0..RATE_BURST as usize {
            assert!(r.take().is_ok());
        }
        assert!(r.take().is_err());
    }
}
