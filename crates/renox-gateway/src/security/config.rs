//! The `security` object of a version 1 manifest (`manifest.schema.json`,
//! `$defs/security`), with the defaults of `artifact.md` section 3. The
//! cell's loader validates the whole manifest (V3, V16); the gateway only
//! reads it, and a manifest it cannot read gets the defaults (fail closed:
//! the defaults are the strictest settings).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;

/// At most this many `form_action` origins (`artifact.md` 1.10).
const MAX_FORM_ACTION: usize = 8;

/// `https://host[:port]`, the host lowercase with at least one dot and no
/// wildcard; no path, no `;` or `,` (`artifact.md` 1.10, #740). A form target
/// is an origin: a path would pin one URL, which a form does not need.
fn is_form_action_origin(src: &str) -> bool {
    let Some(rest) = src.strip_prefix("https://") else {
        return false;
    };
    let (host, port) = match rest.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (rest, None),
    };
    if port.is_some_and(|p| p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|l| {
            let b = l.as_bytes();
            !b.is_empty()
                && b.len() <= 63
                && b.iter()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
                && b[0] != b'-'
                && b[b.len() - 1] != b'-'
        })
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Csp {
    pub script_src: Vec<String>,
    pub style_src: Vec<String>,
    pub img_src: Vec<String>,
    pub connect_src: Vec<String>,
    pub frame_src: Vec<String>,
    pub font_src: Vec<String>,
    /// Extra origins a form may post to (`form-action 'self' <sources>`, #740):
    /// `https://` origins only, from the app's own `renox.toml`.
    pub form_action: Vec<String>,
    pub allow_unsafe: bool,
    pub report_only: bool,
}

impl Csp {
    /// Drops every source that holds `;` or `,` (`manifest.md` MF17,
    /// `artifact.md` 1.9.2): in a `Content-Security-Policy` header `;` ends a
    /// directive and `,` starts a second policy, so a source must never change
    /// the policy's structure. The cell and the CLI refuse such a manifest; this
    /// is the gateway's own guard, so a bad source is never merged into the
    /// header. Each dropped source is logged as a platform warning.
    fn drop_structural_sources(&mut self) {
        for (directive, list) in [
            ("script_src", &mut self.script_src),
            ("style_src", &mut self.style_src),
            ("img_src", &mut self.img_src),
            ("connect_src", &mut self.connect_src),
            ("frame_src", &mut self.frame_src),
            ("font_src", &mut self.font_src),
        ] {
            list.retain(|src| {
                let bad = src.contains([';', ',']);
                if bad {
                    tracing::warn!(directive, source = %src, "dropped a CSP source with ';' or ',' (MF17)");
                }
                !bad
            });
        }
        self.form_action.retain(|src| {
            let ok = is_form_action_origin(src);
            if !ok {
                tracing::warn!(directive = "form_action", source = %src, "dropped a form_action source that is not an https:// origin (#740)");
            }
            ok
        });
        self.form_action.truncate(MAX_FORM_ACTION);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Cors {
    pub origins: Vec<String>,
    pub methods: Vec<String>,
    pub headers: Vec<String>,
    pub credentials: bool,
    pub max_age_s: u32,
}

impl Default for Cors {
    fn default() -> Self {
        Cors {
            origins: Vec::new(),
            methods: vec!["GET".into(), "HEAD".into(), "POST".into()],
            headers: Vec::new(),
            credentials: false,
            max_age_s: 600,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Headers {
    pub referrer_policy: String,
    pub permissions_allow: Vec<String>,
}

impl Default for Headers {
    fn default() -> Self {
        Headers {
            referrer_policy: "strict-origin-when-cross-origin".into(),
            permissions_allow: Vec::new(),
        }
    }
}

/// One `ratelimit[]` bucket: `requests` per `window_s` per key (`ip`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RateBucket {
    pub method: String,
    pub path: String,
    pub requests: u32,
    pub window_s: u32,
    pub key: String,
}

/// `manifest.security`, every field defaulted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct SecurityConfig {
    pub csp: Csp,
    pub cors: Cors,
    pub headers: Headers,
    pub ratelimit: Vec<RateBucket>,
}

/// What the gateway reads from a deployment's `manifest.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeploymentInfo {
    /// `artifact.version` (0 or 1): where the public index is.
    pub version: u32,
    pub security: SecurityConfig,
    /// `client.events` (`client-events.md` section 2, Open 1): `false`
    /// turns the client script and `/__renox/events` off. Default `true`.
    pub client_events: bool,
}

impl Default for DeploymentInfo {
    fn default() -> Self {
        DeploymentInfo {
            version: 0,
            security: SecurityConfig::default(),
            client_events: true,
        }
    }
}

#[derive(Deserialize)]
struct ManifestHead {
    artifact: ArtifactHead,
    #[serde(default)]
    security: Option<SecurityConfig>,
    #[serde(default)]
    client: Option<ClientHead>,
}

#[derive(Deserialize)]
struct ClientHead {
    #[serde(default = "yes")]
    events: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
struct ArtifactHead {
    version: u32,
}

impl DeploymentInfo {
    /// Parses the parts of `manifest.json` the gateway uses; other keys are
    /// ignored here (the cell validates them).
    pub fn parse(json: &str) -> Result<DeploymentInfo, String> {
        let head: ManifestHead = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let mut security = head.security.unwrap_or_default();
        security.csp.drop_structural_sources();
        Ok(DeploymentInfo {
            version: head.artifact.version,
            security,
            client_events: head.client.is_none_or(|c| c.events),
        })
    }
}

/// `<artifact_root>/<hash>/manifest.json`, read once per hash
/// (`artifact.md` section 4: "which it reads once per hash").
#[derive(Debug)]
pub struct SecurityStore {
    artifact_root: PathBuf,
    cache: Mutex<HashMap<String, Arc<DeploymentInfo>>>,
}

impl SecurityStore {
    pub fn new(artifact_root: impl Into<PathBuf>) -> SecurityStore {
        SecurityStore {
            artifact_root: artifact_root.into(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<DeploymentInfo>>> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The deployment's info; the defaults (strictest) when the manifest is
    /// missing or unreadable.
    pub async fn get(&self, deployment_hash: &str) -> Arc<DeploymentInfo> {
        if let Some(i) = self.lock().get(deployment_hash) {
            return i.clone();
        }
        let path = self
            .artifact_root
            .join(deployment_hash)
            .join("manifest.json");
        let info = match tokio::fs::read_to_string(&path).await {
            Ok(json) => DeploymentInfo::parse(&json).unwrap_or_default(),
            Err(_) => DeploymentInfo::default(),
        };
        let info = Arc::new(info);
        self.lock()
            .entry(deployment_hash.to_owned())
            .or_insert(info)
            .clone()
    }

    /// Forgets a deployment (after it is evicted).
    pub fn forget(&self, deployment_hash: &str) {
        self.lock().remove(deployment_hash);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_the_shop_example() {
        let v0 = DeploymentInfo::parse(r#"{"artifact":{"version":0},"routes":[]}"#).unwrap();
        assert_eq!(v0.version, 0);
        assert_eq!(v0.security, SecurityConfig::default());
        assert_eq!(v0.security.cors.methods, ["GET", "HEAD", "POST"]);
        assert_eq!(v0.security.cors.max_age_s, 600);
        let shop = DeploymentInfo::parse(
            r#"{"artifact":{"version":1},"security":{"csp":{"script_src":["https://js.stripe.com"]}}}"#,
        )
        .unwrap();
        assert_eq!(shop.version, 1);
        assert_eq!(shop.security.csp.script_src, ["https://js.stripe.com"]);
        assert!(!shop.security.csp.allow_unsafe);
    }

    #[test]
    fn a_csp_source_with_semicolon_or_comma_is_dropped() {
        let info = DeploymentInfo::parse(
            r#"{"artifact":{"version":1},"security":{"csp":{"script_src":["https://cdn.example/;report-uri","https://ok.example","https://a.example/x,y"],"img_src":["https://i.example/a;b"]}}}"#,
        )
        .unwrap();
        assert_eq!(info.security.csp.script_src, ["https://ok.example"]);
        assert!(info.security.csp.img_src.is_empty());
    }

    #[test]
    fn form_action_keeps_only_https_origins() {
        let info = DeploymentInfo::parse(
            r#"{"artifact":{"version":1},"security":{"csp":{"form_action":["https://api.example.com","https://*.example.com","http://api.example.com","data:","https://a.example/x;y","https://b.example/path","https://c.example:8443"]}}}"#,
        )
        .unwrap();
        assert_eq!(
            info.security.csp.form_action,
            ["https://api.example.com", "https://c.example:8443"]
        );
    }
}
