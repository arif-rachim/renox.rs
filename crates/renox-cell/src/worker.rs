//! The worker process: config → runtime, meter, route table, cell manager,
//! gateway. The `renox-worker` binary is a thin `main` around [`Worker`];
//! tests start it in-process.
//!
//! The gateway serves plain HTTP/1.1 only, on a unix socket behind
//! `cloudflared` in production (`listen = "unix:…"`, #414) or on a TCP
//! address. TLS, certificates, ACME and HTTP/2 end at Cloudflare's edge
//! (ADR D25, #418): the worker has no `[tls]`, no port 80 listener and no
//! certificate store. SIGHUP reloads the route table (`src/bin/renox-worker.rs`).
//!
//! With `mode = "controlled"` (#55) routes, tiers, artifacts and secrets
//! come from the control plane of `[control]` (`crate::control`), meters
//! and logs go to it over HTTP, and `[control] health_listen` serves
//! `GET /healthz`. A controlled worker refuses to start when `[control] url`
//! resolves to an address tenant `fetch` could reach (ADR D23 follow-up,
//! #218): the node-facing listener must sit on an address that the private
//! ranges or `fetch_blocked_addresses` already refuse.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use http::{Request, Response};

use renox_gateway::{Gateway, GatewayConfig, RouteEntry, RouteTable};
use renox_meter::{HttpMeterSink, Meter, MeterConfig, NdjsonFileSink};
use renox_runtime::ops::fetch::FetchConfig;
use renox_runtime::ops::log::NdjsonLogSink;
use renox_runtime::ops::net_policy::{ExtraBlocked, blocked_reason};
use renox_runtime::{Runtime, RuntimeConfig};
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::artifact::LocalArtifactStore;
use crate::artifact_s3::S3ArtifactStore;
use crate::cell::LocalSecrets;
use crate::client_events::ClientLogSink;
use crate::config::{Mode, WorkerConfig};
use crate::control::degraded::{Guard, GuardedDispatcher, SnapshotFile};
use crate::control::health::Health;
use crate::control::http::{ControlClient, read_node_token};
use crate::control::log_sink::HttpLogSink;
use crate::control::prepare::Preparer;
use crate::control::routes::RouteState;
use crate::control::secrets::ControlSecrets;
use crate::control::{self, Controller, MeterPoster};
use crate::manager::{CellManager, ManagerConfig, StaticTiers};
use crate::pages::PlatformKey;
#[cfg(unix)]
use crate::process::{ProcessLookup, StaticProcesses};
use crate::spool::{self, Queue};
#[cfg(unix)]
use crate::supervisor::Supervisor;

/// The gateway's dispatcher: the shared process alone, or the supervisor
/// of the process tiers in front of it (#254).
enum Dispatch {
    Shared(Arc<GuardedDispatcher>),
    #[cfg(unix)]
    Tiers(Supervisor<GuardedDispatcher>),
}

/// The dispatcher, with the node's checks in front of either process tier:
/// a tenant being moved answers 503 `RENOX_TENANT_MOVING` (#259); a tenant
/// whose file is being restored after damage answers 503
/// `RENOX_DB_UNAVAILABLE`, and the disk watermarks refuse new cells and
/// writes with 503 `RENOX_UNAVAILABLE` (#103).
struct NodeDispatcher {
    inner: Dispatch,
    manager: CellManager,
    replication: Option<crate::replication::Replication>,
    disk: crate::disk::DiskMonitor,
}

/// `errors.md`, `RENOX_TENANT_MOVING`.
const MOVING_MESSAGE: &str = "The service is being moved. Try again shortly.";

/// `errors.md`, `RENOX_DB_UNAVAILABLE` and `RENOX_UNAVAILABLE`.
const UNAVAILABLE_MESSAGE: &str = "The service is temporarily unavailable.";

fn unavailable(
    code: &'static str,
    retry_after: &'static str,
    ctx: &renox_gateway::RequestCtx,
    headers: &http::HeaderMap,
) -> Response<axum::body::Body> {
    let mut res = renox_gateway::limits::platform_error(
        http::StatusCode::SERVICE_UNAVAILABLE,
        code,
        UNAVAILABLE_MESSAGE,
        &ctx.request_id,
        headers,
    );
    res.headers_mut().insert(
        http::header::RETRY_AFTER,
        http::HeaderValue::from_static(retry_after),
    );
    res
}

impl renox_gateway::CellDispatcher for NodeDispatcher {
    async fn dispatch(
        &self,
        ctx: renox_gateway::RequestCtx,
        req: Request<axum::body::Body>,
    ) -> Response<axum::body::Body> {
        if self.manager.is_moving(&ctx.tenant_id) {
            let mut res = renox_gateway::limits::platform_error(
                http::StatusCode::SERVICE_UNAVAILABLE,
                "RENOX_TENANT_MOVING",
                MOVING_MESSAGE,
                &ctx.request_id,
                req.headers(),
            );
            res.headers_mut().insert(
                http::header::RETRY_AFTER,
                http::HeaderValue::from_static("30"),
            );
            return res;
        }
        let restoring = |ctx: &renox_gateway::RequestCtx| {
            self.replication
                .as_ref()
                .and_then(|r| r.unavailable(&ctx.tenant_id))
        };
        if restoring(&ctx).is_some() {
            return unavailable("RENOX_DB_UNAVAILABLE", "30", &ctx, req.headers());
        }
        if let Some(refusal) = self
            .disk
            .refuses(req.method(), self.manager.db_open(&ctx.tenant_id))
        {
            tracing::warn!(tenant_id = %ctx.tenant_id, ?refusal, level = self.disk.level().as_str(), "refused at the disk watermark");
            return unavailable("RENOX_UNAVAILABLE", "30", &ctx, req.headers());
        }
        let headers = req.headers().clone();
        let res = match &self.inner {
            Dispatch::Shared(d) => d.dispatch(ctx.clone(), req).await,
            #[cfg(unix)]
            Dispatch::Tiers(s) => s.dispatch(ctx.clone(), req).await,
        };
        // #311: a statement found the file damaged mid-request (SQLITE_CORRUPT,
        // SQLITE_NOTADB). The tenant's cells of that database are drained,
        // the file goes to the quarantine-and-restore path of #103, and this
        // request answers what the following ones answer while it runs.
        if let Some(c) = res.extensions().get::<crate::manager::DbCorrupt>().cloned() {
            let drained = self.manager.drain_database(&c.database);
            tracing::error!(tenant_id = %ctx.tenant_id, database = %c.database, drained, "damaged tenant file: cells drained, restoring");
            if let Some(r) = &self.replication {
                r.recover_corrupt(&c.database);
            }
            return unavailable("RENOX_DB_UNAVAILABLE", "30", &ctx, &headers);
        }
        // The request that found the damage failed opening the file (500):
        // it answers what the following ones answer while the restore runs.
        if res.status() == http::StatusCode::INTERNAL_SERVER_ERROR && restoring(&ctx).is_some() {
            return unavailable("RENOX_DB_UNAVAILABLE", "30", &ctx, &headers);
        }
        res
    }
}

/// Why the worker did not start. No file contents, no secrets.
#[derive(Debug)]
pub enum WorkerError {
    Io(String, std::io::Error),
    Routes(String),
    /// `platform_key_file` refused (never contains key bytes).
    Key(String),
    /// Controlled mode: the node token or the control client (never the token).
    Control(String),
    /// `[sandbox]` could not be applied (#253).
    Sandbox(String),
    /// A `worker.toml` value the worker cannot use (#364: `[gateway.security_txt]`).
    Config(String),
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkerError::Io(what, e) => write!(f, "{what}: {e}"),
            WorkerError::Routes(e) => write!(f, "route table: {e}"),
            WorkerError::Key(e) => write!(f, "platform key: {e}"),
            WorkerError::Control(e) => write!(f, "control plane: {e}"),
            WorkerError::Sandbox(e) => write!(f, "{e}"),
            WorkerError::Config(e) => write!(f, "worker.toml: {e}"),
        }
    }
}

impl std::error::Error for WorkerError {}

/// Refuses a `[control] url` that tenant code could reach: every address
/// the host resolves to must be in a blocked range or listed in
/// `fetch_blocked_addresses`, otherwise a tenant `fetch` to the same address
/// would reach the node-facing endpoints (ADR D23, #218;
/// `docs/24-threat-model.md` B, node-facing endpoints). Fails closed: a host
/// that does not resolve is refused too. Checked once at start; when the
/// control plane moves, the operator updates the list and restarts.
async fn check_control_unreachable(url: &str, extra: &ExtraBlocked) -> Result<(), WorkerError> {
    let refuse = |why: String| WorkerError::Control(format!("control.url: {why}"));
    // `WorkerConfig::parse` already checked the form (`check_control_url`).
    let uri: http::Uri = url.parse().map_err(|_| refuse("not a URL".into()))?;
    let host = uri
        .host()
        .ok_or_else(|| refuse("no host".into()))?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = uri
        .port_u16()
        .unwrap_or(if uri.scheme_str() == Some("http") {
            80
        } else {
            443
        });
    let addrs: Vec<_> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| refuse(format!("{host} does not resolve ({e}); refusing to start")))?
        .map(|a| a.ip())
        .collect();
    if addrs.is_empty() {
        return Err(refuse(format!(
            "{host} does not resolve; refusing to start"
        )));
    }
    for ip in addrs {
        if blocked_reason(ip).is_none() && !extra.contains(ip) {
            return Err(refuse(format!(
                "{host} resolves to {ip}, which tenant fetch can reach; add {ip} to fetch_blocked_addresses or serve the node-facing control API on a private address"
            )));
        }
    }
    Ok(())
}

/// The route table file, read for the manager's drain decisions; the
/// gateway validates it (V13) on its own.
#[derive(Deserialize)]
struct RoutesFile {
    entries: Vec<RouteEntry>,
}

/// A running worker.
pub struct Worker {
    /// The gateway's TCP address (plain HTTP/1.1); `0.0.0.0:0` with a
    /// `unix:` listen socket (`config.listen` names it).
    pub addr: SocketAddr,
    /// The operator listener of `[control] health_listen` (`GET /healthz`).
    pub health_addr: Option<SocketAddr>,
    /// The node listener of `[control] node_listen` (deploy-api.md 0.3).
    pub node_addr: Option<SocketAddr>,
    /// Litestream per tenant file (#255), with `[replication] enabled`.
    pub replication: Option<crate::replication::Replication>,
    /// The data directory's disk watermarks (#103).
    pub disk: crate::disk::DiskMonitor,
    /// Dead-letter pruning, the idle-file sweep, the log volume limit (#103).
    pub pruning: crate::pruning::Pruning,
    pub manager: CellManager,
    pub routes: Arc<RouteTable>,
    routes_file: PathBuf,
    /// The control-plane side of controlled mode (#55).
    pub controller: Option<Arc<Controller>>,
    /// The process tiers (#254), with `[process] enabled`. Unix hosts only.
    #[cfg(unix)]
    pub supervisor: Option<Supervisor<GuardedDispatcher>>,
    server: JoinHandle<std::io::Result<()>>,
    /// The background tasks (disk, pruning, health, spool, node listener).
    tasks: Vec<JoinHandle<()>>,
}

impl Worker {
    pub async fn start(config: WorkerConfig) -> Result<Worker, WorkerError> {
        let io = |what: &str| {
            let what = what.to_string();
            move |e| WorkerError::Io(what, e)
        };
        for d in [
            &config.data_dir,
            &config.artifacts_dir,
            &config.meters_dir,
            &config.logs_dir,
        ] {
            std::fs::create_dir_all(d).map_err(io("create a worker directory"))?;
        }
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(config.logs_dir.join("tenant.ndjson"))
            .map_err(io("open the tenant log"))?;
        let mut fetch = FetchConfig::default();
        // `WorkerConfig::parse` refuses an empty list in controlled mode.
        if config.fetch_blocked_addresses.is_empty() {
            tracing::warn!(
                "fetch_blocked_addresses is empty: set the node's own addresses and the control plane's node-facing ones in production"
            );
        }
        fetch.extra_blocked = ExtraBlocked(config.fetch_blocked_addresses.clone());
        let control = match (&config.mode, &config.control) {
            (Mode::Controlled, Some(section)) => {
                check_control_unreachable(&section.url, &fetch.extra_blocked).await?;
                let token =
                    read_node_token(&section.node_token_file).map_err(WorkerError::Control)?;
                Some(
                    ControlClient::new(&section.url, &token, &config.node_id)
                        .map_err(WorkerError::Control)?,
                )
            }
            _ => None,
        };
        // Degraded mode (#98): batches the control plane did not take wait
        // in `<data_dir>/spool/` for the replayer.
        let spool = [
            Queue::meters(&config.data_dir),
            Queue::logs(&config.data_dir),
        ];
        let health = Arc::new(Health::default());
        let log_sink: Arc<dyn renox_runtime::LogSink> = match &control {
            Some(client) => {
                let logs = spool[1].clone();
                Arc::new(HttpLogSink::start(
                    client.clone(),
                    Some(Arc::new(move |body: Vec<u8>| logs.append(&body))),
                ))
            }
            None => Arc::new(NdjsonLogSink::new(Box::new(log_file))),
        };
        // The per-tenant log volume limit (#103) in front of either sink.
        let prune_counters = Arc::new(crate::pruning::Counters::default());
        let log_sink: Arc<dyn renox_runtime::LogSink> = Arc::new(crate::pruning::LogVolume::new(
            log_sink,
            prune_counters.clone(),
        ));
        let runtime = Runtime::new(RuntimeConfig {
            log_sink: log_sink.clone(),
            fetch,
        });
        let mut meter_config = MeterConfig::new(&config.node_id, &config.node_id, &config.data_dir);
        meter_config.flush_interval = Duration::from_millis(config.meter_flush_ms.max(1));
        meter_config.dead_letter = match &control {
            Some(_) => NdjsonFileSink::new(&spool[0].dir),
            None => NdjsonFileSink::new(config.meters_dir.join("dead")),
        };
        let meter = match &control {
            Some(client) => Meter::start(
                meter_config,
                HttpMeterSink::new(MeterPoster {
                    client: client.clone(),
                }),
            ),
            None => Meter::start(meter_config, NdjsonFileSink::new(&config.meters_dir)),
        };

        // Controlled mode starts with an empty table: every host is unknown
        // until the first snapshot from the control plane.
        let routes = match &control {
            Some(_) => Arc::new(RouteTable::new()),
            None => {
                let routes_json = std::fs::read_to_string(&config.routes_file)
                    .map_err(io("read the route table"))?;
                Arc::new(
                    RouteTable::from_json(&routes_json)
                        .map_err(|e| WorkerError::Routes(e.to_string()))?,
                )
            }
        };
        let route_state = control
            .as_ref()
            .map(|c| Arc::new(RouteState::new(c.node_id(), routes.clone())));
        let s3 = control
            .as_ref()
            .map(|c| Arc::new(S3ArtifactStore::new(&config.artifacts_dir, c.clone())));
        let tiers = config.tier_table();
        let platform_key = match &config.platform_key_file {
            Some(path) => PlatformKey::load(path).map_err(|e| WorkerError::Key(e.to_string()))?,
            None => {
                tracing::warn!(
                    "platform_key_file is not set: page sessions use a random key and end when the worker restarts"
                );
                PlatformKey::random()
            }
        };
        let manager = CellManager::new(
            runtime,
            meter,
            ManagerConfig {
                data_dir: config.data_dir.clone(),
                artifacts: match &s3 {
                    Some(store) => store.clone(),
                    None => Arc::new(LocalArtifactStore::new(&config.artifacts_dir)),
                },
                idle_timeout: config.idle_timeout(),
                tiers: tiers.clone(),
                deployments: match &route_state {
                    Some(state) => state.clone(),
                    None => Arc::new(StaticTiers {
                        default_tier: config.default_tier,
                        tenant_tiers: config.tenant_tiers.clone(),
                    }),
                },
                secrets: match &control {
                    Some(client) => Arc::new(ControlSecrets {
                        client: client.clone(),
                        artifacts_dir: config.artifacts_dir.clone(),
                    }),
                    None => Arc::new(LocalSecrets {
                        data_dir: config.data_dir.clone(),
                    }),
                },
                platform_key,
            },
        );
        manager.set_authz_config(config.authz.to_config());
        manager.set_realtime_config(config.realtime.clone());
        manager.set_jobs_config(config.jobs.clone());
        // #322: `ctx.ai` in gateway mode forwards to the control plane.
        if let Some(client) = &control {
            manager.set_ai_gateway(std::sync::Arc::new(crate::control::AiForward {
                client: client.clone(),
            }));
        }
        // #321: the platform bucket of tenant files, when configured.
        if let Some(bucket) = &config.storage.bucket {
            match crate::storage::S3Store::new(
                config.storage.endpoint.clone(),
                config
                    .storage
                    .region
                    .clone()
                    .unwrap_or_else(|| "us-east-1".into()),
                bucket.clone(),
            ) {
                Ok(s3) => manager.set_file_store(std::sync::Arc::new(std::sync::Arc::new(s3))),
                Err(e) => {
                    tracing::error!(error = %e, "[storage] bucket configured but unusable; files stay local")
                }
            }
        }
        // Litestream per tenant file (#255).
        let replication = config.replication.enabled.then(|| {
            let r = crate::replication::Replication::start(
                config.replication.clone(),
                config.mode,
                &config.node_id,
                &config.data_dir,
                &config.process.run_dir,
            );
            manager.set_db_lifecycle(Arc::new(r.clone()));
            r
        });
        if let Some(state) = &route_state {
            state.set_manager(manager.clone());
            // #403: `process = "own"` without the supervisor is warned about.
            state.set_process_enabled(config.process.enabled);
            // The last table this node applied: served until the control
            // plane answers (#98); replaced by its first snapshot.
            let file = SnapshotFile::in_data_dir(&config.data_dir);
            if let Some(snapshot) = file.load() {
                tracing::info!(
                    version = snapshot.version,
                    "route table restored from the snapshot file"
                );
                state.apply_snapshot(snapshot);
            }
            state.persist_to(file);
        }
        let mut gw_config = GatewayConfig::new(&config.artifacts_dir);
        gw_config.wall_clock_limit = Duration::from_millis(tiers.max_wall_ms());
        gw_config.rate_limit.requests_per_second = config.gateway.rate_limit_per_ip;
        gw_config.rate_limit.burst = config.gateway.rate_limit_burst;
        gw_config.limits.max_connections_per_ip = config.gateway.max_connections_per_ip;
        gw_config.limits.max_connections_per_trusted_peer =
            config.gateway.max_connections_per_trusted_peer;
        // #414: who may name the client (`WorkerConfig::parse` checked it).
        gw_config.client_ip = config.gateway.client_ip().map_err(WorkerError::Config)?;
        // The platform's security.txt (#121) from `[gateway.security_txt]`
        // (#364; default: `renoxium.app`, `security@renoxium.com`); production
        // only. `WorkerConfig::parse` already checked it builds.
        if config.mode == Mode::Controlled {
            let txt = config
                .gateway
                .security_txt
                .settings()
                .build(std::time::SystemTime::now())
                .map_err(|e| WorkerError::Config(format!("gateway.security_txt: {e}")))?;
            gw_config.security_txt = Some(Arc::new(txt));
        }
        let gateway = Gateway::new(gw_config, routes.clone());
        // `/__renox/events` lines go to the same tenant log (#126).
        gateway.set_client_event_sink(Arc::new(ClientLogSink::new(log_sink, &config.data_dir)));
        let (listener, addr) = match &config.listen {
            crate::config::Listen::Tcp(a) => {
                let l = bind_listener(*a)
                    .await
                    .map_err(io("bind the listen address"))?;
                let addr = l.local_addr().map_err(io("read the listen address"))?;
                (Listener::Tcp(l), addr)
            }
            #[cfg(unix)]
            crate::config::Listen::Unix(path) => {
                let l = bind_unix_listener(path, config.gateway.socket_gid)
                    .map_err(io("bind the listen socket"))?;
                (Listener::Unix(l), SocketAddr::from(([0, 0, 0, 0], 0)))
            }
            // `WorkerConfig::parse` refuses `unix:` here; a hand-built config
            // gets the same error.
            #[cfg(not(unix))]
            crate::config::Listen::Unix(_) => {
                return Err(WorkerError::Config(
                    crate::config::UNIX_LISTEN_REFUSED.into(),
                ));
            }
        };
        let s3_for_prepare = s3.clone();
        let guarded = Arc::new(GuardedDispatcher {
            manager: manager.clone(),
            guard: s3.map(|store| Guard::new(store, health.clone(), config.artifacts_dir.clone())),
        });
        // Process tiers (#254): tenants placed in a child process of their own.
        #[cfg(unix)]
        let supervisor = if config.process.enabled {
            let lookup: Arc<dyn ProcessLookup> = match &route_state {
                Some(state) => state.clone(),
                None => Arc::new(StaticProcesses(
                    config.process.own_tenants.iter().cloned().collect(),
                )),
            };
            let config_path = config.config_path.clone().ok_or_else(|| {
                WorkerError::Control("[process] needs the worker started from a config file".into())
            })?;
            let require_cgroup =
                config.mode == Mode::Controlled && !config.sandbox.allow_unsandboxed;
            Some(
                Supervisor::start(
                    guarded.clone(),
                    manager.clone(),
                    lookup,
                    config.process.clone(),
                    config_path,
                    require_cgroup,
                )
                .map_err(|e| WorkerError::Sandbox(e.to_string()))?,
            )
        } else {
            None
        };
        // Disk watermarks and pruning (#103).
        let disk = crate::disk::DiskMonitor::new(
            &config.data_dir,
            crate::disk::Watermarks::default(),
            Some(health.clone()),
        );
        disk.set_enforcing(config.mode == Mode::Controlled);
        let pruning = crate::pruning::Pruning::new(
            crate::pruning::Sweeper {
                data_dir: config.data_dir.clone(),
                is_open: {
                    let m = manager.clone();
                    Arc::new(move |db| m.db_open(db))
                },
                on_corrupt: replication.clone().map(|r| {
                    Arc::new(move |db: &str, _file: &Path| r.recover_corrupt(db))
                        as crate::pruning::OnCorrupt
                }),
                retention: crate::pruning::DEAD_LETTER_RETENTION,
                check_limit: crate::pruning::SWEEP_CHECK_LIMIT,
            },
            control.as_ref().map(|_| spool[1].clone()),
            prune_counters,
        );
        {
            let p = pruning.clone();
            disk.on_pressure(move |level| p.on_pressure(level));
        }
        let mut tasks = vec![
            disk.spawn(crate::disk::POLL_INTERVAL),
            pruning.spawn(crate::pruning::SWEEP_INTERVAL),
        ];
        let dispatcher = Arc::new(NodeDispatcher {
            #[cfg(unix)]
            inner: match &supervisor {
                Some(s) => Dispatch::Tiers(s.clone()),
                None => Dispatch::Shared(guarded),
            },
            #[cfg(not(unix))]
            inner: Dispatch::Shared(guarded),
            manager: manager.clone(),
            replication: replication.clone(),
            disk: disk.clone(),
        });
        let server = match listener {
            Listener::Tcp(l) => tokio::spawn(async move { gateway.serve(l, dispatcher).await }),
            #[cfg(unix)]
            Listener::Unix(l) => {
                tokio::spawn(async move { gateway.serve_unix(l, dispatcher).await })
            }
        };
        let mut health_addr = None;
        let mut node_addr = None;
        let extra_blocked = ExtraBlocked(config.fetch_blocked_addresses.clone());
        let controller = match (control, route_state, &config.control) {
            (Some(client), Some(state), Some(section)) => {
                if let Some(listen) = section.health_listen {
                    // #295: `/metrics` beside `/healthz` on the operator listener.
                    let (m, d, h) = (manager.clone(), disk.clone(), health.clone());
                    let metrics: control::health::MetricsText = Arc::new(move || {
                        let (m, d, h) = (m.clone(), d.clone(), h.clone());
                        Box::pin(async move {
                            let disk = Some((d.used_pct() / 100.0, d.level() as u8));
                            m.metrics_text(disk, h.reasons()).await
                        })
                    });
                    let (bound, task) =
                        control::health::serve(listen, health.clone(), Some(metrics))
                            .await
                            .map_err(io("bind control.health_listen"))?;
                    health_addr = Some(bound);
                    tasks.push(task);
                }
                tasks.push(spool::spawn_replayer(
                    client.clone(),
                    spool.to_vec(),
                    health.clone(),
                ));
                let controller = Controller::new(
                    client,
                    state,
                    health,
                    manager.clone(),
                    &section.region,
                    section.max_cells,
                );
                // #311: the disk level on every heartbeat.
                controller.set_disk(disk.clone());
                // The node listener (deploy-api.md 0.3 section 15), on an
                // address tenant fetch cannot reach (#218 rule).
                if let Some(listen) = section.node_listen {
                    if blocked_reason(listen.ip()).is_none()
                        && !extra_blocked.contains(listen.ip())
                        && !listen.ip().is_unspecified()
                    {
                        return Err(WorkerError::Control(format!(
                            "control.node_listen {listen} is an address tenant fetch can reach; use a private address or add it to fetch_blocked_addresses"
                        )));
                    }
                    let token = Arc::new(crate::control::node_listener::CallbackToken::default());
                    let listener = Arc::new(crate::control::node_listener::NodeListener {
                        node_id: config.node_id.clone(),
                        token: token.clone(),
                        replication: replication.clone(),
                        manager: manager.clone(),
                        microvm_hook: config.process.microvm_hook.clone(),
                    });
                    let (bound, task) = listener
                        .serve(listen)
                        .await
                        .map_err(io("bind control.node_listen"))?;
                    node_addr = Some(bound);
                    tasks.push(task);
                    let url = section
                        .node_listen_url
                        .clone()
                        .unwrap_or_else(|| format!("http://{bound}"));
                    controller.set_node_listener(url, token);
                }
                // `prepare` (#96) from the stream.
                let preparer = s3_for_prepare.as_ref().map(|store| {
                    Arc::new(Preparer {
                        client: controller.client.clone(),
                        manager: manager.clone(),
                        store: store.clone(),
                        routes: controller.routes.clone(),
                        data_dir: config.data_dir.clone(),
                        tiers: tiers.clone(),
                    })
                });
                if let Some(p) = preparer {
                    controller.on_message(Arc::new(move |m| p.handle(m)));
                }
                controller.start();
                Some(controller)
            }
            _ => None,
        };
        // #253: the listeners are bound and every file read at start (config,
        // keys, token, route table) is open; from here on only the allowlist.
        if config.sandbox.enabled {
            let exe = std::env::current_exe().ok();
            let profile = crate::sandbox::Profile::from_config(
                &config,
                exe.as_deref().and_then(Path::parent),
            );
            if !crate::sandbox::landlock_applied() {
                tracing::warn!(
                    "sandbox: Landlock was not applied before the runtime started; only seccomp applies (renox-worker applies Landlock in main)"
                );
            }
            crate::sandbox::restrict_syscalls(&profile)
                .map_err(|e| WorkerError::Sandbox(e.to_string()))?;
        } else {
            if config.mode == Mode::Controlled {
                tracing::warn!(
                    "[sandbox] is off (allow_unsandboxed = true): this controlled node runs without seccomp and Landlock"
                );
            }
            crate::sandbox::apply_test_sandbox();
        }
        let listen = config.listen.to_string();
        tracing::info!(%listen, %addr, ?health_addr, controlled = controller.is_some(), routes = routes.len(), "renox-worker listening");
        Ok(Worker {
            addr,
            health_addr,
            node_addr,
            replication,
            disk,
            pruning,
            manager,
            routes,
            routes_file: config.routes_file.clone(),
            controller,
            #[cfg(unix)]
            supervisor,
            server,
            tasks,
        })
    }

    /// Re-read the route table file (SIGHUP). On a file that fails
    /// validation the previous table stays in use. Cells whose deployment
    /// lost its active entry start draining.
    pub fn reload_routes(&self) -> Result<usize, WorkerError> {
        if self.controller.is_some() {
            tracing::info!(
                "controlled mode: routes come from the control plane; nothing to reload"
            );
            return Ok(self.routes.len());
        }
        let json = std::fs::read_to_string(&self.routes_file)
            .map_err(|e| WorkerError::Io("read the route table".into(), e))?;
        self.routes
            .reload_from_json(&json)
            .map_err(|e| WorkerError::Routes(e.to_string()))?;
        let file: RoutesFile =
            serde_json::from_str(&json).map_err(|e| WorkerError::Routes(e.to_string()))?;
        self.manager.sync_routes(&file.entries);
        tracing::info!(entries = file.entries.len(), "route table reloaded");
        Ok(file.entries.len())
    }

    /// Stop accepting connections and write every queued meter record.
    pub async fn shutdown(self) {
        if let Some(c) = &self.controller {
            c.stop();
        }
        #[cfg(unix)]
        if let Some(s) = &self.supervisor {
            s.shutdown().await;
        }
        self.server.abort();
        for t in &self.tasks {
            t.abort();
        }
        self.manager.meter().flush_and_close().await;
    }
}

/// The gateway's listener: TCP, or the unix socket behind `cloudflared`.
enum Listener {
    Tcp(TcpListener),
    #[cfg(unix)]
    Unix(tokio::net::UnixListener),
}

/// Binds the gateway's unix socket (#414, ADR D25): a stale socket file
/// from a previous run is removed first (only a socket, never another kind
/// of file), then the new one is mode 0660 in `gid` (the group `cloudflared`
/// is in), or 0600 without a group. The mode is set before the first
/// `accept`, and the trusted peer is still decided per connection by uid.
#[cfg(unix)]
pub fn bind_unix_listener(
    path: &Path,
    gid: Option<u32>,
) -> std::io::Result<tokio::net::UnixListener> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if !meta.file_type().is_socket() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("{} exists and is not a socket", path.display()),
            ));
        }
        std::fs::remove_file(path)?;
    }
    let listener = tokio::net::UnixListener::bind(path)?;
    let mode = if gid.is_some() { 0o660 } else { 0o600 };
    if gid.is_some() {
        std::os::unix::fs::chown(path, None, gid)?;
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    Ok(listener)
}

/// Binds a public listener (#404). `[::]:<port>` is dual-stack: one IPv6
/// socket with `IPV6_V6ONLY` off, so IPv4 clients arrive as v4-mapped
/// addresses (`::ffff:a.b.c.d`), which the gateway's per-IP limits and
/// `client_ip` count as the IPv4 address (`renox_gateway::rate_limit`).
/// On a host without IPv6 the same port is bound on `0.0.0.0` with a
/// warning. Any other address is bound as given.
pub async fn bind_listener(addr: SocketAddr) -> std::io::Result<TcpListener> {
    let SocketAddr::V6(v6) = addr else {
        return TcpListener::bind(addr).await;
    };
    if !v6.ip().is_unspecified() {
        return TcpListener::bind(addr).await;
    }
    use socket2::{Domain, Protocol, Socket, Type};
    let socket = match Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP)) {
        Ok(s) => s,
        Err(e) => {
            let v4 = SocketAddr::from(([0, 0, 0, 0], addr.port()));
            tracing::warn!(%addr, error = %e, fallback = %v4, "no IPv6 on this host; listening on IPv4 only");
            return TcpListener::bind(v4).await;
        }
    };
    socket.set_only_v6(false)?;
    // What tokio's own bind sets on Unix: a restart rebinds at once.
    #[cfg(unix)]
    socket.set_reuse_address(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&addr.into())?;
    socket.listen(1024)?;
    TcpListener::from_std(socket.into())
}
