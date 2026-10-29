//! One cell: the isolate of one `(tenant, deployment)` on this node, plus
//! its share of the tenant's database (`docs/17-glossary.md`, "Cell").
//!
//! Lifecycle (README, "Lifecycle"):
//!
//! | State | Meaning |
//! | --- | --- |
//! | starting | Being created: database opened, migrations run, isolate created. Requests for it wait |
//! | ready | Serving |
//! | draining | Its route entry is no longer active: no new route points to it; evicted as soon as its in-flight requests finish |
//! | evicted | Removed from the manager; the isolate is terminated and the tenant's database closed when no other cell uses it |

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use renox_runtime::IsolateHandle;

use crate::pages::PageGuard;
use crate::ratelimit::RouteBuckets;
use crate::render::SharedPages;
use tokio::sync::Notify;

/// The key of a cell.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CellKey {
    pub tenant_id: String,
    pub deployment_hash: String,
}

/// What the cell does around the isolate for one deployment (artifact v1).
pub struct WebLayer {
    /// The deployment's templates; `None` without templates.
    pub(crate) pages: Option<SharedPages>,
    /// Sessions and CSRF for page routes (#41); `None` without page routes.
    pub(crate) guard: Option<PageGuard>,
    /// `security.ratelimit` buckets (#47); `None` without buckets.
    pub(crate) buckets: Option<RouteBuckets>,
    /// The session cookie may be `SameSite=None` (CORS with credentials).
    pub(crate) same_site_none: bool,
}

/// A live cell.
pub struct Cell {
    pub key: CellKey,
    pub(crate) isolate: IsolateHandle,
    /// Pages, sessions, buckets of the deployment.
    pub(crate) web: WebLayer,
    inflight: AtomicUsize,
    last_used: Mutex<Instant>,
    draining: AtomicBool,
    evicted: AtomicBool,
    /// Wakes the eviction task: a request ended, or the cell started draining.
    pub(crate) wake: Notify,
    /// The outbox delivery task (#229); dropped (stopped) at eviction.
    outbox: Mutex<Option<crate::outbox::OutboxWorker>>,
}

impl Cell {
    pub(crate) fn new(key: CellKey, isolate: IsolateHandle, web: WebLayer) -> Cell {
        Cell {
            key,
            isolate,
            web,
            inflight: AtomicUsize::new(0),
            last_used: Mutex::new(Instant::now()),
            draining: AtomicBool::new(false),
            evicted: AtomicBool::new(false),
            wake: Notify::new(),
            outbox: Mutex::new(None),
        }
    }

    /// Attach the cell's outbox worker; it stops when the cell is evicted.
    pub(crate) fn set_outbox(&self, w: crate::outbox::OutboxWorker) {
        *self.outbox.lock().expect("cell lock") = Some(w);
    }

    /// Stop the outbox worker (eviction).
    pub(crate) fn stop_outbox(&self) {
        self.outbox.lock().expect("cell lock").take();
    }

    pub fn inflight(&self) -> usize {
        self.inflight.load(Ordering::SeqCst)
    }

    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }

    pub fn last_used(&self) -> Instant {
        *self.last_used.lock().expect("cell lock")
    }

    /// Admit a request. Called with the manager's map lock held, so it never
    /// races [`Cell::try_mark_evicted`].
    pub(crate) fn try_admit(&self) -> bool {
        if self.evicted.load(Ordering::SeqCst) {
            return false;
        }
        self.inflight.fetch_add(1, Ordering::SeqCst);
        *self.last_used.lock().expect("cell lock") = Instant::now();
        true
    }

    pub(crate) fn finish(&self) {
        *self.last_used.lock().expect("cell lock") = Instant::now();
        let left = self.inflight.fetch_sub(1, Ordering::SeqCst) - 1;
        if left == 0 {
            self.wake.notify_one();
        }
    }

    pub(crate) fn start_draining(&self) {
        if !self.draining.swap(true, Ordering::SeqCst) {
            self.wake.notify_one();
        }
    }

    /// Mark evicted if nothing is in flight and the cell is draining or has
    /// been idle for `idle`. Called with the manager's map lock held.
    pub(crate) fn try_mark_evicted(&self, idle: std::time::Duration) -> bool {
        if self.inflight() > 0 {
            return false;
        }
        if !self.is_draining() && self.last_used().elapsed() < idle {
            return false;
        }
        !self.evicted.swap(true, Ordering::SeqCst)
    }
}

/// Decrements the in-flight count when the request ends.
pub(crate) struct InFlightGuard<'a>(pub &'a Cell);

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.0.finish();
    }
}

/// Why secrets could not be loaded. Never contains a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretsError {
    /// The file is readable by group or others (it must be 0600).
    Permissions(u32),
    Read(String),
    Parse,
    /// The control plane did not deliver the bundle (controlled mode, #55).
    Unavailable(String),
}

/// The deployment a cell is created for, as [`SecretsSource`] sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretsRequest {
    pub tenant_id: String,
    /// The app of the deployment; `None` in local mode, where the route
    /// table file has no app.
    pub app: Option<String>,
    pub deployment_hash: String,
    /// The secret-set version the deployment pins (`deploy-api.md` section 9).
    pub secrets_version: u64,
}

/// What [`SecretsSource::secrets`] returns: the name → value map.
pub type SecretsFuture<'a> =
    Pin<Box<dyn Future<Output = Result<BTreeMap<String, String>, SecretsError>> + Send + 'a>>;

/// Where a cell's secrets come from (#55): `secrets.json` in local mode
/// ([`LocalSecrets`]), the control plane's bundle in controlled mode
/// (`crate::control::secrets`). Called once per cell creation; the values
/// stay in memory and go only into the isolate.
pub trait SecretsSource: Send + Sync + 'static {
    fn secrets(&self, request: SecretsRequest) -> SecretsFuture<'_>;
}

/// `<data_dir>/<tenant_id>/secrets.json` ([`load_secrets`]).
pub struct LocalSecrets {
    pub data_dir: PathBuf,
}

impl SecretsSource for LocalSecrets {
    fn secrets(&self, request: SecretsRequest) -> SecretsFuture<'_> {
        let path = self.data_dir.join(&request.tenant_id).join("secrets.json");
        Box::pin(async move {
            tokio::task::spawn_blocking(move || load_secrets(&path))
                .await
                .map_err(|e| SecretsError::Read(e.to_string()))?
        })
    }
}

impl std::fmt::Display for SecretsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretsError::Permissions(mode) => {
                write!(f, "secrets.json has mode {mode:o}; it must be 0600")
            }
            SecretsError::Read(e) => write!(f, "secrets.json cannot be read: {e}"),
            SecretsError::Parse => f.write_str("secrets.json is not an object of string values"),
            SecretsError::Unavailable(e) => write!(f, "secret bundle unavailable: {e}"),
        }
    }
}

/// `<data_dir>/<tenant_id>/secrets.json`: the F1 stand-in for the control
/// plane's secret delivery. A missing file means no secrets. The file must
/// not be readable by group or others.
pub fn load_secrets(path: &Path) -> Result<BTreeMap<String, String>, SecretsError> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(SecretsError::Read(e.kind().to_string())),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(SecretsError::Permissions(mode));
        }
    }
    #[cfg(not(unix))]
    let _ = meta;
    let text = std::fs::read(path).map_err(|e| SecretsError::Read(e.kind().to_string()))?;
    serde_json::from_slice(&text).map_err(|_| SecretsError::Parse)
}

/// A tenant id is used as a directory name: the route table pattern
/// (`^[a-z0-9][a-z0-9_-]{0,62}$`), checked again here.
pub fn valid_tenant_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tenant_ids_cannot_escape_the_data_dir() {
        assert!(valid_tenant_id("t_hello"));
        for bad in ["", "..", "a/b", "A", "t.x", "-x"] {
            assert!(!valid_tenant_id(bad), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn secrets_file_must_be_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("renox-cell-secrets-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("secrets.json");
        assert_eq!(load_secrets(&p), Ok(BTreeMap::new()));
        std::fs::write(&p, r#"{"STRIPE_KEY":"sk_test_0123456789"}"#).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(load_secrets(&p), Err(SecretsError::Permissions(0o644)));
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            load_secrets(&p).unwrap()["STRIPE_KEY"],
            "sk_test_0123456789"
        );
        std::fs::write(&p, r#"{"A": 1}"#).unwrap();
        assert_eq!(load_secrets(&p), Err(SecretsError::Parse));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
