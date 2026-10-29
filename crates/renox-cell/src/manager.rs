//! `CellManager`: implements the gateway's `CellDispatcher`. Looks up or
//! creates the cell of `(tenant_id, deployment_hash)`, dispatches the request
//! to its isolate, completes the meter record, and evicts idle and draining
//! cells (`docs/05-tenant-lifecycle.md`, "Cold start", "Deployment switch",
//! scale to zero).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use bytes::Bytes;
use http::{Request, Response};
use http_body_util::BodyExt;
use renox_data::{
    DbError, DbOptions, MigrationError, MigrationFile, TenantDb, migrate_with_checksums,
};
use renox_gateway::{CellDispatcher, RequestCtx, RouteEntry, RouteStatus, compress};
use renox_meter::{Meter, MeterRecord, MeterStatus};
use renox_runtime::error::{ErrorCode, PlatformResponse};
use renox_runtime::isolate::{CreateError, MeterStatus as RuntimeStatus};
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
use crate::render::{PageRenderer, Rendered, platform_error, prefers_html};
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

/// What the manager needs to know about a deployment before creating its cell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeploymentMeta {
    pub tier: TierName,
    /// `None` in local mode (the route table file has no app).
    pub app: Option<String>,
    pub secrets_version: u64,
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
    /// A trim is scheduled after the current burst of evictions (#144).
    trim_scheduled: std::sync::atomic::AtomicBool,
    /// Allocator trims run since start (operator metrics, tests).
    trims: std::sync::atomic::AtomicU64,
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
                trim_scheduled: Default::default(),
                trims: Default::default(),
            }),
        }
    }

    pub fn runtime(&self) -> &Runtime {
        &self.inner.runtime
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
        // #157: the tenant file opens on its DB thread while the artifact is
        // verified and the isolate is created; migrations run alongside the
        // isolate's creation. Tenant code cannot reach the DB before the
        // cell is ready: module evaluation runs outside any request, where
        // `ctx.db` rejects with `RENOX_NO_REQUEST` (ops.md section 11).
        let db = self.acquire_db(&key.tenant_id, tier.db_quota_bytes).await?;
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
                self.release_db(&key.tenant_id).await;
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
                    Ok(isolate)
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
                self.release_db(&key.tenant_id).await;
                return Err(e);
            }
        };
        let keys = SessionKeys::new(self.inner.config.platform_key.tenant_key(&key.tenant_id));
        let web = match load_pages(&artifact_dir, &key.deployment_hash, keys).await {
            Ok(p) => p,
            Err(e) => {
                isolate.terminate();
                self.release_db(&key.tenant_id).await;
                return Err(e);
            }
        };
        let stats = isolate.stats();
        let cell = Arc::new(Cell::new(key.clone(), isolate, web));
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
        // The open runs on the DB thread; the handle is usable at once and
        // `DbHandle::ready` reports an open failure (#157).
        let handle = DbHandle::open_in_background(move || {
            std::fs::create_dir_all(&dir).map_err(|e| DbError::Open(e.kind().to_string()))?;
            let options = DbOptions {
                module_prefix: Some("app".into()),
                ..DbOptions::with_quota_bytes(quota)
            };
            TenantDb::open(dir.join("app.db"), options)
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
        }
    }

    /// One task per cell: evict after `idle_timeout` without a request, or
    /// as soon as a draining cell has nothing in flight.
    fn spawn_eviction(&self, cell: Arc<Cell>) {
        let this = self.clone();
        let idle = self.inner.config.idle_timeout;
        tokio::spawn(async move {
            loop {
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
        cell.isolate.terminate();
        let tenant = cell.key.tenant_id.clone();
        drop(cell);
        self.release_db(&tenant).await;
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
        let mut out = cell
            .isolate
            .dispatch(rt_ctx, Request::from_parts(parts, body))
            .await;
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
        if let Some(r) = rendered {
            if let Some((message, fields)) = &r.log {
                cell.isolate
                    .log("error", Some(&ctx.request_id), message, fields.clone());
            }
            render_fuel = r.fuel;
            render_ms = r.ms;
            render_limit = r.limit;
            if r.response.status().is_server_error() && out.meter.status == RuntimeStatus::Ok {
                out.meter.status = RuntimeStatus::Error;
            }
            out.response = r.response;
        }
        // Compress before the meter record, so `egress_bytes` counts the
        // bytes sent (#159; gateway README, "Compression"). HEAD gets the
        // headers of the GET it stands for.
        out.response = compress::apply(out.response, encoding);
        if is_head {
            *out.response.body_mut() = Bytes::new();
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
        // 404 and 405 answered by route matching produce no record
        // (`meter.md` section 1).
        if let Some(route) = out.meter.route.clone() {
            let m = &out.meter;
            self.inner.meter.record(MeterRecord {
                request_id: ctx.request_id.clone(),
                tenant_id: ctx.tenant_id.clone(),
                deployment_hash: ctx.deployment_hash.clone(),
                route,
                started_at,
                cpu_ms: m.cpu_ms,
                wall_ms: t0.elapsed().as_secs_f64() * 1000.0,
                peak_heap_bytes: m.peak_heap_bytes,
                ingress_bytes: ingress,
                egress_bytes: out.response.body().len() as u64,
                fetch_sent_bytes: m.fetch_sent_bytes,
                fetch_received_bytes: m.fetch_received_bytes,
                fetch_blocked: m.fetch_blocked,
                db_ms: m.db_ms,
                db_rows: m.db_rows,
                render_fuel,
                render_ms,
                logs_dropped: m.logs_dropped,
                http_status: out.response.status().as_u16(),
                status: if render_limit {
                    MeterStatus::RenderLimit
                } else {
                    meter_status(m.status)
                },
            });
        }
        to_body(out.response)
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
) -> Result<WebLayer, CellError> {
    let dir = artifact_dir.to_path_buf();
    let hash = deployment_hash.to_string();
    tokio::task::spawn_blocking(move || {
        let raw = std::fs::read(dir.join("manifest.json"))
            .map_err(|_| "V3: manifest.json cannot be read".to_string())?;
        // `client.events` (client-events.md Open 1), read the way the
        // gateway reads it, so the script tag and the endpoint agree.
        let client_script = std::str::from_utf8(&raw)
            .ok()
            .and_then(|j| DeploymentInfo::parse(j).ok())
            .is_none_or(|i| i.client_events)
            .then(renox_gateway::client_script::script_src);
        let manifest: renox_runtime::manifest::Manifest =
            serde_json::from_slice(&raw).map_err(|e| format!("V3: manifest.json: {e}"))?;
        let guard = PageGuard::new(&manifest.routes, keys);
        let security: SecurityConfig = match &manifest.security {
            Some(v) => serde_json::from_value(v.clone())
                .map_err(|e| format!("V16: manifest.security: {e}"))?,
            None => SecurityConfig::default(),
        };
        let buckets = RouteBuckets::new(&manifest.routes, &security.ratelimit);
        PageRenderer::load(&dir, &manifest, &hash, client_script).map(|p| WebLayer {
            pages: p.map(Arc::new),
            guard,
            buckets,
            // `SameSite=None` only when CORS with credentials is enabled
            // (docs/04-isolation-security.md, "Cookies").
            same_site_none: security.cors.credentials && !security.cors.origins.is_empty(),
        })
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r)
    .map_err(|reason| {
        CellError::Artifact(ArtifactError::Invalid {
            rule: "V14",
            reason,
        })
    })
}

fn to_body(r: Response<Bytes>) -> Response<Body> {
    r.map(Body::from)
}

fn meter_status(s: RuntimeStatus) -> MeterStatus {
    match s {
        RuntimeStatus::Ok => MeterStatus::Ok,
        RuntimeStatus::Error => MeterStatus::Error,
        RuntimeStatus::Timeout => MeterStatus::Timeout,
        RuntimeStatus::CpuLimit => MeterStatus::CpuLimit,
        RuntimeStatus::Oom => MeterStatus::Oom,
        RuntimeStatus::BlockedFetch => MeterStatus::BlockedFetch,
        RuntimeStatus::Busy => MeterStatus::Busy,
    }
}

/// Apply the artifact's app migrations (`migrations/app/*.sql`, checked
/// against `migrations/checksums.json`) on the DB thread.
async fn run_migrations(db: &DbHandle, artifact_dir: &Path) -> Result<(), CellError> {
    let dir = artifact_dir.join("migrations");
    let app = dir.join("app");
    if !app.is_dir() {
        return Ok(());
    }
    let sums_text = std::fs::read(dir.join("checksums.json"))
        .map_err(|_| artifact_err("migrations/checksums.json missing"))?;
    let sums: ChecksumsFile = serde_json::from_slice(&sums_text)
        .map_err(|_| artifact_err("migrations/checksums.json invalid"))?;
    let mut files = Vec::new();
    let entries = std::fs::read_dir(&app).map_err(|e| artifact_err(format!("migrations: {e}")))?;
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
    let checksums = sums.files;
    let report = db
        .call(move |db| migrate_with_checksums(db, "app", &files, &checksums))
        .await
        .map_err(CellError::Db)?
        .map_err(CellError::Migration)?;
    if !report.applied.is_empty() {
        tracing::info!(applied = ?report.applied, "migrations applied");
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
