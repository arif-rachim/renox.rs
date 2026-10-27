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

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::{Duration, Instant};

use bytes::Bytes;
use deno_core::error::AnyError;
use deno_core::serde_v8;
use deno_core::v8;
use deno_core::{
    ByteString, JsBuffer, JsRuntime, ModuleSpecifier, PollEventLoopOptions, ToJsBuffer,
};
use deno_runtime::BootstrapOptions;
use deno_runtime::deno_permissions::{Permissions, PermissionsContainer};
use deno_runtime::permissions::RuntimePermissionDescriptorParser;
use deno_runtime::worker::{MainWorker, WorkerOptions, WorkerServiceOptions};
use futures::stream::{FuturesUnordered, StreamExt};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};

use crate::error::{ErrorCode, PlatformResponse};
use crate::limits::Limits;
use crate::limits::concurrency::ConcurrencyLimit;
use crate::limits::cpu::Watchdog;
use crate::limits::heap::{self, HeapFlag};
use crate::limits::wall::effective_deadline;
use crate::loader::{ArtifactLoader, specifier_for};
use crate::manifest::{Artifact, CodeFormat, LoadError, load_artifact};
use crate::ops::fetch::{FetchEnv, close_request_bodies};
use crate::ops::net_policy::Allowlist;
use crate::ops::request::{RequestState, RequestTable};
use crate::router::{ParamValue, RouteMatch, Router};
use crate::runtime::{LogLine, Runtime};

/// What the cell asks for when it creates a deployment's isolate.
#[derive(Debug, Clone)]
pub struct IsolateSpec {
    pub tenant_id: String,
    pub deployment_hash: String,
    /// The artifact directory; its name must be `deployment_hash` (V2).
    pub artifact_dir: PathBuf,
    /// Tier limits; the manifest may lower them.
    pub limits: Limits,
    /// Decrypted secrets of the deployment. Consumed by `op_secrets_get_all`
    /// (#28); not exposed to tenant code by this crate yet.
    pub secrets: BTreeMap<String, String>,
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
        }
    }
}

/// The result of one dispatch.
#[derive(Debug)]
pub struct Dispatched {
    pub response: http::Response<Bytes>,
    pub meter: InvocationMeter,
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
    params: BTreeMap<String, ParamValue>,
    method: String,
    url: String,
    headers: Vec<(ByteString, ByteString)>,
    body: Bytes,
    want_body: bool,
    ctx: RequestCtx,
    reply: oneshot::Sender<ThreadReply>,
}

enum Command {
    Dispatch(Box<DispatchJob>),
    /// The request's deadline passed on the handle side: end it now and
    /// report what it used.
    Cancel {
        seq: u64,
        meter: oneshot::Sender<InvocationMeter>,
    },
    Terminate,
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
    /// The request ended with a platform error.
    Failed {
        code: ErrorCode,
        meter: InvocationMeter,
    },
}

/// Shared state between a handle and its isolate thread.
struct ThreadShared {
    poisoned: AtomicBool,
}

/// One live isolate on its thread.
struct IsolateThread {
    tx: mpsc::UnboundedSender<Command>,
    v8_handle: v8::IsolateHandle,
    shared: Arc<ThreadShared>,
    stats: CreateStats,
}

impl Drop for IsolateThread {
    fn drop(&mut self) {
        // The thread disposes the isolate itself when its channel closes,
        // so dropping a handle never blocks on V8.
        let _ = self.tx.send(Command::Terminate);
    }
}

/// The handle of one deployment's isolate. Cheap to share (`Arc`).
pub struct IsolateHandle {
    runtime: Runtime,
    spec: Arc<IsolateSpec>,
    artifact: Arc<Artifact>,
    router: Arc<Router>,
    allowlist: Arc<Allowlist>,
    limits: Limits,
    concurrency: ConcurrencyLimit,
    seq: AtomicU64,
    current: Mutex<Option<Arc<IsolateThread>>>,
    /// Serialises re-creation so concurrent requests build one isolate.
    respawn: tokio::sync::Mutex<()>,
    last_failure: Mutex<Option<(Instant, CreateError)>>,
}

impl IsolateHandle {
    pub(crate) async fn create(
        runtime: Runtime,
        spec: IsolateSpec,
    ) -> Result<IsolateHandle, CreateError> {
        let artifact = load_artifact(&spec.artifact_dir).map_err(CreateError::Artifact)?;
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
        let handle = IsolateHandle {
            runtime,
            spec: Arc::new(spec),
            artifact: Arc::new(artifact),
            router: Arc::new(router),
            allowlist: Arc::new(allowlist),
            limits,
            concurrency: ConcurrencyLimit::new(limits.concurrency),
            seq: AtomicU64::new(0),
            current: Mutex::new(None),
            respawn: tokio::sync::Mutex::new(()),
            last_failure: Mutex::new(None),
        };
        let thread = handle.spawn_thread().await?;
        *handle.current.lock().expect("isolate lock") = Some(Arc::new(thread));
        Ok(handle)
    }

    /// The effective limits (tier limits lowered by the manifest).
    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// Free concurrency slots of the deployment.
    pub fn available_slots(&self) -> usize {
        self.concurrency.available()
    }

    /// Creation numbers of the current isolate.
    pub fn stats(&self) -> Option<CreateStats> {
        self.current
            .lock()
            .expect("isolate lock")
            .as_ref()
            .map(|t| t.stats)
    }

    /// Stop the current isolate: running JavaScript is terminated and the
    /// isolate is disposed on its thread. The next dispatch creates a new one.
    pub fn terminate(&self) {
        if let Some(t) = self.current.lock().expect("isolate lock").take() {
            t.shared.poisoned.store(true, Ordering::SeqCst);
            t.v8_handle.terminate_execution();
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
        })
    }

    fn healthy(&self) -> Option<Arc<IsolateThread>> {
        let cur = self.current.lock().expect("isolate lock");
        match cur.as_ref() {
            Some(t) if !t.shared.poisoned.load(Ordering::SeqCst) => Some(t.clone()),
            _ => None,
        }
    }

    /// The live isolate, or a fresh one if the current one was poisoned
    /// (CPU, heap, uncaught error) or terminated: the recycle step of
    /// `ops.md` section 10. A creation failure is cached for
    /// [`CREATE_FAILURE_CACHE`].
    async fn live_thread(&self) -> Result<Arc<IsolateThread>, CreateError> {
        if let Some(t) = self.healthy() {
            return Ok(t);
        }
        let _guard = self.respawn.lock().await;
        if let Some(t) = self.healthy() {
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
                let old = self
                    .current
                    .lock()
                    .expect("isolate lock")
                    .replace(t.clone());
                if old.is_some() {
                    self.runtime
                        .inner
                        .metrics
                        .recycles
                        .fetch_add(1, Ordering::Relaxed);
                }
                Ok(t)
            }
            Err(e) => {
                *self.last_failure.lock().expect("failure lock") =
                    Some((Instant::now(), e.clone()));
                Err(e)
            }
        }
    }

    fn log(
        &self,
        level: &'static str,
        request_id: Option<&str>,
        message: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) {
        self.runtime.inner.config.log_sink.log(LogLine {
            level,
            tenant_id: self.spec.tenant_id.clone(),
            deployment_hash: self.spec.deployment_hash.clone(),
            request_id: request_id.map(str::to_string),
            message: message.to_string(),
            fields,
        });
    }

    /// Dispatch one request to the handler its route names.
    ///
    /// `req`'s URI must be absolute (`https://<host><path>?<query>`), or its
    /// `Host` header is used with `https`. 404 and 405 are answered here
    /// without entering the isolate. The request then waits for one of the
    /// deployment's concurrency slots (503 `RENOX_BUSY` at the deadline),
    /// runs under the CPU and heap limits, and is answered with 504
    /// `RENOX_DEADLINE` at its deadline whatever the handler does after.
    pub async fn dispatch(&self, ctx: RequestCtx, req: http::Request<Bytes>) -> Dispatched {
        let admitted = Instant::now();
        let (parts, body) = req.into_parts();
        let path = parts.uri.path().to_string();
        let method = parts.method.as_str().to_string();
        let (route, params) = match self.router.find(&method, &path) {
            RouteMatch::Found { route, params } => (route, params),
            RouteMatch::NotFound => {
                return Dispatched {
                    response: PlatformResponse::not_found(&ctx.request_id),
                    meter: InvocationMeter::new(None, MeterStatus::Ok),
                };
            }
            RouteMatch::MethodNotAllowed { allow } => {
                return Dispatched {
                    response: PlatformResponse::method_not_allowed(&ctx.request_id, &allow),
                    meter: InvocationMeter::new(None, MeterStatus::Ok),
                };
            }
        };
        let route_def = &self.artifact.manifest.routes[route];
        let route_name = format!("{} {}", route_def.method.as_str(), route_def.path);
        let deadline = effective_deadline(ctx.deadline, self.limits.wall_ms, admitted);
        let ctx = RequestCtx {
            request_id: ctx.request_id,
            deadline,
        };
        let fail = |code: ErrorCode, status: MeterStatus| Dispatched {
            response: PlatformResponse::error(code, &ctx.request_id),
            meter: InvocationMeter::new(Some(route_name.clone()), status),
        };

        // Concurrency: queue up to the deadline (ops.md section 10).
        let Ok(_permit) = self.concurrency.acquire(deadline).await else {
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

        let thread = match self.live_thread().await {
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
        let url = absolute_url(&parts);
        let headers = parts
            .headers
            .iter()
            .map(|(k, v)| {
                (
                    ByteString::from(k.as_str().as_bytes().to_vec()),
                    ByteString::from(v.as_bytes().to_vec()),
                )
            })
            .collect();
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let (reply_tx, reply_rx) = oneshot::channel();
        let job = DispatchJob {
            seq,
            route,
            params,
            want_body: method != "HEAD",
            method,
            url,
            headers,
            body,
            ctx: ctx.clone(),
            reply: reply_tx,
        };
        if thread.tx.send(Command::Dispatch(Box::new(job))).is_err() {
            return fail(ErrorCode::Internal, MeterStatus::Error);
        }
        let reply = match tokio::time::timeout_at(deadline.into(), reply_rx).await {
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
                    Ok(response) => Dispatched { response, meter },
                    Err(_) => {
                        meter.status = MeterStatus::Error;
                        Dispatched {
                            response: PlatformResponse::error(ErrorCode::Internal, &ctx.request_id),
                            meter,
                        }
                    }
                }
            }
            ThreadReply::Failed { code, mut meter } => {
                meter.route = Some(route_name);
                Dispatched {
                    response: PlatformResponse::error(code, &ctx.request_id),
                    meter,
                }
            }
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
    shared: Arc<ThreadShared>,
}

type ReadyResult = Result<(v8::IsolateHandle, CreateStats), CreateError>;

/// The JavaScript functions the bootstrap hands to Rust.
struct Platform {
    dispatch: v8::Global<v8::Function>,
    /// One handler per `manifest.routes[]` entry.
    handlers: Vec<v8::Global<v8::Function>>,
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
    let mut s = v8::HeapStatistics::default();
    js.v8_isolate().get_heap_statistics(&mut s);
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
        create_params: Some(create_params),
        ..Default::default()
    }
}

/// Bootstrap → capture and harden → tenant modules → handler lookup
/// (`ops.md` section 11, steps 1, 2, 4, 5; step 3 is #28).
async fn create_worker(
    ctx: &ThreadContext,
) -> Result<(MainWorker, Platform, Guards, Duration), CreateError> {
    let manifest = &ctx.artifact.manifest;
    let loader: Rc<ArtifactLoader> = Rc::new(match manifest.code.format {
        CodeFormat::EsmDir => ArtifactLoader::esm_dir(&ctx.artifact.code_dir())
            .map_err(|e| CreateError::Internal(e.to_string()))?,
        CodeFormat::Eszip => ArtifactLoader::in_memory(
            crate::loader::eszip_modules(&ctx.artifact)
                .await
                .map_err(|e| CreateError::ModuleLoad(e.to_string()))?,
        ),
    });
    let fs = Arc::new(deno_fs::RealFs);
    // Step 1: every Deno permission denied, without prompting.
    let permissions = PermissionsContainer::new(
        Arc::new(RuntimePermissionDescriptorParser::new(fs.clone())),
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
        blob_store: Default::default(),
        broadcast_channel: Default::default(),
        feature_checker: Default::default(),
        node_services: Default::default(),
        npm_process_state_provider: Default::default(),
        root_cert_store_provider: Default::default(),
        fetch_dns_resolver: Default::default(),
        shared_array_buffer_store: Default::default(),
        compiled_wasm_module_store: Default::default(),
        v8_code_cache: Default::default(),
        fs,
    };
    let mut worker = MainWorker::bootstrap_from_options(main_module, services, worker_options(ctx));

    // Limits: heap callback and CPU watchdog for this isolate's thread.
    let heap_flag = Arc::new(HeapFlag::default());
    heap::install(&mut worker.js_runtime, heap_flag.clone());
    let v8_handle = worker.js_runtime.v8_isolate().thread_safe_handle();
    let watchdog = Watchdog::start(Box::new(move || {
        v8_handle.terminate_execution();
    }))
    .map_err(|e| CreateError::Internal(format!("cpu watchdog: {e}")))?;
    // op_fetch's environment (ops.md section 2), before any tenant code.
    worker
        .js_runtime
        .op_state()
        .borrow_mut()
        .put(Rc::new(FetchEnv::new(
            (*ctx.allowlist).clone(),
            ctx.runtime.inner.config.fetch.clone(),
            ctx.spec.tenant_id.clone(),
            ctx.spec.deployment_hash.clone(),
            ctx.runtime.inner.config.log_sink.clone(),
        )));
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
        let scope = &mut worker.js_runtime.handle_scope();
        let obj = v8::Local::new(scope, internal)
            .to_object(scope)
            .ok_or_else(|| CreateError::Internal("bootstrap object missing".into()))?;
        let get = |scope: &mut v8::HandleScope,
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

    // Step 5: every route's export must be a function (fail closed).
    let handlers = {
        let scope = &mut worker.js_runtime.handle_scope();
        let mut handlers = Vec::with_capacity(manifest.routes.len());
        for r in &manifest.routes {
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
            handlers.push(v8::Global::new(scope, f));
        }
        handlers
    };
    Ok((worker, Platform { dispatch, handlers }, guards, module_time))
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
fn tenant_safe(e: &AnyError) -> String {
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
}

const KIND_OK: u8 = 0;
const KIND_THROW: u8 = 1;

type CallFuture = Pin<Box<dyn Future<Output = Result<v8::Global<v8::Value>, AnyError>>>>;
/// A dispatch call tagged with its dispatch sequence number.
type SeqCall = Pin<Box<dyn Future<Output = (u64, Result<v8::Global<v8::Value>, AnyError>)>>>;

/// A request the isolate is working on.
struct InFlight {
    token: u32,
    ctx: RequestCtx,
    route: usize,
    /// Thread CPU charged so far (ns), not counting the current slice.
    cpu_ns: u64,
    /// CPU of the current slice that ran before this request joined it (ns).
    slice_offset_ns: u64,
    peak_heap: u64,
    /// `fetch_sent_bytes`, `fetch_received_bytes`, `fetch_blocked`, taken
    /// when the request ends.
    fetch: (u64, u64, u64),
    reply: Option<oneshot::Sender<ThreadReply>>,
}

impl InFlight {
    fn meter(&self, ctx: &ThreadContext, status: MeterStatus) -> InvocationMeter {
        let r = &ctx.artifact.manifest.routes[self.route];
        InvocationMeter {
            route: Some(format!("{} {}", r.method.as_str(), r.path)),
            status,
            cpu_ms: (self.cpu_ns as f64 / 1_000.0).round() / 1_000.0,
            peak_heap_bytes: self.peak_heap,
            fetch_sent_bytes: self.fetch.0,
            fetch_received_bytes: self.fetch.1,
            fetch_blocked: self.fetch.2,
        }
    }
}

/// How much CPU the current slice may use, measured from the slice start:
/// the smallest remaining budget among the requests in flight (a request
/// that joined mid-slice is offset by the slice CPU before it joined). With
/// nothing in flight (a timer that outlived its request) the per-request
/// limit still applies, so orphaned work cannot spin forever.
fn slice_budget(limit: Duration, inflight: &HashMap<u64, InFlight>) -> Duration {
    let limit_ns = limit.as_nanos() as u64;
    let min_left = inflight
        .values()
        .map(|f| limit_ns.saturating_sub(f.cpu_ns) + f.slice_offset_ns)
        .min()
        .unwrap_or(limit_ns);
    Duration::from_nanos(min_left)
}

impl InFlight {
    /// Charge the part of the current slice this request was in flight for.
    fn charge(&mut self, slice_cpu_ns: u64) {
        self.cpu_ns += slice_cpu_ns.saturating_sub(self.slice_offset_ns);
        self.slice_offset_ns = 0;
    }
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
    std::future::poll_fn(|cx| {
        let slice = guards
            .watchdog
            .begin_slice(slice_budget(cpu_limit, &inflight));
        let watch = guards.watchdog.watch().clone();
        let slice_cpu = |watch: &crate::limits::cpu::CpuWatch| watch.now_ns().saturating_sub(slice);
        let mut stop = false;

        // 1. New commands.
        while let Poll::Ready(cmd) = rx.poll_recv(cx) {
            match cmd {
                Some(Command::Dispatch(job)) => {
                    if ctx.shared.poisoned.load(Ordering::SeqCst) {
                        let _ = job.reply.send(ThreadReply::Failed {
                            code: ErrorCode::Internal,
                            meter: InvocationMeter::new(None, MeterStatus::Error),
                        });
                        continue;
                    }
                    let seq = job.seq;
                    // A request that joins mid-slice is charged only from
                    // now on, and its synchronous part already runs inside
                    // start_dispatch, under its own budget.
                    let offset = slice_cpu(&watch);
                    guards.watchdog.set_budget(
                        slice_budget(cpu_limit, &inflight)
                            .min(Duration::from_nanos(offset) + cpu_limit),
                    );
                    match start_dispatch(worker, platform, ctx.limits.egress_bytes, *job) {
                        Ok((fut, mut flight)) => {
                            flight.slice_offset_ns = offset;
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
                    guards
                        .watchdog
                        .set_budget(slice_budget(cpu_limit, &inflight));
                }
                Some(Command::Cancel { seq, meter }) => {
                    if let Some(mut f) = inflight.remove(&seq) {
                        f.charge(slice_cpu(&watch));
                        f.fetch = end_request(worker, f.token);
                        let _ = meter.send(f.meter(ctx, MeterStatus::Timeout));
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
                flight.charge(slice_cpu(&watch));
                flight.peak_heap = flight
                    .peak_heap
                    .max(heap::used_heap_bytes(&mut worker.js_runtime));
                if watch.fired() || guards.heap.hit() {
                    inflight.insert(seq, flight);
                    break;
                }
                flight.fetch = end_request(worker, flight.token);
                let reply = finish_dispatch(ctx, worker, &flight, result);
                if let Some(tx) = flight.reply.take() {
                    let _ = tx.send(reply);
                }
            }
        }

        // End of slice: charge every request still in flight.
        let used = guards.watchdog.end_slice(slice).as_nanos() as u64;
        let heap_now = heap::used_heap_bytes(&mut worker.js_runtime);
        for f in inflight.values_mut() {
            f.charge(used);
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
                flight.fetch = end_request(worker, flight.token);
                let mut f = serde_json::Map::new();
                f.insert("code".into(), code.as_str().into());
                f.insert(
                    "route".into(),
                    flight.meter(ctx, status).route.unwrap_or_default().into(),
                );
                f.insert("phase".into(), "request".into());
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
                if let Some(tx) = flight.reply.take() {
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
            return Poll::Ready(());
        }
        Poll::Pending
    })
    .await;
}

/// End a request: its token stops working, its pending ops are cancelled,
/// its fetch bodies are closed. Returns its fetch meter fields.
fn end_request(worker: &mut MainWorker, token: u32) -> (u64, u64, u64) {
    let state = worker.js_runtime.op_state();
    let mut state = state.borrow_mut();
    let Some(request) = state.borrow_mut::<RequestTable>().end(token) else {
        return (0, 0, 0);
    };
    let request = request.borrow();
    close_request_bodies(&mut state, &request);
    (
        request.egress.sent.load(Ordering::Relaxed),
        request.egress.received.load(Ordering::Relaxed),
        request.fetch_blocked,
    )
}

fn log_line(
    ctx: &ThreadContext,
    level: &'static str,
    request_id: Option<&str>,
    message: &str,
    fields: serde_json::Map<String, serde_json::Value>,
) {
    ctx.runtime.inner.config.log_sink.log(LogLine {
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
    worker: &mut MainWorker,
    platform: &Platform,
    egress_limit_bytes: u64,
    job: DispatchJob,
) -> StartResult {
    let token = {
        let state = worker.js_runtime.op_state();
        let mut state = state.borrow_mut();
        state.borrow_mut::<RequestTable>().begin(RequestState::new(
            job.ctx.request_id.clone(),
            job.ctx.deadline,
            egress_limit_bytes,
        ))
    };
    let args = {
        let scope = &mut worker.js_runtime.handle_scope();
        build_args(scope, platform, token, &job)
    };
    let args = match args {
        Ok(a) => a,
        Err(_) => {
            end_request(worker, token);
            return Err((job.reply, ErrorCode::Internal));
        }
    };
    let fut = worker.js_runtime.call_with_args(&platform.dispatch, &args);
    Ok((
        Box::pin(fut),
        InFlight {
            token,
            ctx: job.ctx,
            route: job.route,
            cpu_ns: 0,
            slice_offset_ns: 0,
            peak_heap: 0,
            fetch: (0, 0, 0),
            reply: Some(job.reply),
        },
    ))
}

fn build_args(
    scope: &mut v8::HandleScope,
    platform: &Platform,
    token: u32,
    job: &DispatchJob,
) -> Result<Vec<v8::Global<v8::Value>>, AnyError> {
    let handler: v8::Local<v8::Value> = v8::Local::new(scope, &platform.handlers[job.route]).into();
    let token_v: v8::Local<v8::Value> = v8::Integer::new_from_unsigned(scope, token).into();
    let method: v8::Local<v8::Value> = serde_v8::to_v8(scope, &job.method)?;
    let url: v8::Local<v8::Value> = serde_v8::to_v8(scope, &job.url)?;
    let headers: v8::Local<v8::Value> = serde_v8::to_v8(scope, &job.headers)?;
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
    Ok([handler, token_v, method, url, headers, body, params, want]
        .into_iter()
        .map(|l| v8::Global::new(scope, l))
        .collect())
}

fn finish_dispatch(
    ctx: &ThreadContext,
    worker: &mut MainWorker,
    flight: &InFlight,
    result: Result<v8::Global<v8::Value>, AnyError>,
) -> ThreadReply {
    let route = &ctx.artifact.manifest.routes[flight.route];
    let route_name = format!("{} {}", route.method.as_str(), route.path);
    let outcome: Result<JsOutcome, String> = match result {
        Ok(v) => {
            let scope = &mut worker.js_runtime.handle_scope();
            let local = v8::Local::new(scope, v);
            serde_v8::from_v8(scope, local).map_err(|e| e.to_string())
        }
        Err(e) => Err(tenant_safe(&e)),
    };
    match outcome {
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
