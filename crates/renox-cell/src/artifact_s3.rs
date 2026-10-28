//! `S3ArtifactStore` (#55): artifacts of a controlled worker come from
//! object storage through the control plane, with a disk cache under
//! `artifacts_dir` (`docs/05-tenant-lifecycle.md`, "Cold start" step 3).
//!
//! `GET /v1/nodes/{node_id}/artifacts/{hash}` answers with a 307 to a
//! presigned S3 GET (the node holds no storage credentials) or with the tar
//! itself. The tar is written to a temporary file, extracted with the upload
//! caps T1–T8 ([`crate::tar_safe`]), and its canonical hash is checked before
//! the directory is renamed to `<artifacts_dir>/<hash>`. A cached directory
//! is verified again by [`LocalArtifactStore`] on first use, like in local
//! mode, so the cache is never trusted blindly.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http::{Method, StatusCode, header};
use http_body_util::BodyExt;

use crate::artifact::{
    ArtifactDir, ArtifactError, ArtifactStore, LocalArtifactStore, canonical_hash,
};
use crate::control::http::{Answer, ControlClient, ControlError};
use crate::tar_safe::{TarCaps, extract};

/// Time for one artifact download, response head to last byte.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// The stored object is the uncompressed tar of at most 100 MiB of files
/// (T2), plus headers and padding.
pub const MAX_TAR_BYTES: u64 = 110 * 1024 * 1024;

static TEMP: AtomicU64 = AtomicU64::new(0);

/// Fetches through the control API, caches on disk.
pub struct S3ArtifactStore {
    dir: PathBuf,
    local: LocalArtifactStore,
    client: ControlClient,
    runtime: tokio::runtime::Handle,
    /// One download per hash at a time.
    fetching: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    downloads: AtomicU64,
}

impl S3ArtifactStore {
    /// Must be called on a Tokio runtime; downloads run on it.
    pub fn new(dir: impl Into<PathBuf>, client: ControlClient) -> S3ArtifactStore {
        let dir = dir.into();
        S3ArtifactStore {
            local: LocalArtifactStore::new(&dir),
            dir,
            client,
            runtime: tokio::runtime::Handle::current(),
            fetching: Mutex::new(HashMap::new()),
            downloads: AtomicU64::new(0),
        }
    }

    /// Artifacts downloaded since start (operator metrics, tests).
    pub fn downloads(&self) -> u64 {
        self.downloads.load(Ordering::Relaxed)
    }

    /// Whether `hash` is in the disk cache (degraded mode, #98).
    pub fn is_cached(&self, hash: &str) -> bool {
        valid_hash(hash) && self.dir.join(hash).is_dir()
    }

    fn download(&self, hash: &str) -> Result<(), ArtifactError> {
        let n = TEMP.fetch_add(1, Ordering::Relaxed);
        let tag = format!(".fetch-{hash}-{}-{n}", std::process::id());
        let tar_path = self.dir.join(format!("{tag}.tar"));
        let tmp_dir = self.dir.join(&tag);
        let result = (|| {
            self.runtime
                .block_on(self.fetch_to(hash, &tar_path))
                .map_err(|e| unavailable(hash, &e))?;
            let file = std::fs::File::open(&tar_path)
                .map_err(|e| fetch_err(format!("temporary tar: {}", e.kind())))?;
            extract(std::io::BufReader::new(file), &tmp_dir, &TarCaps::default()).map_err(|e| {
                ArtifactError::Invalid {
                    rule: "T",
                    reason: e.to_string(),
                }
            })?;
            let actual = canonical_hash(&tmp_dir)?;
            if actual != hash {
                return Err(ArtifactError::HashMismatch {
                    expected: hash.to_string(),
                    actual,
                });
            }
            match std::fs::rename(&tmp_dir, self.dir.join(hash)) {
                Ok(()) => Ok(()),
                // Another process cached it first: same content by hash.
                Err(_) if self.dir.join(hash).is_dir() => Ok(()),
                Err(e) => Err(fetch_err(format!("cache: {}", e.kind()))),
            }
        })();
        let _ = std::fs::remove_file(&tar_path);
        let _ = std::fs::remove_dir_all(&tmp_dir);
        if result.is_ok() {
            self.downloads.fetch_add(1, Ordering::Relaxed);
            tracing::info!(deployment_hash = hash, "artifact fetched");
        }
        result
    }

    async fn fetch_to(&self, hash: &str, dest: &Path) -> Result<(), ControlError> {
        let path = self.client.node_path(&format!("/artifacts/{hash}"));
        let first = self
            .client
            .send(Method::GET, &path, None, &[], DOWNLOAD_TIMEOUT)
            .await?;
        let answer = match first.status {
            StatusCode::OK => first,
            StatusCode::TEMPORARY_REDIRECT => {
                let location = first
                    .headers
                    .get(header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| ControlError::Body("307 without Location".into()))?
                    .to_string();
                let a = self
                    .client
                    .get_external(&location, DOWNLOAD_TIMEOUT)
                    .await?;
                if a.status != StatusCode::OK {
                    return Err(ControlError::Status(a.status.as_u16()));
                }
                a
            }
            s => return Err(ControlError::Status(s.as_u16())),
        };
        tokio::time::timeout(DOWNLOAD_TIMEOUT, write_body(answer, dest))
            .await
            .map_err(|_| ControlError::Unreachable("download timed out".into()))?
    }
}

/// Streams the body into `dest`, at most [`MAX_TAR_BYTES`].
async fn write_body(answer: Answer, dest: &Path) -> Result<(), ControlError> {
    let mut file =
        std::fs::File::create(dest).map_err(|e| ControlError::Body(e.kind().to_string()))?;
    let mut body = answer.body;
    let mut total = 0u64;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| ControlError::Unreachable(e.to_string()))?;
        if let Some(chunk) = frame.data_ref() {
            total += chunk.len() as u64;
            if total > MAX_TAR_BYTES {
                return Err(ControlError::Body(
                    "the artifact is over the size cap".into(),
                ));
            }
            file.write_all(chunk)
                .map_err(|e| ControlError::Body(e.kind().to_string()))?;
        }
    }
    file.sync_all()
        .map_err(|e| ControlError::Body(e.kind().to_string()))
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn fetch_err(reason: String) -> ArtifactError {
    ArtifactError::Invalid {
        rule: "fetch",
        reason,
    }
}

fn unavailable(hash: &str, e: &ControlError) -> ArtifactError {
    match e {
        ControlError::Status(404) => ArtifactError::NotFound(hash.to_string()),
        e => fetch_err(e.to_string()),
    }
}

impl ArtifactStore for S3ArtifactStore {
    fn get(&self, hash: &str) -> Result<ArtifactDir, ArtifactError> {
        if !valid_hash(hash) {
            return Err(ArtifactError::Invalid {
                rule: "V2",
                reason: "a deployment hash is 64 lower-case hex characters".into(),
            });
        }
        if !self.dir.join(hash).is_dir() {
            let lock = self
                .fetching
                .lock()
                .expect("fetch lock")
                .entry(hash.to_string())
                .or_default()
                .clone();
            let _guard = lock.lock().expect("fetch lock");
            if !self.dir.join(hash).is_dir() {
                self.download(hash)?;
            }
        }
        self.local.get(hash)
    }
}
