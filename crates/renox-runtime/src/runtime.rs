//! Process-wide runtime: V8 platform, the platform snapshot, configuration
//! shared by every isolate, and the tenant log sink.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::isolate::{CreateError, IsolateHandle, IsolateSpec};
use crate::ops::fetch::FetchConfig;

/// One line for the tenant's log sink (`docs/contracts/ops.md` section 4,
/// `docs/contracts/errors.md` section 2).
#[derive(Debug, Clone, PartialEq)]
pub struct LogLine {
    pub level: &'static str,
    pub tenant_id: String,
    pub deployment_hash: String,
    pub request_id: Option<String>,
    pub message: String,
    pub fields: serde_json::Map<String, serde_json::Value>,
}

/// Where tenant log lines go. `renox-cell` supplies the real sink (#28);
/// tests capture lines.
pub trait LogSink: Send + Sync {
    fn log(&self, line: LogLine);
}

/// Writes JSON lines to stderr. The default when no sink is configured.
pub struct StderrLogSink;

impl LogSink for StderrLogSink {
    fn log(&self, line: LogLine) {
        let v = serde_json::json!({
            "level": line.level,
            "tenant_id": line.tenant_id,
            "deployment_hash": line.deployment_hash,
            "request_id": line.request_id,
            "message": line.message,
            "fields": line.fields,
        });
        eprintln!("{v}");
    }
}

/// A sink that keeps every line in memory (tests, `renox dev`).
#[derive(Default)]
pub struct MemoryLogSink {
    lines: Mutex<Vec<LogLine>>,
}

impl MemoryLogSink {
    pub fn lines(&self) -> Vec<LogLine> {
        self.lines.lock().expect("log sink lock").clone()
    }
}

impl LogSink for MemoryLogSink {
    fn log(&self, line: LogLine) {
        self.lines.lock().expect("log sink lock").push(line);
    }
}

/// Configuration shared by every isolate of the process.
#[derive(Clone)]
pub struct RuntimeConfig {
    pub log_sink: Arc<dyn LogSink>,
    /// Outbound `fetch`: resolver, node-blocked addresses, trust anchors.
    pub fetch: FetchConfig,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        RuntimeConfig {
            log_sink: Arc::new(StderrLogSink),
            fetch: FetchConfig::default(),
        }
    }
}

/// Counters the cell exports as metrics.
#[derive(Debug, Default)]
pub struct RuntimeMetrics {
    /// Isolates replaced after a CPU or heap limit (#26).
    pub recycles: AtomicU64,
    pub isolates_created: AtomicU64,
}

impl RuntimeMetrics {
    pub fn recycles(&self) -> u64 {
        self.recycles.load(Ordering::Relaxed)
    }
}

pub(crate) struct RuntimeInner {
    pub snapshot: &'static [u8],
    pub lazy: &'static LazySources,
    pub config: RuntimeConfig,
    pub metrics: RuntimeMetrics,
}

/// The process-wide runtime. Cheap to clone.
#[derive(Clone)]
pub struct Runtime {
    pub(crate) inner: Arc<RuntimeInner>,
}

/// How long building the platform snapshot took (once per process).
static SNAPSHOT: OnceLock<(&'static [u8], &'static LazySources, Duration)> = OnceLock::new();

/// Extension scripts `deno_runtime` loads lazily (`core.loadExtScript`) that
/// are not compiled into the snapshot: `(specifier, source)` pairs handed to
/// every worker (`WorkerOptions::residual_lazy_*_sources`).
pub(crate) struct LazySources {
    pub js: &'static [(&'static str, &'static str)],
    pub esm: &'static [(&'static str, &'static str)],
}

/// V8 flags set once, before the platform is initialised.
///
/// `--enable-sharedarraybuffer-per-context`: `SharedArrayBuffer` exists
/// only in contexts the embedder enables, and we never enable one, so
/// shared `WebAssembly.Memory` is refused too (`ops.md` section 11).
const V8_FLAGS: &[&str] = &["--enable-sharedarraybuffer-per-context"];

fn init_platform_once() {
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        let mut args = vec![String::from("renox")];
        args.extend(V8_FLAGS.iter().map(|f| f.to_string()));
        let unknown = deno_core::v8_set_flags(args);
        assert_eq!(
            unknown,
            vec![String::from("renox")],
            "unknown V8 flags: {unknown:?}"
        );
        // Initialise V8 in non-snapshotting mode first, so the snapshot
        // built below does not switch the whole process into
        // `--predictable` (README, "Platform snapshot").
        deno_core::JsRuntime::init_platform(None);
    });
}

/// Build the platform snapshot: every `deno_runtime` extension plus the
/// `renox` extension's ESM bootstrap, evaluated once.
fn build_snapshot() -> (&'static [u8], &'static LazySources, Duration) {
    let start = Instant::now();
    let path = std::env::temp_dir().join(format!(
        "renox-snapshot-{}-{}.bin",
        std::process::id(),
        start.elapsed().as_nanos()
    ));
    // Snapshot creation drives its own Tokio runtime, so it runs on a thread
    // of its own (Runtime::new may be called from async code).
    let target = path.clone();
    let output = std::thread::Builder::new()
        .name("renox-snapshot".into())
        .spawn(move || {
            deno_runtime::snapshot::create_runtime_snapshot(
                target,
                deno_runtime::ops::bootstrap::SnapshotOptions::default(),
                vec![crate::globals::for_snapshot()],
            )
        })
        .expect("spawn the snapshot thread")
        .join()
        .expect("build the platform snapshot");
    // Lazy files not consumed by the snapshot are read now, once, from the
    // Deno crates' sources (README, "Platform snapshot").
    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
    let (mut js, mut esm) = (Vec::new(), Vec::new());
    for f in &output.lazy_extension_files {
        if output.consumed_lazy_specifiers.contains(&f.specifier) {
            continue;
        }
        let source = std::fs::read_to_string(&f.path).expect("read a lazy extension source");
        // TypeScript sources (Node polyfills, timers) are transpiled here,
        // as Deno's own build script does before embedding them.
        let (code, _) = deno_runtime::transpile::maybe_transpile_source(
            deno_core::ModuleName::from(f.specifier.clone()),
            deno_core::ModuleCodeString::from(source),
        )
        .expect("transpile a lazy extension source");
        let pair = (leak(f.specifier.clone()), leak(code.as_str().to_string()));
        match f.kind {
            deno_runtime::snapshot::LazyExtensionFileKind::Js => js.push(pair),
            deno_runtime::snapshot::LazyExtensionFileKind::Esm => esm.push(pair),
        }
    }
    let lazy: &'static LazySources = Box::leak(Box::new(LazySources {
        js: Box::leak(js.into_boxed_slice()),
        esm: Box::leak(esm.into_boxed_slice()),
    }));
    let bytes = std::fs::read(&path).expect("read the platform snapshot just written");
    let _ = std::fs::remove_file(&path);
    (Box::leak(bytes.into_boxed_slice()), lazy, start.elapsed())
}

impl Runtime {
    /// Initialise V8 (once per process), build the platform snapshot (once
    /// per process), and return a runtime handle.
    pub fn new(config: RuntimeConfig) -> Runtime {
        init_platform_once();
        let (snapshot, lazy, _) = *SNAPSHOT.get_or_init(build_snapshot);
        Runtime {
            inner: Arc::new(RuntimeInner {
                snapshot,
                lazy,
                config,
                metrics: RuntimeMetrics::default(),
            }),
        }
    }

    /// Time spent building the platform snapshot in this process.
    pub fn snapshot_build_time() -> Option<Duration> {
        SNAPSHOT.get().map(|s| s.2)
    }

    pub fn snapshot_bytes(&self) -> usize {
        self.inner.snapshot.len()
    }

    pub fn metrics(&self) -> &RuntimeMetrics {
        &self.inner.metrics
    }

    /// Create the isolate of one deployment: load and verify the artifact,
    /// start the isolate from the snapshot on its own thread, evaluate the
    /// tenant modules, and look up every route's handler.
    pub async fn create_isolate(&self, spec: IsolateSpec) -> Result<IsolateHandle, CreateError> {
        IsolateHandle::create(self.clone(), spec).await
    }
}
