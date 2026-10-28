//! Static files from a deployment's `public/` directory, served by the
//! gateway outside the tenant's isolate and quota (`docs/05-tenant-lifecycle.md`;
//! `docs/contracts/artifact.md` section 4, `public/manifest.json`).
//!
//! The gateway serves only paths listed in `public/manifest.json`; the
//! request path is never joined onto the filesystem. Manifests are read once
//! per deployment and cached: artifacts are immutable, so a cached manifest
//! never goes stale.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, Response, StatusCode, header};
use serde::Deserialize;
use tokio_util::io::ReaderStream;

use crate::route_table::is_sha256_hex;

/// `Cache-Control` for paths whose file name carries a content hash.
pub const CACHE_IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// `Cache-Control` for other paths: cache, but revalidate with the `ETag`.
pub const CACHE_REVALIDATE: &str = "public, max-age=0, must-revalidate";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicManifestFile {
    #[serde(rename = "$comment")]
    #[allow(dead_code)]
    comment: Option<String>,
    version: u32,
    files: HashMap<String, PublicFile>,
}

/// One entry of `public/manifest.json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicFile {
    pub sha256: String,
    pub size: u64,
    pub content_type: String,
}

/// The parsed `public/manifest.json` of one deployment.
#[derive(Debug, Default)]
pub struct PublicManifest {
    files: HashMap<String, PublicFile>,
}

impl PublicManifest {
    /// Parses a manifest. Entries whose key is not a safe URL path or whose
    /// hash or content type is malformed are refused as a whole.
    pub fn parse(json: &str) -> Result<Self, String> {
        let file: PublicManifestFile = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if file.version != 0 {
            return Err(format!("unknown public manifest version {}", file.version));
        }
        for (path, entry) in &file.files {
            if !is_safe_url_path(path) {
                return Err(format!("invalid public path {path:?}"));
            }
            if !is_sha256_hex(&entry.sha256) {
                return Err(format!("invalid sha256 for {path:?}"));
            }
            if HeaderValue::from_str(&entry.content_type).is_err() {
                return Err(format!("invalid content_type for {path:?}"));
            }
        }
        Ok(Self { files: file.files })
    }

    pub fn get(&self, url_path: &str) -> Option<&PublicFile> {
        self.files.get(url_path)
    }

    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

/// `/` followed by segments with no `.`/`..`, no empty segment, no
/// backslash, `:`, or control characters (`artifact.md` section 1, "Paths").
fn is_safe_url_path(p: &str) -> bool {
    let Some(rest) = p.strip_prefix('/') else {
        return false;
    };
    p.len() <= 513
        && !rest.is_empty()
        && rest.split('/').all(|seg| {
            !seg.is_empty()
                && seg != "."
                && seg != ".."
                && !seg.chars().any(|c| c == '\\' || c == ':' || c.is_control())
        })
}

/// Whether the last segment of `path` carries a content hash: a `.` or `-`
/// separated part of at least 8 hex characters before the extension, as
/// bundlers write it (`app.3f2a9c1b.js`, `logo-5d41402abc4b2a76.png`).
pub fn is_hashed_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let Some((stem, _ext)) = name.rsplit_once('.') else {
        return false;
    };
    stem.rsplit(['.', '-'])
        .next()
        .filter(|part| part.len() != stem.len())
        .is_some_and(|part| part.len() >= 8 && part.bytes().all(|c| c.is_ascii_hexdigit()))
}

/// Loads and caches the public index per deployment (`public.json` in
/// artifact version 1, `public/manifest.json` in version 0).
#[derive(Debug)]
pub struct StaticFiles {
    artifact_root: PathBuf,
    cache: Mutex<HashMap<String, Arc<PublicManifest>>>,
}

impl StaticFiles {
    /// `artifact_root/<deployment_hash>/` is the artifact directory.
    pub fn new(artifact_root: impl Into<PathBuf>) -> Self {
        Self {
            artifact_root: artifact_root.into(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn artifact_dir(&self, deployment_hash: &str) -> PathBuf {
        self.artifact_root.join(deployment_hash)
    }

    /// The deployment's public manifest. An artifact without `public/` (or
    /// with an unreadable manifest) has no static files; the artifact loader
    /// of the cell is what refuses broken artifacts (V12).
    pub async fn manifest(&self, deployment_hash: &str) -> Arc<PublicManifest> {
        if let Some(m) = self.lock().get(deployment_hash) {
            return m.clone();
        }
        // The index lives in `public.json` in version 1 and in
        // `public/manifest.json` in version 0 (`artifact.md` section 4); the
        // version comes from `manifest.json`, read once per hash.
        let dir = self.artifact_dir(deployment_hash);
        let version = match tokio::fs::read_to_string(dir.join("manifest.json")).await {
            Ok(json) => crate::security::DeploymentInfo::parse(&json)
                .map(|i| i.version)
                .unwrap_or(0),
            Err(_) => 0,
        };
        let path = if version >= 1 {
            dir.join("public.json")
        } else {
            dir.join("public").join("manifest.json")
        };
        let manifest = match tokio::fs::read_to_string(&path).await {
            Ok(json) => PublicManifest::parse(&json).unwrap_or_default(),
            Err(_) => PublicManifest::default(),
        };
        let manifest = Arc::new(manifest);
        self.lock()
            .entry(deployment_hash.to_owned())
            .or_insert(manifest)
            .clone()
    }

    /// Forgets a deployment's manifest (after the deployment is evicted).
    pub fn forget(&self, deployment_hash: &str) {
        self.lock().remove(deployment_hash);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<PublicManifest>>> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Serves `url_path` if the deployment's manifest lists it and the method
    /// is `GET` or `HEAD`; `None` means "not a static file" and the request
    /// goes to the cell.
    pub async fn serve(
        &self,
        deployment_hash: &str,
        method: &Method,
        url_path: &str,
        headers: &HeaderMap,
    ) -> Option<Response<Body>> {
        if method != Method::GET && method != Method::HEAD {
            return None;
        }
        let manifest = self.manifest(deployment_hash).await;
        if manifest.is_empty() {
            return None;
        }
        let decoded = percent_encoding::percent_decode_str(url_path)
            .decode_utf8()
            .ok()?;
        let entry = manifest.get(&decoded)?;

        let etag = format!("\"{}\"", entry.sha256);
        let cache_control = if is_hashed_path(&decoded) {
            CACHE_IMMUTABLE
        } else {
            CACHE_REVALIDATE
        };
        let builder = Response::builder()
            .header(header::ETAG, &etag)
            .header(header::CACHE_CONTROL, cache_control)
            .header(header::CONTENT_TYPE, &entry.content_type);

        if if_none_match(headers, &etag) {
            return Some(
                builder
                    .status(StatusCode::NOT_MODIFIED)
                    .body(Body::empty())
                    .expect("valid response"),
            );
        }

        // The key was validated by `is_safe_url_path`, so this join stays
        // inside `public/`.
        let file_path = self
            .artifact_dir(deployment_hash)
            .join("public")
            .join(Path::new(&decoded[1..]));
        let file = match tokio::fs::File::open(&file_path).await {
            Ok(f) => f,
            Err(_) => return Some(internal_error()),
        };
        match file.metadata().await {
            Ok(meta) if meta.is_file() && meta.len() == entry.size => {}
            _ => return Some(internal_error()),
        }
        let builder = builder
            .status(StatusCode::OK)
            .header(header::CONTENT_LENGTH, entry.size);
        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from_stream(ReaderStream::new(file))
        };
        Some(builder.body(body).expect("valid response"))
    }
}

fn if_none_match(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().trim_start_matches("W/"))
        .any(|t| t == etag || t == "*")
}

/// The artifact on disk does not match its manifest. The tenant sees a
/// plain 500; the cause is for the operator.
fn internal_error() -> Response<Body> {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from("Internal error"))
        .expect("valid response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashed_paths() {
        assert!(is_hashed_path("/assets/app.3f2a9c1b.js"));
        assert!(is_hashed_path("/logo-5d41402abc4b2a76.png"));
        assert!(!is_hashed_path("/robots.txt"));
        assert!(!is_hashed_path("/deadbeef12.txt"));
        assert!(!is_hashed_path("/app.abc.js"));
        assert!(!is_hashed_path("/noext"));
    }

    #[test]
    fn manifest_refuses_unsafe_keys() {
        let h = "a".repeat(64);
        for key in ["/../x", "/a/./b", "x", "/a//b", "/a\\b", "/", "/c:d"] {
            let json = format!(
                r#"{{"version":0,"files":{{"{}":{{"sha256":"{h}","size":1,"content_type":"text/plain"}}}}}}"#,
                key.replace('\\', "\\\\")
            );
            assert!(PublicManifest::parse(&json).is_err(), "{key}");
        }
    }
}
