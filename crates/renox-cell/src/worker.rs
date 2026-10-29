//! The worker process: config → runtime, meter, route table, cell manager,
//! gateway. The `renox-worker` binary is a thin `main` around [`Worker`];
//! tests start it in-process.
//!
//! With `[tls]` (#162) the gateway serves HTTPS on `listen` (SNI picks the
//! certificate, the SNI/`Host` rule of #107 applies), and a second, plain
//! listener on `tls.http_listen` serves only ACME HTTP-01 challenges and
//! answers everything else with `308` to the HTTPS URL. SIGHUP reloads the
//! certificate directory as well as the route table.
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

use bytes::Bytes;
use http::{Request, Response, StatusCode, header};
use http_body_util::Full;
use renox_gateway::{
    CertStore, Gateway, GatewayConfig, LoadReport, RouteEntry, RouteTable, TlsConfig, parse_host,
};
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
use crate::config::{Mode, TlsSection, WorkerConfig};
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
use crate::spool::{self, Queue};
use crate::supervisor::{ProcessLookup, StaticProcesses, Supervisor};

/// The gateway's dispatcher: the shared process alone, or the supervisor
/// of the process tiers in front of it (#254).
enum Dispatch {
    Shared(Arc<GuardedDispatcher>),
    Tiers(Supervisor<GuardedDispatcher>),
}

/// The dispatcher, with the moving check in front of either process tier
/// (#259): a tenant being moved answers 503 `RENOX_TENANT_MOVING`.
struct NodeDispatcher {
    inner: Dispatch,
    manager: CellManager,
}

/// `errors.md`, `RENOX_TENANT_MOVING`.
const MOVING_MESSAGE: &str = "The service is being moved. Try again shortly.";

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
        match &self.inner {
            Dispatch::Shared(d) => d.dispatch(ctx, req).await,
            Dispatch::Tiers(s) => s.dispatch(ctx, req).await,
        }
    }
}

/// Why the worker did not start. No file contents, no secrets.
#[derive(Debug)]
pub enum WorkerError {
    Io(String, std::io::Error),
    Routes(String),
    /// `platform_key_file` refused (never contains key bytes).
    Key(String),
    /// `[tls] cert_dir` unreadable (never contains key bytes).
    Tls(String),
    /// Controlled mode: the node token or the control client (never the token).
    Control(String),
    /// `[sandbox]` could not be applied (#253).
    Sandbox(String),
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkerError::Io(what, e) => write!(f, "{what}: {e}"),
            WorkerError::Routes(e) => write!(f, "route table: {e}"),
            WorkerError::Key(e) => write!(f, "platform key: {e}"),
            WorkerError::Tls(e) => write!(f, "tls: {e}"),
            WorkerError::Control(e) => write!(f, "control plane: {e}"),
            WorkerError::Sandbox(e) => write!(f, "{e}"),
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
    /// The gateway's address: HTTPS with `[tls]`, plain HTTP without.
    pub addr: SocketAddr,
    /// The plain listener of `[tls] http_listen` (ACME and redirects).
    pub http_addr: Option<SocketAddr>,
    /// The operator listener of `[control] health_listen` (`GET /healthz`).
    pub health_addr: Option<SocketAddr>,
    /// The node listener of `[control] node_listen` (deploy-api.md 0.3).
    pub node_addr: Option<SocketAddr>,
    /// Litestream per tenant file (#255), with `[replication] enabled`.
    pub replication: Option<crate::replication::Replication>,
    pub manager: CellManager,
    pub routes: Arc<RouteTable>,
    routes_file: PathBuf,
    /// The control-plane side of controlled mode (#55).
    pub controller: Option<Arc<Controller>>,
    /// The process tiers (#254), with `[process] enabled`.
    pub supervisor: Option<Supervisor<GuardedDispatcher>>,
    certs: Option<Arc<CertStore>>,
    server: JoinHandle<std::io::Result<()>>,
    /// The plain listener and the SIGHUP certificate reloader.
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
        let gateway = Gateway::new(gw_config, routes.clone());
        // `/__renox/events` lines go to the same tenant log (#126).
        gateway.set_client_event_sink(Arc::new(ClientLogSink::new(log_sink, &config.data_dir)));
        let certs = match &config.tls {
            Some(tls) => Some(load_certificates(tls)?),
            None => None,
        };
        let listener = TcpListener::bind(config.listen)
            .await
            .map_err(io("bind the listen address"))?;
        let addr = listener
            .local_addr()
            .map_err(io("read the listen address"))?;
        let s3_for_prepare = s3.clone();
        let guarded = Arc::new(GuardedDispatcher {
            manager: manager.clone(),
            guard: s3.map(|store| Guard::new(store, health.clone(), config.artifacts_dir.clone())),
        });
        // Process tiers (#254): tenants placed in a child process of their own.
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
        let dispatcher = Arc::new(NodeDispatcher {
            inner: match &supervisor {
                Some(s) => Dispatch::Tiers(s.clone()),
                None => Dispatch::Shared(guarded),
            },
            manager: manager.clone(),
        });
        let mut tasks = Vec::new();
        let mut http_addr = None;
        let server = match (&config.tls, &certs) {
            (Some(tls), Some(store)) => {
                if let Some(http_listen) = tls.http_listen {
                    let plain = TcpListener::bind(http_listen)
                        .await
                        .map_err(io("bind tls.http_listen"))?;
                    http_addr = Some(plain.local_addr().map_err(io("read tls.http_listen"))?);
                    let site = Arc::new(PlainSite {
                        acme_dir: tls.acme_dir.clone(),
                        https_port: tls.https_port.unwrap_or(addr.port()),
                    });
                    tasks.push(tokio::spawn(serve_plain(plain, site)));
                }
                tasks.push(spawn_sighup_reload(store.clone()));
                let store = store.clone();
                tokio::spawn(async move { gateway.serve_tls(listener, store, dispatcher).await })
            }
            _ => tokio::spawn(async move { gateway.serve(listener, dispatcher).await }),
        };
        let mut health_addr = None;
        let mut node_addr = None;
        let extra_blocked = ExtraBlocked(config.fetch_blocked_addresses.clone());
        let controller = match (control, route_state, &config.control) {
            (Some(client), Some(state), Some(section)) => {
                if let Some(listen) = section.health_listen {
                    let (bound, task) = control::health::serve(listen, health.clone())
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
                if let Some(store) = &s3_for_prepare {
                    let preparer = Arc::new(Preparer {
                        client: controller.client.clone(),
                        manager: manager.clone(),
                        store: store.clone(),
                        routes: controller.routes.clone(),
                        data_dir: config.data_dir.clone(),
                        tiers: tiers.clone(),
                    });
                    controller.on_message(Arc::new(move |m| preparer.handle(m)));
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
        tracing::info!(%addr, ?http_addr, ?health_addr, tls = certs.is_some(), controlled = controller.is_some(), routes = routes.len(), "renox-worker listening");
        Ok(Worker {
            addr,
            http_addr,
            health_addr,
            node_addr,
            replication,
            manager,
            routes,
            routes_file: config.routes_file.clone(),
            controller,
            supervisor,
            certs,
            server,
            tasks,
        })
    }

    /// Re-read `[tls] cert_dir` (SIGHUP, or a control message from the
    /// control plane, #59). New handshakes use the new certificates;
    /// established connections keep theirs. `None` without `[tls]`.
    pub fn reload_certificates(&self) -> Option<Result<LoadReport, WorkerError>> {
        let store = self.certs.as_ref()?;
        Some(reload_store(store))
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

fn load_certificates(tls: &TlsSection) -> Result<Arc<CertStore>, WorkerError> {
    let (store, report) = CertStore::load(&TlsConfig {
        cert_dir: tls.cert_dir.clone(),
    })
    .map_err(|e| WorkerError::Tls(e.to_string()))?;
    log_report(&report);
    if report.names.is_empty() {
        tracing::warn!("tls: no certificate loaded; every handshake is refused until a reload");
    }
    Ok(store)
}

fn reload_store(store: &CertStore) -> Result<LoadReport, WorkerError> {
    let report = store
        .reload()
        .map_err(|e| WorkerError::Tls(e.to_string()))?;
    log_report(&report);
    Ok(report)
}

/// Names and failures only; never key material (`CertStore` messages
/// do not contain any).
fn log_report(report: &LoadReport) {
    for (dir, reason) in &report.failed {
        tracing::error!(entry = %dir, %reason, "tls: certificate not loaded");
    }
    tracing::info!(
        names = report.names.len(),
        failed = report.failed.len(),
        "tls: certificates loaded"
    );
}

/// SIGHUP reloads the certificates. The binary's own SIGHUP handler reloads
/// the route table; both handlers receive every signal.
fn spawn_sighup_reload(store: Arc<CertStore>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut hup = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup()) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(error = %e, "tls: cannot install the SIGHUP handler");
                return;
            }
        };
        while hup.recv().await.is_some() {
            if let Err(e) = reload_store(&store) {
                tracing::error!(error = %e, "tls: reload refused; the previous certificates stay in use");
            }
        }
    })
}

/// Bounds of the plain listener: it serves two kinds of tiny responses,
/// so one request per connection, a short head timeout, and a global cap.
const PLAIN_MAX_CONNECTIONS: usize = 1024;
const PLAIN_HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const PLAIN_CONNECTION_TIMEOUT: Duration = Duration::from_secs(30);
const PLAIN_MAX_HEAD_BYTES: usize = 16 * 1024;
/// A key authorization is `<token>.<thumbprint>`, well under this.
const ACME_MAX_FILE_BYTES: u64 = 4096;
const ACME_PREFIX: &str = "/.well-known/acme-challenge/";

/// What the plain listener needs to answer.
struct PlainSite {
    acme_dir: Option<PathBuf>,
    https_port: u16,
}

async fn serve_plain(listener: TcpListener, site: Arc<PlainSite>) {
    let slots = Arc::new(tokio::sync::Semaphore::new(PLAIN_MAX_CONNECTIONS));
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(c) => c,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(10)).await;
                continue;
            }
        };
        // Over the cap the connection is closed at once.
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            continue;
        };
        let site = site.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let service = hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                let site = site.clone();
                async move { Ok::<_, std::convert::Infallible>(plain_response(&site, &req).await) }
            });
            let conn = hyper::server::conn::http1::Builder::new()
                .timer(hyper_util::rt::TokioTimer::new())
                .header_read_timeout(PLAIN_HEADER_TIMEOUT)
                .max_buf_size(PLAIN_MAX_HEAD_BYTES)
                .keep_alive(false)
                .serve_connection(hyper_util::rt::TokioIo::new(stream), service);
            let _ = tokio::time::timeout(PLAIN_CONNECTION_TIMEOUT, conn).await;
        });
    }
}

fn plain(status: StatusCode, body: &'static str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Full::new(Bytes::from_static(body.as_bytes())))
        .expect("valid response")
}

/// The plain listener's one handler: an ACME challenge from `acme_dir`, or
/// `308` to the same host and path over HTTPS. A request body is never read.
async fn plain_response<B>(site: &PlainSite, req: &Request<B>) -> Response<Full<Bytes>> {
    let path = req.uri().path();
    if let Some(token) = path.strip_prefix(ACME_PREFIX) {
        if !matches!(*req.method(), http::Method::GET | http::Method::HEAD) {
            return plain(StatusCode::METHOD_NOT_ALLOWED, "method not allowed\n");
        }
        return match acme_answer(site.acme_dir.as_deref(), token).await {
            Some(body) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .header(header::CACHE_CONTROL, "no-store")
                .body(Full::new(if req.method() == http::Method::HEAD {
                    Bytes::new()
                } else {
                    body
                }))
                .expect("valid response"),
            None => plain(StatusCode::NOT_FOUND, "not found\n"),
        };
    }
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| parse_host(h).ok());
    let Some(host) = host else {
        return plain(StatusCode::BAD_REQUEST, "bad host\n");
    };
    let path_and_query = req.uri().path_and_query().map_or("/", |p| p.as_str());
    let location = if site.https_port == 443 {
        format!("https://{host}{path_and_query}")
    } else {
        format!("https://{host}:{}{path_and_query}", site.https_port)
    };
    match Response::builder()
        .status(StatusCode::PERMANENT_REDIRECT)
        .header(header::LOCATION, location)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Full::new(Bytes::new()))
    {
        Ok(r) => r,
        Err(_) => plain(StatusCode::BAD_REQUEST, "bad request\n"),
    }
}

/// The key authorization for `token`: a regular file (no link followed)
/// named by a base64url token (RFC 8555 section 8.3), at most 4 KiB.
async fn acme_answer(dir: Option<&Path>, token: &str) -> Option<Bytes> {
    let dir = dir?;
    if token.is_empty()
        || token.len() > 255
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    let path = dir.join(token);
    let meta = tokio::fs::symlink_metadata(&path).await.ok()?;
    if !meta.is_file() || meta.len() > ACME_MAX_FILE_BYTES {
        return None;
    }
    tokio::fs::read(&path).await.ok().map(Bytes::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(dir: Option<PathBuf>, port: u16) -> PlainSite {
        PlainSite {
            acme_dir: dir,
            https_port: port,
        }
    }

    fn req(method: &str, uri: &str, host: Option<&str>) -> Request<()> {
        let mut b = Request::builder().method(method).uri(uri);
        if let Some(h) = host {
            b = b.header(header::HOST, h);
        }
        b.body(()).unwrap()
    }

    #[tokio::test]
    async fn redirects_keep_host_path_and_query() {
        let s = site(None, 443);
        let r = plain_response(&s, &req("POST", "/a/b?x=1", Some("Shop.Example.COM:80"))).await;
        assert_eq!(r.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(
            r.headers()[header::LOCATION],
            "https://shop.example.com/a/b?x=1"
        );
        let s = site(None, 8443);
        let r = plain_response(&s, &req("GET", "/", Some("a.test"))).await;
        assert_eq!(r.headers()[header::LOCATION], "https://a.test:8443/");
        for bad in [None, Some("a b"), Some("a.test/evil"), Some("")] {
            let r = plain_response(&s, &req("GET", "/", bad)).await;
            assert_eq!(r.status(), StatusCode::BAD_REQUEST, "{bad:?}");
        }
    }

    #[tokio::test]
    async fn acme_tokens_are_served_from_the_directory_only() {
        let dir = std::env::temp_dir().join(format!("renox-acme-unit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tok_EN-1"), "tok_EN-1.thumb").unwrap();
        std::fs::write(dir.join("big"), vec![b'x'; 5000]).unwrap();
        std::fs::write(dir.parent().unwrap().join("renox-acme-outside"), "secret").unwrap();
        std::os::unix::fs::symlink(
            dir.parent().unwrap().join("renox-acme-outside"),
            dir.join("link"),
        )
        .ok();
        let s = site(Some(dir.clone()), 443);
        let r = plain_response(
            &s,
            &req(
                "GET",
                "/.well-known/acme-challenge/tok_EN-1",
                Some("a.test"),
            ),
        )
        .await;
        assert_eq!(r.status(), StatusCode::OK);
        for token in ["missing", "big", "link", "..%2Fx", "a.b", ""] {
            let uri = format!("/.well-known/acme-challenge/{token}");
            let r = plain_response(&s, &req("GET", &uri, Some("a.test"))).await;
            assert_eq!(r.status(), StatusCode::NOT_FOUND, "{token}");
        }
        let r = plain_response(
            &s,
            &req(
                "POST",
                "/.well-known/acme-challenge/tok_EN-1",
                Some("a.test"),
            ),
        )
        .await;
        assert_eq!(r.status(), StatusCode::METHOD_NOT_ALLOWED);
        let none = site(None, 443);
        let r = plain_response(
            &none,
            &req("GET", "/.well-known/acme-challenge/tok_EN-1", None),
        )
        .await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }
}
