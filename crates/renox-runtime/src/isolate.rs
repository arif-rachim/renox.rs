//! One deployment's isolate: creation from the platform snapshot, tenant
//! module evaluation, handler lookup, request dispatch
//! (`docs/contracts/ops.md` section 11), and the per-request limits of
//! section 10 (#26).
//!
//! Thread model: every isolate lives on its own OS thread with a
//! single-threaded Tokio runtime, and the rest of the process talks to it
//! through a channel ([`IsolateHandle`]). A V8 isolate is bound to the
//! thread that created it, `deno_core`'s `JsRuntime` is `!Send`, and a
//! dedicated thread lets the CPU watchdog measure exactly that thread's CPU
//! clock. See README, "Thread model".
//!
//! Pool (#156): a deployment that is hot (requests waiting on a busy
//! isolate) runs up to [`IsolateSpec::max_isolates`] isolates, each on its
//! own thread. A request goes to the least-loaded member; one spare is kept
//! ready once the deployment is hot, so a member that is terminated (CPU,
//! heap, uncaught error) is replaced at once and the termination ends only
//! the requests on that member. The concurrency limit stays per deployment.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::{Duration, Instant};

use bytes::Bytes;
use deno_core::serde_v8;
use deno_core::v8;
use deno_core::{
    ByteString, JsBuffer, JsRuntime, ModuleSpecifier, PollEventLoopOptions, ToJsBuffer,
};
use deno_resolver::npm::{DenoInNpmPackageChecker, NpmResolver};
use deno_runtime::BootstrapOptions;
use deno_runtime::deno_permissions::{Permissions, PermissionsContainer};
use deno_runtime::permissions::RuntimePermissionDescriptorParser;
use deno_runtime::worker::{MainWorker, WorkerOptions, WorkerServiceOptions};
use futures::stream::{FuturesUnordered, StreamExt};
use serde::Deserialize;
use sys_traits::impls::RealSys;
use tokio::sync::{mpsc, oneshot};

use crate::error::{ErrorCode, PlatformResponse};
use crate::limits::Limits;
use crate::limits::concurrency::ConcurrencyLimit;
use crate::limits::cpu::{CpuLedger, CpuWatch, Watchdog};
use crate::limits::heap::{self, HeapFlag};
use crate::limits::wall::effective_deadline;
use crate::loader::{ArtifactLoader, specifier_for};
use crate::manifest::{Artifact, CodeFormat, LoadError, RouteKind};
use crate::ops::db::{DbEnv, DbHandle};
use crate::ops::fetch::FetchEnv;
use crate::ops::log::{LogEnv, RedactingSink};
use crate::ops::net_policy::Allowlist;
use crate::ops::request::{RequestState, RequestTable};
use crate::ops::response::{ResponseSinks, StreamEvent, StreamEvents};
use crate::ops::secrets::{self, Redactor, SecretsState};
use crate::pages::{
    MAX_DATA_JSON_BYTES, PageCall, PageRender, PageSession, page_call, select_fragment,
};
use crate::request_resources;
use crate::router::{ParamValue, RouteMatch, Router};
use crate::runtime::{LogLine, LogSink, Runtime};

/// What the cell asks for when it creates a deployment's isolate.
#[derive(Debug, Clone)]
pub struct IsolateSpec {
    pub tenant_id: String,
    pub deployment_hash: String,
    /// The artifact directory; its name must be `deployment_hash` (V2).
    pub artifact_dir: PathBuf,
    /// Tier limits; the manifest may lower them.
    pub limits: Limits,
    /// Decrypted secrets of the tenant. Only the names the manifest declares
    /// (`permissions.secrets`) reach the isolate, frozen as `ctx.secrets`
    /// (`ops.md` section 3); a value shorter than 8 bytes fails creation.
    pub secrets: BTreeMap<String, String>,
    /// The tenant's database: the DB thread of its SQLite file, opened by
    /// the cell (`ops/db.rs`). `None` gives a deployment whose `ctx.db`
    /// calls fail.
    pub db: Option<DbHandle>,
    /// Isolates of the deployment when it is hot, the spare not counted
    /// (#156; the cell sets it per tier). 0 and 1 mean one isolate, no pool.
    pub max_isolates: usize,
}

/// Per-request context from the cell.
#[derive(Debug, Clone)]
pub struct RequestCtx {
    /// Gateway-assigned request id (`x-renox-request-id`).
    pub request_id: String,
    /// Wall-clock deadline of the request (`ops.md` section 5). The runtime
    /// further caps it at `now + limits.wall_ms`.
    pub deadline: Instant,
}

/// How an invocation ended (`docs/contracts/meter.md` section 2, `status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeterStatus {
    Ok,
    Error,
    Timeout,
    CpuLimit,
    Oom,
    BlockedFetch,
    Busy,
}

impl MeterStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            MeterStatus::Ok => "ok",
            MeterStatus::Error => "error",
            MeterStatus::Timeout => "timeout",
            MeterStatus::CpuLimit => "cpu_limit",
            MeterStatus::Oom => "oom",
            MeterStatus::BlockedFetch => "blocked_fetch",
            MeterStatus::Busy => "busy",
        }
    }
}

/// The meter fields the runtime fills (`ops.md` section 7). The cell adds
/// the rest of the record.
#[derive(Debug, Clone, PartialEq)]
pub struct InvocationMeter {
    /// `<METHOD> <pattern>`; `None` when no route matched (404/405, no record).
    pub route: Option<String>,
    pub status: MeterStatus,
    /// Thread CPU time charged to the request (`meter.md`, `cpu_ms`).
    pub cpu_ms: f64,
    /// Peak `used_heap_size` of the isolate while the request was in flight.
    pub peak_heap_bytes: u64,
    pub fetch_sent_bytes: u64,
    pub fetch_received_bytes: u64,
    pub fetch_blocked: u64,
    /// Wall time in database statements (`meter.md`, `db_ms`).
    pub db_ms: f64,
    /// Rows returned plus rows changed (`meter.md`, `db_rows`).
    pub db_rows: u64,
    /// Log lines dropped by the rate limit (`meter.md`, `logs_dropped`).
    pub logs_dropped: u64,
}

impl InvocationMeter {
    fn new(route: Option<String>, status: MeterStatus) -> InvocationMeter {
        InvocationMeter {
            route,
            status,
            cpu_ms: 0.0,
            peak_heap_bytes: 0,
            fetch_sent_bytes: 0,
            fetch_received_bytes: 0,
            fetch_blocked: 0,
            db_ms: 0.0,
            db_rows: 0,
            logs_dropped: 0,
        }
    }
}

/// The result of one dispatch.
#[derive(Debug)]
pub struct Dispatched {
    /// The response. When `render` is set it is an empty placeholder: the
    /// cell renders the page and builds the real response.
    pub response: http::Response<Bytes>,
    pub meter: InvocationMeter,
    /// A page route whose `load` returned an object, or that has no loader:
    /// what the cell renders (`ops.md` section 14, "Rendering").
    pub render: Option<PageRender>,
    /// The request matched a page route: platform errors are answered with
    /// the error page (`errors.md` section 1, "Page (HTML) routes").
    pub page: bool,
    /// The handler's body is a stream (`ops.md` section 6, "Response body"):
    /// `response` holds the head and an empty body, the chunks come from
    /// here, and `meter` is final only when the stream has ended
    /// ([`ResponseStream::end`]).
    pub body: Option<ResponseStream>,
}

impl Dispatched {
    fn plain(response: http::Response<Bytes>, meter: InvocationMeter, page: bool) -> Dispatched {
        Dispatched {
            response,
            meter,
            render: None,
            page,
            body: None,
        }
    }
}

/// How a streamed body ended (`ops.md` section 10, "Mid-stream").
#[derive(Debug, Clone)]
pub struct StreamEnd {
    /// The request's meter record, written at the end of the stream
    /// (`ops.md` section 7).
    pub meter: InvocationMeter,
    /// `op_response_end(null)`: the body is complete. Anything else
    /// truncates it.
    pub complete: bool,
}

/// The body of a streamed response, read by the cell. Holds the request's
/// concurrency slot and its pool member until the stream ends; the
/// deadline applies to the whole stream. Dropping it before the end does
/// not stop the request: call [`ResponseStream::client_gone`].
pub struct ResponseStream {
    chunks: mpsc::Receiver<Bytes>,
    end: Option<oneshot::Receiver<StreamEnd>>,
    outcome: Option<StreamEnd>,
    deadline: Instant,
    seq: u64,
    member: LoadGuard,
    _permit: tokio::sync::OwnedSemaphorePermit,
    pool: Arc<Pool>,
    request_id: String,
    route: String,
    received: u64,
    /// The request was ended from here ([`Self::client_gone`]).
    ended: bool,
}

impl Drop for ResponseStream {
    /// Dropped before its end: the request ends as if the client went away,
    /// so it does not hold its slot until the deadline.
    fn drop(&mut self) {
        if self.outcome.is_none() && !self.ended {
            let (meter, _) = oneshot::channel();
            let _ = self.member.0.tx.send(Command::Cancel {
                seq: self.seq,
                meter,
                reason: CancelReason::ClientGone,
            });
        }
    }
}

impl std::fmt::Debug for ResponseStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResponseStream")
            .field("route", &self.route)
            .field("received", &self.received)
            .finish_non_exhaustive()
    }
}

impl ResponseStream {
    /// The next chunk, or `None` once the stream has ended; [`Self::end`]
    /// then says how. The wall-clock deadline ends the stream here.
    pub async fn next_chunk(&mut self) -> Option<Bytes> {
        if self.outcome.is_some() {
            return None;
        }
        let deadline = tokio::time::Instant::from_std(self.deadline);
        tokio::select! {
            biased;
            chunk = self.chunks.recv() => {
                if let Some(b) = chunk {
                    self.received += b.len() as u64;
                    return Some(b);
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                self.outcome = Some(self.stop(CancelReason::Deadline).await);
                return None;
            }
        }
        // Every sender is gone: the request has ended, its record follows.
        let ended = match self.end.as_mut() {
            Some(rx) => tokio::select! {
                r = rx => Some(r.ok()),
                _ = tokio::time::sleep_until(deadline) => None,
            },
            None => Some(None),
        };
        self.outcome = Some(match ended {
            Some(Some(end)) => end,
            // The member went away without an answer (disposal).
            Some(None) => StreamEnd {
                meter: InvocationMeter::new(Some(self.route.clone()), MeterStatus::Error),
                complete: false,
            },
            None => self.stop(CancelReason::Deadline).await,
        });
        None
    }

    /// How the stream ended; `None` until [`Self::next_chunk`] returned `None`.
    pub fn end(&self) -> Option<&StreamEnd> {
        self.outcome.as_ref()
    }

    /// How the stream ended, once [`Self::next_chunk`] returned `None`;
    /// a truncated `error` record if it has not.
    pub fn take_end(&mut self) -> StreamEnd {
        self.outcome.take().unwrap_or_else(|| StreamEnd {
            meter: InvocationMeter::new(Some(self.route.clone()), MeterStatus::Error),
            complete: false,
        })
    }

    /// Body bytes taken from the isolate so far, before compression.
    pub fn received_bytes(&self) -> u64 {
        self.received
    }

    /// The client went away: end the request now (meter `status` as the
    /// stream had it, `ok` when nothing else stopped it).
    pub async fn client_gone(mut self) -> StreamEnd {
        if let Some(end) = self.outcome.take() {
            self.ended = true;
            return end;
        }
        let end = self.stop(CancelReason::ClientGone).await;
        self.ended = true;
        end
    }

    /// End the request on the isolate thread and take its meter.
    async fn stop(&mut self, reason: CancelReason) -> StreamEnd {
        // The stream may have ended a moment ago.
        if let Some(Ok(end)) = self.end.as_mut().map(|rx| rx.try_recv()) {
            return end;
        }
        let (meter_tx, meter_rx) = oneshot::channel();
        let _ = self.member.0.tx.send(Command::Cancel {
            seq: self.seq,
            meter: meter_tx,
            reason,
        });
        let meter = tokio::time::timeout(Duration::from_millis(100), meter_rx)
            .await
            .ok()
            .and_then(Result::ok);
        let mut meter = match (meter, self.end.as_mut().map(|rx| rx.try_recv())) {
            (Some(m), _) => m,
            (None, Some(Ok(end))) => return end,
            (None, _) => InvocationMeter::new(Some(self.route.clone()), reason.status()),
        };
        meter.route = Some(self.route.clone());
        if reason == CancelReason::Deadline {
            meter.status = MeterStatus::Timeout;
            let mut f = serde_json::Map::new();
            f.insert("code".into(), "RENOX_DEADLINE".into());
            f.insert("route".into(), self.route.clone().into());
            f.insert("phase".into(), "stream".into());
            f.insert("sent_bytes".into(), self.received.into());
            f.insert("limit_ms".into(), self.pool.limits.wall_ms.into());
            self.pool.log(
                "warn",
                Some(&self.request_id),
                "request deadline passed; stream truncated",
                f,
            );
        }
        StreamEnd {
            meter,
            complete: false,
        }
    }
}

/// Why an isolate could not be created. Every variant is a
/// module-evaluation failure in the contract's sense (`ops.md` section 10).
#[derive(Debug, Clone)]
pub enum CreateError {
    /// The artifact failed a load-time rule (`artifact.md` section 6).
    Artifact(LoadError),
    /// Route patterns or allowlist entries are invalid.
    Manifest(String),
    /// A tenant module failed to load or threw during evaluation, or a
    /// route's export is missing or not a function.
    ModuleLoad(String),
    /// Module evaluation hit the CPU, wall-clock, or heap limit
    /// (`RENOX_CPU_LIMIT`, `RENOX_DEADLINE`, `RENOX_OOM`).
    Limit(ErrorCode),
    /// The platform itself failed (snapshot, bootstrap, thread).
    Internal(String),
}

impl CreateError {
    /// The response code requests waiting on this isolate get.
    pub fn code(&self) -> ErrorCode {
        match self {
            CreateError::Limit(code) => *code,
            _ => ErrorCode::Internal,
        }
    }
}

impl std::fmt::Display for CreateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CreateError::Artifact(e) => write!(f, "artifact refused: {e}"),
            CreateError::Manifest(e) => write!(f, "manifest refused: {e}"),
            CreateError::ModuleLoad(e) => write!(f, "module evaluation failed: {e}"),
            CreateError::Limit(code) => write!(f, "module evaluation hit {}", code.as_str()),
            CreateError::Internal(e) => write!(f, "isolate creation failed: {e}"),
        }
    }
}

impl std::error::Error for CreateError {}

/// How long a failed isolate creation is remembered per deployment, so a
/// broken deployment is not rebuilt on every request (`ops.md` section 10).
pub const CREATE_FAILURE_CACHE: Duration = Duration::from_secs(5);

/// Numbers measured when the isolate was created (README; B1, B4).
#[derive(Debug, Clone, Copy)]
pub struct CreateStats {
    /// From thread start to "ready to dispatch": snapshot deserialisation,
    /// bootstrap, hardening, module evaluation, handler lookup.
    pub create_time: Duration,
    /// Of which: tenant module load and evaluation.
    pub module_time: Duration,
    pub used_heap_bytes: u64,
    pub total_heap_bytes: u64,
}

// ---------------------------------------------------------------------------
// Channel protocol between handles and the isolate thread.

struct DispatchJob {
    seq: u64,
    route: usize,
    params: Arc<BTreeMap<String, ParamValue>>,
    method: String,
    url: String,
    headers: Arc<Vec<(ByteString, ByteString)>>,
    body: Bytes,
    want_body: bool,
    /// Page routes: what the bootstrap needs for `LoaderContext` and
    /// `ActionContext` (`ops.md` section 14).
    page: Option<PageJob>,
    ctx: RequestCtx,
    reply: oneshot::Sender<ThreadReply>,
}

struct PageJob {
    fragment: Option<String>,
    session: String,
    /// The action to run (`POST ?/<name>`), or `None` for `load`.
    action: Option<String>,
    /// The page has a template (an object result can be rendered).
    template: bool,
}

enum Command {
    Dispatch(Box<DispatchJob>),
    /// The request's deadline passed on the handle side: end it now and
    /// report what it used.
    Cancel {
        seq: u64,
        meter: oneshot::Sender<InvocationMeter>,
        reason: CancelReason,
    },
    Terminate,
}

/// Why the handle side ends a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CancelReason {
    /// The wall-clock deadline passed (504, or a truncated stream).
    Deadline,
    /// The client stopped reading a streamed body.
    ClientGone,
}

impl CancelReason {
    fn status(self) -> MeterStatus {
        match self {
            CancelReason::Deadline => MeterStatus::Timeout,
            CancelReason::ClientGone => MeterStatus::Ok,
        }
    }
}

/// What the isolate thread answers for one dispatch.
enum ThreadReply {
    /// The handler returned a `Response`.
    Ok {
        status: u16,
        headers: Vec<(ByteString, ByteString)>,
        body: Bytes,
        meter: InvocationMeter,
    },
    /// The handler returned a `Response` with a streamed body: the head
    /// now, the chunks and the meter record at the end of the stream.
    Stream {
        status: u16,
        headers: Vec<(ByteString, ByteString)>,
        body: mpsc::Receiver<Bytes>,
        end: oneshot::Receiver<StreamEnd>,
    },
    /// A page loader or action returned an object: the template data as
    /// JSON, and an action's out-of-band fragments.
    Render {
        data_json: String,
        fragments: Vec<String>,
        meter: InvocationMeter,
    },
    /// The request ended with a platform error.
    Failed {
        code: ErrorCode,
        meter: InvocationMeter,
    },
    /// The member was already terminated: nothing of the request ran, and
    /// the handle sends it to another member.
    Refused,
}

/// Shared state between a handle and its isolate thread.
struct ThreadShared {
    poisoned: AtomicBool,
}

/// One live isolate on its thread: a member of the deployment's pool.
struct IsolateThread {
    tx: mpsc::UnboundedSender<Command>,
    v8_handle: v8::IsolateHandle,
    shared: Arc<ThreadShared>,
    stats: CreateStats,
    /// Requests sent to this member and not answered yet.
    load: AtomicUsize,
}

impl IsolateThread {
    fn healthy(&self) -> bool {
        !self.shared.poisoned.load(Ordering::SeqCst)
    }

    fn poison(&self) {
        self.shared.poisoned.store(true, Ordering::SeqCst);
        self.v8_handle.terminate_execution();
    }
}

/// Counts a request against its member's load while it is in flight.
struct LoadGuard(Arc<IsolateThread>);

impl LoadGuard {
    /// Take a member for one request. Called with the members lock held,
    /// so concurrent picks see each other's load.
    fn take(t: &Arc<IsolateThread>) -> LoadGuard {
        t.load.fetch_add(1, Ordering::SeqCst);
        LoadGuard(t.clone())
    }
}

impl Drop for LoadGuard {
    fn drop(&mut self) {
        self.0.load.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A member with this many requests in flight counts as busy: the pool
/// grows (up to `max_isolates`) instead of queueing more on it.
pub const POOL_GROW_AT_LOAD: usize = 2;

impl Drop for IsolateThread {
    fn drop(&mut self) {
        // The thread disposes the isolate itself when its channel closes,
        // so dropping a handle never blocks on V8.
        let _ = self.tx.send(Command::Terminate);
    }
}

/// The handle of one deployment's isolates. Cheap to share (`Arc`).
pub struct IsolateHandle {
    inner: Arc<Pool>,
}

impl std::ops::Deref for IsolateHandle {
    type Target = Pool;

    fn deref(&self) -> &Pool {
        &self.inner
    }
}

/// The isolates of one deployment and what it takes to create one more.
pub struct Pool {
    runtime: Runtime,
    spec: Arc<IsolateSpec>,
    artifact: Arc<Artifact>,
    router: Arc<Router>,
    allowlist: Arc<Allowlist>,
    /// The declared secrets (`IsolateSpec::secrets` filtered).
    secrets: Arc<BTreeMap<String, String>>,
    /// The tenant log sink behind the isolate's redaction.
    sink: Arc<dyn LogSink>,
    limits: Limits,
    /// The deployment's concurrency limit, shared by all members.
    concurrency: ConcurrencyLimit,
    seq: AtomicU64,
    /// The members, in creation order.
    members: Mutex<Vec<Arc<IsolateThread>>>,
    /// A ready isolate that takes over from a terminated member, or joins
    /// when the deployment grows. Kept only while the deployment is hot.
    spare: Mutex<Option<Arc<IsolateThread>>>,
    max_members: usize,
    /// A member or the spare is being created in the background.
    growing: AtomicBool,
    /// Serialises re-creation so concurrent requests build one isolate.
    respawn: tokio::sync::Mutex<()>,
    last_failure: Mutex<Option<(Instant, CreateError)>>,
}

impl IsolateHandle {
    pub(crate) async fn create(
        runtime: Runtime,
        spec: IsolateSpec,
    ) -> Result<IsolateHandle, CreateError> {
        let artifact = runtime.load_artifact(&spec.artifact_dir)?;
        if artifact.hash != spec.deployment_hash {
            return Err(CreateError::Artifact(LoadError {
                rule: "V2",
                reason: "artifact hash differs from the deployment hash".into(),
            }));
        }
        let router = Router::new(&artifact.manifest.routes)
            .map_err(|e| CreateError::Manifest(e.to_string()))?;
        // V9: an invalid network entry fails the deployment (fail closed).
        let allowlist = Allowlist::parse(&artifact.manifest.permissions.network)
            .map_err(|e| CreateError::Manifest(e.to_string()))?;
        let limits = spec
            .limits
            .with_overrides(artifact.manifest.limits.as_ref());
        // ops.md section 3: only declared secrets; short values refused by name.
        let declared = secrets::select(&artifact.manifest.permissions.secrets, &spec.secrets);
        let redactor = Arc::new(Redactor::new(spec.secrets.values()));
        let sink: Arc<dyn LogSink> = Arc::new(RedactingSink {
            inner: runtime.inner.config.log_sink.clone(),
            redactor,
        });
        if let Err(name) = secrets::check_lengths(&declared) {
            let mut f = serde_json::Map::new();
            f.insert("code".into(), "RENOX_INTERNAL".into());
            f.insert("phase".into(), "module_load".into());
            f.insert("secret".into(), name.clone().into());
            sink.log(LogLine {
                level: "error",
                tenant_id: spec.tenant_id.clone(),
                deployment_hash: spec.deployment_hash.clone(),
                request_id: None,
                message: "secret value shorter than 8 bytes".into(),
                fields: f,
            });
            return Err(CreateError::Internal(format!(
                "secret {name} is shorter than {} bytes",
                secrets::MIN_SECRET_BYTES
            )));
        }
        let max_members = spec.max_isolates.max(1);
        let pool = Pool {
            runtime,
            spec: Arc::new(spec),
            artifact,
            router: Arc::new(router),
            allowlist: Arc::new(allowlist),
            secrets: Arc::new(declared),
            sink,
            limits,
            concurrency: ConcurrencyLimit::new(limits.concurrency),
            seq: AtomicU64::new(0),
            members: Mutex::new(Vec::new()),
            spare: Mutex::new(None),
            max_members,
            growing: AtomicBool::new(false),
            respawn: tokio::sync::Mutex::new(()),
            last_failure: Mutex::new(None),
        };
        let thread = pool.spawn_thread().await?;
        pool.members
            .lock()
            .expect("pool lock")
            .push(Arc::new(thread));
        Ok(IsolateHandle {
            inner: Arc::new(pool),
        })
    }

    /// Dispatch one request to the handler its route names.
    ///
    /// `req`'s URI must be absolute (`https://<host><path>?<query>`), or its
    /// `Host` header is used with `https`. 404 and 405 are answered here
    /// without entering the isolate. The request then waits for one of the
    /// deployment's concurrency slots (503 `RENOX_BUSY` at the deadline),
    /// runs on the least-loaded member of the pool under the CPU and heap
    /// limits, and is answered with 504 `RENOX_DEADLINE` at its deadline
    /// whatever the handler does after.
    pub async fn dispatch(&self, ctx: RequestCtx, req: http::Request<Bytes>) -> Dispatched {
        self.inner.dispatch(ctx, req).await
    }
}

impl Pool {
    /// The effective limits (tier limits lowered by the manifest).
    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// The page template of a request that may get its shell first
    /// (`ops.md` section 14, "Streaming the shell"): a full-page `GET` (no
    /// fragment selected) of a page route with `load` and a template.
    pub fn shell_template(&self, parts: &http::request::Parts) -> Option<String> {
        if parts.method != http::Method::GET {
            return None;
        }
        let RouteMatch::Found { route, .. } = self.router.find("GET", parts.uri.path()) else {
            return None;
        };
        let r = &self.artifact.manifest.routes[route];
        if r.kind != RouteKind::Page || r.handler_export().is_none() {
            return None;
        }
        if select_fragment(&self.artifact.manifest, r, &parts.headers).is_some() {
            return None;
        }
        r.page().and_then(|p| p.template.clone())
    }

    /// Free concurrency slots of the deployment.
    pub fn available_slots(&self) -> usize {
        self.concurrency.available()
    }

    /// Creation numbers of the oldest live member.
    pub fn stats(&self) -> Option<CreateStats> {
        self.members
            .lock()
            .expect("pool lock")
            .iter()
            .find(|t| t.healthy())
            .map(|t| t.stats)
    }

    /// Live members of the pool, the spare not counted.
    pub fn pool_size(&self) -> usize {
        self.members
            .lock()
            .expect("pool lock")
            .iter()
            .filter(|t| t.healthy())
            .count()
    }

    /// Is a spare isolate ready?
    pub fn has_spare(&self) -> bool {
        self.spare.lock().expect("pool lock").is_some()
    }

    /// The most isolates the deployment runs, the spare not counted.
    pub fn max_isolates(&self) -> usize {
        self.max_members
    }

    /// Stop every isolate of the deployment, the spare included: running
    /// JavaScript is terminated and each isolate is disposed on its thread.
    /// The next dispatch creates a new one.
    pub fn terminate(&self) {
        let members = std::mem::take(&mut *self.members.lock().expect("pool lock"));
        let spare = self.spare.lock().expect("pool lock").take();
        for t in members.iter().chain(spare.iter()) {
            t.poison();
        }
    }

    async fn spawn_thread(&self) -> Result<IsolateThread, CreateError> {
        let (tx, rx) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let shared = Arc::new(ThreadShared {
            poisoned: AtomicBool::new(false),
        });
        let ctx = ThreadContext {
            runtime: self.runtime.clone(),
            spec: self.spec.clone(),
            artifact: self.artifact.clone(),
            limits: self.limits,
            allowlist: self.allowlist.clone(),
            secrets: self.secrets.clone(),
            sink: self.sink.clone(),
            shared: shared.clone(),
        };
        let name = format!(
            "renox-isolate-{}",
            &self.spec.deployment_hash[..12.min(self.spec.deployment_hash.len())]
        );
        std::thread::Builder::new()
            .name(name)
            .spawn(move || isolate_thread_main(ctx, rx, ready_tx))
            .map_err(|e| CreateError::Internal(format!("spawn isolate thread: {e}")))?;
        let (v8_handle, stats) = ready_rx
            .await
            .map_err(|_| CreateError::Internal("isolate thread exited during creation".into()))??;
        self.runtime
            .inner
            .metrics
            .isolates_created
            .fetch_add(1, Ordering::Relaxed);
        Ok(IsolateThread {
            tx,
            v8_handle,
            shared,
            stats,
            load: AtomicUsize::new(0),
        })
    }

    fn count_recycle(&self, n: usize) {
        self.runtime
            .inner
            .metrics
            .recycles
            .fetch_add(n as u64, Ordering::Relaxed);
    }

    /// Pick a member for one request, without waiting when a live member
    /// exists. Poisoned members (CPU, heap, uncaught error) leave the pool
    /// and the spare takes over: the recycle step of `ops.md` section 10.
    /// The least-loaded member is chosen; when it is busy
    /// ([`POOL_GROW_AT_LOAD`]) and the pool has room, the spare joins (or a
    /// member is created in the background) and the deployment keeps a
    /// spare from then on.
    fn pick_live(self: &Arc<Self>) -> Option<LoadGuard> {
        let mut members = self.members.lock().expect("pool lock");
        let before = members.len();
        members.retain(|t| t.healthy());
        let dead = before - members.len();
        let mut grow = false;
        let picked = match members.iter().min_by_key(|t| t.load.load(Ordering::SeqCst)) {
            None => None,
            Some(best) => {
                let busy = best.load.load(Ordering::SeqCst) >= POOL_GROW_AT_LOAD;
                if busy && members.len() < self.max_members {
                    match self.take_spare() {
                        Some(spare) => {
                            members.push(spare.clone());
                            grow = true;
                            Some(LoadGuard::take(&spare))
                        }
                        None => {
                            grow = true;
                            Some(LoadGuard::take(best))
                        }
                    }
                } else {
                    Some(LoadGuard::take(best))
                }
            }
        };
        // A dead member is replaced by the spare at once.
        for _ in 0..dead {
            if members.len() >= self.max_members {
                break;
            }
            let Some(spare) = self.take_spare() else {
                break;
            };
            members.push(spare);
        }
        let picked = match picked {
            Some(p) => Some(p),
            None => members.first().map(LoadGuard::take),
        };
        // Hot: the pool grew or lost a member; it keeps a spare from now on.
        let hot = members.len() > 1 || grow || (dead > 0 && self.max_members > 1);
        drop(members);
        // Every poisoned member that leaves the pool is one recycle.
        if dead > 0 {
            self.count_recycle(dead);
        }
        if hot {
            self.refill();
        }
        picked
    }

    fn take_spare(&self) -> Option<Arc<IsolateThread>> {
        let mut spare = self.spare.lock().expect("pool lock");
        match spare.take() {
            Some(t) if t.healthy() => Some(t),
            _ => None,
        }
    }

    /// Create one isolate in the background, if none is being created: a
    /// member while the pool is below its size and busy, else the spare.
    fn refill(self: &Arc<Self>) {
        if self.max_members < 2 || self.has_spare() {
            return;
        }
        if self.growing.swap(true, Ordering::SeqCst) {
            return;
        }
        let pool = self.clone();
        tokio::spawn(async move {
            let created = pool.spawn_thread().await;
            let more = match created {
                Ok(t) => {
                    let t = Arc::new(t);
                    let mut members = pool.members.lock().expect("pool lock");
                    let before = members.len();
                    members.retain(|m| m.healthy());
                    let dead = before - members.len();
                    if dead > 0 {
                        pool.count_recycle(dead);
                    }
                    let busy = members
                        .iter()
                        .all(|m| m.load.load(Ordering::SeqCst) >= POOL_GROW_AT_LOAD);
                    if members.len() < pool.max_members && (busy || members.is_empty()) {
                        members.push(t);
                        true
                    } else {
                        drop(members);
                        *pool.spare.lock().expect("pool lock") = Some(t);
                        false
                    }
                }
                Err(e) => {
                    let mut f = serde_json::Map::new();
                    f.insert("code".into(), e.code().as_str().into());
                    f.insert("phase".into(), "module_load".into());
                    f.insert("cause_message".into(), e.to_string().into());
                    pool.log("error", None, "pool isolate creation failed", f);
                    false
                }
            };
            pool.growing.store(false, Ordering::SeqCst);
            // A member joined: the hot deployment still wants its spare.
            if more {
                pool.refill();
            }
        });
    }

    /// A member for one request: a live one, or a fresh isolate when none
    /// is left and no spare is ready. A creation failure is cached for
    /// [`CREATE_FAILURE_CACHE`].
    async fn live_thread(self: &Arc<Self>) -> Result<LoadGuard, CreateError> {
        if let Some(t) = self.pick_live() {
            return Ok(t);
        }
        let _guard = self.respawn.lock().await;
        if let Some(t) = self.pick_live() {
            return Ok(t);
        }
        if let Some((at, err)) = self.last_failure.lock().expect("failure lock").as_ref()
            && at.elapsed() < CREATE_FAILURE_CACHE
        {
            return Err(err.clone());
        }
        match self.spawn_thread().await {
            Ok(t) => {
                let t = Arc::new(t);
                let mut members = self.members.lock().expect("pool lock");
                let before = members.len();
                members.retain(|m| m.healthy());
                let dead = before - members.len();
                members.push(t.clone());
                let guard = LoadGuard::take(&t);
                drop(members);
                if dead > 0 {
                    self.count_recycle(dead);
                }
                Ok(guard)
            }
            Err(e) => {
                *self.last_failure.lock().expect("failure lock") =
                    Some((Instant::now(), e.clone()));
                Err(e)
            }
        }
    }

    /// Write one line to the tenant's log sink (redacted like every line
    /// of this deployment). The cell uses it for render failures.
    pub fn log(
        &self,
        level: &'static str,
        request_id: Option<&str>,
        message: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) {
        self.sink.log(LogLine {
            level,
            tenant_id: self.spec.tenant_id.clone(),
            deployment_hash: self.spec.deployment_hash.clone(),
            request_id: request_id.map(str::to_string),
            message: message.to_string(),
            fields,
        });
    }

    async fn dispatch(self: &Arc<Self>, ctx: RequestCtx, req: http::Request<Bytes>) -> Dispatched {
        let admitted = Instant::now();
        let (parts, body) = req.into_parts();
        let path = parts.uri.path().to_string();
        let method = parts.method.as_str().to_string();
        let (route, params) = match self.router.find(&method, &path) {
            RouteMatch::Found { route, params } => (route, params),
            RouteMatch::NotFound => {
                return Dispatched::plain(
                    PlatformResponse::not_found(&ctx.request_id),
                    InvocationMeter::new(None, MeterStatus::Ok),
                    false,
                );
            }
            RouteMatch::MethodNotAllowed { allow } => {
                return Dispatched::plain(
                    PlatformResponse::method_not_allowed(&ctx.request_id, &allow),
                    InvocationMeter::new(None, MeterStatus::Ok),
                    false,
                );
            }
            RouteMatch::Redirect { location } => {
                // artifact.md section 3, "Trailing slashes": 308, query kept.
                let location = match parts.uri.query() {
                    Some(q) => format!("{location}?{q}"),
                    None => location,
                };
                let response = http::Response::builder()
                    .status(308)
                    .header(http::header::LOCATION, location)
                    .header("x-renox-request-id", ctx.request_id.as_str())
                    .body(Bytes::new())
                    .unwrap_or_else(|_| PlatformResponse::not_found(&ctx.request_id));
                return Dispatched::plain(
                    response,
                    InvocationMeter::new(None, MeterStatus::Ok),
                    false,
                );
            }
        };
        let route_def = &self.artifact.manifest.routes[route];
        let route_name = format!("{} {}", route_def.method.as_str(), route_def.path);
        let is_page = route_def.kind == RouteKind::Page;
        let fragment = if is_page {
            select_fragment(&self.artifact.manifest, route_def, &parts.headers)
        } else {
            None
        };
        let action = match is_page.then(|| page_call(route_def, &method, parts.uri.query())) {
            Some(PageCall::UnknownAction) => {
                // An unknown or missing action name: 404, no tenant code.
                return Dispatched::plain(
                    PlatformResponse::not_found(&ctx.request_id),
                    InvocationMeter::new(None, MeterStatus::Ok),
                    false,
                );
            }
            Some(PageCall::Action(name)) => Some(name),
            _ => None,
        };
        // ops.md section 14: only an htmx request gets out-of-band fragments;
        // a plain form POST gets the full page.
        let htmx = parts
            .headers
            .get("hx-request")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.eq_ignore_ascii_case("true"));
        let session = parts
            .extensions
            .get::<PageSession>()
            .map(|s| s.id.clone())
            .unwrap_or_default();
        if is_page && action.is_none() && route_def.handler_export().is_none() {
            // An `.html` page, or `.ts` + `.html` without `load`: no tenant
            // code runs; the template gets `{}`.
            return Dispatched {
                response: http::Response::new(Bytes::new()),
                meter: InvocationMeter::new(Some(route_name), MeterStatus::Ok),
                render: Some(PageRender {
                    template: route_def.page().and_then(|p| p.template.clone()),
                    fragment,
                    data_json: "{}".into(),
                    oob_fragments: Vec::new(),
                }),
                page: true,
                body: None,
            };
        }
        let deadline = effective_deadline(ctx.deadline, self.limits.wall_ms, admitted);
        let ctx = RequestCtx {
            request_id: ctx.request_id,
            deadline,
        };
        let fail = |code: ErrorCode, status: MeterStatus| {
            Dispatched::plain(
                PlatformResponse::error(code, &ctx.request_id),
                InvocationMeter::new(Some(route_name.clone()), status),
                is_page,
            )
        };

        // Concurrency: queue up to the deadline (ops.md section 10).
        let Ok(permit) = self.concurrency.acquire(deadline).await else {
            let mut f = serde_json::Map::new();
            f.insert("code".into(), "RENOX_BUSY".into());
            f.insert("route".into(), route_name.clone().into());
            f.insert("concurrency_limit".into(), self.limits.concurrency.into());
            f.insert(
                "queued_ms".into(),
                (admitted.elapsed().as_millis() as u64).into(),
            );
            self.log("warn", Some(&ctx.request_id), "concurrency limit", f);
            return fail(ErrorCode::Busy, MeterStatus::Busy);
        };

        let url = absolute_url(&parts);
        let headers: Arc<Vec<(ByteString, ByteString)>> = Arc::new(
            parts
                .headers
                .iter()
                .map(|(k, v)| {
                    (
                        ByteString::from(k.as_str().as_bytes().to_vec()),
                        ByteString::from(v.as_bytes().to_vec()),
                    )
                })
                .collect(),
        );
        let params = Arc::new(params);
        // A member that dies between the pick and the start of the request
        // refuses it (or drops it with its queue); nothing of it ran, so it
        // goes to another member, once.
        let mut attempts = 0;
        let (member, seq, waited) = loop {
            attempts += 1;
            let member = match self.live_thread().await {
                Ok(t) => t,
                Err(e) => {
                    let mut f = serde_json::Map::new();
                    f.insert("code".into(), e.code().as_str().into());
                    f.insert("phase".into(), "module_load".into());
                    f.insert("cause_message".into(), e.to_string().into());
                    self.log("error", Some(&ctx.request_id), "isolate creation failed", f);
                    let status = match e.code() {
                        ErrorCode::CpuLimit => MeterStatus::CpuLimit,
                        ErrorCode::Oom => MeterStatus::Oom,
                        ErrorCode::Deadline => MeterStatus::Timeout,
                        _ => MeterStatus::Error,
                    };
                    return fail(e.code(), status);
                }
            };
            let seq = self.seq.fetch_add(1, Ordering::Relaxed);
            let (reply_tx, reply_rx) = oneshot::channel();
            let job = DispatchJob {
                seq,
                route,
                params: params.clone(),
                want_body: method != "HEAD",
                page: is_page.then(|| PageJob {
                    fragment: fragment.clone(),
                    session: session.clone(),
                    action: action.clone(),
                    template: route_def.page().is_some_and(|p| p.template.is_some()),
                }),
                method: method.clone(),
                url: url.clone(),
                headers: headers.clone(),
                body: body.clone(),
                ctx: ctx.clone(),
                reply: reply_tx,
            };
            // A failed send drops the job and its reply sender: the wait
            // below then ends at once with a closed channel.
            let _ = member.0.tx.send(Command::Dispatch(Box::new(job)));
            let waited = tokio::time::timeout_at(deadline.into(), reply_rx).await;
            match waited {
                Ok(Ok(ThreadReply::Refused)) | Ok(Err(_)) if attempts < 2 => continue,
                waited => break (member, seq, waited),
            }
        };
        let thread = &member.0;
        let reply = match waited {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => ThreadReply::Failed {
                code: ErrorCode::Internal,
                meter: InvocationMeter::new(None, MeterStatus::Error),
            },
            Err(_elapsed) => {
                // Wall clock (ops.md section 10): answer 504 now; the
                // isolate ends the request and cancels its pending ops.
                let (meter_tx, meter_rx) = oneshot::channel();
                let _ = thread.tx.send(Command::Cancel {
                    seq,
                    meter: meter_tx,
                    reason: CancelReason::Deadline,
                });
                let mut meter = tokio::time::timeout(Duration::from_millis(100), meter_rx)
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_else(|| InvocationMeter::new(None, MeterStatus::Timeout));
                meter.status = MeterStatus::Timeout;
                let mut f = serde_json::Map::new();
                f.insert("code".into(), "RENOX_DEADLINE".into());
                f.insert("route".into(), route_name.clone().into());
                f.insert(
                    "wall_ms".into(),
                    (admitted.elapsed().as_millis() as u64).into(),
                );
                f.insert("limit_ms".into(), self.limits.wall_ms.into());
                self.log("warn", Some(&ctx.request_id), "request deadline passed", f);
                ThreadReply::Failed {
                    code: ErrorCode::Deadline,
                    meter,
                }
            }
        };
        match reply {
            ThreadReply::Ok {
                status,
                headers,
                body,
                mut meter,
            } => {
                meter.route = Some(route_name);
                let mut b = http::Response::builder().status(status);
                for (k, v) in headers {
                    b = b.header(k.as_slice(), v.as_slice());
                }
                match b.body(body) {
                    Ok(response) => Dispatched::plain(response, meter, is_page),
                    Err(_) => {
                        meter.status = MeterStatus::Error;
                        Dispatched::plain(
                            PlatformResponse::error(ErrorCode::Internal, &ctx.request_id),
                            meter,
                            is_page,
                        )
                    }
                }
            }
            ThreadReply::Stream {
                status,
                headers,
                body,
                end,
            } => {
                let mut b = http::Response::builder().status(status);
                for (k, v) in headers {
                    // ops.md section 6: no length on a streamed body.
                    if k.as_slice().eq_ignore_ascii_case(b"content-length") {
                        continue;
                    }
                    b = b.header(k.as_slice(), v.as_slice());
                }
                let response = b.body(Bytes::new());
                let stream = ResponseStream {
                    chunks: body,
                    end: Some(end),
                    outcome: None,
                    deadline,
                    seq,
                    member,
                    _permit: permit,
                    pool: self.clone(),
                    request_id: ctx.request_id.clone(),
                    route: route_name.clone(),
                    received: 0,
                    ended: false,
                };
                let Ok(response) = response else {
                    // A head the HTTP types refuse: 500; dropping the
                    // stream ends the request.
                    drop(stream);
                    return fail(ErrorCode::Internal, MeterStatus::Error);
                };
                Dispatched {
                    response,
                    meter: InvocationMeter::new(Some(route_name), MeterStatus::Ok),
                    render: None,
                    page: is_page,
                    body: Some(stream),
                }
            }
            ThreadReply::Render {
                data_json,
                fragments,
                mut meter,
            } => {
                meter.route = Some(route_name.clone());
                // ops.md section 14: an out-of-band name not in the page's
                // fragment map is 500, whether or not the request is htmx.
                let template = route_def.page().and_then(|p| p.template.as_deref());
                let known = self
                    .artifact
                    .manifest
                    .template_defs()
                    .find(|(id, _)| Some(id.as_str()) == template)
                    .and_then(|(_, d)| d.fragments.as_ref());
                if let Some(unknown) = fragments
                    .iter()
                    .find(|f| !known.is_some_and(|k| k.contains_key(*f)))
                {
                    let mut f = serde_json::Map::new();
                    f.insert("code".into(), "RENOX_INTERNAL".into());
                    f.insert("route".into(), route_name.into());
                    f.insert("reason".into(), "unknown_fragment".into());
                    f.insert("fragment".into(), unknown.clone().into());
                    self.log(
                        "error",
                        Some(&ctx.request_id),
                        "action named an unknown fragment",
                        f,
                    );
                    meter.status = MeterStatus::Error;
                    return Dispatched::plain(
                        PlatformResponse::error(ErrorCode::Internal, &ctx.request_id),
                        meter,
                        true,
                    );
                }
                Dispatched {
                    response: http::Response::new(Bytes::new()),
                    meter,
                    render: Some(PageRender {
                        template: route_def.page().and_then(|p| p.template.clone()),
                        fragment,
                        data_json,
                        oob_fragments: if htmx { fragments } else { Vec::new() },
                    }),
                    page: true,
                    body: None,
                }
            }
            ThreadReply::Failed { code, mut meter } => {
                meter.route = Some(route_name);
                Dispatched::plain(
                    PlatformResponse::error(code, &ctx.request_id),
                    meter,
                    is_page,
                )
            }
            // Refused twice: both members died before the request started.
            ThreadReply::Refused => fail(ErrorCode::Internal, MeterStatus::Error),
        }
    }
}

fn absolute_url(parts: &http::request::Parts) -> String {
    if parts.uri.scheme().is_some() && parts.uri.authority().is_some() {
        return parts.uri.to_string();
    }
    let host = parts
        .headers
        .get(http::header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost");
    let pq = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    format!("https://{host}{pq}")
}

// ---------------------------------------------------------------------------
// The isolate thread.

struct ThreadContext {
    runtime: Runtime,
    spec: Arc<IsolateSpec>,
    artifact: Arc<Artifact>,
    limits: Limits,
    allowlist: Arc<Allowlist>,
    secrets: Arc<BTreeMap<String, String>>,
    sink: Arc<dyn LogSink>,
    shared: Arc<ThreadShared>,
}

type ReadyResult = Result<(v8::IsolateHandle, CreateStats), CreateError>;

/// The JavaScript functions the bootstrap hands to Rust.
struct Platform {
    dispatch: v8::Global<v8::Function>,
    /// One handler per `manifest.routes[]` entry; `None` for a page route
    /// without `load` (it never enters the isolate).
    handlers: Vec<Option<v8::Global<v8::Function>>>,
    /// Per route: action name -> function, from the page module's
    /// `export const actions` (empty for every other route).
    actions: Vec<BTreeMap<String, v8::Global<v8::Function>>>,
}

/// The limit machinery of one isolate thread.
struct Guards {
    watchdog: Watchdog,
    heap: Arc<HeapFlag>,
}

fn isolate_thread_main(
    ctx: ThreadContext,
    rx: mpsc::UnboundedReceiver<Command>,
    ready: oneshot::Sender<ReadyResult>,
) {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            let _ = ready.send(Err(CreateError::Internal(format!("tokio runtime: {e}"))));
            return;
        }
    };
    rt.block_on(async move {
        let start = Instant::now();
        let (mut worker, platform, guards, module_time) = match create_worker(&ctx).await {
            Ok(w) => w,
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };
        let heap = heap_stats(&mut worker.js_runtime);
        let stats = CreateStats {
            create_time: start.elapsed(),
            module_time,
            used_heap_bytes: heap.0,
            total_heap_bytes: heap.1,
        };
        let v8_handle = worker.js_runtime.v8_isolate().thread_safe_handle();
        if ready.send(Ok((v8_handle, stats))).is_err() {
            return;
        }
        serve(&ctx, &mut worker, &platform, &guards, rx).await;
        // Dropping `worker` here disposes the isolate on this thread; the
        // watchdog is stopped first (declaration order of the locals).
        drop(guards);
    });
}

fn heap_stats(js: &mut JsRuntime) -> (u64, u64) {
    let s = js.v8_isolate().get_heap_statistics();
    (s.used_heap_size() as u64, s.total_heap_size() as u64)
}

fn worker_options(ctx: &ThreadContext) -> WorkerOptions {
    // Heap limit (ops.md section 10): V8's own limit, plus the
    // near-heap-limit callback installed in create_worker.
    let create_params = v8::CreateParams::default().heap_limits(0, ctx.limits.heap_bytes as usize);
    WorkerOptions {
        bootstrap: BootstrapOptions {
            // Do not leak the host's CPU count through navigator.hardwareConcurrency.
            cpu_count: 1,
            user_agent: "Renox".to_string(),
            ..Default::default()
        },
        extensions: vec![crate::globals::for_isolate()],
        startup_snapshot: Some(ctx.runtime.inner.snapshot),
        residual_lazy_js_sources: ctx.runtime.inner.lazy.js,
        residual_lazy_esm_sources: ctx.runtime.inner.lazy.esm,
        create_params: Some(create_params),
        ..Default::default()
    }
}

/// Bootstrap → capture and harden → tenant modules → handler lookup
/// (`ops.md` section 11, steps 1-5; `harden` takes the secrets, step 3).
async fn create_worker(
    ctx: &ThreadContext,
) -> Result<(MainWorker, Platform, Guards, Duration), CreateError> {
    let manifest = &ctx.artifact.manifest;
    let loader: Rc<ArtifactLoader> = Rc::new(
        match manifest.code.format {
            CodeFormat::EsmDir => ArtifactLoader::esm_dir(&ctx.artifact.code_dir())
                .map_err(|e| CreateError::Internal(e.to_string()))?,
            CodeFormat::Eszip => ArtifactLoader::in_memory(
                crate::loader::eszip_modules(&ctx.artifact)
                    .await
                    .map_err(|e| CreateError::ModuleLoad(e.to_string()))?,
            ),
        }
        .with_code_cache(&ctx.spec.tenant_id, &ctx.spec.deployment_hash),
    );
    let fs: Arc<dyn deno_fs::FileSystem> = Arc::new(deno_fs::RealFs);
    // Step 1: every Deno permission denied, without prompting.
    let permissions = PermissionsContainer::new(
        Arc::new(RuntimePermissionDescriptorParser::new(RealSys)),
        Permissions::none_without_prompt(),
    );
    let entries: Vec<(String, ModuleSpecifier)> = manifest
        .code
        .entry
        .iter()
        .map(|(id, path)| specifier_for(path).map(|s| (id.clone(), s)))
        .collect::<Result<_, _>>()
        .map_err(|e| CreateError::Manifest(e.to_string()))?;
    let main_module = entries
        .first()
        .map(|e| e.1.clone())
        .ok_or_else(|| CreateError::Manifest("no code.entry".into()))?;
    let services = WorkerServiceOptions {
        module_loader: loader,
        permissions,
        blob_store: deno_runtime::deno_web::BlobStore::default_arc(),
        broadcast_channel: Default::default(),
        feature_checker: Default::default(),
        node_services: Default::default(),
        npm_process_state_provider: Default::default(),
        root_cert_store_provider: Default::default(),
        fetch_dns_resolver: Default::default(),
        shared_array_buffer_store: Default::default(),
        compiled_wasm_module_store: Default::default(),
        v8_code_cache: Default::default(),
        bundle_provider: None,
        deno_rt_native_addon_loader: None,
        fs,
    };
    // No Node services: npm resolution never happens at runtime (README,
    // "Module loader"); the type parameters are the ones Deno itself uses.
    let mut worker = MainWorker::bootstrap_from_options::<
        DenoInNpmPackageChecker,
        NpmResolver<RealSys>,
        RealSys,
    >(&main_module, services, worker_options(ctx));

    // Limits: heap callback and CPU watchdog for this isolate's thread.
    let heap_flag = Arc::new(HeapFlag::default());
    heap::install(&mut worker.js_runtime, heap_flag.clone());
    let v8_handle = worker.js_runtime.v8_isolate().thread_safe_handle();
    let watchdog = Watchdog::start(Box::new(move || {
        v8_handle.terminate_execution();
    }))
    .map_err(|e| CreateError::Internal(format!("cpu watchdog: {e}")))?;
    // The ops' environments (ops.md sections 1-4), before any tenant code.
    {
        let state = worker.js_runtime.op_state();
        let mut state = state.borrow_mut();
        state.put(Rc::new(FetchEnv::new(
            (*ctx.allowlist).clone(),
            ctx.runtime.inner.config.fetch.clone(),
            ctx.spec.tenant_id.clone(),
            ctx.spec.deployment_hash.clone(),
            ctx.sink.clone(),
        )));
        state.put(Rc::new(DbEnv {
            db: ctx.spec.db.clone(),
            redactor: Arc::new(Redactor::new(ctx.spec.secrets.values())),
        }));
        state.put(LogEnv {
            sink: ctx.sink.clone(),
            limiter: ctx.runtime.inner.log_limiter.clone(),
            tenant_id: ctx.spec.tenant_id.clone(),
            deployment_hash: ctx.spec.deployment_hash.clone(),
            lines_per_min: ctx.limits.log_lines_per_min,
        });
        // Step 3: consumed once by `harden` (op_secrets_get_all).
        state.put(SecretsState(Some((*ctx.secrets).clone())));
    }
    let guards = Guards {
        watchdog,
        heap: heap_flag,
    };

    // Step 2: take the bootstrap's functions, remove the handle, harden.
    let (dispatch, harden) = {
        let internal = worker
            .js_runtime
            .execute_script(
                "[renox:capture]",
                "const i = globalThis.__renoxInternal; delete globalThis.__renoxInternal; i",
            )
            .map_err(|e| CreateError::Internal(format!("bootstrap capture: {e}")))?;
        deno_core::scope!(scope, &mut worker.js_runtime);
        let obj = v8::Local::new(scope, internal)
            .to_object(scope)
            .ok_or_else(|| CreateError::Internal("bootstrap object missing".into()))?;
        let get = |scope: &mut v8::PinScope,
                   name: &str|
         -> Result<v8::Global<v8::Function>, CreateError> {
            let key = v8::String::new(scope, name).expect("short ASCII string");
            let v = obj
                .get(scope, key.into())
                .ok_or_else(|| CreateError::Internal(format!("bootstrap {name} missing")))?;
            let f = v8::Local::<v8::Function>::try_from(v).map_err(|_| {
                CreateError::Internal(format!("bootstrap {name} is not a function"))
            })?;
            Ok(v8::Global::new(scope, f))
        };
        (get(scope, "dispatch")?, get(scope, "harden")?)
    };
    let harden_call = worker.js_runtime.call_with_args(&harden, &[]);
    worker
        .js_runtime
        .with_event_loop_promise(harden_call, PollEventLoopOptions::default())
        .await
        .map_err(|e| CreateError::Internal(format!("hardening: {e}")))?;

    // Step 4: tenant modules, under the module-evaluation limits
    // (ops.md section 10, last row).
    let module_start = Instant::now();
    let slice = guards
        .watchdog
        .begin_slice(Duration::from_millis(ctx.limits.module_cpu_ms));
    let loaded = tokio::time::timeout(
        Duration::from_millis(ctx.limits.module_wall_ms),
        load_modules(&mut worker, &entries),
    )
    .await;
    guards.watchdog.end_slice(slice);
    let namespaces = match loaded {
        _ if guards.watchdog.watch().fired() => {
            return Err(CreateError::Limit(ErrorCode::CpuLimit));
        }
        _ if guards.heap.hit() => return Err(CreateError::Limit(ErrorCode::Oom)),
        Err(_elapsed) => {
            worker.js_runtime.v8_isolate().terminate_execution();
            return Err(CreateError::Limit(ErrorCode::Deadline));
        }
        Ok(r) => r?,
    };
    let module_time = module_start.elapsed();

    // Step 5: every route's export must be a function, and every declared
    // action a function of `export const actions` (fail closed).
    let (handlers, actions) = {
        deno_core::scope!(scope, &mut worker.js_runtime);
        let mut handlers = Vec::with_capacity(manifest.routes.len());
        let mut actions = Vec::with_capacity(manifest.routes.len());
        for r in &manifest.routes {
            let mut route_actions = BTreeMap::new();
            let declared = r.page().map(|p| p.actions.as_slice()).unwrap_or(&[]);
            if !declared.is_empty() {
                let ns = namespaces.get(&r.module).ok_or_else(|| {
                    CreateError::ModuleLoad(format!(
                        "route {}: module {} not loaded",
                        r.path, r.module
                    ))
                })?;
                let ns = v8::Local::new(scope, ns);
                let key = v8::String::new(scope, "actions")
                    .ok_or_else(|| CreateError::Manifest("export name".into()))?;
                let obj = ns
                    .get(scope, key.into())
                    .and_then(|v| v8::Local::<v8::Object>::try_from(v).ok())
                    .ok_or_else(|| {
                        CreateError::ModuleLoad(format!(
                            "route {}: export actions of {} is missing or not an object",
                            r.path, r.module
                        ))
                    })?;
                for name in declared {
                    let k = v8::String::new(scope, name)
                        .ok_or_else(|| CreateError::Manifest("action name".into()))?;
                    let f = obj
                        .get(scope, k.into())
                        .and_then(|v| v8::Local::<v8::Function>::try_from(v).ok())
                        .ok_or_else(|| {
                            CreateError::ModuleLoad(format!(
                                "route {}: action {name} of {} is missing or not a function",
                                r.path, r.module
                            ))
                        })?;
                    route_actions.insert(name.clone(), v8::Global::new(scope, f));
                }
            }
            actions.push(route_actions);
            if r.handler_export().is_none() {
                handlers.push(None);
                continue;
            }
            let ns = namespaces.get(&r.module).ok_or_else(|| {
                CreateError::ModuleLoad(format!(
                    "route {} {}: module {} not loaded",
                    r.method.as_str(),
                    r.path,
                    r.module
                ))
            })?;
            let ns = v8::Local::new(scope, ns);
            let key = v8::String::new(scope, &r.export)
                .ok_or_else(|| CreateError::Manifest("export name".into()))?;
            let v = ns.get(scope, key.into());
            let f = v
                .and_then(|v| v8::Local::<v8::Function>::try_from(v).ok())
                .ok_or_else(|| {
                    CreateError::ModuleLoad(format!(
                        "route {} {}: export {} of {} is missing or not a function",
                        r.method.as_str(),
                        r.path,
                        r.export,
                        r.module
                    ))
                })?;
            handlers.push(Some(v8::Global::new(scope, f)));
        }
        (handlers, actions)
    };
    Ok((
        worker,
        Platform {
            dispatch,
            handlers,
            actions,
        },
        guards,
        module_time,
    ))
}

async fn load_modules(
    worker: &mut MainWorker,
    entries: &[(String, ModuleSpecifier)],
) -> Result<HashMap<String, v8::Global<v8::Object>>, CreateError> {
    let mut namespaces = HashMap::new();
    for (id, specifier) in entries {
        let module_id = worker
            .preload_side_module(specifier)
            .await
            .map_err(|e| CreateError::ModuleLoad(format!("{id}: {}", tenant_safe(&e))))?;
        worker
            .evaluate_module(module_id)
            .await
            .map_err(|e| CreateError::ModuleLoad(format!("{id}: {}", tenant_safe(&e))))?;
        let ns = worker
            .js_runtime
            .get_module_namespace(module_id)
            .map_err(|e| CreateError::ModuleLoad(format!("{id}: {e}")))?;
        namespaces.insert(id.clone(), ns);
    }
    Ok(namespaces)
}

/// A JS error rendered for the tenant log: `deno_core` errors carry the
/// virtual `file:///` specifiers only, never a path of the machine.
fn tenant_safe(e: &dyn std::fmt::Display) -> String {
    e.to_string()
}

/// What the bootstrap's `dispatch` resolves to.
#[derive(Deserialize)]
struct JsOutcome {
    kind: u8,
    status: Option<u16>,
    headers: Option<Vec<(ByteString, ByteString)>>,
    body: Option<JsBuffer>,
    name: Option<String>,
    message: Option<String>,
    stack: Option<String>,
    code: Option<String>,
    /// `KIND_RENDER`: the loader's object as JSON.
    data_json: Option<String>,
    /// `KIND_PAGE_INTERNAL`: why the page result was refused.
    reason: Option<String>,
    /// `KIND_RENDER` after an action: the out-of-band fragment names.
    fragments: Option<Vec<String>>,
    /// `KIND_OK`: the body streams through `op_response_write` (`ops.md`
    /// section 6).
    stream: Option<bool>,
}

const KIND_OK: u8 = 0;
const KIND_THROW: u8 = 1;
/// A page loader returned an object (`ops.md` section 14).
const KIND_RENDER: u8 = 3;
/// A page loader's result broke a rule (`load_result`, `data_not_serialisable`,
/// `data_too_large`).
const KIND_PAGE_INTERNAL: u8 = 4;

type JsResult<T> = Result<T, Box<deno_core::error::JsError>>;
type CallFuture = Pin<Box<dyn Future<Output = JsResult<v8::Global<v8::Value>>>>>;
/// A dispatch call tagged with its dispatch sequence number.
type SeqCall = Pin<Box<dyn Future<Output = (u64, JsResult<v8::Global<v8::Value>>)>>>;

/// A request the isolate is working on.
struct InFlight {
    token: u32,
    ctx: RequestCtx,
    route: usize,
    /// Thread CPU charged to the request (ns); set from the CPU ledger when
    /// the request ends.
    cpu_ns: u64,
    peak_heap: u64,
    /// What the ops used, taken when the request ends.
    used: RequestEnd,
    reply: Option<oneshot::Sender<ThreadReply>>,
    /// The receiving half of the request's streamed body, handed to the
    /// cell with the head (`ops/response.rs`).
    body: Option<mpsc::Receiver<Bytes>>,
    /// Set once the head of a streamed body was sent: the request ends,
    /// and its meter goes here, when the stream ends.
    stream_end: Option<oneshot::Sender<StreamEnd>>,
}

impl InFlight {
    fn meter(&self, ctx: &ThreadContext, status: MeterStatus) -> InvocationMeter {
        let r = &ctx.artifact.manifest.routes[self.route];
        InvocationMeter {
            route: Some(format!("{} {}", r.method.as_str(), r.path)),
            status,
            cpu_ms: (self.cpu_ns as f64 / 1_000.0).round() / 1_000.0,
            peak_heap_bytes: self.peak_heap,
            fetch_sent_bytes: self.used.fetch_sent_bytes,
            fetch_received_bytes: self.used.fetch_received_bytes,
            fetch_blocked: self.used.fetch_blocked,
            db_ms: (self.used.db_ms * 1_000.0).round() / 1_000.0,
            db_rows: self.used.db_rows,
            logs_dropped: self.used.logs_dropped,
        }
    }
}

// ---------------------------------------------------------------------------
// CPU attribution (#155; limits/cpu.rs, "Accounting").

/// The CPU ledger of the isolate on this thread and the watchdog it steers.
struct Attribution {
    ledger: CpuLedger,
    watch: Arc<CpuWatch>,
    /// A slice is running: switches are charged and re-arm the watchdog.
    in_slice: bool,
}

thread_local! {
    /// Installed by `serve` for the isolate of this thread (one per thread).
    static ATTRIBUTION: RefCell<Option<Attribution>> = const { RefCell::new(None) };
}

/// Run `f` on this thread's ledger, if `serve` installed one.
fn with_attribution<R>(f: impl FnOnce(&mut Attribution) -> R) -> Option<R> {
    ATTRIBUTION.with(|a| {
        let mut a = a.try_borrow_mut().ok()?;
        a.as_mut().map(f)
    })
}

/// Apply a context switch inside a slice; when the running context changed,
/// the watchdog measures the new run against its budget.
fn attribute(change: impl FnOnce(&mut CpuLedger, u64) -> bool) {
    with_attribution(|a| {
        if !a.in_slice {
            return;
        }
        let now = a.watch.now_ns();
        if change(&mut a.ledger, now) {
            a.watch.rebase(now, a.ledger.budget());
        }
    });
}

/// End a request in the ledger; returns its CPU (ns).
fn release_cpu(token: u32) -> u64 {
    with_attribution(|a| {
        let now = a.watch.now_ns();
        let cpu = a.ledger.release(token, now);
        if a.in_slice {
            a.watch.rebase(now, a.ledger.budget());
        }
        cpu
    })
    .unwrap_or(0)
}

/// The key of the request token in the async context object. The
/// bootstrap's `AsyncVariable` builds its context mapping by spreading the
/// previous one (`{ ...previous, [id]: entry }`), so the key survives every
/// `requestVar.enter`; numeric `AsyncVariable` ids never collide with it.
const CPU_TOKEN_KEY: &str = "renox:cpu";

/// The request token in an async context value, if it carries one.
fn context_token(scope: &mut v8::PinScope, cped: v8::Local<v8::Value>) -> Option<u32> {
    let obj = v8::Local::<v8::Object>::try_from(cped).ok()?;
    let key = v8::String::new(scope, CPU_TOKEN_KEY)?;
    let v = obj.get(scope, key.into())?;
    if v.is_uint32() {
        v.uint32_value(scope)
    } else {
        None
    }
}

/// The context's `before` promise hook: a promise reaction (an `await`
/// continuation, a `then` callback) starts. V8 has restored the
/// continuation-preserved embedder data captured when the reaction was
/// created: the async context of the request that created it (see
/// [`CPU_TOKEN_KEY`]) or none.
fn promise_before(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let cped = scope.get_continuation_preserved_embedder_data();
    let token = context_token(scope, cped);
    attribute(|l, now| l.enter(token, now));
}

/// The context's `after` promise hook: back to what the reaction
/// interrupted.
fn promise_after(
    _scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    attribute(|l, now| l.leave(now));
}

/// Install the `before` and `after` hooks on the main context. Context
/// hooks (not the isolate's `SetPromiseHook`) leave `init` and `resolve`
/// unset, so V8 calls into Rust only around reactions and keeps its fast
/// paths for creating and resolving promises.
fn install_promise_hooks(worker: &mut MainWorker) {
    deno_core::scope!(scope, &mut worker.js_runtime);
    let before = v8::Function::new(scope, promise_before);
    let after = v8::Function::new(scope, promise_after);
    scope.set_promise_hooks(None, before, after, None);
}

/// Set the async context that JavaScript started now runs in: a
/// null-prototype object holding the request token under
/// [`CPU_TOKEN_KEY`], or `undefined` for none.
fn set_async_context(worker: &mut MainWorker, token: Option<u32>) {
    deno_core::scope!(scope, &mut worker.js_runtime);
    let v: v8::Local<v8::Value> = match token {
        Some(t) => {
            let key: v8::Local<v8::Name> = v8::String::new(scope, CPU_TOKEN_KEY)
                .expect("short ASCII string")
                .into();
            let value: v8::Local<v8::Value> = v8::Integer::new_from_unsigned(scope, t).into();
            let null = v8::null(scope).into();
            v8::Object::with_prototype_and_properties(scope, null, &[key], &[value]).into()
        }
        None => v8::undefined(scope).into(),
    };
    scope.set_continuation_preserved_embedder_data(v);
}

/// The isolate's main loop: accept dispatches, poll the event loop, and
/// answer finished requests. Each poll is one CPU slice (limits/cpu.rs).
async fn serve(
    ctx: &ThreadContext,
    worker: &mut MainWorker,
    platform: &Platform,
    guards: &Guards,
    mut rx: mpsc::UnboundedReceiver<Command>,
) {
    let cpu_limit = Duration::from_millis(ctx.limits.cpu_ms);
    let mut calls: FuturesUnordered<SeqCall> = FuturesUnordered::new();
    let mut inflight: HashMap<u64, InFlight> = HashMap::new();
    let watch = guards.watchdog.watch().clone();
    ATTRIBUTION.with(|a| {
        *a.borrow_mut() = Some(Attribution {
            ledger: CpuLedger::new(cpu_limit),
            watch: watch.clone(),
            in_slice: false,
        })
    });
    install_promise_hooks(worker);
    std::future::poll_fn(|cx| {
        let budget = with_attribution(|a| a.ledger.budget()).unwrap_or(cpu_limit);
        let slice = guards.watchdog.begin_slice(budget);
        with_attribution(|a| {
            a.ledger.begin(slice);
            a.in_slice = true;
        });
        let mut stop = false;

        // 1. New commands.
        while let Poll::Ready(cmd) = rx.poll_recv(cx) {
            match cmd {
                Some(Command::Dispatch(job)) => {
                    if ctx.shared.poisoned.load(Ordering::SeqCst) {
                        let _ = job.reply.send(ThreadReply::Refused);
                        continue;
                    }
                    let seq = job.seq;
                    // The request is charged from now on; its synchronous
                    // part runs inside start_dispatch, in its own context.
                    match start_dispatch(ctx, worker, platform, *job) {
                        Ok((fut, flight)) => {
                            inflight.insert(seq, flight);
                            calls.push(Box::pin(async move { (seq, fut.await) }));
                        }
                        Err((reply, code)) => {
                            let _ = reply.send(ThreadReply::Failed {
                                code,
                                meter: InvocationMeter::new(None, MeterStatus::Error),
                            });
                        }
                    }
                }
                Some(Command::Cancel { seq, meter, reason }) => {
                    if let Some(mut f) = inflight.remove(&seq) {
                        f.cpu_ns = release_cpu(f.token);
                        f.used = end_request(ctx, worker, f.token, Ended::Terminated);
                        let _ = meter.send(f.meter(ctx, reason.status()));
                    }
                }
                Some(Command::Terminate) | None => {
                    stop = true;
                    break;
                }
            }
        }

        // 2. The event loop: timers, ops, microtasks.
        let mut loop_error = None;
        if !stop
            && !watch.fired()
            && !guards.heap.hit()
            && let Poll::Ready(Err(e)) = worker
                .js_runtime
                .poll_event_loop(cx, PollEventLoopOptions::default())
        {
            loop_error = Some(e);
        }

        // 3. Finished dispatches.
        if !watch.fired() && !guards.heap.hit() {
            while let Poll::Ready(Some((seq, result))) = calls.poll_next_unpin(cx) {
                let Some(mut flight) = inflight.remove(&seq) else {
                    continue;
                };
                flight.peak_heap = flight
                    .peak_heap
                    .max(heap::used_heap_bytes(&mut worker.js_runtime));
                if watch.fired() || guards.heap.hit() {
                    inflight.insert(seq, flight);
                    break;
                }
                let outcome = read_outcome(worker, result);
                if let Ok(o) = &outcome
                    && o.kind == KIND_OK
                    && o.stream == Some(true)
                    && let Some(body) = flight.body.take()
                {
                    // Head first (ops.md section 6): the request goes on
                    // until its stream ends (step 3b).
                    let (end_tx, end_rx) = oneshot::channel();
                    let head = ThreadReply::Stream {
                        status: o.status.unwrap_or(200),
                        headers: o.headers.clone().unwrap_or_default(),
                        body,
                        end: end_rx,
                    };
                    if let Some(tx) = flight.reply.take() {
                        let _ = tx.send(head);
                    }
                    flight.stream_end = Some(end_tx);
                    inflight.insert(seq, flight);
                    continue;
                }
                flight.cpu_ns = release_cpu(flight.token);
                flight.used = end_request(ctx, worker, flight.token, Ended::Finished);
                let reply = finish_dispatch(ctx, &flight, outcome);
                if flight.used.rolled_back_tx {
                    let threw = matches!(reply, ThreadReply::Failed { .. });
                    if threw {
                        count_termination_rollback(ctx);
                    }
                    let mut f = serde_json::Map::new();
                    f.insert(
                        "route".into(),
                        flight
                            .meter(ctx, MeterStatus::Ok)
                            .route
                            .unwrap_or_default()
                            .into(),
                    );
                    let message = if threw {
                        "request failed with a transaction open; rolled back"
                    } else {
                        "transaction left open when the handler returned; rolled back"
                    };
                    log_line(ctx, "warn", Some(&flight.ctx.request_id), message, f);
                }
                if let Some(tx) = flight.reply.take() {
                    let _ = tx.send(reply);
                }
            }
            // 3b. Streamed bodies that ended (ops/response.rs).
            end_streams(ctx, worker, &mut inflight);
        }

        // End of slice: charge the last run, record the heap peak.
        with_attribution(|a| {
            a.ledger.end(a.watch.now_ns());
            a.in_slice = false;
        });
        guards.watchdog.end_slice(slice);
        let heap_now = heap::used_heap_bytes(&mut worker.js_runtime);
        for f in inflight.values_mut() {
            f.peak_heap = f.peak_heap.max(heap_now);
        }

        // 4. Limits hit: the isolate is poisoned and every request in flight
        // ends with the limit's code (ops.md section 10).
        let killed = if watch.fired() {
            Some((ErrorCode::CpuLimit, MeterStatus::CpuLimit))
        } else if guards.heap.hit() {
            Some((ErrorCode::Oom, MeterStatus::Oom))
        } else {
            loop_error
                .as_ref()
                .map(|_| (ErrorCode::Internal, MeterStatus::Error))
        };
        if let Some((code, status)) = killed {
            ctx.shared.poisoned.store(true, Ordering::SeqCst);
            for (_, mut flight) in inflight.drain() {
                flight.cpu_ns = release_cpu(flight.token);
                flight.used = end_request(ctx, worker, flight.token, Ended::Terminated);
                let mut f = serde_json::Map::new();
                f.insert("code".into(), code.as_str().into());
                f.insert(
                    "route".into(),
                    flight.meter(ctx, status).route.unwrap_or_default().into(),
                );
                let streaming = flight.stream_end.is_some();
                f.insert(
                    "phase".into(),
                    if streaming { "stream" } else { "request" }.into(),
                );
                if streaming {
                    f.insert("sent_bytes".into(), flight.used.response_sent_bytes.into());
                }
                match code {
                    ErrorCode::CpuLimit => {
                        f.insert("cpu_ms".into(), flight.meter(ctx, status).cpu_ms.into());
                        f.insert("limit_ms".into(), ctx.limits.cpu_ms.into());
                    }
                    ErrorCode::Oom => {
                        f.insert("peak_heap_bytes".into(), flight.peak_heap.into());
                        f.insert("limit_bytes".into(), ctx.limits.heap_bytes.into());
                    }
                    _ => {
                        if let Some(e) = &loop_error {
                            f.insert("cause_message".into(), tenant_safe(e).into());
                        }
                    }
                }
                let message = match code {
                    ErrorCode::CpuLimit => "request CPU limit reached; isolate recycled",
                    ErrorCode::Oom => "isolate heap limit reached; isolate recycled",
                    _ => "uncaught error in the isolate event loop; isolate recycled",
                };
                log_line(ctx, "error", Some(&flight.ctx.request_id), message, f);
                let meter = flight.meter(ctx, status);
                if let Some(end) = flight.stream_end.take() {
                    // After the head: the body is truncated (ops.md section
                    // 10, "Mid-stream").
                    let _ = end.send(StreamEnd {
                        meter,
                        complete: false,
                    });
                } else if let Some(tx) = flight.reply.take() {
                    let _ = tx.send(ThreadReply::Failed { code, meter });
                }
            }
            if inflight.is_empty() && code != ErrorCode::Internal {
                // Orphaned work (a timer after its request) hit the limit.
                let mut f = serde_json::Map::new();
                f.insert("code".into(), code.as_str().into());
                f.insert("phase".into(), "background".into());
                log_line(
                    ctx,
                    "error",
                    None,
                    "limit reached outside a request; isolate recycled",
                    f,
                );
            }
            return Poll::Ready(());
        }
        if stop {
            // Disposal: requests still in flight get no answer, but their
            // resources are released before the isolate goes.
            for (_, mut flight) in inflight.drain() {
                release_cpu(flight.token);
                flight.used = end_request(ctx, worker, flight.token, Ended::Terminated);
            }
            return Poll::Ready(());
        }
        Poll::Pending
    })
    .await;
    ATTRIBUTION.with(|a| a.borrow_mut().take());
}

/// What a request's ops used, and what had to be cleaned up when it ended.
#[derive(Debug, Clone, Copy, Default)]
struct RequestEnd {
    fetch_sent_bytes: u64,
    fetch_received_bytes: u64,
    fetch_blocked: u64,
    db_ms: f64,
    db_rows: u64,
    logs_dropped: u64,
    /// An open transaction was rolled back.
    rolled_back_tx: bool,
    /// Bytes `op_response_write` took for a streamed body.
    response_sent_bytes: u64,
}

/// How a request ended, for the rollback counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ended {
    /// The dispatch finished: a `Response`, a throw, or not a `Response`
    /// (the caller counts a throw as a termination).
    Finished,
    /// Deadline, CPU or heap limit, event-loop error, or disposal.
    Terminated,
}

fn count_termination_rollback(ctx: &ThreadContext) {
    ctx.runtime
        .inner
        .metrics
        .rolled_back_on_termination
        .fetch_add(1, Ordering::Relaxed);
}

/// End a request: its token stops working, its pending ops (fetches
/// waiting for headers, timers' ops) are cancelled, and its registered
/// resources are released (`request_resources::drain`): fetch bodies
/// closed, open transaction rolled back. The DB thread handles the rollback
/// before anything sent later, so the next request finds the writer free.
fn end_request(
    ctx: &ThreadContext,
    worker: &mut MainWorker,
    token: u32,
    ended: Ended,
) -> RequestEnd {
    let state = worker.js_runtime.op_state();
    let mut state = state.borrow_mut();
    // The body's channel closes once a pending write lets go of it.
    let response_sent_bytes = state
        .borrow_mut::<ResponseSinks>()
        .0
        .remove(&token)
        .map_or(0, |s| s.sent_bytes);
    let Some(request) = state.borrow_mut::<RequestTable>().end(token) else {
        return RequestEnd {
            response_sent_bytes,
            ..RequestEnd::default()
        };
    };
    let mut request = request.borrow_mut();
    let rolled_back_tx =
        request_resources::drain(&mut state, &mut request.resources).rolled_back_tx;
    if rolled_back_tx {
        ctx.runtime
            .inner
            .metrics
            .rolled_back_transactions
            .fetch_add(1, Ordering::Relaxed);
        if ended == Ended::Terminated {
            count_termination_rollback(ctx);
        }
    }
    RequestEnd {
        fetch_sent_bytes: request.egress.sent.load(Ordering::Relaxed),
        fetch_received_bytes: request.egress.received.load(Ordering::Relaxed),
        fetch_blocked: request.fetch_blocked,
        db_ms: request.db_ms,
        db_rows: request.db_rows,
        logs_dropped: request.logs_dropped,
        rolled_back_tx,
        response_sent_bytes,
    }
}

/// Step 3b of the serve loop: end the requests whose streamed body ended
/// (`ops.md` sections 7 and 10, "Mid-stream"). A report for a request whose
/// head has not been sent yet waits for the next slice.
fn end_streams(
    ctx: &ThreadContext,
    worker: &mut MainWorker,
    inflight: &mut HashMap<u64, InFlight>,
) {
    let events = {
        let state = worker.js_runtime.op_state();
        let mut state = state.borrow_mut();
        std::mem::take(&mut state.borrow_mut::<StreamEvents>().0)
    };
    if events.is_empty() {
        return;
    }
    let mut later = Vec::new();
    for (token, event) in events {
        let Some(seq) = inflight
            .iter()
            .find(|(_, f)| f.token == token)
            .map(|(seq, _)| *seq)
        else {
            continue;
        };
        if inflight[&seq].stream_end.is_none() {
            later.push((token, event));
            continue;
        }
        let Some(mut flight) = inflight.remove(&seq) else {
            continue;
        };
        flight.cpu_ns = release_cpu(token);
        flight.used = end_request(ctx, worker, token, Ended::Finished);
        let route = flight.meter(ctx, MeterStatus::Ok).route.unwrap_or_default();
        let (status, complete) = match event {
            StreamEvent::End(None) => (MeterStatus::Ok, true),
            StreamEvent::ClientGone => (MeterStatus::Ok, false),
            StreamEvent::End(Some(message)) => {
                let mut f = serde_json::Map::new();
                f.insert("route".into(), route.into());
                f.insert("reason".into(), "stream_error".into());
                f.insert("cause_message".into(), message.into());
                f.insert("sent_bytes".into(), flight.used.response_sent_bytes.into());
                log_line(
                    ctx,
                    "error",
                    Some(&flight.ctx.request_id),
                    "response stream failed; body truncated",
                    f,
                );
                (MeterStatus::Error, false)
            }
            StreamEvent::EgressLimit {
                limit_bytes,
                sent_bytes,
            } => {
                let mut f = serde_json::Map::new();
                f.insert("route".into(), route.into());
                f.insert("reason".into(), "egress_limit".into());
                f.insert("limit_bytes".into(), limit_bytes.into());
                f.insert("sent_bytes".into(), sent_bytes.into());
                log_line(
                    ctx,
                    "warn",
                    Some(&flight.ctx.request_id),
                    "response egress limit reached; body truncated",
                    f,
                );
                (MeterStatus::Error, false)
            }
        };
        if let Some(end) = flight.stream_end.take() {
            let _ = end.send(StreamEnd {
                meter: flight.meter(ctx, status),
                complete,
            });
        }
    }
    if !later.is_empty() {
        let state = worker.js_runtime.op_state();
        let mut state = state.borrow_mut();
        state.borrow_mut::<StreamEvents>().0.extend(later);
    }
}

fn log_line(
    ctx: &ThreadContext,
    level: &'static str,
    request_id: Option<&str>,
    message: &str,
    fields: serde_json::Map<String, serde_json::Value>,
) {
    ctx.sink.log(LogLine {
        level,
        tenant_id: ctx.spec.tenant_id.clone(),
        deployment_hash: ctx.spec.deployment_hash.clone(),
        request_id: request_id.map(str::to_string),
        message: message.to_string(),
        fields,
    });
}

type StartResult = Result<(CallFuture, InFlight), (oneshot::Sender<ThreadReply>, ErrorCode)>;

fn start_dispatch(
    ctx: &ThreadContext,
    worker: &mut MainWorker,
    platform: &Platform,
    job: DispatchJob,
) -> StartResult {
    let egress_limit_bytes = ctx.limits.egress_bytes;
    let (token, body) = {
        let state = worker.js_runtime.op_state();
        let mut state = state.borrow_mut();
        let token = state.borrow_mut::<RequestTable>().begin(RequestState::new(
            job.ctx.request_id.clone(),
            job.ctx.deadline,
            egress_limit_bytes,
        ));
        // ops.md section 10: the response egress limit has the tier's
        // egress value, on a counter of its own.
        let body = state
            .borrow_mut::<ResponseSinks>()
            .open(token, egress_limit_bytes);
        (token, body)
    };
    let args = {
        deno_core::scope!(scope, &mut worker.js_runtime);
        build_args(scope, platform, token, &job)
    };
    let args = match args {
        Ok(a) => a,
        Err(_) => {
            end_request(ctx, worker, token, Ended::Terminated);
            return Err((job.reply, ErrorCode::Internal));
        }
    };
    // The handler runs in the request's async context; V8 carries it into
    // every reaction the handler creates (CPU attribution, #155).
    with_attribution(|a| {
        let now = a.watch.now_ns();
        a.ledger.admit(token, now)
    });
    set_async_context(worker, Some(token));
    attribute(|l, now| l.switch(Some(token), now));
    let fut = worker.js_runtime.call_with_args(&platform.dispatch, &args);
    attribute(|l, now| l.switch(None, now));
    set_async_context(worker, None);
    Ok((
        Box::pin(fut),
        InFlight {
            token,
            ctx: job.ctx,
            route: job.route,
            cpu_ns: 0,
            peak_heap: 0,
            used: RequestEnd::default(),
            reply: Some(job.reply),
            body: Some(body),
            stream_end: None,
        },
    ))
}

fn build_args(
    scope: &mut v8::PinScope,
    platform: &Platform,
    token: u32,
    job: &DispatchJob,
) -> Result<Vec<v8::Global<v8::Value>>, serde_v8::Error> {
    let action_name = job.page.as_ref().and_then(|p| p.action.as_ref());
    let handler: v8::Local<v8::Value> = match &platform.handlers[job.route] {
        Some(h) => v8::Local::new(scope, h).into(),
        // An action on a page without `load`.
        None if action_name.is_some() => v8::null(scope).into(),
        None => return Err(serde_v8::Error::Message("route has no handler".into())),
    };
    let action: v8::Local<v8::Value> = match action_name {
        Some(name) => match platform.actions[job.route].get(name) {
            Some(f) => v8::Local::new(scope, f).into(),
            None => return Err(serde_v8::Error::Message("unknown action".into())),
        },
        None => v8::null(scope).into(),
    };
    let token_v: v8::Local<v8::Value> = v8::Integer::new_from_unsigned(scope, token).into();
    let method: v8::Local<v8::Value> = serde_v8::to_v8(scope, &job.method)?;
    let url: v8::Local<v8::Value> = serde_v8::to_v8(scope, &job.url)?;
    let headers: v8::Local<v8::Value> = serde_v8::to_v8(scope, job.headers.as_slice())?;
    let body: v8::Local<v8::Value> = if job.body.is_empty() {
        v8::null(scope).into()
    } else {
        serde_v8::to_v8(scope, ToJsBuffer::from(job.body.to_vec()))?
    };
    let params_json: serde_json::Map<String, serde_json::Value> = job
        .params
        .iter()
        .map(|(k, v)| {
            let v = match v {
                ParamValue::One(s) => serde_json::Value::String(s.clone()),
                ParamValue::Many(list) => serde_json::Value::Array(
                    list.iter()
                        .cloned()
                        .map(serde_json::Value::String)
                        .collect(),
                ),
            };
            (k.clone(), v)
        })
        .collect();
    let params: v8::Local<v8::Value> = serde_v8::to_v8(scope, &params_json)?;
    let want: v8::Local<v8::Value> = v8::Boolean::new(scope, job.want_body).into();
    let page: v8::Local<v8::Value> = match &job.page {
        Some(p) => serde_v8::to_v8(
            scope,
            serde_json::json!({
                "fragment": p.fragment,
                "session": p.session,
                "action": p.action,
                "template": p.template,
            }),
        )?,
        None => v8::null(scope).into(),
    };
    Ok([
        handler, token_v, method, url, headers, body, params, want, page, action,
    ]
    .into_iter()
    .map(|l| v8::Global::new(scope, l))
    .collect())
}

/// What the bootstrap's `dispatch` resolved to.
fn read_outcome(
    worker: &mut MainWorker,
    result: JsResult<v8::Global<v8::Value>>,
) -> Result<JsOutcome, String> {
    match result {
        Ok(v) => {
            deno_core::scope!(scope, &mut worker.js_runtime);
            let local = v8::Local::new(scope, v);
            serde_v8::from_v8(scope, local).map_err(|e| e.to_string())
        }
        Err(e) => Err(tenant_safe(&e)),
    }
}

fn finish_dispatch(
    ctx: &ThreadContext,
    flight: &InFlight,
    outcome: Result<JsOutcome, String>,
) -> ThreadReply {
    let route = &ctx.artifact.manifest.routes[flight.route];
    let route_name = format!("{} {}", route.method.as_str(), route.path);
    let no_template = route.page().is_some_and(|p| p.template.is_none());
    let page_internal = |reason: &str, detail: Option<String>| {
        // ops.md section 14: the reason and detail go to the tenant log only.
        let mut f = serde_json::Map::new();
        f.insert("code".into(), "RENOX_INTERNAL".into());
        f.insert("route".into(), route_name.clone().into());
        f.insert("phase".into(), "request".into());
        f.insert("reason".into(), reason.into());
        if let Some(d) = detail {
            f.insert("cause_message".into(), d.into());
        }
        log_line(
            ctx,
            "error",
            Some(&flight.ctx.request_id),
            "page loader result refused",
            f,
        );
        ThreadReply::Failed {
            code: ErrorCode::Internal,
            meter: flight.meter(ctx, MeterStatus::Error),
        }
    };
    match outcome {
        Ok(o) if o.kind == KIND_RENDER => match o.data_json {
            Some(_) if no_template => page_internal(
                "no_template",
                Some("load returned an object on a page without a template".into()),
            ),
            Some(json) if json.len() > MAX_DATA_JSON_BYTES => page_internal(
                "data_too_large",
                Some(format!("{} bytes of JSON", json.len())),
            ),
            Some(data_json) => ThreadReply::Render {
                data_json,
                fragments: o.fragments.unwrap_or_default(),
                meter: flight.meter(ctx, MeterStatus::Ok),
            },
            None => page_internal("data_not_serialisable", None),
        },
        Ok(o) if o.kind == KIND_PAGE_INTERNAL => {
            let reason = o.reason.clone().unwrap_or_else(|| "load_result".into());
            let detail = o
                .name
                .clone()
                .map(|n| format!("the page handler returned {n}"));
            page_internal(&reason, detail)
        }
        Ok(o) if o.kind == KIND_OK => ThreadReply::Ok {
            status: o.status.unwrap_or(200),
            headers: o.headers.unwrap_or_default(),
            body: o
                .body
                .map(|b| Bytes::copy_from_slice(&b))
                .unwrap_or_default(),
            meter: flight.meter(ctx, MeterStatus::Ok),
        },
        Ok(o) => {
            // The handler threw or returned something that is not a
            // Response: 500 RENOX_INTERNAL, cause to the tenant log only
            // (ops.md section 6; errors.md, RENOX_INTERNAL row).
            let mut f = serde_json::Map::new();
            f.insert("code".into(), "RENOX_INTERNAL".into());
            f.insert("route".into(), route_name.clone().into());
            f.insert("phase".into(), "request".into());
            let message = if o.kind == KIND_THROW {
                if let Some(code) = &o.code {
                    f.insert("cause_code".into(), code.clone().into());
                }
                f.insert(
                    "cause_name".into(),
                    o.name.clone().unwrap_or_default().into(),
                );
                f.insert(
                    "cause_message".into(),
                    o.message.clone().unwrap_or_default().into(),
                );
                f.insert("stack".into(), o.stack.clone().unwrap_or_default().into());
                "handler threw"
            } else {
                f.insert(
                    "cause_message".into(),
                    format!(
                        "handler returned {} instead of a Response",
                        o.name.clone().unwrap_or_default()
                    )
                    .into(),
                );
                "handler did not return a Response"
            };
            log_line(ctx, "error", Some(&flight.ctx.request_id), message, f);
            let status = if o.code.as_deref() == Some("RENOX_FETCH_BLOCKED") {
                MeterStatus::BlockedFetch
            } else {
                MeterStatus::Error
            };
            ThreadReply::Failed {
                code: ErrorCode::Internal,
                meter: flight.meter(ctx, status),
            }
        }
        Err(e) => {
            let mut f = serde_json::Map::new();
            f.insert("code".into(), "RENOX_INTERNAL".into());
            f.insert("route".into(), route_name.clone().into());
            f.insert("cause_message".into(), e.into());
            log_line(
                ctx,
                "error",
                Some(&flight.ctx.request_id),
                "dispatch failed",
                f,
            );
            ThreadReply::Failed {
                code: ErrorCode::Internal,
                meter: flight.meter(ctx, MeterStatus::Error),
            }
        }
    }
}
