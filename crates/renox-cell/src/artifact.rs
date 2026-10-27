//! Artifact loader v0 (`docs/contracts/artifact.md`, `docs/05-tenant-lifecycle.md`):
//! artifacts are content-addressed and never overwritten; the worker
//! verifies the canonical hash before first use and refuses a mismatch.
//!
//! In F1 the "object storage" is a local directory ([`LocalArtifactStore`]);
//! F3 adds the S3 fetch with a disk cache behind the same [`ArtifactStore`]
//! trait (#55).
//!
//! What is checked where:
//!
//! | Rule (`artifact.md` section 6) | Here | Again in `renox-runtime` at each isolate creation |
//! | --- | --- | --- |
//! | V1 paths, no symbolic links or special files | [`canonical_hash`] (tree walk) | yes |
//! | V2 directory name = content hash | [`LocalArtifactStore::get`] | yes |
//! | V3 manifest against `manifest.schema.json` | [`Manifest::parse`] (`jsonschema`) | shape only (serde) |
//! | V5-V7 code size, layout, routes and entries | — | yes |
//! | V8 route conflicts | [`Manifest::parse`] | — |
//! | V11 migrations checksums | [`check_migrations`] | the migration runner checks again |

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use renox_runtime::manifest::{RouteDef, check_relative_path, content_hash};
use sha2::{Digest, Sha256};

/// The manifest schema of artifact contract version 0.
const MANIFEST_SCHEMA: &str = include_str!("../../../docs/contracts/schemas/manifest.schema.json");

/// Why an artifact was refused. Messages name the rule, the artifact path
/// or field, and a reason; never a path of the machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactError {
    /// No artifact with this hash in the store.
    NotFound(String),
    /// V2: the content does not hash to the name it is stored under.
    HashMismatch { expected: String, actual: String },
    /// Another rule (`V1`, `V3`, `V8`, `V11`).
    Invalid { rule: &'static str, reason: String },
}

impl std::fmt::Display for ArtifactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArtifactError::NotFound(h) => write!(f, "artifact {h} not found"),
            ArtifactError::HashMismatch { expected, actual } => {
                write!(f, "V2: artifact {expected} hashes to {actual}")
            }
            ArtifactError::Invalid { rule, reason } => write!(f, "{rule}: {reason}"),
        }
    }
}

impl std::error::Error for ArtifactError {}

fn invalid(rule: &'static str, reason: impl Into<String>) -> ArtifactError {
    ArtifactError::Invalid {
        rule,
        reason: reason.into(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The canonical listing of section 2 for in-memory files: one
/// `<sha256 hex>  <path>\n` line per file, paths sorted by their UTF-8 bytes.
/// The CLI's TypeScript implementation (#32) must produce the same text;
/// `docs/contracts/examples/hash-vectors.json` holds the shared vectors.
pub fn canonical_listing(files: &[(String, Vec<u8>)]) -> String {
    let mut sorted: Vec<&(String, Vec<u8>)> = files.iter().collect();
    sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    sorted
        .iter()
        .map(|(path, bytes)| format!("{}  {path}\n", hex(&Sha256::digest(bytes))))
        .collect()
}

/// The artifact hash of in-memory files (section 2).
pub fn hash_files(files: &[(String, Vec<u8>)]) -> String {
    hex(&Sha256::digest(canonical_listing(files).as_bytes()))
}

/// The artifact hash of a directory (section 2). Walks the tree without
/// following links: a symbolic link, a special file, or a path that breaks
/// the path rules is refused (V1).
pub fn canonical_hash(dir: &Path) -> Result<String, ArtifactError> {
    content_hash(dir).map_err(|e| invalid(e.rule, e.reason))
}

/// A validated `manifest.json`.
#[derive(Debug, Clone)]
pub struct Manifest {
    pub inner: renox_runtime::manifest::Manifest,
}

fn schema() -> &'static jsonschema::Validator {
    static V: OnceLock<jsonschema::Validator> = OnceLock::new();
    V.get_or_init(|| {
        let schema: serde_json::Value =
            serde_json::from_str(MANIFEST_SCHEMA).expect("manifest schema is JSON");
        jsonschema::validator_for(&schema).expect("manifest schema compiles")
    })
}

impl Manifest {
    /// Read and validate a manifest file: the JSON Schema (V3, which also
    /// refuses unknown keys, V9) and the route-conflict rule (V8).
    pub fn parse(path: &Path) -> Result<Manifest, ArtifactError> {
        let bytes =
            std::fs::read(path).map_err(|_| invalid("V3", "manifest.json cannot be read"))?;
        Manifest::from_slice(&bytes)
    }

    pub fn from_slice(bytes: &[u8]) -> Result<Manifest, ArtifactError> {
        let value: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|e| invalid("V3", format!("manifest.json is not JSON: {e}")))?;
        let errors: Vec<String> = schema()
            .iter_errors(&value)
            .map(|e| format!("{} at {}", e, e.instance_path()))
            .take(5)
            .collect();
        if !errors.is_empty() {
            return Err(invalid("V3", errors.join("; ")));
        }
        // The schema allows a top-level `$comment`; the runtime's typed
        // manifest does not know it, so it is dropped after validation.
        let mut value = value;
        if let Some(obj) = value.as_object_mut() {
            obj.remove("$comment");
        }
        let inner: renox_runtime::manifest::Manifest = serde_json::from_value(value)
            .map_err(|e| invalid("V3", format!("manifest.json: {e}")))?;
        check_route_conflicts(&inner.routes)?;
        Ok(Manifest { inner })
    }
}

/// The shape of a route pattern for V8: static segments literally,
/// parameter and catch-all names ignored.
fn shape(path: &str) -> Vec<String> {
    path.split('/')
        .skip(1)
        .map(|seg| match seg.as_bytes().first() {
            Some(b':') => ":".to_string(),
            Some(b'*') => "*".to_string(),
            _ => format!("={seg}"),
        })
        .collect()
}

/// V8: two routes with the same method and the same shape conflict.
pub fn check_route_conflicts(routes: &[RouteDef]) -> Result<(), ArtifactError> {
    let mut seen: HashMap<(String, Vec<String>), &str> = HashMap::new();
    for r in routes {
        let names: Vec<&str> = r
            .path
            .split('/')
            .filter_map(|s| s.strip_prefix(':').or_else(|| s.strip_prefix('*')))
            .collect();
        let unique: HashSet<&str> = names.iter().copied().collect();
        if unique.len() != names.len() {
            return Err(invalid(
                "V8",
                format!("route {}: parameter names repeat", r.path),
            ));
        }
        let key = (r.method.as_str().to_string(), shape(&r.path));
        if let Some(other) = seen.insert(key, &r.path) {
            return Err(invalid(
                "V8",
                format!(
                    "routes {} {other} and {} conflict",
                    r.method.as_str(),
                    r.path
                ),
            ));
        }
    }
    Ok(())
}

/// V11: `migrations/` holds `checksums.json` and `<module>/NNN_<name>.sql`
/// files only, numbered without gaps per module, and `checksums.json`
/// lists exactly those files with matching hashes.
pub fn check_migrations(artifact: &Path) -> Result<(), ArtifactError> {
    let dir = artifact.join("migrations");
    if !dir.is_dir() {
        return Ok(());
    }
    let sums: serde_json::Value = std::fs::read(dir.join("checksums.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| invalid("V11", "migrations/checksums.json missing or not JSON"))?;
    let listed: BTreeMap<String, String> = sums
        .get("files")
        .and_then(|f| serde_json::from_value(f.clone()).ok())
        .ok_or_else(|| invalid("V11", "migrations/checksums.json has no files map"))?;
    let mut found: BTreeMap<String, String> = BTreeMap::new();
    let mut numbers: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    let modules =
        std::fs::read_dir(&dir).map_err(|_| invalid("V11", "migrations/ cannot be read"))?;
    for m in modules.flatten() {
        let name = m.file_name().to_string_lossy().into_owned();
        if name == "checksums.json" {
            continue;
        }
        if !m.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            return Err(invalid(
                "V11",
                format!("migrations/{name} is not a module folder"),
            ));
        }
        let files = std::fs::read_dir(m.path())
            .map_err(|_| invalid("V11", format!("migrations/{name} cannot be read")))?;
        for f in files.flatten() {
            let file = f.file_name().to_string_lossy().into_owned();
            let rel = format!("{name}/{file}");
            let n = file
                .strip_suffix(".sql")
                .and_then(|s| s.split_once('_'))
                .filter(|(num, rest)| {
                    num.len() == 3
                        && num.bytes().all(|b| b.is_ascii_digit())
                        && !rest.is_empty()
                        && rest
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                })
                .and_then(|(num, _)| num.parse::<u32>().ok())
                .ok_or_else(|| invalid("V11", format!("migrations/{rel}: bad file name")))?;
            numbers.entry(name.clone()).or_default().push(n);
            let bytes = std::fs::read(f.path())
                .map_err(|_| invalid("V11", format!("migrations/{rel} cannot be read")))?;
            found.insert(rel, hex(&Sha256::digest(&bytes)));
        }
    }
    for (module, mut nums) in numbers {
        nums.sort_unstable();
        if nums.iter().enumerate().any(|(i, n)| *n != i as u32 + 1) {
            return Err(invalid(
                "V11",
                format!("migrations/{module}: numbering has gaps"),
            ));
        }
    }
    if found != listed {
        return Err(invalid(
            "V11",
            "migrations/checksums.json does not match the .sql files",
        ));
    }
    Ok(())
}

/// A verified artifact directory.
#[derive(Debug, Clone)]
pub struct ArtifactDir {
    pub hash: String,
    pub path: PathBuf,
    pub manifest: Arc<Manifest>,
}

/// Where the worker gets artifacts by hash. Blocking: callers on an async
/// runtime use `spawn_blocking`.
pub trait ArtifactStore: Send + Sync + 'static {
    fn get(&self, hash: &str) -> Result<ArtifactDir, ArtifactError>;
}

/// F1 store: `<dir>/<hash>/`. The canonical hash, the manifest, and the
/// migrations are verified the first time a hash is asked for; the
/// successful result is cached (artifacts are never overwritten). A failed
/// verification is not cached, so a repaired copy is picked up.
pub struct LocalArtifactStore {
    dir: PathBuf,
    verified: Mutex<HashMap<String, ArtifactDir>>,
}

impl LocalArtifactStore {
    pub fn new(dir: impl Into<PathBuf>) -> LocalArtifactStore {
        LocalArtifactStore {
            dir: dir.into(),
            verified: Mutex::new(HashMap::new()),
        }
    }

    /// Hashes verified so far.
    pub fn verified_count(&self) -> usize {
        self.verified.lock().expect("store lock").len()
    }

    fn verify(&self, hash: &str) -> Result<ArtifactDir, ArtifactError> {
        let path = self.dir.join(hash);
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|_| ArtifactError::NotFound(hash.to_string()))?;
        if !meta.is_dir() {
            return Err(invalid("V1", "the artifact is not a directory"));
        }
        let actual = canonical_hash(&path)?;
        if actual != hash {
            return Err(ArtifactError::HashMismatch {
                expected: hash.to_string(),
                actual,
            });
        }
        let manifest = Manifest::parse(&path.join("manifest.json"))?;
        for p in manifest.inner.code.entry.values() {
            check_relative_path(p).map_err(|r| invalid("V1", format!("code.entry {p:?}: {r}")))?;
        }
        check_migrations(&path)?;
        Ok(ArtifactDir {
            hash: hash.to_string(),
            path,
            manifest: Arc::new(manifest),
        })
    }
}

impl ArtifactStore for LocalArtifactStore {
    fn get(&self, hash: &str) -> Result<ArtifactDir, ArtifactError> {
        if hash.len() != 64 || !hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(invalid(
                "V2",
                "a deployment hash is 64 lower-case hex characters",
            ));
        }
        if let Some(a) = self.verified.lock().expect("store lock").get(hash) {
            return Ok(a.clone());
        }
        let a = self.verify(hash)?;
        self.verified
            .lock()
            .expect("store lock")
            .insert(hash.to_string(), a.clone());
        Ok(a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_is_sorted_by_bytes() {
        let files = vec![
            ("b".to_string(), b"2".to_vec()),
            ("B".to_string(), b"1".to_vec()),
            ("a/b".to_string(), Vec::new()),
        ];
        let l = canonical_listing(&files);
        let paths: Vec<&str> = l.lines().map(|line| &line[66..]).collect();
        assert_eq!(paths, ["B", "a/b", "b"]);
        assert!(l.starts_with(&format!("{}  B\n", hex(&Sha256::digest(b"1")))));
    }

    #[test]
    fn route_shapes() {
        assert_eq!(shape("/a/:id"), shape("/a/:slug"));
        assert_ne!(shape("/a/new"), shape("/a/:id"));
        assert_ne!(shape("/a/:id"), shape("/a/*rest"));
    }
}
