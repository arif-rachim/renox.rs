//! The `security` object of a version 1 manifest (`manifest.schema.json`,
//! `$defs/security`), with the defaults of `artifact.md` section 3. The
//! cell's loader validates the whole manifest (V3, V16); the gateway only
//! reads it, and a manifest it cannot read gets the defaults (fail closed:
//! the defaults are the strictest settings).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Csp {
    pub script_src: Vec<String>,
    pub style_src: Vec<String>,
    pub img_src: Vec<String>,
    pub connect_src: Vec<String>,
    pub frame_src: Vec<String>,
    pub font_src: Vec<String>,
    pub allow_unsafe: bool,
    pub report_only: bool,
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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeploymentInfo {
    /// `artifact.version` (0 or 1): where the public index is.
    pub version: u32,
    pub security: SecurityConfig,
}

#[derive(Deserialize)]
struct ManifestHead {
    artifact: ArtifactHead,
    #[serde(default)]
    security: Option<SecurityConfig>,
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
        Ok(DeploymentInfo {
            version: head.artifact.version,
            security: head.security.unwrap_or_default(),
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
}
