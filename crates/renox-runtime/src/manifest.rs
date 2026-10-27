//! `manifest.json` and the load-time checks of an artifact directory
//! (`docs/contracts/artifact.md` sections 1-3 and the rules marked *load*
//! in section 6). Pure Rust, no V8.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The artifact contract version this runtime understands.
pub const ARTIFACT_VERSION: u32 = 0;

/// V5: bytes under `code/` (20 MiB).
pub const MAX_CODE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Options,
    Head,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
            Method::Options => "OPTIONS",
            Method::Head => "HEAD",
        }
    }

    /// Methods are case-sensitive on the wire (RFC 9110); `get` is not `GET`.
    pub fn parse(s: &str) -> Option<Method> {
        Some(match s {
            "GET" => Method::Get,
            "POST" => Method::Post,
            "PUT" => Method::Put,
            "PATCH" => Method::Patch,
            "DELETE" => Method::Delete,
            "OPTIONS" => Method::Options,
            "HEAD" => Method::Head,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteKind {
    Function,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum CodeFormat {
    #[serde(rename = "esm-dir")]
    EsmDir,
    #[serde(rename = "eszip")]
    Eszip,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteDef {
    pub kind: RouteKind,
    pub method: Method,
    pub path: String,
    pub module: String,
    pub export: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactInfo {
    pub version: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct App {
    pub name: String,
    pub timezone: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Code {
    pub format: CodeFormat,
    /// Module id -> module path (relative to `code/`, or the `file:///`
    /// specifier inside `bundle.eszip`).
    pub entry: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Permissions {
    pub network: Vec<String>,
    pub secrets: Vec<String>,
}

/// Per-app overrides; the runtime applies `min(override, tier limit)`.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LimitOverrides {
    pub cpu_ms: Option<u64>,
    pub wall_ms: Option<u64>,
    pub memory_mb: Option<u64>,
    pub concurrency: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub artifact: ArtifactInfo,
    pub app: App,
    pub code: Code,
    pub routes: Vec<RouteDef>,
    pub permissions: Permissions,
    #[serde(default)]
    pub limits: Option<LimitOverrides>,
    #[serde(default)]
    pub modules: Option<serde_json::Map<String, serde_json::Value>>,
}

/// An artifact refused at load. `rule` is the contract's `V1`-`V13`. The
/// message names artifact-relative paths only, never a path of the machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadError {
    pub rule: &'static str,
    pub reason: String,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.rule, self.reason)
    }
}

impl std::error::Error for LoadError {}

fn load_err(rule: &'static str, reason: impl Into<String>) -> LoadError {
    LoadError {
        rule,
        reason: reason.into(),
    }
}

/// A verified artifact on disk.
#[derive(Debug, Clone)]
pub struct Artifact {
    /// The artifact root (its directory name is `hash`).
    pub root: PathBuf,
    pub hash: String,
    pub manifest: Manifest,
}

impl Artifact {
    /// The directory tenant modules are loaded from.
    pub fn code_dir(&self) -> PathBuf {
        self.root.join("code")
    }
}

/// V1, "Paths": one artifact-relative path.
pub fn check_relative_path(p: &str) -> Result<(), &'static str> {
    if p.is_empty() || p.len() > 512 {
        return Err("empty or longer than 512 bytes");
    }
    if p.starts_with('/') || p.ends_with('/') {
        return Err("leading or trailing /");
    }
    let segments: Vec<&str> = p.split('/').collect();
    if segments.len() > 32 {
        return Err("more than 32 segments");
    }
    for s in &segments {
        if s.is_empty() {
            return Err("empty segment");
        }
        if *s == "." || *s == ".." {
            return Err("segment . or ..");
        }
    }
    if p.chars().any(|c| c == '\\' || c == ':' || c.is_control()) {
        return Err("backslash, colon, or control character");
    }
    Ok(())
}

/// Walk the tree: every regular file with its artifact-relative path.
/// Symbolic links and special files are refused (V1).
fn collect_files(root: &Path) -> Result<Vec<(String, PathBuf)>, LoadError> {
    let mut out = Vec::new();
    let mut stack = vec![(String::new(), root.to_path_buf())];
    while let Some((rel, dir)) = stack.pop() {
        let entries = fs::read_dir(&dir)
            .map_err(|_| load_err("V1", format!("cannot read directory {rel:?}")))?;
        for entry in entries {
            let entry = entry.map_err(|_| load_err("V1", "cannot read directory entry"))?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| load_err("V1", "non UTF-8 file name"))?;
            let rel_path = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            // symlink_metadata: never follow a link.
            let meta = entry
                .metadata()
                .map_err(|_| load_err("V1", format!("cannot stat {rel_path:?}")))?;
            let ft = meta.file_type();
            if ft.is_symlink() {
                return Err(load_err("V1", format!("symbolic link {rel_path:?}")));
            } else if ft.is_dir() {
                stack.push((rel_path, entry.path()));
            } else if ft.is_file() {
                check_relative_path(&rel_path)
                    .map_err(|r| load_err("V1", format!("{rel_path:?}: {r}")))?;
                out.push((rel_path, entry.path()));
            } else {
                return Err(load_err("V1", format!("special file {rel_path:?}")));
            }
        }
    }
    Ok(out)
}

/// V2: the content hash of section 2 (canonical `sha256sum` listing).
pub fn content_hash(root: &Path) -> Result<String, LoadError> {
    let mut files = collect_files(root)?;
    files.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut listing = Sha256::new();
    for (rel, path) in &files {
        let bytes = fs::read(path).map_err(|_| load_err("V2", format!("cannot read {rel:?}")))?;
        let digest = hex(&Sha256::digest(&bytes));
        listing.update(format!("{digest}  {rel}\n").as_bytes());
    }
    Ok(hex(&listing.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Load and verify an artifact directory: V1 (paths, links), V2 (hash =
/// directory name), V3 (manifest and version), V5 (code size), V6 (code
/// layout), V7 (routes and entries). V8 (route conflicts) and V9-V12 are
/// `renox check`'s job in F1; the router still refuses invalid patterns.
pub fn load_artifact(root: &Path) -> Result<Artifact, LoadError> {
    let dir_name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let files = collect_files(root)?;
    for (rel, _) in &files {
        let top = rel.split('/').next().unwrap_or("");
        if !matches!(top, "manifest.json" | "code" | "migrations" | "public") {
            return Err(load_err(
                "V1",
                format!("unexpected top-level entry {top:?}"),
            ));
        }
    }
    let hash = content_hash(root)?;
    if hash != dir_name {
        return Err(load_err(
            "V2",
            "directory name does not equal the content hash",
        ));
    }
    let raw = fs::read(root.join("manifest.json"))
        .map_err(|_| load_err("V3", "manifest.json missing"))?;
    let manifest: Manifest =
        serde_json::from_slice(&raw).map_err(|e| load_err("V3", format!("manifest.json: {e}")))?;
    if manifest.artifact.version != ARTIFACT_VERSION {
        return Err(load_err(
            "V3",
            format!("unknown artifact.version {}", manifest.artifact.version),
        ));
    }
    let code_files: Vec<&(String, PathBuf)> = files
        .iter()
        .filter(|(r, _)| r.starts_with("code/"))
        .collect();
    let mut code_bytes = 0u64;
    for (_, p) in &code_files {
        code_bytes += fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    }
    if code_bytes > MAX_CODE_BYTES {
        return Err(load_err(
            "V5",
            format!("code/ is {code_bytes} bytes, over {MAX_CODE_BYTES}"),
        ));
    }
    match manifest.code.format {
        CodeFormat::EsmDir => {
            for (rel, _) in &code_files {
                if !(rel.ends_with(".js") || rel.ends_with(".mjs") || rel.ends_with(".json")) {
                    return Err(load_err(
                        "V6",
                        format!("{rel:?} is not .js, .mjs, or .json"),
                    ));
                }
            }
            for (id, path) in &manifest.code.entry {
                check_relative_path(path)
                    .map_err(|r| load_err("V6", format!("code.entry {id:?}: {r}")))?;
                if !code_files
                    .iter()
                    .any(|(r, _)| r.strip_prefix("code/") == Some(path.as_str()))
                {
                    return Err(load_err(
                        "V6",
                        format!("code.entry {id:?} points to a missing file"),
                    ));
                }
            }
        }
        CodeFormat::Eszip => {
            if code_files.len() != 1 || code_files[0].0 != "code/bundle.eszip" {
                return Err(load_err("V6", "code/ must hold exactly bundle.eszip"));
            }
        }
    }
    for (id, path) in &manifest.code.entry {
        if !(path.ends_with(".js") || path.ends_with(".mjs")) {
            return Err(load_err(
                "V6",
                format!("code.entry {id:?} must end in .js or .mjs"),
            ));
        }
    }
    if manifest.routes.is_empty() || manifest.code.entry.is_empty() {
        return Err(load_err(
            "V7",
            "at least one route and one code.entry are required",
        ));
    }
    for r in &manifest.routes {
        if !manifest.code.entry.contains_key(&r.module) {
            return Err(load_err(
                "V7",
                format!(
                    "route {} {} names unknown module {:?}",
                    r.method.as_str(),
                    r.path,
                    r.module
                ),
            ));
        }
        if r.export != r.method.as_str() {
            return Err(load_err(
                "V7",
                format!(
                    "route {} {}: export must equal method",
                    r.method.as_str(),
                    r.path
                ),
            ));
        }
    }
    for id in manifest.code.entry.keys() {
        if !manifest.routes.iter().any(|r| &r.module == id) {
            return Err(load_err(
                "V7",
                format!("code.entry {id:?} is not used by any route"),
            ));
        }
    }
    Ok(Artifact {
        root: root.to_path_buf(),
        hash,
        manifest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/contracts/examples/hello-artifact/802957869194e4c16e462dfcb50bfa6b3e435fca606b96a1223e2b7e21271d7a")
    }

    #[test]
    fn hello_artifact_loads_and_hash_matches() {
        let a = load_artifact(&hello_dir()).unwrap();
        assert_eq!(a.manifest.routes.len(), 1);
        assert_eq!(a.manifest.code.format, CodeFormat::EsmDir);
    }

    #[test]
    fn relative_paths() {
        for bad in [
            "", "/a", "a/", "a//b", "a/../b", "./a", "a\\b", "a:b", "a\u{1}b",
        ] {
            assert!(check_relative_path(bad).is_err(), "{bad:?}");
        }
        assert!(check_relative_path("functions/api/hello.js").is_ok());
    }

    #[test]
    fn hash_mismatch_is_refused() {
        let tmp = std::env::temp_dir().join(format!("renox-manifest-test-{}", std::process::id()));
        let dir = tmp.join("0000000000000000000000000000000000000000000000000000000000000000");
        fs::create_dir_all(dir.join("code")).unwrap();
        fs::copy(hello_dir().join("manifest.json"), dir.join("manifest.json")).unwrap();
        let err = load_artifact(&dir).unwrap_err();
        assert_eq!(err.rule, "V2");
        fs::remove_dir_all(&tmp).unwrap();
    }
}
