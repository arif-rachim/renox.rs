//! The worker process: config → runtime, meter, route table, cell manager,
//! gateway. The `renox-worker` binary is a thin `main` around [`Worker`];
//! tests start it in-process.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use renox_gateway::{Gateway, GatewayConfig, RouteEntry, RouteTable};
use renox_meter::{Meter, MeterConfig, NdjsonFileSink};
use renox_runtime::ops::fetch::FetchConfig;
use renox_runtime::ops::log::NdjsonLogSink;
use renox_runtime::ops::net_policy::ExtraBlocked;
use renox_runtime::{Runtime, RuntimeConfig};
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::artifact::LocalArtifactStore;
use crate::config::WorkerConfig;
use crate::manager::{CellManager, ManagerConfig};
use crate::pages::PlatformKey;

/// Why the worker did not start. No file contents, no secrets.
#[derive(Debug)]
pub enum WorkerError {
    Io(String, std::io::Error),
    Routes(String),
    /// `platform_key_file` refused (never contains key bytes).
    Key(String),
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkerError::Io(what, e) => write!(f, "{what}: {e}"),
            WorkerError::Routes(e) => write!(f, "route table: {e}"),
            WorkerError::Key(e) => write!(f, "platform key: {e}"),
        }
    }
}

impl std::error::Error for WorkerError {}

/// The route table file, read for the manager's drain decisions; the
/// gateway validates it (V13) on its own.
#[derive(Deserialize)]
struct RoutesFile {
    entries: Vec<RouteEntry>,
}

/// A running worker.
pub struct Worker {
    pub addr: SocketAddr,
    pub manager: CellManager,
    pub routes: Arc<RouteTable>,
    routes_file: PathBuf,
    server: JoinHandle<std::io::Result<()>>,
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
        if config.fetch_blocked_addresses.is_empty() {
            tracing::warn!(
                "fetch_blocked_addresses is empty: set the node's and the control plane's addresses in production"
            );
        }
        fetch.extra_blocked = ExtraBlocked(config.fetch_blocked_addresses.clone());
        let runtime = Runtime::new(RuntimeConfig {
            log_sink: Arc::new(NdjsonLogSink::new(Box::new(log_file))),
            fetch,
        });
        let mut meter_config = MeterConfig::new(&config.node_id, &config.node_id, &config.data_dir);
        meter_config.flush_interval = Duration::from_millis(config.meter_flush_ms.max(1));
        meter_config.dead_letter = NdjsonFileSink::new(config.meters_dir.join("dead"));
        let meter = Meter::start(meter_config, NdjsonFileSink::new(&config.meters_dir));

        let routes_json =
            std::fs::read_to_string(&config.routes_file).map_err(io("read the route table"))?;
        let routes = Arc::new(
            RouteTable::from_json(&routes_json).map_err(|e| WorkerError::Routes(e.to_string()))?,
        );
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
                artifacts: Arc::new(LocalArtifactStore::new(&config.artifacts_dir)),
                idle_timeout: config.idle_timeout(),
                tiers: tiers.clone(),
                default_tier: config.default_tier,
                tenant_tiers: config.tenant_tiers.clone(),
                platform_key,
            },
        );
        let mut gw_config = GatewayConfig::new(&config.artifacts_dir);
        gw_config.wall_clock_limit = Duration::from_millis(tiers.max_wall_ms());
        gw_config.rate_limit.requests_per_second = config.gateway.rate_limit_per_ip;
        gw_config.rate_limit.burst = config.gateway.rate_limit_burst;
        gw_config.limits.max_connections_per_ip = config.gateway.max_connections_per_ip;
        let gateway = Gateway::new(gw_config, routes.clone());
        let listener = TcpListener::bind(config.listen)
            .await
            .map_err(io("bind the listen address"))?;
        let addr = listener
            .local_addr()
            .map_err(io("read the listen address"))?;
        let dispatcher = Arc::new(manager.clone());
        let server = tokio::spawn(async move { gateway.serve(listener, dispatcher).await });
        tracing::info!(%addr, routes = routes.len(), "renox-worker listening");
        Ok(Worker {
            addr,
            manager,
            routes,
            routes_file: config.routes_file.clone(),
            server,
        })
    }

    /// Re-read the route table file (SIGHUP). On a file that fails
    /// validation the previous table stays in use. Cells whose deployment
    /// lost its active entry start draining.
    pub fn reload_routes(&self) -> Result<usize, WorkerError> {
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
        self.server.abort();
        self.manager.meter().flush_and_close().await;
    }
}
