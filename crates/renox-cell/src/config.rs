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
}

impl Default for GatewaySection {
    fn default() -> Self {
        let rate = renox_gateway::RateLimitConfig::default();
        GatewaySection {
            rate_limit_per_ip: rate.requests_per_second,
            rate_limit_burst: rate.burst,
            max_connections_per_ip: renox_gateway::GatewayLimits::default().max_connections_per_ip,
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
        WorkerConfig::parse(&text, base)
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
    fn unknown_keys_are_refused() {
        let text = "listen = \"127.0.0.1:1\"\ndata_dir=\"d\"\nartifacts_dir=\"a\"\nroutes_file=\"r\"\nmeters_dir=\"m\"\nlogs_dir=\"l\"\nsurprise = 1\n";
        assert!(WorkerConfig::parse(text, Path::new("/")).is_err());
    }
}
