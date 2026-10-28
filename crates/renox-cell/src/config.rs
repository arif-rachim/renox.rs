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
    /// The node's own public addresses and the control plane's: tenant
    /// `fetch` is refused to them on top of the private ranges
    /// (`crates/renox-runtime` README, "Outbound fetch").
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
            if p.is_relative() {
                *p = base.join(&*p);
            }
        }
        if let Some(p) = &mut c.platform_key_file
            && p.is_relative()
        {
            *p = base.join(&*p);
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
    fn unknown_keys_are_refused() {
        let text = "listen = \"127.0.0.1:1\"\ndata_dir=\"d\"\nartifacts_dir=\"a\"\nroutes_file=\"r\"\nmeters_dir=\"m\"\nlogs_dir=\"l\"\nsurprise = 1\n";
        assert!(WorkerConfig::parse(text, Path::new("/")).is_err());
    }
}
