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
//! `PUT /_files/<key>` (#580, `ops.md` section 21, "Tenant uploads") is the one write: a browser's
//! upload to a URL from `ctx.storage.signUpload`. The signature (`exp`, `max`, `ct`, `pub`, `sig`)
//! decides everything; the body is read up to `max` and stored through the same
//! [`store_file`] as `op_storage_put`.
//!
//! A cache hit never decodes; only a miss counts against the rate and is metered
//! (`image` record, `IMG <w>w <fmt>`).
//!
//! Cargo features (#372; both on by default): `media` is the pipeline itself
//! (without it every `/_img` request is 503 `RENOX_UNAVAILABLE`, `/_files`
//! still serves), `avif` the AVIF encoder (without it `f=auto` picks WebP and
//! `f=avif` is 400 `RENOX_VALIDATION`).

use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use renox_data::Value;
use renox_runtime::ops::db::DbHandle;
use renox_runtime::ops::storage::{
    StorageHost, StoreError, StoreInput, check_key, object_key, store_file,
};

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

/// Whether this worker encodes AVIF (the `avif` feature).
pub const AVIF: bool = cfg!(feature = "avif");

/// The format `f` asks for, given the request's `Accept` and the original's type.
pub fn pick_format(f: Option<&str>, accept: &str, original: &str) -> Result<Format, &'static str> {
    let fallback = if original == "image/png" {
        Format::Png
    } else {
        Format::Jpeg
    };
    match f.unwrap_or("auto") {
        "auto" => Ok(if AVIF && accept.contains("image/avif") {
            Format::Avif
        } else if accept.contains("image/webp") {
            Format::Webp
        } else {
            fallback
        }),
        "avif" if AVIF => Ok(Format::Avif),
        "webp" => Ok(Format::Webp),
        "jpeg" | "jpg" => Ok(Format::Jpeg),
        "png" => Ok(Format::Png),
        _ => Err("f"),
    }
}

/// Resize and encode. Pixels only: EXIF, XMP, ICC and GPS never reach the variant.
#[cfg(feature = "media")]
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
        #[cfg(feature = "avif")]
        Format::Avif => {
            let enc = image::codecs::avif::AvifEncoder::new_with_speed_quality(&mut out, 10, 70);
            img.to_rgba8()
                .write_with_encoder(enc)
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(feature = "avif"))]
        Format::Avif => return Err("AVIF is not available on this worker".into()),
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

/// Without the `media` feature (#372) nothing is decoded; `serve` answers
/// 503 before it gets here.
#[cfg(not(feature = "media"))]
pub fn transform(_original: &[u8], _width: u32, _format: Format) -> Result<Vec<u8>, String> {
    Err("the image pipeline is not available on this worker".into())
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
    /// Owner (`app` or a module) -> its `allowed_types`, for `PUT /_files/<key>`.
    pub allowed: std::collections::BTreeMap<String, Vec<String>>,
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
    error_with(status, code, request_id, retry, None)
}

fn error_with(
    status: u16,
    code: &str,
    request_id: &str,
    retry: Option<u64>,
    details: Option<(&str, serde_json::Value)>,
) -> Served {
    let mut body = serde_json::json!({ "error": { "code": code, "message": match code {
        "RENOX_IMAGE_RATE" => "Too many image transforms. Try again shortly.",
        "RENOX_STORAGE_NOT_FOUND" => "No stored file has this key.",
        "RENOX_STORAGE_CONFLICT" => "The upload URL was already used.",
        "RENOX_BODY_TOO_LARGE" => "The request body is too large.",
        "RENOX_VALIDATION" => "The request is not valid.",
        "RENOX_UNAVAILABLE" => "The service is temporarily unavailable.",
        _ => "The request could not be served.",
    }, "request_id": request_id } });
    if let Some((message, d)) = details {
        body["error"]["message"] = message.into();
        body["error"]["details"] = d;
    }
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
pub async fn serve(
    files: &Files,
    parts: &http::request::Parts,
    body: axum::body::Body,
    request_id: &str,
) -> Served {
    let path = parts.uri.path();
    let (image, key) = match (path.strip_prefix("/_img/"), path.strip_prefix("/_files/")) {
        (Some(k), _) => (true, k),
        (_, Some(k)) => (false, k),
        _ => return error(404, "RENOX_NOT_FOUND", request_id, None),
    };
    let key = percent_decode(key);
    if !image && parts.method == http::Method::PUT {
        return put(files, parts, body, &key, request_id).await;
    }
    drop(body);
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
    // A worker without the pipeline (#372): the file exists and is readable,
    // but no variant can be made; `errors.md` `RENOX_UNAVAILABLE` (503, Retry-After).
    if !cfg!(feature = "media") {
        return error(503, "RENOX_UNAVAILABLE", request_id, Some(5));
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

/// `[storage.images] widths` of a manifest's `storage` object (empty: the defaults).
pub fn manifest_widths(storage: Option<&serde_json::Value>) -> Vec<u32> {
    storage
        .and_then(|s| s.get("images"))
        .and_then(|i| i.get("widths"))
        .and_then(|w| w.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_u64().map(|n| n as u32))
                .collect()
        })
        .unwrap_or_default()
}

/// `ctx.pdf`'s images (ops.md 1.13.0 section 24, #582): a key of this
/// deployment's tenant, as the `/_img` variant of the asked width (at most
/// 1600 px) in the original's format, JPEG or PNG (other originals become
/// PNG). The variant cache is the one `/_img` uses. No signature is needed
/// for a private key: the render runs server-side as the tenant, and the
/// lookup is in the tenant's own `renox__files` and object prefix, so another
/// tenant's key never resolves.
pub struct PdfImageStore {
    pub storage: Arc<CellStorage>,
    pub db: DbHandle,
    pub tenant_id: String,
    pub widths: Vec<u32>,
}

impl PdfImageStore {
    async fn read(
        &self,
        key: &str,
        width: Option<u32>,
    ) -> Result<(Vec<u8>, renox_runtime::ops::pdf::ImageFormat), renox_runtime::ops::pdf::ImageError>
    {
        use renox_runtime::ops::pdf::{ImageError, ImageFormat, MAX_IMAGE_WIDTH};
        if check_key(key, key.split('/').next().unwrap_or("")).is_err() {
            return Err(ImageError::NotFound);
        }
        let file = row(&self.db, key).await.ok_or(ImageError::NotFound)?;
        let (format, pdf_format) = match file.content_type.as_str() {
            "image/jpeg" => (Format::Jpeg, ImageFormat::Jpeg),
            "image/png" | "image/webp" | "image/avif" | "image/gif" => {
                (Format::Png, ImageFormat::Png)
            }
            _ => return Err(ImageError::Unsupported),
        };
        let asked = width.unwrap_or(MAX_IMAGE_WIDTH).min(MAX_IMAGE_WIDTH);
        let width =
            round_width(asked, &self.widths, file.width.unwrap_or(u32::MAX)).min(MAX_IMAGE_WIDTH);
        let variant = format!(
            "tenants/{}/variants/{}-w{width}-{}",
            self.tenant_id,
            file.sha256,
            format.as_str()
        );
        if let Ok(Some(hit)) = self.storage.store().get(variant.clone()).await {
            return Ok((hit.to_vec(), pdf_format));
        }
        let original = match self
            .storage
            .store()
            .get(object_key(&self.tenant_id, key))
            .await
        {
            Ok(Some(b)) => b,
            Ok(None) => return Err(ImageError::NotFound),
            Err(e) => return Err(ImageError::Failed(e.to_string())),
        };
        // Already on the blocking pool (the PDF render).
        let out = transform(&original, width, format).map_err(ImageError::Failed)?;
        let out = Bytes::from(out);
        if let Err(e) = self
            .storage
            .store()
            .put(variant, out.clone(), format.content_type().into())
            .await
        {
            tracing::warn!(tenant_id = %self.tenant_id, error = %e, "pdf image variant not stored");
        }
        Ok((out.to_vec(), pdf_format))
    }
}

impl renox_runtime::ops::pdf::PdfImages for PdfImageStore {
    fn read_image(
        &self,
        key: &str,
        width: Option<u32>,
    ) -> Result<(Vec<u8>, renox_runtime::ops::pdf::ImageFormat), renox_runtime::ops::pdf::ImageError>
    {
        // Called from the render's blocking-pool thread, which carries the runtime.
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|e| renox_runtime::ops::pdf::ImageError::Failed(format!("no runtime: {e}")))?;
        handle.block_on(self.read(key, width))
    }
}

/// One query parameter exactly as it appears in the URL (not decoded): the signed message
/// holds `ct` in that spelling.
fn raw_param<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query
        .split('&')
        .filter_map(|p| p.split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v)
}

/// The media type of a `Content-Type` value: no parameters, lower case.
fn media_type(v: &str) -> String {
    v.split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// The status of a storage refusal on a `PUT` (`errors.md` has none for the thrown codes).
fn store_status(code: &str) -> u16 {
    match code {
        "RENOX_STORAGE_TYPE" => 415,
        "RENOX_STORAGE_TOO_LARGE" | "RENOX_STORAGE_QUOTA" => 413,
        _ => 500,
    }
}

fn store_error(e: StoreError, request_id: &str) -> Served {
    let status = store_status(e.code);
    error_with(
        status,
        e.code,
        request_id,
        None,
        Some((e.message, e.details)),
    )
}

/// The SHA-256 of a signature, hex: what the single-use table keeps (never the signature).
fn sig_hash(sig: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(sig.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Reads at most `max` bytes: `None` when the body is longer (the rest is never read).
async fn read_limited(body: axum::body::Body, max: u64) -> Result<Option<Bytes>, ()> {
    use http_body_util::BodyExt;
    let mut body = body;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| ())?;
        if let Ok(data) = frame.into_data() {
            if buf.len() as u64 + data.len() as u64 > max {
                return Ok(None);
            }
            buf.extend_from_slice(&data);
        }
    }
    Ok(Some(Bytes::from(buf)))
}

/// `PUT /_files/<key>?exp=&max=&ct=&pub=&sig=`: a browser's signed upload.
async fn put(
    files: &Files,
    parts: &http::request::Parts,
    body: axum::body::Body,
    key: &str,
    request_id: &str,
) -> Served {
    let not_found = || error(404, "RENOX_STORAGE_NOT_FOUND", request_id, None);
    let query = parts.uri.query().unwrap_or("");
    let number = |n: &str| raw_param(query, n).and_then(|v| v.parse::<u64>().ok());
    let (Some(exp), Some(max), Some(ct), Some(sig)) = (
        number("exp"),
        number("max"),
        raw_param(query, "ct"),
        raw_param(query, "sig"),
    ) else {
        return not_found();
    };
    let public = match raw_param(query, "pub") {
        Some("1") => true,
        Some("0") => false,
        _ => return not_found(),
    };
    // Nothing below is trusted before this: a missing, altered, expired or foreign
    // (the download one) signature is a 404, as an unknown key would be.
    if !files
        .storage
        .verify_upload(key, exp, max, ct, public, sig, now_s())
    {
        return not_found();
    }
    // The key rules of `op_storage_put`; the signer applied them already.
    let owner = key.split('/').next().unwrap_or("");
    if check_key(key, owner).is_err() {
        return not_found();
    }
    let hash = sig_hash(sig);
    if spent(&files.db, &hash).await {
        return error_with(
            409,
            "RENOX_STORAGE_CONFLICT",
            request_id,
            None,
            Some((
                "The upload URL was already used.",
                serde_json::json!({ "key": key.chars().take(64).collect::<String>() }),
            )),
        );
    }
    let signed_type = media_type(&percent_decode(ct));
    let sent_type = parts
        .headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(media_type)
        .unwrap_or_default();
    if sent_type != signed_type {
        return error_with(
            415,
            "RENOX_STORAGE_TYPE",
            request_id,
            None,
            Some((
                "The content type is not the signed one.",
                serde_json::json!({ "key": key, "declared": sent_type, "reason": "mismatch" }),
            )),
        );
    }
    // `max` is the body limit: a declared length over it is refused before a byte is read.
    let limit = max.min(files.storage.limits_file_bytes());
    let too_large = |received: Option<u64>| {
        error_with(
            413,
            "RENOX_BODY_TOO_LARGE",
            request_id,
            None,
            Some((
                "The upload is over the signed limit.",
                serde_json::json!({ "limit_bytes": limit, "received_bytes": received }),
            )),
        )
    };
    let declared = parts
        .headers
        .get(http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .or_else(|| axum::body::HttpBody::size_hint(&body).exact());
    if let Some(n) = declared
        && n > limit
    {
        return too_large(Some(n));
    }
    let bytes = match read_limited(body, limit).await {
        Ok(Some(b)) => b,
        Ok(None) => return too_large(None),
        Err(()) => return error(400, "RENOX_VALIDATION", request_id, None),
    };
    // Reserved before the write so two concurrent PUTs cannot both succeed; given back when
    // the store refuses, so a failed PUT does not spend the URL.
    match reserve(&files.db, &hash).await {
        Ok(true) => {}
        Ok(false) => {
            return error_with(
                409,
                "RENOX_STORAGE_CONFLICT",
                request_id,
                None,
                Some((
                    "The upload URL was already used.",
                    serde_json::json!({ "key": key.chars().take(64).collect::<String>() }),
                )),
            );
        }
        Err(()) => return error(503, "RENOX_UNAVAILABLE", request_id, Some(1)),
    }
    let allowed = files.allowed.get(owner).cloned().unwrap_or_default();
    let host: &dyn StorageHost = files.storage.as_ref();
    let stored = store_file(StoreInput {
        host,
        limits: host.limits(&files.tenant_id),
        db: &files.db,
        tx: None,
        tenant_id: &files.tenant_id,
        owner,
        allowed: &allowed,
        key,
        bytes,
        content_type: &signed_type,
        public,
        sanitised: false,
    })
    .await;
    match stored {
        Ok(s) => Served {
            response: http::Response::builder()
                .status(201)
                .header("content-type", "application/json")
                .header("cache-control", "no-store")
                .body(Bytes::from(serde_json::to_vec(&s.file).unwrap_or_default()))
                .expect("valid response"),
            created: None,
        },
        Err(e) => {
            release(&files.db, &hash).await;
            store_error(e, request_id)
        }
    }
}

/// Whether this signature hash is in `renox__upload_sigs`.
async fn spent(db: &DbHandle, hash: &str) -> bool {
    let hash = hash.to_string();
    let r = db
        .call(move |db| {
            db.with_policy(None, || {
                db.query_one(
                    "select 1 as n from renox__upload_sigs where sig_hash = ?",
                    &[Value::Text(hash)],
                )
            })
        })
        .await;
    matches!(r, Ok(Ok(Ok(Some(_)))))
}

/// Records the signature hash; `false` when it was already there. Rows older than 2 hours
/// (a signature lives 1 hour at most) are deleted on each insert.
async fn reserve(db: &DbHandle, hash: &str) -> Result<bool, ()> {
    let hash = hash.to_string();
    let now_ms = (now_s() * 1000) as i64;
    let r = db
        .call(move |db| {
            db.with_policy(None, || {
                db.execute(
                    "delete from renox__upload_sigs where used_at < ?",
                    &[Value::Integer(now_ms - 2 * 3600 * 1000)],
                )?;
                db.execute(
                    "insert or ignore into renox__upload_sigs (sig_hash, used_at) values (?, ?)",
                    &[Value::Text(hash), Value::Integer(now_ms)],
                )
            })
        })
        .await;
    match r {
        Ok(Ok(Ok(done))) => Ok(done.changes == 1),
        _ => Err(()),
    }
}

/// Gives a reserved signature back after a refused store.
async fn release(db: &DbHandle, hash: &str) {
    let hash = hash.to_string();
    let _ = db
        .call(move |db| {
            db.with_policy(None, || {
                db.execute(
                    "delete from renox__upload_sigs where sig_hash = ?",
                    &[Value::Text(hash)],
                )
            })
        })
        .await;
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

    #[cfg(feature = "avif")]
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

    #[cfg(not(feature = "avif"))]
    #[test]
    fn without_the_avif_feature_auto_picks_webp_and_avif_is_refused() {
        assert_eq!(
            pick_format(None, "image/avif,image/webp,*/*", "image/jpeg"),
            Ok(Format::Webp)
        );
        assert_eq!(
            pick_format(Some("avif"), "image/avif", "image/jpeg"),
            Err("f")
        );
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
