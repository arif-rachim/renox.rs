//! `worker.toml` (see `worker.example.toml`).

use std::collections::BTreeMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::tiers::{TierName, TierOverride, Tiers};

/// The worker configuration file.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerConfig {
    /// Address the gateway listens on: plain HTTP without `[tls]` (local
    /// development, F1), HTTPS with it (production `0.0.0.0:443`).
    pub listen: SocketAddr,
    /// `<data_dir>/<tenant_id>/app.db` and `secrets.json`.
    pub data_dir: PathBuf,
    /// Artifact directories named by their hash.
    pub artifacts_dir: PathBuf,
    /// The route table file (`docs/contracts/schemas/route-table.schema.json`).
    /// Local mode only; required there.
    #[serde(default)]
    pub routes_file: PathBuf,
    /// Meter batches, one ndjson file per UTC day.
    pub meters_dir: PathBuf,
    /// Tenant log lines (`tenant.ndjson`).
    pub logs_dir: PathBuf,
    /// Node id written into meter batches.
    #[serde(default = "default_node_id")]
    pub node_id: String,
    /// Seconds without a request before a cell is evicted.
    #[serde(default = "default_idle_timeout")]
    pub idle_timeout_secs: f64,
    /// Tier of tenants not listed in `tenant_tiers`.
    #[serde(default = "default_tier")]
    pub default_tier: TierName,
    /// Tier per tenant id (F1 stand-in for the control plane).
    #[serde(default)]
    pub tenant_tiers: BTreeMap<String, TierName>,
    /// Overrides of the tier table.
    #[serde(default)]
    pub tiers: BTreeMap<TierName, TierOverride>,
    /// The node's own public addresses and the control plane's node-facing
    /// ones (where `[control] url` resolves; never the public API address,
    /// ADR D23): tenant `fetch` is refused to them on top of the private
    /// ranges (`crates/renox-runtime` README, "Outbound fetch"). A
    /// controlled worker refuses to start when `[control] url` resolves to
    /// an address that is neither listed here nor in a private range.
    #[serde(default)]
    pub fetch_blocked_addresses: Vec<IpAddr>,
    /// Meter batches are written at least this often (contract: 5 s).
    #[serde(default = "default_meter_flush_ms")]
    pub meter_flush_ms: u64,
    /// Gateway limits per client IP.
    #[serde(default)]
    pub gateway: GatewaySection,
    /// The node's platform key (mode 0600, at least 32 bytes): page session
    /// and CSRF keys are derived from it per tenant (`src/pages/keys.rs`).
    /// Absent: a random key per process, logged as a warning (sessions end
    /// on restart). F3 delivers the node key (#54, #55).
    #[serde(default)]
    pub platform_key_file: Option<PathBuf>,
    /// HTTPS (#162). Absent: `listen` serves plain HTTP.
    #[serde(default)]
    pub tls: Option<TlsSection>,
    /// `local` (F1: route table file, artifacts directory, `secrets.json`,
    /// files for meters and logs) or `controlled` (F3, #55: everything from
    /// and to the control plane of `[control]`).
    #[serde(default)]
    pub mode: Mode,
    /// The control plane (`mode = "controlled"` only).
    #[serde(default)]
    pub control: Option<ControlSection>,
    /// The seccomp allowlist and Landlock rules the worker applies to
    /// itself (#253, `src/sandbox/`). Required in controlled mode unless
    /// `allow_unsandboxed`.
    #[serde(default)]
    pub sandbox: SandboxSection,
    /// Process tiers (#254, `src/supervisor/`): paid tenants in child
    /// processes of their own.
    #[serde(default)]
    pub process: ProcessSection,
    /// Litestream per tenant file (#255, `src/replication/`).
    #[serde(default)]
    pub replication: ReplicationSection,
    /// Authorization (#279, `src/authz/`): dev mode and the principal
    /// cache TTL.
    #[serde(default)]
    pub authz: AuthzSection,
    /// Realtime connection caps (#281, `src/realtime/`).
    #[serde(default)]
    pub realtime: RealtimeSection,
    /// `[jobs]` (#297).
    #[serde(default)]
    pub jobs: JobsSection,
    /// Traces over OTLP/HTTP and the sampling ratio (#295, `src/telemetry/`).
    #[serde(default)]
    pub telemetry: crate::telemetry::TelemetrySection,
    /// The file this config was loaded from ([`WorkerConfig::load`]); the
    /// supervisor passes it to its children. Not a key.
    #[serde(skip)]
    pub config_path: Option<PathBuf>,
}

/// `[authz]` (#279; `docs/contracts/ops.md` 1.5.0 section 17).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct AuthzSection {
    /// Dev mode (`renox dev`): `ctx.authz.explain` works and
    /// `RENOX_FORBIDDEN` names the deciding policy. Default false.
    pub dev: bool,
    /// How long a resolved principal is kept per session (`ops.md` Open
    /// 12: 60 s *proposed*); a role change, login or logout drops it
    /// sooner.
    pub principal_ttl_secs: f64,
}

impl Default for AuthzSection {
    fn default() -> Self {
        AuthzSection {
            dev: false,
            principal_ttl_secs: 60.0,
        }
    }
}

impl AuthzSection {
    pub fn to_config(&self) -> crate::authz::AuthzConfig {
        crate::authz::AuthzConfig {
            dev: self.dev,
            principal_ttl: std::time::Duration::from_secs_f64(
                self.principal_ttl_secs.clamp(0.0, 3600.0),
            ),
        }
    }
}

/// `[realtime]` (#281; `docs/contracts/ops.md` 1.5.0 section 18,
/// "Limits"). The per-connection limits are the contract's and not keys.
/// `[jobs]`: the scheduler of `job` routes (`ops.md` section 20).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct JobsSection {
    /// Run the scheduler in every cell (`renox dev` sets false unless
    /// `--jobs`). Queued runs (`ctx.jobs.enqueue`) are delivered either way.
    pub enabled: bool,
    /// Development only: also look for due outbox rows every `poll_ms`, so
    /// rows the CLI writes into the dev tenant file from another connection
    /// (`renox jobs run`, `retry`) are seen. 0 (the default) never polls:
    /// in production only the cell writes the file and its commits wake the
    /// worker (D14).
    pub poll_ms: u64,
}

impl Default for JobsSection {
    fn default() -> Self {
        JobsSection {
            enabled: true,
            poll_ms: 0,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct RealtimeSection {
    /// Connections per tenant on the free tier (`docs/04`: 100).
    pub free_connections: usize,
    /// Connections per tenant on the paid tier (`docs/04`: 10,000).
    pub paid_connections: usize,
    /// Connections per user (principal id, or client IP when anonymous).
    pub user_connections: usize,
}

impl Default for RealtimeSection {
    fn default() -> Self {
        let free = renox_realtime::Limits::free();
        RealtimeSection {
            free_connections: free.tenant_connections,
            paid_connections: renox_realtime::Limits::paid().tenant_connections,
            user_connections: free.user_connections,
        }
    }
}

impl RealtimeSection {
    /// The hub limits of a tier.
    pub fn limits(&self, paid: bool) -> renox_realtime::Limits {
        let base = if paid {
            renox_realtime::Limits::paid()
        } else {
            renox_realtime::Limits::free()
        };
        renox_realtime::Limits {
            tenant_connections: if paid {
                self.paid_connections
            } else {
                self.free_connections
            }
            .max(1),
            user_connections: self.user_connections.max(1),
            ..base
        }
    }
}

/// `[process]` (#254): the supervisor and its child workers.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct ProcessSection {
    /// Run tenants whose route entry says `process = "own"` (controlled
    /// mode) or that `own_tenants` lists (local mode) in a child process.
    /// Default false: every tenant in this process.
    pub enabled: bool,
    /// Children at most; a tenant over the limit is served in this process
    /// (logged).
    pub max_children: usize,
    /// A child without a request for this long is stopped.
    pub child_idle_secs: f64,
    /// First wait before a crashed child is started again; doubles per
    /// crash up to 30 s, reset after a child lived 60 s.
    pub restart_backoff_ms: u64,
    /// The children's Unix sockets (`<run_dir>/children/<tenant>.sock`).
    pub run_dir: PathBuf,
    /// `direct` (the supervisor spawns the child and creates its cgroup
    /// under its own delegated one) or `systemd` (`renox-child@<tenant>`,
    /// `ops/systemd`).
    pub launcher: Launcher,
    /// The binary the children run. Default: this process's own.
    pub worker_bin: Option<PathBuf>,
    /// Local mode: tenants that get a child (F1 stand-in for the route
    /// entry's `process`).
    pub own_tenants: Vec<String>,
    /// The cgroup v2 directory children are created under (`direct`).
    /// Default: this process's own cgroup (`Delegate=yes`).
    pub cgroup_root: Option<PathBuf>,
    /// Limits of a child's cgroup: `cpu.max` quota per 100 ms period,
    /// `memory.max`, `pids.max`.
    pub child_cpu_quota_us: u64,
    pub child_memory_bytes: u64,
    pub child_pids: u64,
    /// The operator hook a move to a microVM runs (#259,
    /// `ops/scripts/move-to-microvm.sh`), with the tenant id and the file
    /// path. Absent: such a move answers exit code 75. It inherits the
    /// `[sandbox]` seccomp filter, which has no fork: builtins or `exec`
    /// only (ops/README.md, "Moving a tenant to a microVM").
    pub microvm_hook: Option<PathBuf>,
}

/// `[replication]` (#255): one `litestream replicate` per active tenant
/// file (`docs/06-data.md` "Replication and backup tiers").
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct ReplicationSection {
    pub enabled: bool,
    /// `file` (a directory: tests, the dev container, one-node setups) or
    /// `s3` (production, a UAE region).
    pub replica: ReplicaKind,
    /// `file`: the replica root; each database under `<path>/<database>`.
    pub path: Option<PathBuf>,
    /// `s3`: bucket, key prefix (each database under `<prefix>/<database>`),
    /// region, an endpoint for S3-compatible stores, and the KMS key id the
    /// bucket encrypts with (#120). Credentials come from the node's
    /// environment, never from tenant secrets.
    pub bucket: Option<String>,
    pub prefix: String,
    pub region: Option<String>,
    pub endpoint: Option<String>,
    pub sse_kms_key_id: Option<String>,
    /// Regions an `s3` replica may use in controlled mode (`docs/21`:
    /// backups stay in the UAE).
    pub allowed_regions: Vec<String>,
    pub sync_interval_ms: u64,
    pub retention_hours: u64,
    pub snapshot_interval_secs: u64,
    /// After the last cell of a database closes, the sidecar keeps running
    /// this long so the last WAL frames ship.
    pub stop_grace_ms: u64,
    /// The Litestream binary (`ops/litestream.lock`). Default: on `PATH`.
    pub litestream_bin: PathBuf,
}

/// `[replication] replica`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReplicaKind {
    #[default]
    File,
    S3,
}

impl Default for ReplicationSection {
    fn default() -> Self {
        ReplicationSection {
            enabled: false,
            replica: ReplicaKind::File,
            path: None,
            bucket: None,
            prefix: String::new(),
            region: None,
            endpoint: None,
            sse_kms_key_id: None,
            allowed_regions: vec!["me-central-1".into()],
            sync_interval_ms: 1_000,
            retention_hours: 24,
            snapshot_interval_secs: 3_600,
            stop_grace_ms: 3_000,
            litestream_bin: PathBuf::from("litestream"),
        }
    }
}

/// `[process] launcher`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Launcher {
    #[default]
    Direct,
    Systemd,
}

impl Default for ProcessSection {
    fn default() -> Self {
        ProcessSection {
            enabled: false,
            max_children: 64,
            child_idle_secs: 600.0,
            restart_backoff_ms: 200,
            run_dir: PathBuf::from("run"),
            launcher: Launcher::Direct,
            worker_bin: None,
            own_tenants: Vec::new(),
            cgroup_root: None,
            child_cpu_quota_us: 200_000,
            child_memory_bytes: 1 << 30,
            child_pids: 512,
            microvm_hook: None,
        }
    }
}

/// `[sandbox]` (#253): what the worker may do after start. Linux only; on
/// other systems `enabled = true` refuses to start.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct SandboxSection {
    /// Apply the profile at start. Default false; a controlled worker
    /// refuses to start without it unless `allow_unsandboxed = true`.
    pub enabled: bool,
    /// `enforce`: a syscall outside the allowlist kills the process.
    /// `audit`: it is logged by the kernel (`SECCOMP_RET_LOG`) and allowed.
    /// Landlock always enforces.
    pub mode: SandboxMode,
    /// Syscall names allowed on top of `sandbox/syscalls.<arch>.txt`.
    pub extra_syscalls: Vec<String>,
    /// Paths readable on top of the profile (files or directories).
    pub extra_read_paths: Vec<PathBuf>,
    /// TCP ports `connect` may reach on top of 443 and the control
    /// plane's port (Landlock ABI 4): for `fetch` allowlist entries with
    /// `http://` (80) or an explicit port.
    pub extra_connect_ports: Vec<u16>,
    /// Lets a controlled worker run with `enabled = false` (a kernel or a
    /// host where the profile cannot apply; tests). Logged at start.
    pub allow_unsandboxed: bool,
}

/// `[sandbox] mode`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxMode {
    #[default]
    Enforce,
    Audit,
}

/// Where routes, artifacts and secrets come from, and where meters and
/// logs go.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Local,
    Controlled,
}

/// `[control]`: the control plane a controlled worker registers with
/// (`docs/contracts/deploy-api.md` section 7).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlSection {
    /// Base URL of the control API's node-facing listener: `https://…` in
    /// production; plain `http://` only for a loopback address (local
    /// stack, tests). It must resolve only to addresses tenant `fetch`
    /// refuses (a private range or `fetch_blocked_addresses`), or the
    /// worker does not start.
    pub url: String,
    /// File holding the node token (`renox_node_…`), mode 0600.
    pub node_token_file: PathBuf,
    /// Region sent at registration.
    #[serde(default = "default_region")]
    pub region: String,
    /// Cells this node offers, sent at registration.
    #[serde(default = "default_max_cells")]
    pub max_cells: u32,
    /// The operator listener serving `GET /healthz` (bind it to a private
    /// address). Absent: none.
    #[serde(default)]
    pub health_listen: Option<SocketAddr>,
    /// The node listener (deploy-api.md 0.3 section 15: restore,
    /// replication status, drop, snapshot, import, move), on an address
    /// only the control plane reaches. Absent: none.
    #[serde(default)]
    pub node_listen: Option<SocketAddr>,
    /// The URL announced as `listen_url` (default `http://<node_listen>`).
    #[serde(default)]
    pub node_listen_url: Option<String>,
}

fn default_region() -> String {
    "local".into()
}

fn default_max_cells() -> u32 {
    1000
}

/// `[tls]`: the gateway serves HTTPS on `listen` with certificates chosen
/// by SNI from `cert_dir` (`crates/renox-gateway/src/tls.rs`), and the plain
/// listener on `http_listen` answers only ACME HTTP-01 challenges
/// (`docs/contracts/deploy-api.md` section 10) and redirects everything
/// else to HTTPS with 308. SIGHUP (or [`crate::Worker::reload_certificates`])
/// reloads `cert_dir` without dropping connections.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TlsSection {
    /// `<cert_dir>/<hostname>/{fullchain,privkey}.pem` and
    /// `<cert_dir>/_wildcard.<domain>/…`.
    pub cert_dir: PathBuf,
    /// The plain-HTTP listener (production `0.0.0.0:80`). Absent: none.
    #[serde(default)]
    pub http_listen: Option<SocketAddr>,
    /// `GET /.well-known/acme-challenge/<token>` on the plain listener is
    /// answered with the file `<acme_dir>/<token>` (the key authorization
    /// the ACME client of #59 writes there). Absent: every challenge is 404.
    #[serde(default)]
    pub acme_dir: Option<PathBuf>,
    /// The port in redirect `Location`s. Default: the port `listen` is
    /// bound to; 443 is left out of the URL.
    #[serde(default)]
    pub https_port: Option<u16>,
}

/// `[gateway]`: the per-client limits of `renox-gateway` (README of that
/// crate, "Configuration" and "Input limits"). Benchmarks that send all
/// their load from one address raise them.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct GatewaySection {
    /// Sustained requests per second per client IP.
    pub rate_limit_per_ip: f64,
    /// Token bucket size per client IP.
    pub rate_limit_burst: u32,
    /// Open connections per client IP.
    pub max_connections_per_ip: usize,
    /// HTTP/2 resets per connection in any one second (#166, #260).
    pub h2_max_resets_per_second: u32,
    /// HTTP/2 resets per client IP (IPv6 by /64) in any one second.
    pub h2_max_resets_per_ip_per_second: u32,
    /// HTTP/2 control frames per connection per second (token bucket).
    pub h2_max_control_frames_per_second: u32,
}

impl Default for GatewaySection {
    fn default() -> Self {
        let rate = renox_gateway::RateLimitConfig::default();
        let protocol = renox_gateway::ProtocolLimits::default();
        GatewaySection {
            rate_limit_per_ip: rate.requests_per_second,
            rate_limit_burst: rate.burst,
            max_connections_per_ip: renox_gateway::GatewayLimits::default().max_connections_per_ip,
            h2_max_resets_per_second: protocol.h2_max_resets_per_second,
            h2_max_resets_per_ip_per_second: protocol.h2_max_resets_per_ip_per_second,
            h2_max_control_frames_per_second: protocol.h2_max_control_frames_per_second,
        }
    }
}

fn default_meter_flush_ms() -> u64 {
    5_000
}

fn default_node_id() -> String {
    "node-local".into()
}

fn default_idle_timeout() -> f64 {
    600.0
}

fn default_tier() -> TierName {
    TierName::Free
}

/// Why the config could not be used. Never contains file contents.
#[derive(Debug)]
pub enum ConfigError {
    Read(std::io::Error),
    Parse(String),
    Invalid(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Read(e) => write!(f, "cannot read the config: {e}"),
            ConfigError::Parse(e) => write!(f, "config does not parse: {e}"),
            ConfigError::Invalid(e) => write!(f, "invalid config: {e}"),
        }
    }
}

impl std::error::Error for ConfigError {}

/// `https://host[:port]`, or `http://` to a loopback address. No path, no
/// user info, no query: the API paths are appended to it.
fn check_control_url(url: &str) -> Result<(), ConfigError> {
    let bad = |why: &str| Err(ConfigError::Invalid(format!("control.url: {why}")));
    let Ok(uri) = url.parse::<http::Uri>() else {
        return bad("not a URL");
    };
    let Some(authority) = uri.authority() else {
        return bad("no host");
    };
    if authority.as_str().contains('@') {
        return bad("user info is not allowed");
    }
    if !matches!(uri.path(), "" | "/") || uri.query().is_some() {
        return bad("a base URL has no path or query");
    }
    match uri.scheme_str() {
        Some("https") => Ok(()),
        Some("http") => {
            let host = authority
                .host()
                .trim_start_matches('[')
                .trim_end_matches(']');
            let loopback =
                host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
            if loopback {
                Ok(())
            } else {
                bad("plain http is allowed only to a loopback address")
            }
        }
        _ => bad("the scheme must be https"),
    }
}

impl WorkerConfig {
    /// Parse TOML. Relative paths are resolved against `base` (the config
    /// file's directory).
    pub fn parse(text: &str, base: &Path) -> Result<WorkerConfig, ConfigError> {
        let mut c: WorkerConfig =
            toml::from_str(text).map_err(|e| ConfigError::Parse(e.message().to_string()))?;
        for p in [
            &mut c.data_dir,
            &mut c.artifacts_dir,
            &mut c.routes_file,
            &mut c.meters_dir,
            &mut c.logs_dir,
        ] {
            if p.is_relative() && !p.as_os_str().is_empty() {
                *p = base.join(&*p);
            }
        }
        if let Some(p) = &mut c.platform_key_file
            && p.is_relative()
        {
            *p = base.join(&*p);
        }
        if let Some(control) = &mut c.control
            && control.node_token_file.is_relative()
        {
            control.node_token_file = base.join(&control.node_token_file);
        }
        for p in &mut c.sandbox.extra_read_paths {
            if p.is_relative() {
                *p = base.join(&*p);
            }
        }
        for p in std::iter::once(&mut c.process.run_dir)
            .chain(c.process.worker_bin.as_mut())
            .chain(c.process.microvm_hook.as_mut())
        {
            if p.is_relative() {
                *p = base.join(&*p);
            }
        }
        // A zero budget would close every HTTP/2 connection at its first reset or PING.
        for (key, value) in [
            (
                "h2_max_resets_per_second",
                c.gateway.h2_max_resets_per_second,
            ),
            (
                "h2_max_resets_per_ip_per_second",
                c.gateway.h2_max_resets_per_ip_per_second,
            ),
            (
                "h2_max_control_frames_per_second",
                c.gateway.h2_max_control_frames_per_second,
            ),
        ] {
            if value == 0 {
                return Err(ConfigError::Invalid(format!(
                    "gateway.{key} must be at least 1"
                )));
            }
        }
        if let Some(p) = &mut c.replication.path
            && p.is_relative()
        {
            *p = base.join(&*p);
        }
        if c.replication.enabled {
            let r = &c.replication;
            match r.replica {
                ReplicaKind::File if r.path.is_none() => {
                    return Err(ConfigError::Invalid(
                        "replication.path is required with replica = \"file\"".into(),
                    ));
                }
                ReplicaKind::S3 if r.bucket.is_none() => {
                    return Err(ConfigError::Invalid(
                        "replication.bucket is required with replica = \"s3\"".into(),
                    ));
                }
                _ => {}
            }
            if r.sync_interval_ms == 0 {
                return Err(ConfigError::Invalid(
                    "replication.sync_interval_ms must be positive".into(),
                ));
            }
            // docs/21-uae-gcc-strategy.md: tenant data and its backups stay
            // in the UAE; a controlled node does not start otherwise.
            if c.mode == Mode::Controlled && r.replica == ReplicaKind::S3 {
                let region = r.region.as_deref().unwrap_or("");
                if !r.allowed_regions.iter().any(|a| a == region) {
                    return Err(ConfigError::Invalid(format!(
                        "replication.region {region:?} is not in replication.allowed_regions ({}); backups stay in the UAE",
                        r.allowed_regions.join(", ")
                    )));
                }
                if r.sse_kms_key_id.is_none() {
                    return Err(ConfigError::Invalid(
                        "replication.sse_kms_key_id is required for an s3 replica in controlled mode".into(),
                    ));
                }
            }
        }
        if !(c.process.child_idle_secs.is_finite() && c.process.child_idle_secs > 0.0) {
            return Err(ConfigError::Invalid(
                "process.child_idle_secs must be positive".into(),
            ));
        }
        match c.mode {
            Mode::Local => {
                if c.control.is_some() {
                    return Err(ConfigError::Invalid(
                        "[control] is only used with mode = \"controlled\"".into(),
                    ));
                }
                if c.routes_file.as_os_str().is_empty() {
                    return Err(ConfigError::Invalid(
                        "routes_file is required in local mode".into(),
                    ));
                }
            }
            Mode::Controlled => {
                let Some(control) = &c.control else {
                    return Err(ConfigError::Invalid(
                        "mode = \"controlled\" needs a [control] section".into(),
                    ));
                };
                check_control_url(&control.url)?;
                // Gate F1 notes on #55: a controlled worker never runs tenant
                // code without the node's and the control plane's node-facing
                // addresses on the fetch blocklist (docs/24-threat-model.md B,
                // SSRF). `Worker::start` also checks that `url` resolves only
                // to refused addresses (#218).
                if c.fetch_blocked_addresses.is_empty() {
                    return Err(ConfigError::Invalid(
                        "fetch_blocked_addresses must list the node's own addresses and the control plane's node-facing ones in controlled mode".into(),
                    ));
                }
                // #253: a production node cannot forget the sandbox.
                if !c.sandbox.enabled && !c.sandbox.allow_unsandboxed {
                    return Err(ConfigError::Invalid(
                        "[sandbox] enabled = true is required in controlled mode (set [sandbox] allow_unsandboxed = true to run without it)".into(),
                    ));
                }
            }
        }
        if let Some(tls) = &mut c.tls {
            for p in std::iter::once(&mut tls.cert_dir).chain(tls.acme_dir.as_mut()) {
                if p.is_relative() {
                    *p = base.join(&*p);
                }
            }
            if tls
                .http_listen
                .is_some_and(|h| h == c.listen && h.port() != 0)
            {
                return Err(ConfigError::Invalid(
                    "tls.http_listen must differ from listen".into(),
                ));
            }
        }
        if !(c.gateway.rate_limit_per_ip.is_finite() && c.gateway.rate_limit_per_ip > 0.0) {
            return Err(ConfigError::Invalid(
                "gateway.rate_limit_per_ip must be positive".into(),
            ));
        }
        if !(c.idle_timeout_secs.is_finite() && c.idle_timeout_secs > 0.0) {
            return Err(ConfigError::Invalid(
                "idle_timeout_secs must be positive".into(),
            ));
        }
        Ok(c)
    }

    pub fn load(path: &Path) -> Result<WorkerConfig, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(ConfigError::Read)?;
        let base = path.parent().unwrap_or(Path::new("."));
        let mut c = WorkerConfig::parse(&text, base)?;
        c.config_path = Some(path.to_path_buf());
        Ok(c)
    }

    pub fn idle_timeout(&self) -> Duration {
        Duration::from_secs_f64(self.idle_timeout_secs)
    }

    pub fn tier_table(&self) -> Tiers {
        Tiers::with_overrides(&self.tiers)
    }

    pub fn tier_of(&self, tenant_id: &str) -> TierName {
        self.tenant_tiers
            .get(tenant_id)
            .copied()
            .unwrap_or(self.default_tier)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_config_parses() {
        let text = include_str!("../worker.example.toml");
        let c = WorkerConfig::parse(text, Path::new("/srv/renox")).unwrap();
        assert_eq!(c.data_dir, Path::new("/srv/renox/data"));
        assert_eq!(c.idle_timeout(), Duration::from_secs(600));
        assert_eq!(c.tier_of("t_paid_example"), TierName::Paid);
        assert_eq!(c.tier_of("anyone"), TierName::Free);
        assert_eq!(c.tier_table().free.cpu_ms, 50);
        assert_eq!(c.gateway.rate_limit_per_ip, 100.0);
        assert_eq!(c.gateway.max_connections_per_ip, 100);
        assert_eq!(c.gateway.h2_max_resets_per_second, 100);
        assert_eq!(c.gateway.h2_max_resets_per_ip_per_second, 200);
        assert_eq!(c.gateway.h2_max_control_frames_per_second, 2000);
    }

    /// #260: the three HTTP/2 flood knobs of #166 parse, default to the
    /// gateway's `ProtocolLimits`, and refuse 0 with the key's name.
    #[test]
    fn gateway_h2_flood_keys() {
        let base = Path::new("/srv/renox");
        let min = "listen = \"127.0.0.1:0\"\ndata_dir = \"d\"\nartifacts_dir = \"a\"\nroutes_file = \"r.json\"\nmeters_dir = \"m\"\nlogs_dir = \"l\"\n";
        let with = |extra: &str| format!("{min}{extra}");
        let d = WorkerConfig::parse(min, base).unwrap();
        assert_eq!(
            (
                d.gateway.h2_max_resets_per_second,
                d.gateway.h2_max_resets_per_ip_per_second,
                d.gateway.h2_max_control_frames_per_second
            ),
            (100, 200, 2000)
        );
        let c = WorkerConfig::parse(
            &with("[gateway]\nh2_max_resets_per_second = 50\nh2_max_resets_per_ip_per_second = 80\nh2_max_control_frames_per_second = 500\n"),
            base,
        )
        .unwrap();
        assert_eq!(
            (
                c.gateway.h2_max_resets_per_second,
                c.gateway.h2_max_resets_per_ip_per_second,
                c.gateway.h2_max_control_frames_per_second
            ),
            (50, 80, 500)
        );
        for key in [
            "h2_max_resets_per_second",
            "h2_max_resets_per_ip_per_second",
            "h2_max_control_frames_per_second",
        ] {
            let err = WorkerConfig::parse(&with(&format!("[gateway]\n{key} = 0\n")), base)
                .unwrap_err()
                .to_string();
            assert!(err.contains(&format!("gateway.{key}")), "{err}");
        }
        assert!(
            WorkerConfig::parse(&with("[gateway]\nh2_max_resets_per_second = -1\n"), base).is_err()
        );
    }

    #[test]
    fn tls_section() {
        let base = "listen = \"0.0.0.0:443\"\ndata_dir=\"d\"\nartifacts_dir=\"a\"\nroutes_file=\"r\"\nmeters_dir=\"m\"\nlogs_dir=\"l\"\n";
        let c = WorkerConfig::parse(base, Path::new("/srv")).unwrap();
        assert!(c.tls.is_none());
        let text = format!(
            "{base}[tls]\ncert_dir = \"certs\"\nhttp_listen = \"0.0.0.0:80\"\nacme_dir = \"/var/acme\"\n"
        );
        let tls = WorkerConfig::parse(&text, Path::new("/srv"))
            .unwrap()
            .tls
            .unwrap();
        assert_eq!(tls.cert_dir, Path::new("/srv/certs"));
        assert_eq!(tls.acme_dir.as_deref(), Some(Path::new("/var/acme")));
        assert_eq!(tls.http_listen, Some("0.0.0.0:80".parse().unwrap()));
        assert_eq!(tls.https_port, None);
        let same = format!("{base}[tls]\ncert_dir = \"c\"\nhttp_listen = \"0.0.0.0:443\"\n");
        assert!(WorkerConfig::parse(&same, Path::new("/")).is_err());
        let unknown = format!("{base}[tls]\ncert_dir = \"c\"\nkey = \"k\"\n");
        assert!(WorkerConfig::parse(&unknown, Path::new("/")).is_err());
    }

    #[test]
    fn controlled_mode() {
        let base = "listen = \"0.0.0.0:443\"\ndata_dir=\"d\"\nartifacts_dir=\"a\"\nmeters_dir=\"m\"\nlogs_dir=\"l\"\n";
        // Local mode needs the route table file.
        assert!(WorkerConfig::parse(base, Path::new("/srv")).is_err());
        let control = "[control]\nurl = \"https://control.renox.test\"\nnode_token_file = \"node.token\"\nhealth_listen = \"127.0.0.1:9090\"\n[sandbox]\nallow_unsandboxed = true\n";
        let blocked = "fetch_blocked_addresses = [\"203.0.113.10\"]\n";
        let ok = format!("mode = \"controlled\"\n{blocked}{base}{control}");
        let c = WorkerConfig::parse(&ok, Path::new("/srv")).unwrap();
        assert_eq!(c.mode, Mode::Controlled);
        let s = c.control.unwrap();
        assert_eq!(s.node_token_file, Path::new("/srv/node.token"));
        assert_eq!(s.region, "local");
        assert_eq!(s.health_listen, Some("127.0.0.1:9090".parse().unwrap()));
        // Gate F1 notes on #55: an empty fetch blocklist refuses to start.
        let open = format!("mode = \"controlled\"\n{base}{control}");
        let e = WorkerConfig::parse(&open, Path::new("/srv")).unwrap_err();
        assert!(e.to_string().contains("fetch_blocked_addresses"), "{e}");
        // No [control] in controlled mode; [control] in local mode.
        let bare = format!("mode = \"controlled\"\n{blocked}{base}");
        assert!(WorkerConfig::parse(&bare, Path::new("/srv")).is_err());
        let local = format!("{base}routes_file = \"r\"\n{control}");
        assert!(WorkerConfig::parse(&local, Path::new("/srv")).is_err());
        for url in [
            "http://control.renox.test",
            "ftp://control.renox.test",
            "https://u:p@control.renox.test",
            "https://control.renox.test/v1",
            "control.renox.test",
        ] {
            let text = format!(
                "mode = \"controlled\"\n{blocked}{base}[control]\nurl = \"{url}\"\nnode_token_file = \"t\"\n"
            );
            assert!(
                WorkerConfig::parse(&text, Path::new("/srv")).is_err(),
                "{url}"
            );
        }
        for url in [
            "http://127.0.0.1:8787",
            "http://localhost:8787/",
            "https://control.renox.test:8443",
        ] {
            let text = format!(
                "mode = \"controlled\"\n{blocked}{base}[control]\nurl = \"{url}\"\nnode_token_file = \"t\"\n[sandbox]\nenabled = true\n"
            );
            assert!(
                WorkerConfig::parse(&text, Path::new("/srv")).is_ok(),
                "{url}"
            );
        }
    }

    /// #253: `[sandbox]` parses, and a controlled worker without it refuses
    /// to start unless `allow_unsandboxed` (docs/24-threat-model.md,
    /// "Isolate escape (V8 bug)").
    #[test]
    fn sandbox_section() {
        let base = "listen = \"127.0.0.1:1\"\ndata_dir=\"d\"\nartifacts_dir=\"a\"\nroutes_file=\"r\"\nmeters_dir=\"m\"\nlogs_dir=\"l\"\n";
        let c = WorkerConfig::parse(base, Path::new("/srv")).unwrap();
        assert!(!c.sandbox.enabled);
        assert_eq!(c.sandbox.mode, SandboxMode::Enforce);
        let text = format!(
            "{base}[sandbox]\nenabled = true\nmode = \"audit\"\nextra_syscalls = [\"io_uring_setup\"]\nextra_read_paths = [\"ca\"]\nextra_connect_ports = [80]\n"
        );
        let s = WorkerConfig::parse(&text, Path::new("/srv"))
            .unwrap()
            .sandbox;
        assert!(s.enabled);
        assert_eq!(s.mode, SandboxMode::Audit);
        assert_eq!(s.extra_syscalls, ["io_uring_setup"]);
        assert_eq!(s.extra_read_paths, [PathBuf::from("/srv/ca")]);
        assert_eq!(s.extra_connect_ports, [80]);
        let bad = format!("{base}[sandbox]\nmode = \"off\"\n");
        assert!(WorkerConfig::parse(&bad, Path::new("/")).is_err());

        let controlled = "mode = \"controlled\"\nfetch_blocked_addresses = [\"203.0.113.10\"]\nlisten = \"0.0.0.0:443\"\ndata_dir=\"d\"\nartifacts_dir=\"a\"\nmeters_dir=\"m\"\nlogs_dir=\"l\"\n[control]\nurl = \"https://control.renox.test\"\nnode_token_file = \"t\"\n";
        let e = WorkerConfig::parse(controlled, Path::new("/srv")).unwrap_err();
        assert!(e.to_string().contains("[sandbox]"), "{e}");
        for extra in [
            "[sandbox]\nenabled = true\n",
            "[sandbox]\nallow_unsandboxed = true\n",
        ] {
            let ok = format!("{controlled}{extra}");
            assert!(
                WorkerConfig::parse(&ok, Path::new("/srv")).is_ok(),
                "{extra}"
            );
        }
    }

    #[test]
    fn process_section() {
        let base = "listen = \"127.0.0.1:1\"\ndata_dir=\"d\"\nartifacts_dir=\"a\"\nroutes_file=\"r\"\nmeters_dir=\"m\"\nlogs_dir=\"l\"\n";
        let p = WorkerConfig::parse(base, Path::new("/srv"))
            .unwrap()
            .process;
        assert!(!p.enabled);
        assert_eq!(p.run_dir, Path::new("/srv/run"));
        assert_eq!(
            (p.max_children, p.restart_backoff_ms, p.launcher),
            (64, 200, Launcher::Direct)
        );
        let text = format!(
            "{base}[process]\nenabled = true\nmax_children = 2\nchild_idle_secs = 5\nrestart_backoff_ms = 50\nrun_dir = \"/run/renox\"\nlauncher = \"systemd\"\nown_tenants = [\"t_a\"]\nmicrovm_hook = \"hook.sh\"\n"
        );
        let p = WorkerConfig::parse(&text, Path::new("/srv"))
            .unwrap()
            .process;
        assert!(p.enabled);
        assert_eq!(p.own_tenants, ["t_a"]);
        assert_eq!(p.launcher, Launcher::Systemd);
        assert_eq!(p.run_dir, Path::new("/run/renox"));
        assert_eq!(p.microvm_hook.as_deref(), Some(Path::new("/srv/hook.sh")));
        let bad = format!("{base}[process]\nchild_idle_secs = 0\n");
        assert!(WorkerConfig::parse(&bad, Path::new("/")).is_err());
    }

    /// #255, `docs/21-uae-gcc-strategy.md`: a controlled node with an s3
    /// replica outside the allowed regions refuses to start.
    #[test]
    fn replication_section() {
        let base = "listen = \"127.0.0.1:1\"\ndata_dir=\"d\"\nartifacts_dir=\"a\"\nroutes_file=\"r\"\nmeters_dir=\"m\"\nlogs_dir=\"l\"\n";
        let r = WorkerConfig::parse(base, Path::new("/srv"))
            .unwrap()
            .replication;
        assert!(!r.enabled);
        assert_eq!(
            (
                r.sync_interval_ms,
                r.retention_hours,
                r.snapshot_interval_secs
            ),
            (1000, 24, 3600)
        );
        let file = format!(
            "{base}[replication]\nenabled = true\nreplica = \"file\"\npath = \"replica\"\n"
        );
        let r = WorkerConfig::parse(&file, Path::new("/srv"))
            .unwrap()
            .replication;
        assert_eq!(r.path.as_deref(), Some(Path::new("/srv/replica")));
        let no_path = format!("{base}[replication]\nenabled = true\n");
        assert!(WorkerConfig::parse(&no_path, Path::new("/")).is_err());

        let controlled = "mode = \"controlled\"\nfetch_blocked_addresses = [\"203.0.113.1\"]\nlisten = \"0.0.0.0:443\"\ndata_dir=\"d\"\nartifacts_dir=\"a\"\nmeters_dir=\"m\"\nlogs_dir=\"l\"\n[control]\nurl = \"https://c.renox.test\"\nnode_token_file = \"t\"\n[sandbox]\nenabled = true\n";
        let s3 = |region: &str, kms: &str| {
            format!(
                "{controlled}[replication]\nenabled = true\nreplica = \"s3\"\nbucket = \"b\"\nregion = \"{region}\"\n{kms}"
            )
        };
        let e = WorkerConfig::parse(
            &s3("eu-west-1", "sse_kms_key_id = \"k\"\n"),
            Path::new("/srv"),
        )
        .unwrap_err();
        assert!(
            e.to_string().contains("eu-west-1") && e.to_string().contains("UAE"),
            "{e}"
        );
        let e = WorkerConfig::parse(&s3("me-central-1", ""), Path::new("/srv")).unwrap_err();
        assert!(e.to_string().contains("sse_kms_key_id"), "{e}");
        assert!(
            WorkerConfig::parse(
                &s3("me-central-1", "sse_kms_key_id = \"k\"\n"),
                Path::new("/srv")
            )
            .is_ok()
        );
    }

    #[test]
    fn unknown_keys_are_refused() {
        let text = "listen = \"127.0.0.1:1\"\ndata_dir=\"d\"\nartifacts_dir=\"a\"\nroutes_file=\"r\"\nmeters_dir=\"m\"\nlogs_dir=\"l\"\nsurprise = 1\n";
        assert!(WorkerConfig::parse(text, Path::new("/")).is_err());
    }
}
