//! `renox-worker --config <worker.toml> --child <tenant> --socket <path>`
//! (#254): one tenant's own worker process. The same binary and config as
//! the supervisor, with:
//!
//! - one tenant only: a request for any other tenant id is 403
//!   `RENOX_TENANT_MISMATCH` ([`ipc::TENANT_MISMATCH`]);
//! - no gateway listener and no control-plane client: requests come from
//!   the supervisor over the Unix socket, and so do each deployment's
//!   metadata and secrets (`prepare`); artifacts are read from the
//!   `artifacts_dir` the supervisor fills;
//! - meters and logs to the node's files (local mode) or to the spool the
//!   supervisor's replayer ships (controlled mode, `spool.rs`), with the
//!   node's `node_id`;
//! - the sandbox of #253 with this tenant's data dir only (`renox-worker`
//!   applies Landlock before the runtime starts, [`child_profile`]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use http::{Request, Response, StatusCode};
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use renox_gateway::CellDispatcher;
use renox_meter::{Meter, MeterConfig, NdjsonFileSink};
use renox_runtime::ops::fetch::FetchConfig;
use renox_runtime::ops::log::NdjsonLogSink;
use renox_runtime::ops::net_policy::ExtraBlocked;
use renox_runtime::{LogLine, LogSink, Runtime, RuntimeConfig};
use tokio::net::UnixListener;
use tokio::sync::Notify;

use super::{Prepare, ipc};
use crate::artifact::LocalArtifactStore;
use crate::cell::{SecretsError, SecretsFuture, SecretsRequest, SecretsSource};
use crate::config::{Mode, WorkerConfig};
use crate::control::log_sink::to_wire;
use crate::manager::{CellManager, DeploymentLookup, DeploymentMeta, ManagerConfig};
use crate::pages::PlatformKey;
use crate::sandbox::Profile;
use crate::spool::Queue;
use crate::tiers::TierName;

/// The deployments the supervisor handed over (`prepare`).
#[derive(Default)]
pub struct Handover {
    deployments: Mutex<HashMap<String, Prepare>>,
}

impl DeploymentLookup for Handover {
    fn lookup(&self, _tenant_id: &str, deployment_hash: &str) -> DeploymentMeta {
        let d = self.deployments.lock().expect("handover lock");
        match d.get(deployment_hash) {
            Some(p) => DeploymentMeta {
                tier: if p.tier == "paid" {
                    TierName::Paid
                } else {
                    TierName::Free
                },
                app: p.app.clone(),
                secrets_version: p.secrets_version,
            },
            None => DeploymentMeta {
                tier: TierName::Free,
                app: None,
                secrets_version: 0,
            },
        }
    }
}

impl SecretsSource for Handover {
    fn secrets(&self, request: SecretsRequest) -> SecretsFuture<'_> {
        let found = self
            .deployments
            .lock()
            .expect("handover lock")
            .get(&request.deployment_hash)
            .filter(|p| p.secrets_version == request.secrets_version)
            .map(|p| p.secrets.clone());
        Box::pin(async move {
            found.ok_or_else(|| {
                SecretsError::Unavailable(
                    "the supervisor has not handed over this deployment".into(),
                )
            })
        })
    }
}

/// Controlled mode: each line as a one-line `log_batch` in the spool, which
/// the supervisor's replayer ships (`spool.rs`).
struct SpoolLogSink {
    queue: Queue,
    node_id: String,
}

impl LogSink for SpoolLogSink {
    fn log(&self, line: LogLine) {
        let body = serde_json::json!({
            "type": "log_batch",
            "schema_version": 0,
            "node_id": self.node_id,
            "lines": [to_wire(line)],
        });
        self.queue
            .append(&serde_json::to_vec(&body).unwrap_or_default());
    }
}

/// The sandbox profile of `tenant`'s child: the worker's, with the data
/// dir narrowed to the tenant's own (and the spool in controlled mode).
pub fn child_profile(config: &WorkerConfig, tenant: &str, exe_dir: Option<&Path>) -> Profile {
    let mut p = Profile::from_config(config, exe_dir);
    p.read_write.retain(|d| d != &config.data_dir);
    p.read_write.push(config.data_dir.join(tenant));
    if config.mode == Mode::Controlled {
        p.read_write.push(config.data_dir.join("spool"));
    }
    if let Some(socket_dir) = config.process.run_dir.join("children").parent() {
        p.read_write.push(socket_dir.join("children"));
    }
    p.bind_ports.clear();
    p
}

/// Why the child stopped.
#[derive(Debug)]
pub struct ChildError(pub String);

impl std::fmt::Display for ChildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "child: {}", self.0)
    }
}

/// Serves `tenant` on `socket` until the supervisor sends `shutdown` (or
/// the socket's accept fails).
pub async fn serve(
    config: WorkerConfig,
    tenant: String,
    socket: PathBuf,
) -> Result<(), ChildError> {
    if !crate::cell::valid_tenant_id(&tenant) {
        return Err(ChildError(format!("invalid tenant id {tenant:?}")));
    }
    let err = |what: &str| {
        let what = what.to_string();
        move |e: std::io::Error| ChildError(format!("{what}: {e}"))
    };
    std::fs::create_dir_all(config.data_dir.join(&tenant)).map_err(err("tenant dir"))?;
    let log_sink: Arc<dyn LogSink> = match config.mode {
        Mode::Controlled => Arc::new(SpoolLogSink {
            queue: Queue::logs(&config.data_dir),
            node_id: config.node_id.clone(),
        }),
        Mode::Local => {
            std::fs::create_dir_all(&config.logs_dir).map_err(err("logs dir"))?;
            let f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(config.logs_dir.join("tenant.ndjson"))
                .map_err(err("open the tenant log"))?;
            Arc::new(NdjsonLogSink::new(Box::new(f)))
        }
    };
    let fetch = FetchConfig {
        extra_blocked: ExtraBlocked(config.fetch_blocked_addresses.clone()),
        ..Default::default()
    };
    let runtime = Runtime::new(RuntimeConfig { log_sink, fetch });
    let mut meter_config = MeterConfig::new(
        &config.node_id,
        &config.node_id,
        &config.data_dir.join(&tenant),
    );
    meter_config.flush_interval = Duration::from_millis(config.meter_flush_ms.max(1));
    let meters_dir = match config.mode {
        Mode::Controlled => Queue::meters(&config.data_dir).dir,
        Mode::Local => config.meters_dir.clone(),
    };
    meter_config.dead_letter = NdjsonFileSink::new(meters_dir.join("dead"));
    let meter = Meter::start(meter_config, NdjsonFileSink::new(&meters_dir));
    let platform_key = match &config.platform_key_file {
        Some(path) => {
            PlatformKey::load(path).map_err(|e| ChildError(format!("platform key: {e}")))?
        }
        None => PlatformKey::random(),
    };
    let handover = Arc::new(Handover::default());
    let manager = CellManager::new(
        runtime,
        meter,
        ManagerConfig {
            data_dir: config.data_dir.clone(),
            artifacts: Arc::new(LocalArtifactStore::new(&config.artifacts_dir)),
            idle_timeout: config.idle_timeout(),
            tiers: config.tier_table(),
            deployments: handover.clone(),
            secrets: handover.clone(),
            platform_key,
        },
    );
    if config.replication.enabled {
        let r = crate::replication::Replication::start(
            config.replication.clone(),
            config.mode,
            &config.node_id,
            &config.data_dir,
            &config.process.run_dir,
        );
        manager.set_db_lifecycle(Arc::new(r));
    }
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).map_err(err("bind the child socket"))?;
    super::set_mode(&socket, 0o600);
    // #253: from here on only the allowlist.
    if config.sandbox.enabled {
        let exe = std::env::current_exe().ok();
        let profile = child_profile(&config, &tenant, exe.as_deref().and_then(Path::parent));
        crate::sandbox::restrict_syscalls(&profile).map_err(|e| ChildError(e.to_string()))?;
    }
    tracing::info!(tenant_id = %tenant, socket = %socket.display(), pid = std::process::id(), "child listening");
    let stop = Arc::new(Notify::new());
    let state = Arc::new(State {
        tenant,
        manager,
        handover,
        stop: stop.clone(),
    });
    loop {
        tokio::select! {
            _ = stop.notified() => break,
            accepted = listener.accept() => {
                let (stream, _) = accepted.map_err(err("accept"))?;
                let state = state.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req: Request<hyper::body::Incoming>| {
                        let state = state.clone();
                        async move { Ok::<_, std::convert::Infallible>(state.handle(req.map(Body::new)).await) }
                    });
                    if let Err(e) = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await
                    {
                        tracing::debug!(error = %e, "child connection ended");
                    }
                });
            }
        }
    }
    // Drain: let in-flight requests finish (twice the paid wall-clock limit at most).
    let started = std::time::Instant::now();
    while state.manager.cell_count() > 0 && started.elapsed() < Duration::from_secs(120) {
        state.manager.sync_routes(&[]);
        if state.manager.cell_count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    state.manager.meter().flush_and_close().await;
    let _ = std::fs::remove_file(&socket);
    tracing::info!(tenant_id = %state.tenant, "child stopped");
    Ok(())
}

struct State {
    tenant: String,
    manager: CellManager,
    handover: Arc<Handover>,
    stop: Arc<Notify>,
}

impl State {
    async fn handle(&self, mut req: Request<Body>) -> Response<Body> {
        let kind = req
            .headers_mut()
            .remove(ipc::H_KIND)
            .and_then(|v| v.to_str().ok().map(str::to_string));
        match kind.as_deref() {
            Some("prepare") => {
                let bytes = match axum::body::to_bytes(req.into_body(), 1 << 20).await {
                    Ok(b) => b,
                    Err(_) => {
                        return ipc::error(
                            StatusCode::BAD_REQUEST,
                            "RENOX_VALIDATION",
                            "The request is not valid.",
                        );
                    }
                };
                match serde_json::from_slice::<Prepare>(&bytes) {
                    Ok(p) if p.tenant_id == self.tenant => {
                        self.handover
                            .deployments
                            .lock()
                            .expect("handover lock")
                            .insert(p.deployment_hash.clone(), p);
                        Response::new(Body::empty())
                    }
                    Ok(_) => ipc::error(
                        StatusCode::FORBIDDEN,
                        ipc::TENANT_MISMATCH,
                        "This process serves another tenant.",
                    ),
                    Err(_) => ipc::error(
                        StatusCode::BAD_REQUEST,
                        "RENOX_VALIDATION",
                        "The request is not valid.",
                    ),
                }
            }
            Some("shutdown") => {
                self.stop.notify_one();
                Response::new(Body::empty())
            }
            #[cfg(feature = "test-support")]
            Some("test-fork") if std::env::var_os("RENOX_TEST_FORK").is_some() => test_fork().await,
            Some(_) => ipc::error(
                StatusCode::BAD_REQUEST,
                "RENOX_VALIDATION",
                "The request is not valid.",
            ),
            None => {
                let Some(ctx) = ipc::decode_ctx(req.headers_mut()) else {
                    return ipc::error(
                        StatusCode::BAD_REQUEST,
                        "RENOX_VALIDATION",
                        "The request is not valid.",
                    );
                };
                if ctx.tenant_id != self.tenant {
                    tracing::warn!(own = %self.tenant, asked = %ctx.tenant_id, "request for another tenant refused");
                    return ipc::error(
                        StatusCode::FORBIDDEN,
                        ipc::TENANT_MISMATCH,
                        "This process serves another tenant.",
                    );
                }
                self.manager.dispatch(ctx, req).await
            }
        }
    }
}

/// Test only (`RENOX_TEST_FORK` and the `test-support` feature): start
/// processes until the kernel refuses (the child's `pids.max`), answer how
/// many started, then stop them.
#[cfg(feature = "test-support")]
async fn test_fork() -> Response<Body> {
    let mut children = Vec::new();
    let mut refused = None;
    for _ in 0..10_000 {
        match tokio::process::Command::new("sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => children.push(c),
            Err(e) => {
                refused = Some(e.to_string());
                break;
            }
        }
    }
    let started = children.len();
    drop(children);
    let body = serde_json::json!({ "started": started, "refused": refused });
    Response::new(Body::from(body.to_string()))
}

/// Secrets in a [`Prepare`] are never printed.
impl std::fmt::Debug for Handover {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let n = self.deployments.lock().map(|d| d.len()).unwrap_or(0);
        f.debug_struct("Handover").field("deployments", &n).finish()
    }
}
