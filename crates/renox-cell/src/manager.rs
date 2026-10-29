//! `CellManager`: implements the gateway's `CellDispatcher`. Looks up or
//! creates the cell of `(tenant_id, deployment_hash)`, dispatches the request
//! to its isolate, completes the meter record, and evicts idle and draining
//! cells (`docs/05-tenant-lifecycle.md`, "Cold start", "Deployment switch",
//! scale to zero).
//!
//! Streamed bodies (`docs/contracts/ops.md` section 6, #161): the head is
//! answered at once and a task moves the chunks to the connection,
//! compressing each one, and writes the meter record at the end of the
//! stream. A page whose loader is slower than [`SHELL_DELAY`] gets its
//! shell first the same way (section 14, "Streaming the shell").

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use bytes::Bytes;
use http::{Request, Response};
use http_body_util::BodyExt;
use renox_data::{
    DbError, DbOptions, MigrationError, MigrationFile, ModuleMigrations, TenantDb, migrate_all,
    migrate_with_checksums,
};
use renox_gateway::compress::StreamEncoder;
use renox_gateway::{CellDispatcher, RequestCtx, RouteEntry, RouteStatus, compress};
use renox_meter::{Meter, MeterRecord, MeterStatus};
use renox_runtime::error::{ErrorCode, PlatformResponse};
use renox_runtime::isolate::{
    CreateError, Dispatched, InvocationMeter, MeterStatus as RuntimeStatus, ResponseStream,
};
use renox_runtime::limits::Limits;
use renox_runtime::ops::db::DbHandle;
use renox_runtime::{IsolateSpec, Runtime};
use tokio::sync::OnceCell;

use crate::artifact::{ArtifactError, ArtifactStore};
use crate::cell::WebLayer;
use crate::cell::{
    Cell, CellKey, InFlightGuard, SecretsError, SecretsRequest, SecretsSource, valid_tenant_id,
};
use crate::pages::{CSRF_CODE, CSRF_MESSAGE, Gate, PageGuard, PlatformKey, SessionKeys};
use crate::ratelimit::RouteBuckets;
use crate::render::{
    PageRenderer, PageShell, Rendered, from_body_tag, html_response, platform_error, prefers_html,
};
use crate::tiers::{TierName, Tiers};
use renox_gateway::security::{DeploymentInfo, SecurityConfig};

/// What the manager needs from the worker config.
#[derive(Clone)]
pub struct ManagerConfig {
    pub data_dir: PathBuf,
    /// Verified artifacts by hash (#30).
    pub artifacts: Arc<dyn ArtifactStore>,
    pub idle_timeout: Duration,
    pub tiers: Tiers,
    /// Tier, app and secret version of a deployment, consulted at cell
    /// creation (#55): `worker.toml [tenant_tiers]` in local mode, the
    /// route entries from the control plane in controlled mode.
    pub deployments: Arc<dyn DeploymentLookup>,
    /// Where a new cell's secrets come from (#55).
    pub secrets: Arc<dyn SecretsSource>,
    /// The node key page sessions and CSRF tokens are derived from (#41).
    pub platform_key: PlatformKey,
}

/// Isolates per hot deployment (#156; `renox_runtime::isolate`, "Pool"):
/// the free tier gets two, the paid tier one per core up to eight. A
/// deployment grows its pool only while requests wait on a busy isolate,
/// and keeps one spare once it has grown.
fn max_isolates(tier: TierName) -> usize {
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    match tier {
        TierName::Free => cores.clamp(1, 2),
        TierName::Paid => cores.clamp(1, 8),
    }
}

/// `database` is `tenant_id` or `<tenant_id>.<app>` (deploy-api.md 0.3 section 3).
pub fn database_belongs(tenant_id: &str, database: &str) -> bool {
    if database == tenant_id {
        return true;
    }
    match database
        .strip_prefix(tenant_id)
        .and_then(|r| r.strip_prefix('.'))
    {
        Some(app) => {
            !app.is_empty()
                && app.len() <= 50
                && app.as_bytes()[0].is_ascii_lowercase()
                && app
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        }
        None => false,
    }
}

/// What the manager needs to know about a deployment before creating its cell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeploymentMeta {
    pub tier: TierName,
    /// `None` in local mode (the route table file has no app).
    pub app: Option<String>,
    pub secrets_version: u64,
    /// deploy-api.md 0.3 section 3: the tenant file the cells open, when the
    /// app has a database of its own (`<tenant_id>.<app>`); `None` is the
    /// tenant's shared file.
    pub database: Option<String>,
}

/// Looks up [`DeploymentMeta`] of `(tenant_id, deployment_hash)`.
pub trait DeploymentLookup: Send + Sync + 'static {
    fn lookup(&self, tenant_id: &str, deployment_hash: &str) -> DeploymentMeta;
}

/// Local mode: the tier per tenant from `worker.toml`, no app, secret
/// version 0.
pub struct StaticTiers {
    pub default_tier: TierName,
    pub tenant_tiers: BTreeMap<String, TierName>,
}

impl DeploymentLookup for StaticTiers {
    fn lookup(&self, tenant_id: &str, _deployment_hash: &str) -> DeploymentMeta {
        DeploymentMeta {
            tier: self
                .tenant_tiers
                .get(tenant_id)
                .copied()
                .unwrap_or(self.default_tier),
            app: None,
            secrets_version: 0,
            database: None,
        }
    }
}

/// Why a cell could not be created. Messages never contain secret values;
/// they may name files of the node and go to the operator log only.
#[derive(Debug)]
pub enum CellError {
    InvalidTenant,
    Artifact(ArtifactError),
    Db(DbError),
    Migration(MigrationError),
    Secrets(SecretsError),
    Isolate(CreateError),
}

impl CellError {
    /// The platform response code for requests waiting on the cell.
    pub fn code(&self) -> ErrorCode {
        match self {
            CellError::Isolate(e) => e.code(),
            _ => ErrorCode::Internal,
        }
    }
}

impl std::fmt::Display for CellError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CellError::InvalidTenant => f.write_str("invalid tenant id"),
            CellError::Artifact(e) => write!(f, "artifact: {e}"),
            CellError::Db(e) => write!(f, "database: {e}"),
            CellError::Migration(e) => write!(f, "migrations: {e:?}"),
            CellError::Secrets(e) => write!(f, "secrets: {e}"),
            CellError::Isolate(e) => write!(f, "isolate: {e}"),
        }
    }
}

type Slot = Arc<OnceCell<Arc<Cell>>>;

/// The tenant's database, shared by its cells (one file, one writer).
#[derive(Default)]
struct DbSlot {
    handle: Option<DbHandle>,
    cells: usize,
}

struct Inner {
    runtime: Runtime,
    meter: Meter,
    config: ManagerConfig,
    cells: Mutex<HashMap<CellKey, Slot>>,
    dbs: Mutex<HashMap<String, Arc<tokio::sync::Mutex<DbSlot>>>>,
    /// Cells created and evicted since start (operator metrics, tests).
    created: std::sync::atomic::AtomicU64,
    evicted: std::sync::atomic::AtomicU64,
    /// Outbox delivery settings for new cells (#229).
    outbox: Mutex<crate::outbox::OutboxConfig>,
    /// The worker's `[authz]` (#279): dev mode and the principal cache TTL.
    authz: Mutex<crate::authz::AuthzConfig>,
    /// The worker's `[realtime]` caps (#281).
    realtime: Mutex<crate::config::RealtimeSection>,
    /// A trim is scheduled after the current burst of evictions (#144).
    trim_scheduled: std::sync::atomic::AtomicBool,
    /// Allocator trims run since start (operator metrics, tests).
    trims: std::sync::atomic::AtomicU64,
    /// Idle timeout in microseconds that replaces the configured one
    /// (`u64::MAX`: none). Tests keep a long timeout and force eviction
    /// instead of racing a short one (#182).
    #[cfg(feature = "test-support")]
    idle_override_us: std::sync::atomic::AtomicU64,
    /// Told about every route sync (#254: the supervisor places tenants
    /// in children from the same entries).
    sync_observer: std::sync::OnceLock<SyncObserver>,
    db_lifecycle: std::sync::OnceLock<Arc<dyn DbLifecycle>>,
    /// The database key (tenant id or `<tenant_id>.<app>`) of each cell.
    db_keys: Mutex<HashMap<CellKey, String>>,
    /// Tenants being moved to a microVM (#259): their requests answer 503.
    moving: Mutex<HashSet<String>>,
}

/// Called with the entries of every [`CellManager::sync_routes`].
pub type SyncObserver = Arc<dyn Fn(&[RouteEntry]) + Send + Sync>;

/// What happens around a tenant file's life in this process (#255: the
/// Litestream sidecar, `crate::replication`).
pub trait DbLifecycle: Send + Sync + 'static {
    /// Before the file is opened, on the database thread (blocking is fine):
    /// restore a missing or corrupt file. An error refuses the open.
    fn before_open(&self, tenant_id: &str, file: &Path) -> Result<(), String>;
    /// The file is open (the first cell of the tenant).
    fn opened(&self, tenant_id: &str, file: &Path);
    /// The last cell closed the file (eviction).
    fn closed(&self, tenant_id: &str);
}

/// Quiet time after the last eviction before freed memory is trimmed: one
/// trim per burst of evictions, after the isolates are disposed.
const TRIM_AFTER: Duration = Duration::from_secs(2);

/// Further trims after the first one (delays from the previous trim).
const TRIM_FOLLOW_UPS: [Duration; 2] = [Duration::from_secs(10), Duration::from_secs(20)];

/// The cells of this node. Cheap to clone.
#[derive(Clone)]
pub struct CellManager {
    inner: Arc<Inner>,
}

impl CellManager {
    pub fn new(runtime: Runtime, meter: Meter, config: ManagerConfig) -> CellManager {
        CellManager {
            inner: Arc::new(Inner {
                runtime,
                meter,
                config,
                cells: Mutex::new(HashMap::new()),
                dbs: Mutex::new(HashMap::new()),
                created: Default::default(),
                evicted: Default::default(),
                outbox: Mutex::new(crate::outbox::OutboxConfig::default()),
                authz: Mutex::new(crate::authz::AuthzConfig::default()),
                realtime: Mutex::new(crate::config::RealtimeSection::default()),
                trim_scheduled: Default::default(),
                trims: Default::default(),
                #[cfg(feature = "test-support")]
                idle_override_us: std::sync::atomic::AtomicU64::new(u64::MAX),
                sync_observer: std::sync::OnceLock::new(),
                db_lifecycle: std::sync::OnceLock::new(),
                db_keys: Mutex::new(HashMap::new()),
                moving: Mutex::new(HashSet::new()),
            }),
        }
    }

    /// The idle timeout in force.
    fn idle_timeout(&self) -> Duration {
        #[cfg(feature = "test-support")]
        {
            let us = self
                .inner
                .idle_override_us
                .load(std::sync::atomic::Ordering::SeqCst);
            if us != u64::MAX {
                return Duration::from_micros(us);
            }
        }
        self.inner.config.idle_timeout
    }

    /// Test hook: treat every cell as idle for `idle` from now on and wake
    /// the eviction tasks, so idle cells go now. `None` restores the
    /// configured timeout.
    #[cfg(feature = "test-support")]
    pub fn set_idle_timeout_for_tests(&self, idle: Option<Duration>) {
        let us = idle.map_or(u64::MAX, |d| d.as_micros().min(u64::MAX as u128 - 1) as u64);
        self.inner
            .idle_override_us
            .store(us, std::sync::atomic::Ordering::SeqCst);
        let cells = self.inner.cells.lock().expect("cells lock");
        for slot in cells.values() {
            if let Some(cell) = slot.get() {
                cell.wake.notify_one();
            }
        }
    }

    /// Test hook: requests in flight across all cells.
    #[cfg(feature = "test-support")]
    pub fn inflight_for_tests(&self) -> usize {
        let cells = self.inner.cells.lock().expect("cells lock");
        cells
            .values()
            .filter_map(|s| s.get())
            .map(|c| c.inflight())
            .sum()
    }

    /// Outbox delivery settings for cells created from now on (retries,
    /// backoff, dead-letter cap; ops.md 1.3.0 section 15.4).
    /// Dev mode and the principal cache TTL of cells created from now on.
    /// The worker's `[realtime]` (#281), for cells created from now on.
    pub fn set_realtime_config(&self, config: crate::config::RealtimeSection) {
        *self.inner.realtime.lock().expect("realtime lock") = config;
    }

    pub fn set_authz_config(&self, config: crate::authz::AuthzConfig) {
        *self.inner.authz.lock().expect("authz lock") = config;
    }

    pub fn set_outbox_config(&self, config: crate::outbox::OutboxConfig) {
        *self.inner.outbox.lock().expect("outbox lock") = config;
    }

    /// Pending deliveries and dead letters of a tenant whose database is
    /// open on this node (the per-tenant gauge of #229); `None` otherwise.
    pub async fn outbox_stats(&self, tenant_id: &str) -> Option<renox_data::OutboxStats> {
        let slot = self
            .inner
            .dbs
            .lock()
            .expect("dbs lock")
            .get(tenant_id)
            .cloned()?;
        let handle = slot.lock().await.handle.clone()?;
        handle.call(renox_data::outbox::stats).await.ok()?.ok()
    }

    /// Statement counters of a tenant's open database (tests: the outbox
    /// worker does not poll an idle tenant).
    pub async fn db_stats(&self, tenant_id: &str) -> Option<renox_data::DbStats> {
        let slot = self
            .inner
            .dbs
            .lock()
            .expect("dbs lock")
            .get(tenant_id)
            .cloned()?;
        let handle = slot.lock().await.handle.clone()?;
        handle.call(|db| db.stats()).await.ok()
    }

    /// Admit an outbox delivery on `cell` under the map lock, like a request
    /// (`admit`): a cell is never evicted while a delivery is in flight.
    fn admit_delivery(&self, cell: &Arc<Cell>) -> bool {
        let cells = self.inner.cells.lock().expect("cells lock");
        let current = cells
            .get(&cell.key)
            .and_then(|s| s.get())
            .is_some_and(|c| Arc::ptr_eq(c, cell));
        current && cell.try_admit()
    }

    pub fn runtime(&self) -> &Runtime {
        &self.inner.runtime
    }

    /// The configuration the manager was built with (#254: the supervisor
    /// hands the same deployment metadata, secrets and artifacts to the
    /// children).
    pub fn config(&self) -> &ManagerConfig {
        &self.inner.config
    }

    /// The tenant-file lifecycle hooks, when set (#255).
    pub fn db_lifecycle(&self) -> Option<Arc<dyn DbLifecycle>> {
        self.inner.db_lifecycle.get().cloned()
    }

    /// Registers the tenant-file lifecycle hooks (once, before any cell).
    pub fn set_db_lifecycle(&self, hooks: Arc<dyn DbLifecycle>) {
        let _ = self.inner.db_lifecycle.set(hooks);
    }

    /// Registers the observer of [`Self::sync_routes`] (once).
    pub fn set_sync_observer(&self, observer: SyncObserver) {
        let _ = self.inner.sync_observer.set(observer);
    }

    /// Marks `tenant_id` as moving (#259); false when it already was.
    pub fn start_moving(&self, tenant_id: &str) -> bool {
        self.inner
            .moving
            .lock()
            .expect("moving lock")
            .insert(tenant_id.to_string())
    }

    /// Ends the move of `tenant_id`: it serves here again.
    pub fn stop_moving(&self, tenant_id: &str) {
        self.inner
            .moving
            .lock()
            .expect("moving lock")
            .remove(tenant_id);
    }

    /// Requests to a moving tenant answer 503 `RENOX_TENANT_MOVING`.
    pub fn is_moving(&self, tenant_id: &str) -> bool {
        self.inner
            .moving
            .lock()
            .expect("moving lock")
            .contains(tenant_id)
    }

    /// The tenant's file is open in this process.
    pub fn db_open(&self, tenant_id: &str) -> bool {
        self.inner
            .dbs
            .lock()
            .expect("dbs lock")
            .get(tenant_id)
            .is_some_and(|s| s.try_lock().map_or(true, |g| g.handle.is_some()))
    }

    /// Drain every cell that opens the database `db_key` (#258: an import
    /// swaps a staging app's file).
    pub fn drain_database(&self, db_key: &str) -> usize {
        let keys: Vec<CellKey> = self
            .inner
            .db_keys
            .lock()
            .expect("db keys lock")
            .iter()
            .filter(|(_, d)| d.as_str() == db_key)
            .map(|(k, _)| k.clone())
            .collect();
        let cells = self.inner.cells.lock().expect("cells lock");
        let mut n = 0;
        for k in keys {
            if let Some(cell) = cells.get(&k).and_then(|s| s.get()) {
                cell.start_draining();
                n += 1;
            }
        }
        n
    }

    /// Drain every cell of `tenant_id` (#254: the tenant moved to a child
    /// process of its own).
    pub fn drain_tenant(&self, tenant_id: &str) -> usize {
        let cells = self.inner.cells.lock().expect("cells lock");
        let mut n = 0;
        for (key, slot) in cells.iter() {
            if key.tenant_id == tenant_id
                && let Some(cell) = slot.get()
            {
                tracing::info!(tenant_id, deployment_hash = %key.deployment_hash, "cell draining: tenant moved to a child process");
                cell.start_draining();
                n += 1;
            }
        }
        n
    }

    pub fn meter(&self) -> &Meter {
        &self.inner.meter
    }

    /// Live cells (each holds one isolate).
    pub fn cell_count(&self) -> usize {
        self.inner
            .cells
            .lock()
            .expect("cells lock")
            .values()
            .filter(|s| s.initialized())
            .count()
    }

    /// Keys of the live cells.
    pub fn cells(&self) -> Vec<CellKey> {
        let mut keys: Vec<CellKey> = self
            .inner
            .cells
            .lock()
            .expect("cells lock")
            .iter()
            .filter(|(_, s)| s.initialized())
            .map(|(k, _)| k.clone())
            .collect();
        keys.sort();
        keys
    }

    /// Tenants whose database is open (a slot being opened or closed
    /// counts as open).
    pub fn open_databases(&self) -> usize {
        self.inner
            .dbs
            .lock()
            .expect("dbs lock")
            .values()
            .filter(|s| s.try_lock().map_or(true, |g| g.handle.is_some()))
            .count()
    }

    pub fn cells_created(&self) -> u64 {
        self.inner
            .created
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Principal cache and decision counters of the live cells (#279).
    pub fn authz_stats(&self) -> crate::authz::AuthzStats {
        let mut stats = crate::authz::AuthzStats::default();
        let cells = self.inner.cells.lock().expect("cells lock");
        for cell in cells.values().filter_map(|slot| slot.get()) {
            stats.add(&cell.isolate.authz_slot());
        }
        stats
    }

    pub fn cells_evicted(&self) -> u64 {
        self.inner
            .evicted
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Mark every cell whose `(tenant, hash)` has no active route entry as
    /// draining: it is evicted as soon as its in-flight requests finish
    /// (`docs/05-tenant-lifecycle.md`, "Deployment switch"). Called after
    /// each route table reload.
    pub fn sync_routes(&self, entries: &[RouteEntry]) {
        let active: HashSet<(String, String)> = entries
            .iter()
            .filter(|e| e.status == RouteStatus::Active)
            .map(|e| (e.tenant_id.clone(), e.deployment_hash.clone()))
            .collect();
        {
            let cells = self.inner.cells.lock().expect("cells lock");
            for (key, slot) in cells.iter() {
                if !active.contains(&(key.tenant_id.clone(), key.deployment_hash.clone()))
                    && let Some(cell) = slot.get()
                {
                    tracing::info!(tenant_id = %key.tenant_id, deployment_hash = %key.deployment_hash, "cell draining");
                    cell.start_draining();
                }
            }
        }
        if let Some(observer) = self.inner.sync_observer.get() {
            observer(entries);
        }
    }

    /// Admit a request to the cell of `key`, creating the cell if needed. A
    /// request arriving while the cell is being evicted waits for a fresh one.
    async fn admit(&self, key: &CellKey) -> Result<Arc<Cell>, CellError> {
        loop {
            let slot = {
                let mut cells = self.inner.cells.lock().expect("cells lock");
                cells.entry(key.clone()).or_default().clone()
            };
            let cell = slot
                .get_or_try_init(|| self.create(key.clone()))
                .await?
                .clone();
            let cells = self.inner.cells.lock().expect("cells lock");
            let current = cells.get(key).is_some_and(|s| Arc::ptr_eq(s, &slot));
            if current && cell.try_admit() {
                return Ok(cell);
            }
        }
    }

    async fn create(&self, key: CellKey) -> Result<Arc<Cell>, CellError> {
        if !valid_tenant_id(&key.tenant_id) {
            return Err(CellError::InvalidTenant);
        }
        let started = Instant::now();
        let meta = self
            .inner
            .config
            .deployments
            .lookup(&key.tenant_id, &key.deployment_hash);
        let tier_name = meta.tier;
        let tier = *self.inner.config.tiers.get(tier_name);
        // A database of the app's own, only ever one of this tenant's.
        let db_key = meta
            .database
            .clone()
            .filter(|d| database_belongs(&key.tenant_id, d))
            .unwrap_or_else(|| key.tenant_id.clone());
        // #157: the tenant file opens on its DB thread while the artifact is
        // verified and the isolate is created; migrations run alongside the
        // isolate's creation. Tenant code cannot reach the DB before the
        // cell is ready: module evaluation runs outside any request, where
        // `ctx.db` rejects with `RENOX_NO_REQUEST` (ops.md section 11).
        let db = self.acquire_db(&db_key, tier.db_quota_bytes).await?;
        self.inner
            .db_keys
            .lock()
            .expect("db keys lock")
            .insert(key.clone(), db_key.clone());
        let store = self.inner.config.artifacts.clone();
        let hash = key.deployment_hash.clone();
        let verified = tokio::task::spawn_blocking(move || store.get(&hash))
            .await
            .map_err(|e| {
                CellError::Artifact(ArtifactError::Invalid {
                    rule: "V2",
                    reason: format!("verification task failed: {e}"),
                })
            })
            .and_then(|r| r.map_err(CellError::Artifact));
        let artifact_dir = match verified {
            Ok(a) => a.path,
            Err(e) => {
                self.inner
                    .db_keys
                    .lock()
                    .expect("db keys lock")
                    .remove(&key);
                self.release_db(&db_key).await;
                return Err(e);
            }
        };
        let artifact_ms = started.elapsed().as_millis() as u64;
        let mut db_ms = 0;
        let mut migrate_ms = 0;
        let result = async {
            let secrets = self
                .inner
                .config
                .secrets
                .secrets(SecretsRequest {
                    tenant_id: key.tenant_id.clone(),
                    app: meta.app.clone(),
                    deployment_hash: key.deployment_hash.clone(),
                    secrets_version: meta.secrets_version,
                })
                .await
                .map_err(CellError::Secrets)?;
            let base = match tier_name {
                TierName::Free => Limits::FREE,
                TierName::Paid => Limits::PAID,
            };
            let spec = IsolateSpec {
                tenant_id: key.tenant_id.clone(),
                deployment_hash: key.deployment_hash.clone(),
                artifact_dir: artifact_dir.clone(),
                limits: tier.runtime_limits(base),
                secrets,
                db: Some(db.clone()),
                max_isolates: max_isolates(tier_name),
            };
            let prepare_db = async {
                db.ready().await.map_err(CellError::Db)?;
                let opened = started.elapsed().as_millis() as u64;
                let t = Instant::now();
                run_migrations(&db, &artifact_dir).await?;
                Ok::<_, CellError>((opened, t.elapsed().as_millis() as u64))
            };
            let (prepared, created) =
                tokio::join!(prepare_db, self.inner.runtime.create_isolate(spec));
            match (prepared, created) {
                (Ok((opened, migrated)), Ok(isolate)) => {
                    db_ms = opened.saturating_sub(artifact_ms);
                    migrate_ms = migrated;
                    // ops.md 1.5.0 section 17: the policies are loaded (V24
                    // at load) once the tables exist, before any request.
                    let config = *self.inner.authz.lock().expect("authz lock");
                    match crate::authz::build(&artifact_dir, &db, config).await {
                        Ok(state) => {
                            *isolate.authz_slot().write().expect("authz slot") = Some(state);
                            Ok(isolate)
                        }
                        Err(reason) => {
                            isolate.terminate();
                            Err(CellError::Artifact(ArtifactError::Invalid {
                                rule: "V24",
                                reason,
                            }))
                        }
                    }
                }
                (Err(e), Ok(isolate)) => {
                    isolate.terminate();
                    Err(e)
                }
                (Err(e), Err(_)) => Err(e),
                (Ok(_), Err(e)) => Err(CellError::Isolate(e)),
            }
        }
        .await;
        let isolate = match result {
            Ok(i) => i,
            Err(e) => {
                self.inner
                    .db_keys
                    .lock()
                    .expect("db keys lock")
                    .remove(&key);
                self.release_db(&db_key).await;
                return Err(e);
            }
        };
        let keys = SessionKeys::new(self.inner.config.platform_key.tenant_key(&key.tenant_id));
        let web = match load_pages(
            &artifact_dir,
            &key.deployment_hash,
            keys,
            isolate.authz_slot(),
        )
        .await
        {
            Ok(p) => p,
            Err(e) => {
                isolate.terminate();
                self.inner
                    .db_keys
                    .lock()
                    .expect("db keys lock")
                    .remove(&key);
                self.release_db(&db_key).await;
                return Err(e);
            }
        };
        let stats = isolate.stats();
        // #281: one hub per cell, sized by the tier; the isolate reaches it
        // through its realtime slot.
        let host = crate::realtime::CellRealtime::new(
            renox_realtime::Hub::new(
                self.inner
                    .realtime
                    .lock()
                    .expect("realtime lock")
                    .limits(tier_name == TierName::Paid),
            ),
            web.pages.clone(),
        );
        *isolate.realtime_slot().write().expect("realtime slot") = Some(host.clone());
        let mut cell = Cell::new(key.clone(), isolate, web);
        cell.realtime = Some(host);
        let cell = Arc::new(cell);
        self.inner
            .created
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        tracing::info!(
            tenant_id = %key.tenant_id,
            deployment_hash = %key.deployment_hash,
            tier = ?tier_name,
            create_ms = started.elapsed().as_millis() as u64,
            artifact_ms,
            db_ms,
            migrate_ms,
            isolate_ms = stats.map(|s| s.create_time.as_millis() as u64),
            module_ms = stats.map(|s| s.module_time.as_millis() as u64),
            "cell ready"
        );
        self.spawn_eviction(cell.clone());
        let this = self.clone();
        cell.set_outbox(crate::outbox::spawn(crate::outbox::Delivery {
            cell: Arc::downgrade(&cell),
            db,
            meter: self.inner.meter.clone(),
            config: *self.inner.outbox.lock().expect("outbox lock"),
            admit: Box::new(move |c| this.admit_delivery(c)),
        }));
        Ok(cell)
    }

    fn tenant_dir(&self, tenant_id: &str) -> PathBuf {
        self.inner.config.data_dir.join(tenant_id)
    }

    /// Start opening the tenant's file (first cell) or share its handle.
    async fn acquire_db(&self, tenant_id: &str, quota: u64) -> Result<DbHandle, CellError> {
        let slot = self
            .inner
            .dbs
            .lock()
            .expect("dbs lock")
            .entry(tenant_id.to_string())
            .or_default()
            .clone();
        let mut slot = slot.lock().await;
        if let Some(h) = slot.handle.clone() {
            slot.cells += 1;
            return Ok(h);
        }
        let dir = self.tenant_dir(tenant_id);
        let hooks = self.inner.db_lifecycle.get().cloned();
        let tenant = tenant_id.to_string();
        // The open runs on the DB thread; the handle is usable at once and
        // `DbHandle::ready` reports an open failure (#157).
        let handle = DbHandle::open_in_background(move || {
            std::fs::create_dir_all(&dir).map_err(|e| DbError::Open(e.kind().to_string()))?;
            let file = dir.join("app.db");
            if let Some(h) = &hooks {
                h.before_open(&tenant, &file).map_err(DbError::Open)?;
            }
            let options = DbOptions {
                module_prefix: Some("app".into()),
                ..DbOptions::with_quota_bytes(quota)
            };
            let db = TenantDb::open(&file, options)?;
            if let Some(h) = &hooks {
                h.opened(&tenant, &file);
            }
            Ok(db)
        })
        .map_err(|e| CellError::Db(DbError::Open(e.kind().to_string())))?;
        slot.handle = Some(handle.clone());
        slot.cells = 1;
        Ok(handle)
    }

    /// The last cell of the tenant closes its file (WAL truncated).
    async fn release_db(&self, tenant_id: &str) {
        let Some(slot) = self
            .inner
            .dbs
            .lock()
            .expect("dbs lock")
            .get(tenant_id)
            .cloned()
        else {
            return;
        };
        let mut guard = slot.lock().await;
        guard.cells = guard.cells.saturating_sub(1);
        if guard.cells > 0 {
            return;
        }
        if let Some(h) = guard.handle.take() {
            // `TenantDb::close` checkpoints with the platform policy (#147).
            if let Err(e) = h.close().await {
                tracing::error!(tenant_id, error = %e, "closing the tenant database failed")
            }
            if let Some(hooks) = self.inner.db_lifecycle.get() {
                hooks.closed(tenant_id);
            }
        }
    }

    /// One task per cell: evict after `idle_timeout` without a request, or
    /// as soon as a draining cell has nothing in flight.
    fn spawn_eviction(&self, cell: Arc<Cell>) {
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                let idle = this.idle_timeout();
                let due = cell.last_used() + idle;
                if !cell.is_draining() {
                    tokio::select! {
                        _ = tokio::time::sleep_until(due.into()) => {}
                        _ = cell.wake.notified() => {}
                    }
                } else if cell.inflight() > 0 {
                    cell.wake.notified().await;
                }
                let evicted = {
                    let mut cells = this.inner.cells.lock().expect("cells lock");
                    let mine = cells
                        .get(&cell.key)
                        .and_then(|s| s.get())
                        .is_some_and(|c| Arc::ptr_eq(c, &cell));
                    if mine && cell.try_mark_evicted(idle) {
                        cells.remove(&cell.key);
                        true
                    } else {
                        false
                    }
                };
                if evicted {
                    this.finish_eviction(cell).await;
                    return;
                }
            }
        });
    }

    async fn finish_eviction(&self, cell: Arc<Cell>) {
        tracing::info!(
            tenant_id = %cell.key.tenant_id,
            deployment_hash = %cell.key.deployment_hash,
            draining = cell.is_draining(),
            "cell evicted"
        );
        cell.stop_outbox();
        cell.isolate.terminate();
        let db_key = self
            .inner
            .db_keys
            .lock()
            .expect("db keys lock")
            .remove(&cell.key)
            .unwrap_or_else(|| cell.key.tenant_id.clone());
        drop(cell);
        self.release_db(&db_key).await;
        self.inner
            .evicted
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.schedule_trim();
    }

    /// Allocator trims run since start.
    pub fn allocator_trims(&self) -> u64 {
        self.inner.trims.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Trim the allocator once no cell was evicted for [`TRIM_AFTER`], and
    /// again after each of [`TRIM_FOLLOW_UPS`]: an evicted cell's memory is
    /// freed in stages (isolate disposal, exiting threads and their caches,
    /// idle blocking-pool threads after 10 s), and only memory already free
    /// can be trimmed. A new eviction starts the sequence over.
    fn schedule_trim(&self) {
        use std::sync::atomic::Ordering;
        if self.inner.trim_scheduled.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = self.clone();
        tokio::spawn(async move {
            'burst: loop {
                let mut seen = this.inner.evicted.load(Ordering::Acquire);
                loop {
                    tokio::time::sleep(TRIM_AFTER).await;
                    let now = this.inner.evicted.load(Ordering::Acquire);
                    if now == seen {
                        break;
                    }
                    seen = now;
                }
                for (i, wait) in std::iter::once(Duration::ZERO)
                    .chain(TRIM_FOLLOW_UPS)
                    .enumerate()
                {
                    tokio::time::sleep(wait).await;
                    if this.inner.evicted.load(Ordering::Acquire) != seen {
                        continue 'burst;
                    }
                    if i == TRIM_FOLLOW_UPS.len() {
                        // The last trim: a later eviction schedules anew.
                        this.inner.trim_scheduled.store(false, Ordering::Release);
                    }
                    let started = Instant::now();
                    if tokio::task::spawn_blocking(crate::alloc::trim)
                        .await
                        .is_ok()
                    {
                        this.inner.trims.fetch_add(1, Ordering::Relaxed);
                        tracing::debug!(
                            ms = started.elapsed().as_millis() as u64,
                            "allocator trimmed"
                        );
                    }
                }
                return;
            }
        });
    }

    async fn handle(&self, ctx: RequestCtx, req: Request<Body>) -> Response<Body> {
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let t0 = Instant::now();
        let key = CellKey {
            tenant_id: ctx.tenant_id.clone(),
            deployment_hash: ctx.deployment_hash.clone(),
        };
        let cell = match self.admit(&key).await {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(
                    tenant_id = %key.tenant_id,
                    deployment_hash = %key.deployment_hash,
                    request_id = %ctx.request_id,
                    error = %e,
                    "cell creation failed"
                );
                return to_body(PlatformResponse::error(e.code(), &ctx.request_id));
            }
        };
        let _guard = InFlightGuard(&cell);
        let (mut parts, body) = req.into_parts();
        // #285: the App MCP endpoint and its metadata, on every app.
        if crate::mcp::handles(parts.uri.path()) {
            // The gateway has applied its body limit already.
            let body = body
                .collect()
                .await
                .map(|b| b.to_bytes())
                .unwrap_or_default();
            return to_body(crate::mcp::serve(self, &cell, ctx, &parts, body).await);
        }
        // #281: `ws` and `sse` routes are served by the realtime layer.
        if let Some(route) = cell.isolate.realtime_route(parts.uri.path()) {
            let session = cell
                .web
                .guard
                .as_ref()
                .and_then(|g| g.session_of(&parts.headers))
                .unwrap_or_default();
            return crate::realtime::serve(self, cell.clone(), ctx, parts, route, session).await;
        }
        let is_head = parts.method == http::Method::HEAD;
        let get_or_head = is_head || parts.method == http::Method::GET;
        let wants_html = prefers_html(&parts.headers);
        let encoding = compress::negotiate(&parts.headers);
        let body = match body.collect().await {
            Ok(b) => b.to_bytes(),
            Err(_) => Bytes::new(),
        };
        let ingress = body.len() as u64;
        // Per-route buckets (#47), after route matching: no tenant code, no
        // meter record, like the gateway's own 429.
        if let Some(buckets) = &cell.web.buckets
            && let Some(retry) =
                buckets.check(parts.method.as_str(), parts.uri.path(), ctx.client_ip)
        {
            return Response::builder()
                .status(http::StatusCode::TOO_MANY_REQUESTS)
                .header(http::header::RETRY_AFTER, retry)
                .body(Body::empty())
                .expect("valid response");
        }
        let nonce = Some(ctx.csp_nonce.clone()).filter(|n| !n.is_empty());
        // Pages (#41): session, CSRF, platform cookies and header removed.
        let mut csrf_token = None;
        let mut set_cookie = Vec::new();
        match cell.web.guard.as_ref().map(|g| {
            g.check(
                parts.method.as_str(),
                parts.uri.path(),
                parts.uri.query(),
                &mut parts.headers,
                &body,
                cell.web.same_site_none,
            )
        }) {
            Some(Gate::Refused {
                route,
                action,
                reason,
            }) => {
                let mut f = serde_json::Map::new();
                f.insert("code".into(), CSRF_CODE.into());
                f.insert("route".into(), route.into());
                f.insert("action".into(), action.into());
                f.insert("reason".into(), reason.into());
                cell.isolate
                    .log("warn", Some(&ctx.request_id), "csrf check failed", f);
                // 403 with the error page; no tenant code ran, no meter record.
                let response = match cell.web.pages.clone() {
                    Some(pages) => {
                        let request_id = ctx.request_id.clone();
                        let nonce = nonce.clone();
                        on_render_pool(move || {
                            pages.error_page(
                                403,
                                Some(CSRF_CODE),
                                CSRF_MESSAGE,
                                &request_id,
                                nonce.as_deref(),
                            )
                        })
                        .await
                        .response
                    }
                    None => crate::render::default_page(403, CSRF_MESSAGE, &ctx.request_id),
                };
                return to_body(response);
            }
            Some(Gate::Page {
                session,
                csrf_token: token,
                set_cookie: cookies,
            }) => {
                parts.extensions.insert(session);
                csrf_token = Some(token);
                set_cookie = cookies;
            }
            Some(Gate::Pass) => {}
            None => {
                parts.headers.remove(crate::pages::session::CSRF_HEADER);
            }
        }
        let rt_ctx = renox_runtime::RequestCtx {
            request_id: ctx.request_id.clone(),
            deadline: ctx.deadline,
        };
        let rc = RecordCtx {
            request_id: ctx.request_id.clone(),
            tenant_id: ctx.tenant_id.clone(),
            deployment_hash: ctx.deployment_hash.clone(),
            started_at,
            t0,
            ingress,
        };
        // ops.md section 14, "Streaming the shell": only a full-page GET of
        // a page with `load` and a template can get its shell first.
        let shell_template = cell
            .web
            .pages
            .as_ref()
            .and_then(|_| cell.isolate.shell_template(&parts));
        let dispatching = cell.clone();
        let mut dispatch: DispatchFuture = Box::pin(async move {
            dispatching
                .isolate
                .dispatch(rt_ctx, Request::from_parts(parts, body))
                .await
        });
        let mut out = match (shell_template, cell.web.pages.clone()) {
            (Some(template), Some(pages)) => {
                tokio::select! {
                    out = &mut dispatch => out,
                    _ = tokio::time::sleep(SHELL_DELAY) => {
                        let request_id = ctx.request_id.clone();
                        let (probe_nonce, token) = (nonce.clone(), csrf_token.clone());
                        let probe = pages.clone();
                        let shell = tokio::task::spawn_blocking(move || {
                            probe.shell_of(&template, &request_id, probe_nonce.as_deref(), token.as_deref())
                        })
                        .await
                        .ok()
                        .flatten();
                        match shell {
                            Some(shell) => {
                                let sent = ShellSent {
                                    shell,
                                    pages,
                                    nonce: nonce.clone(),
                                    csrf_token: csrf_token.clone(),
                                };
                                return self.stream_shell(&cell, dispatch, sent, rc, encoding, set_cookie);
                            }
                            None => dispatch.await,
                        }
                    }
                }
            }
            _ => dispatch.await,
        };
        // Pages (ops.md section 14): render off the isolate thread; platform
        // errors on page routes and HTML 404s get the error pages
        // (errors.md section 1).
        let mut rendered: Option<Rendered> = None;
        if let Some(pages) = cell.web.pages.clone() {
            let request_id = ctx.request_id.clone();
            if let Some(page) = out.render.take() {
                let token = csrf_token.clone();
                let nonce = nonce.clone();
                rendered = Some(
                    on_render_pool(move || {
                        pages.render_page(
                            &page,
                            &request_id,
                            nonce.as_deref(),
                            token.as_deref(),
                            is_head,
                            None,
                        )
                    })
                    .await,
                );
            } else if out.page
                && out.meter.status != RuntimeStatus::Ok
                && let Some((status, code, message)) = platform_error(&out.response)
            {
                let nonce = nonce.clone();
                rendered = Some(
                    on_render_pool(move || {
                        pages.error_page(
                            status,
                            Some(&code),
                            &message,
                            &request_id,
                            nonce.as_deref(),
                        )
                    })
                    .await,
                );
            } else if out.meter.route.is_none()
                && out.response.status() == http::StatusCode::NOT_FOUND
                && get_or_head
                && wants_html
            {
                let nonce = nonce.clone();
                rendered = Some(
                    on_render_pool(move || pages.not_found_page(&request_id, nonce.as_deref()))
                        .await,
                );
            }
        } else if out.render.is_some() {
            // A page result without templates cannot happen after V15; fail
            // closed with the default page.
            out.response = crate::render::default_page(
                500,
                "Internal error. Quote the request id when reporting it.",
                &ctx.request_id,
            );
            out.meter.status = RuntimeStatus::Error;
        }
        let (mut render_fuel, mut render_ms, mut render_limit) = (0, None, false);
        let mut render_evals = 0;
        if let Some(r) = rendered {
            log_authz_warnings(&cell.isolate, &ctx.request_id, &r.authz_warnings);
            render_evals = r.authz_evals;
            if let Some((message, fields)) = &r.log {
                cell.isolate
                    .log("error", Some(&ctx.request_id), message, fields.clone());
            }
            log_i18n_missing(&cell.isolate, &ctx.request_id, &r.i18n_missing);
            render_fuel = r.fuel;
            render_ms = r.ms;
            render_limit = r.limit;
            if r.response.status().is_server_error() && out.meter.status == RuntimeStatus::Ok {
                out.meter.status = RuntimeStatus::Error;
            }
            out.response = r.response;
        }
        if out.page {
            for c in &set_cookie {
                if let Ok(v) = http::HeaderValue::from_str(c) {
                    out.response
                        .headers_mut()
                        .append(http::header::SET_COOKIE, v);
                }
            }
        }
        if let Some(stream) = out.body.take() {
            // ops.md section 6: the head now, the body from the stream.
            let encoder = compress::apply_streamed(&mut out.response, encoding);
            let (sender, body) = BodySender::new(encoder);
            let status = out.response.status().as_u16();
            let held = OwnedInFlight::take(&cell);
            let this = self.clone();
            tokio::spawn(async move {
                let _held = held;
                let (end, egress) = sender.relay(stream).await;
                let used = RenderUse::default();
                this.record(&rc, &end.meter, egress, status, &used);
            });
            return out.response.map(|_| Body::new(body));
        }
        // Compress before the meter record, so `egress_bytes` counts the
        // bytes sent (#159; gateway README, "Compression"). HEAD gets the
        // headers of the GET it stands for.
        out.response = compress::apply(out.response, encoding);
        if is_head {
            *out.response.body_mut() = Bytes::new();
        }
        let used = RenderUse {
            fuel: render_fuel,
            ms: render_ms,
            limit: render_limit,
            authz_evals: render_evals,
        };
        self.record(
            &rc,
            &out.meter,
            out.response.body().len() as u64,
            out.response.status().as_u16(),
            &used,
        );
        to_body(out.response)
    }

    /// A realtime connection's record (#281), built by the realtime layer.
    pub(crate) fn record_realtime(&self, r: MeterRecord) {
        self.inner.meter.record(r);
    }

    /// The realtime counters of a live cell (#281): connections, messages,
    /// refusals and closes by reason.
    pub fn realtime_stats(&self, tenant_id: &str) -> Option<renox_realtime::Counters> {
        let cells = self.inner.cells.lock().expect("cells lock");
        cells
            .iter()
            .filter(|(k, _)| k.tenant_id == tenant_id)
            .filter_map(|(_, slot)| slot.get())
            .find_map(|c| c.realtime.as_ref().map(|r| r.hub.snapshot()))
    }

    /// One meter record (`ops.md` section 7). 404 and 405 answered by
    /// route matching produce none (`meter.md` section 1).
    fn record(
        &self,
        rc: &RecordCtx,
        m: &InvocationMeter,
        egress_bytes: u64,
        http_status: u16,
        render: &RenderUse,
    ) {
        let Some(route) = m.route.clone() else {
            return;
        };
        self.inner.meter.record(MeterRecord {
            request_id: rc.request_id.clone(),
            tenant_id: rc.tenant_id.clone(),
            deployment_hash: rc.deployment_hash.clone(),
            route,
            started_at: rc.started_at,
            cpu_ms: m.cpu_ms,
            wall_ms: rc.t0.elapsed().as_secs_f64() * 1000.0,
            peak_heap_bytes: m.peak_heap_bytes,
            ingress_bytes: rc.ingress,
            egress_bytes,
            fetch_sent_bytes: m.fetch_sent_bytes,
            fetch_received_bytes: m.fetch_received_bytes,
            fetch_blocked: m.fetch_blocked,
            db_ms: m.db_ms,
            db_rows: m.db_rows,
            // #281: realtime fragments the invocation published.
            render_fuel: render.fuel + m.render_fuel,
            render_ms: match (render.ms, m.render_fuel > 0) {
                (Some(ms), true) => Some(ms + m.render_ms),
                (None, true) => Some(m.render_ms),
                (ms, false) => ms,
            },
            logs_dropped: m.logs_dropped,
            http_status,
            status: if render.limit {
                MeterStatus::RenderLimit
            } else {
                meter_status(m.status)
            },
            kind: None,
            authz_evals: Some(m.authz_evals + render.authz_evals).filter(|n| *n > 0),
            realtime_conn_seconds: None,
            realtime_messages: None,
        });
    }

    /// The loader is slower than [`SHELL_DELAY`] and the page has a shell
    /// (`ops.md` section 14, "Streaming the shell"): 200 and the shell now;
    /// the rest of the page, or the error page inside the stream, when the
    /// dispatch ends.
    fn stream_shell(
        &self,
        cell: &Arc<Cell>,
        dispatch: DispatchFuture,
        sent: ShellSent,
        rc: RecordCtx,
        encoding: Option<compress::Encoding>,
        set_cookie: Vec<String>,
    ) -> Response<Body> {
        let mut head = html_response(200, &rc.request_id, Bytes::new());
        for c in &set_cookie {
            if let Ok(v) = http::HeaderValue::from_str(c) {
                head.headers_mut().append(http::header::SET_COOKIE, v);
            }
        }
        let encoder = compress::apply_streamed(&mut head, encoding);
        let (mut sender, body) = BodySender::new(encoder);
        let held = OwnedInFlight::take(cell);
        let this = self.clone();
        let isolate = cell.clone();
        tokio::spawn(async move {
            let _held = held;
            let ShellSent {
                shell,
                pages,
                nonce,
                csrf_token,
            } = sent;
            let mut used = RenderUse {
                fuel: shell.fuel,
                ms: Some(shell.ms),
                limit: false,
                authz_evals: 0,
            };
            let mut live = sender.send(shell.html.as_bytes()).await;
            let mut out = dispatch.await;
            let request_id = rc.request_id.clone();
            // What goes after the shell: the rest of the page, or an error
            // page's markup (errors.md section 1) with what to log.
            let mut error: Option<(u16, String, String, &'static str)> = None;
            let mut rest: Option<Bytes> = None;
            if let Some(page) = out.render.take() {
                if live {
                    let (p, r, n, t) = (
                        pages.clone(),
                        request_id.clone(),
                        nonce.clone(),
                        csrf_token.clone(),
                    );
                    let now = shell.now_ms;
                    let rendered = on_render_pool(move || {
                        p.render_page(&page, &r, n.as_deref(), t.as_deref(), false, Some(now))
                    })
                    .await;
                    used.fuel += rendered.fuel;
                    used.authz_evals += rendered.authz_evals;
                    log_authz_warnings(&isolate.isolate, &request_id, &rendered.authz_warnings);
                    used.ms = add_ms(used.ms, rendered.ms);
                    used.limit = rendered.limit;
                    if let Some((message, mut fields)) = rendered.log {
                        fields.insert("streamed".into(), true.into());
                        isolate
                            .isolate
                            .log("error", Some(&request_id), &message, fields);
                    }
                    log_i18n_missing(&isolate.isolate, &request_id, &rendered.i18n_missing);
                    let body = rendered.response.body().clone();
                    if rendered.response.status() != http::StatusCode::OK {
                        // The page failed: its error page is the response.
                        if out.meter.status == RuntimeStatus::Ok {
                            out.meter.status = RuntimeStatus::Error;
                        }
                        rest = Some(Bytes::copy_from_slice(from_body_tag(&body)));
                    } else if body.starts_with(shell.html.as_bytes()) {
                        rest = Some(body.slice(shell.html.len()..));
                    } else {
                        error = Some((
                            500,
                            "RENOX_INTERNAL".into(),
                            INTERNAL_MESSAGE.into(),
                            "shell_mismatch",
                        ));
                    }
                }
            } else if let Some(stream) = out.body.take() {
                // A `Response` from `load`, streamed: it cannot be sent.
                let end = stream.client_gone().await;
                out.meter = end.meter;
                error = Some((
                    500,
                    "RENOX_INTERNAL".into(),
                    INTERNAL_MESSAGE.into(),
                    "response_after_shell",
                ));
            } else if out.meter.status != RuntimeStatus::Ok {
                if let Some((status, code, message)) = platform_error(&out.response) {
                    error = Some((status, code, message, "error_after_shell"));
                } else {
                    error = Some((
                        500,
                        "RENOX_INTERNAL".into(),
                        INTERNAL_MESSAGE.into(),
                        "error_after_shell",
                    ));
                }
            } else {
                error = Some((
                    500,
                    "RENOX_INTERNAL".into(),
                    INTERNAL_MESSAGE.into(),
                    "response_after_shell",
                ));
            }
            if let Some((status, code, message, reason)) = error {
                if out.meter.status == RuntimeStatus::Ok {
                    out.meter.status = RuntimeStatus::Error;
                }
                let mut f = serde_json::Map::new();
                f.insert("code".into(), code.clone().into());
                f.insert(
                    "route".into(),
                    out.meter.route.clone().unwrap_or_default().into(),
                );
                f.insert("reason".into(), reason.into());
                f.insert("streamed".into(), true.into());
                isolate.isolate.log(
                    "error",
                    Some(&request_id),
                    "error page rendered inside the stream",
                    f,
                );
                if live {
                    let (p, r, n) = (pages.clone(), request_id.clone(), nonce.clone());
                    let page = on_render_pool(move || {
                        p.error_page(status, Some(&code), &message, &r, n.as_deref())
                    })
                    .await;
                    used.fuel += page.fuel;
                    used.ms = add_ms(used.ms, page.ms);
                    rest = Some(Bytes::copy_from_slice(from_body_tag(page.response.body())));
                }
            }
            if let Some(rest) = rest
                && live
            {
                live = sender.send(&rest).await;
            }
            let egress = if live {
                sender.finish().await
            } else {
                sender.egress
            };
            this.record(&rc, &out.meter, egress, 200, &used);
        });
        head.map(|_| Body::new(body))
    }
}

/// The shell delay (`ops.md` section 14, "Streaming the shell"): 50 ms
/// *proposed*.
pub const SHELL_DELAY: Duration = Duration::from_millis(50);

const INTERNAL_MESSAGE: &str = "Internal error. Quote the request id when reporting it.";

type DispatchFuture = Pin<Box<dyn Future<Output = Dispatched> + Send>>;

/// What the meter record needs from the request.
struct RecordCtx {
    request_id: String,
    tenant_id: String,
    deployment_hash: String,
    started_at: u64,
    t0: Instant,
    ingress: u64,
}

/// What rendering used (`meter.md`: `render_fuel`, `render_ms`).
#[derive(Debug, Default)]
struct RenderUse {
    fuel: u64,
    ms: Option<f64>,
    limit: bool,
    /// `r-can` evaluations of the render (#280).
    authz_evals: u64,
}

/// Dev mode: one `warn` line per `r-can` resource that lacked a declared
/// attribute (#280; `docs/11-authorization.md`, "In templates").
fn log_authz_warnings(
    isolate: &renox_runtime::isolate::IsolateHandle,
    request_id: &str,
    warnings: &[String],
) {
    for w in warnings {
        let mut fields = serde_json::Map::new();
        fields.insert("event".into(), "authz_missing_attribute".into());
        isolate.log("warn", Some(request_id), w, fields);
    }
}

/// One `i18n_missing` line per translation key first found missing in this
/// deployment (#233; `renox_template` reports each once).
fn log_i18n_missing(
    isolate: &renox_runtime::isolate::IsolateHandle,
    request_id: &str,
    missing: &[(String, String)],
) {
    for (locale, key) in missing {
        let mut fields = serde_json::Map::new();
        fields.insert("event".into(), "i18n_missing".into());
        fields.insert("locale".into(), locale.as_str().into());
        fields.insert("key".into(), key.as_str().into());
        isolate.log("warn", Some(request_id), "i18n_missing", fields);
    }
}

fn add_ms(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a + b),
        (a, b) => a.or(b),
    }
}

/// A page's shell, sent; what the rest of the page needs.
struct ShellSent {
    shell: PageShell,
    pages: Arc<PageRenderer>,
    nonce: Option<String>,
    csrf_token: Option<String>,
}

/// Keeps a cell counted as in flight while a streamed body is sent after
/// `handle` returned, so a draining cell is not evicted mid-stream.
pub(crate) struct OwnedInFlight(Option<Arc<Cell>>);

impl OwnedInFlight {
    pub(crate) fn take(cell: &Arc<Cell>) -> OwnedInFlight {
        // The request is in flight already, so the cell is not evicted.
        OwnedInFlight(cell.try_admit().then(|| cell.clone()))
    }
}

impl Drop for OwnedInFlight {
    fn drop(&mut self) {
        if let Some(cell) = &self.0 {
            cell.finish();
        }
    }
}

/// Chunks between the relay task and the connection.
const BODY_CHANNEL: usize = 4;

/// The task's end of a streamed body: compresses each chunk and counts the
/// bytes sent (`meter.md`, `egress_bytes`: after compression).
struct BodySender {
    tx: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
    encoder: Option<StreamEncoder>,
    egress: u64,
}

impl BodySender {
    fn new(encoder: Option<StreamEncoder>) -> (BodySender, ChannelBody) {
        let (tx, rx) = tokio::sync::mpsc::channel(BODY_CHANNEL);
        (
            BodySender {
                tx,
                encoder,
                egress: 0,
            },
            ChannelBody { rx, error: None },
        )
    }

    /// Send one chunk; `false` when the client went away.
    async fn send(&mut self, chunk: &[u8]) -> bool {
        if chunk.is_empty() {
            return !self.tx.is_closed();
        }
        let out = match &mut self.encoder {
            Some(e) => e.encode(chunk),
            None => Bytes::copy_from_slice(chunk),
        };
        if out.is_empty() {
            return !self.tx.is_closed();
        }
        self.egress += out.len() as u64;
        self.tx.send(Ok(out)).await.is_ok()
    }

    /// The normal end: the encoder's tail, then the end of the body.
    async fn finish(mut self) -> u64 {
        if let Some(e) = self.encoder.take() {
            let tail = e.finish();
            if !tail.is_empty() {
                self.egress += tail.len() as u64;
                let _ = self.tx.send(Ok(tail)).await;
            }
        }
        self.egress
    }

    /// A stopped stream (ops.md section 6, "Explicit end"): the body ends
    /// with an error, so the client can tell it is incomplete.
    async fn truncate(self) -> u64 {
        let _ = self
            .tx
            .send(Err(std::io::Error::other("response truncated")))
            .await;
        self.egress
    }

    /// Move a runtime stream to the client; its end and the bytes sent.
    async fn relay(
        mut self,
        mut stream: ResponseStream,
    ) -> (renox_runtime::isolate::StreamEnd, u64) {
        loop {
            let chunk = tokio::select! {
                biased;
                chunk = stream.next_chunk() => chunk,
                // The client went away while the handler had nothing to send.
                _ = self.tx.closed() => None,
            };
            let Some(chunk) = chunk else {
                if stream.end().is_none() {
                    return (stream.client_gone().await, self.egress);
                }
                break;
            };
            if !self.send(&chunk).await {
                let end = stream.client_gone().await;
                return (end, self.egress);
            }
        }
        let end = stream.take_end();
        let egress = if end.complete {
            self.finish().await
        } else {
            self.truncate().await
        };
        (end, egress)
    }
}

/// The connection's end of a streamed body. A truncation is held back for
/// one poll: hyper drops the bytes it has buffered when a body fails, so it
/// gets one round to flush the last chunk before the error.
pub(crate) struct ChannelBody {
    rx: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>,
    error: Option<std::io::Error>,
}

impl ChannelBody {
    /// A body fed by the returned sender (an SSE stream, #281).
    pub(crate) fn channel() -> (
        tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
        ChannelBody,
    ) {
        let (tx, rx) = tokio::sync::mpsc::channel(BODY_CHANNEL);
        (tx, ChannelBody { rx, error: None })
    }
}

impl hyper::body::Body for ChannelBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<hyper::body::Frame<Bytes>, std::io::Error>>> {
        if let Some(e) = self.error.take() {
            return Poll::Ready(Some(Err(e)));
        }
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(Ok(b))) => Poll::Ready(Some(Ok(hyper::body::Frame::data(b)))),
            Poll::Ready(Some(Err(e))) => {
                self.error = Some(e);
                cx.waker().wake_by_ref();
                Poll::Pending
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Runs a render on Tokio's blocking pool: off the isolate thread and off
/// the async workers (`ops.md` section 14, "Rendering").
async fn on_render_pool(f: impl FnOnce() -> Rendered + Send + 'static) -> Rendered {
    match tokio::task::spawn_blocking(f).await {
        Ok(r) => r,
        Err(_) => Rendered {
            response: crate::render::default_page(
                500,
                "Internal error. Quote the request id when reporting it.",
                "",
            ),
            fuel: 0,
            ms: None,
            limit: false,
            log: None,
            i18n_missing: Vec::new(),
            authz_evals: 0,
            authz_warnings: Vec::new(),
        },
    }
}

/// The deployment's page renderer, from `manifest.json` and `templates/`.
/// Also the page guard (sessions, CSRF) when the deployment has page routes,
/// and the per-route buckets of `security.ratelimit` (#47).
async fn load_pages(
    artifact_dir: &Path,
    deployment_hash: &str,
    keys: SessionKeys,
    authz: renox_runtime::ops::authz::AuthzSlot,
) -> Result<WebLayer, CellError> {
    let dir = artifact_dir.to_path_buf();
    let hash = deployment_hash.to_string();
    tokio::task::spawn_blocking(move || {
        let raw = std::fs::read(dir.join("manifest.json"))
            .map_err(|_| ("V14", "V3: manifest.json cannot be read".to_string()))?;
        // `client.events` (client-events.md Open 1), read the way the
        // gateway reads it, so the script tag and the endpoint agree.
        let client_script = std::str::from_utf8(&raw)
            .ok()
            .and_then(|j| DeploymentInfo::parse(j).ok())
            .is_none_or(|i| i.client_events)
            .then(renox_gateway::client_script::script_src);
        let manifest: renox_runtime::manifest::Manifest = serde_json::from_slice(&raw)
            .map_err(|e| ("V14", format!("V3: manifest.json: {e}")))?;
        let guard = PageGuard::new(&manifest.routes, keys);
        let security: SecurityConfig = match &manifest.security {
            Some(v) => serde_json::from_value(v.clone())
                .map_err(|e| ("V14", format!("V16: manifest.security: {e}")))?,
            None => SecurityConfig::default(),
        };
        let buckets = RouteBuckets::new(&manifest.routes, &security.ratelimit);
        let pages = PageRenderer::load(&dir, &manifest, &hash, client_script)
            .map_err(|e| ("V14", e))?
            .map(|p| p.with_authz(authz.clone()));
        // #280: a template naming an action the merged action set lacks is
        // refused at prepare (`RENOX_POLICY_INVALID`, V25).
        let engine = authz
            .read()
            .ok()
            .and_then(|s| s.clone())
            .filter(|st| crate::render::declares_actions(&st.engine));
        if let (Some(p), Some(st)) = (&pages, engine)
            && let Some(unknown) = p
                .template_actions()
                .iter()
                .find(|a| !st.engine.schema().actions.contains(*a))
        {
            return Err((
                "V25",
                format!("RENOX_POLICY_INVALID: a template names the action `{unknown}`, which no policy owner declares"),
            ));
        }
        Ok::<_, (&'static str, String)>(WebLayer {
            pages: pages.map(Arc::new),
            guard,
            buckets,
            // `SameSite=None` only when CORS with credentials is enabled
            // (docs/04-isolation-security.md, "Cookies").
            same_site_none: security.cors.credentials && !security.cors.origins.is_empty(),
        })
    })
    .await
    .map_err(|e| ("V14", e.to_string()))
    .and_then(|r| r)
    .map_err(|(rule, reason)| CellError::Artifact(ArtifactError::Invalid { rule, reason }))
}

fn to_body(r: Response<Bytes>) -> Response<Body> {
    r.map(Body::from)
}

pub(crate) fn meter_status(s: RuntimeStatus) -> MeterStatus {
    match s {
        RuntimeStatus::Ok => MeterStatus::Ok,
        RuntimeStatus::Error => MeterStatus::Error,
        RuntimeStatus::Timeout => MeterStatus::Timeout,
        RuntimeStatus::CpuLimit => MeterStatus::CpuLimit,
        RuntimeStatus::Oom => MeterStatus::Oom,
        RuntimeStatus::BlockedFetch => MeterStatus::BlockedFetch,
        RuntimeStatus::Busy => MeterStatus::Busy,
        RuntimeStatus::Forbidden => MeterStatus::Forbidden,
    }
}

/// Apply the artifact's app migrations (`migrations/app/*.sql`, checked
/// against `migrations/checksums.json`) on the DB thread.
/// The `.sql` files of `migrations/<module>/`; none when it is absent.
fn migration_files(dir: &Path) -> Result<Vec<MigrationFile>, CellError> {
    let mut files = Vec::new();
    if !dir.is_dir() {
        return Ok(files);
    }
    let entries = std::fs::read_dir(dir).map_err(|e| artifact_err(format!("migrations: {e}")))?;
    for entry in entries {
        let entry = entry.map_err(|e| artifact_err(format!("migrations: {e}")))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".sql") {
            continue;
        }
        let sql = std::fs::read_to_string(entry.path())
            .map_err(|e| artifact_err(format!("migration {name}: {e}")))?;
        files.push(MigrationFile { name, sql });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

/// The installed modules of the artifact, `(name, dependencies)` in the
/// manifest's (topological) order (`artifact.md` 1.1, "The `modules` field").
fn installed_modules(artifact_dir: &Path) -> Result<Vec<(String, Vec<String>)>, CellError> {
    #[derive(serde::Deserialize)]
    struct Entry {
        name: String,
        #[serde(default)]
        dependencies: Vec<String>,
    }
    #[derive(serde::Deserialize)]
    struct Modules {
        #[serde(default)]
        modules: Option<serde_json::Value>,
    }
    let raw = std::fs::read(artifact_dir.join("manifest.json"))
        .map_err(|_| artifact_err("manifest.json cannot be read"))?;
    let m: Modules =
        serde_json::from_slice(&raw).map_err(|_| artifact_err("manifest.json invalid"))?;
    match m.modules {
        Some(serde_json::Value::Array(list)) => list
            .into_iter()
            .map(|v| {
                serde_json::from_value::<Entry>(v)
                    .map(|e| (e.name, e.dependencies))
                    .map_err(|_| artifact_err("manifest.json: invalid modules entry"))
            })
            .collect(),
        _ => Ok(Vec::new()),
    }
}

/// Run the artifact's migration plan (`artifact.md` 1.1): each installed
/// module in the manifest's order under its own prefix, then the app's
/// (`renox_data::migrate_all`, #228). Without modules, the app's alone.
async fn run_migrations(db: &DbHandle, artifact_dir: &Path) -> Result<(), CellError> {
    let dir = artifact_dir.join("migrations");
    let modules = installed_modules(artifact_dir)?;
    let app = dir.join("app");
    if !app.is_dir() && modules.is_empty() {
        return Ok(());
    }
    let mut plan = Vec::new();
    for (name, deps) in &modules {
        plan.push(ModuleMigrations {
            module: name.clone(),
            dependencies: deps.clone(),
            files: migration_files(&dir.join(name))?,
        });
    }
    if plan.iter().all(|m| m.files.is_empty()) && !app.is_dir() {
        return Ok(());
    }
    let sums_text = std::fs::read(dir.join("checksums.json"))
        .map_err(|_| artifact_err("migrations/checksums.json missing"))?;
    let sums: ChecksumsFile = serde_json::from_slice(&sums_text)
        .map_err(|_| artifact_err("migrations/checksums.json invalid"))?;
    let checksums = sums.files;
    let files = migration_files(&app)?;
    if modules.is_empty() {
        let report = db
            .call(move |db| migrate_with_checksums(db, "app", &files, &checksums))
            .await
            .map_err(CellError::Db)?
            .map_err(CellError::Migration)?;
        if !report.applied.is_empty() {
            tracing::info!(applied = ?report.applied, "migrations applied");
        }
        return Ok(());
    }
    // The app's migrations run last and may read every module's public views.
    plan.push(ModuleMigrations {
        module: "app".into(),
        dependencies: modules.iter().map(|(n, _)| n.clone()).collect(),
        files,
    });
    let report = db
        .call(move |db| migrate_all(db, &plan, Some(&checksums)))
        .await
        .map_err(CellError::Db)?
        .map_err(|e| {
            tracing::error!(module = %e.module, "module migration failed");
            CellError::Migration(e.error)
        })?;
    for (module, r) in &report.modules {
        if !r.applied.is_empty() {
            tracing::info!(module = %module, applied = ?r.applied, "migrations applied");
        }
    }
    Ok(())
}

fn artifact_err(reason: impl Into<String>) -> CellError {
    CellError::Artifact(ArtifactError::Invalid {
        rule: "V11",
        reason: reason.into(),
    })
}

#[derive(serde::Deserialize)]
struct ChecksumsFile {
    #[allow(dead_code)]
    version: u32,
    files: BTreeMap<String, String>,
}

impl CellDispatcher for CellManager {
    async fn dispatch(&self, ctx: RequestCtx, req: Request<Body>) -> Response<Body> {
        self.handle(ctx, req).await
    }
}
