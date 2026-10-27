//! Test helpers: build artifact directories named by their content hash.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use renox_runtime::limits::Limits;
use renox_runtime::manifest::content_hash;
use renox_runtime::{IsolateSpec, RequestCtx};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh scratch directory under the system temp dir.
pub fn scratch(name: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "renox-rt-test-{}-{}-{}",
        std::process::id(),
        name,
        n
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Write `files` (artifact-relative path -> content) into a new artifact
/// directory and rename it to its content hash. Returns (dir, hash).
pub fn write_artifact(files: &[(&str, &[u8])]) -> (PathBuf, String) {
    let base = scratch("artifact");
    let tmp = base.join("tmp");
    for (rel, content) in files {
        let p = tmp.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }
    let hash = content_hash(&tmp).unwrap();
    let dir = base.join(&hash);
    std::fs::rename(&tmp, &dir).unwrap();
    (dir, hash)
}

/// An esm-dir artifact with one module `functions/f.js` serving `routes`
/// (method, path) with the given source.
pub fn function_artifact(
    source: &str,
    routes: &[(&str, &str)],
    network: &[&str],
) -> (PathBuf, String) {
    let routes_json: Vec<serde_json::Value> = routes
        .iter()
        .map(|(m, p)| serde_json::json!({ "kind": "function", "method": m, "path": p, "module": "functions/f", "export": m }))
        .collect();
    let manifest = serde_json::json!({
        "artifact": { "version": 0 },
        "app": { "name": "test", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": { "functions/f": "functions/f.js" } },
        "routes": routes_json,
        "permissions": { "network": network, "secrets": [] }
    });
    let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
    write_artifact(&[
        ("manifest.json", &manifest),
        ("code/functions/f.js", source.as_bytes()),
    ])
}

pub fn spec(dir: &Path, hash: &str, limits: Limits) -> IsolateSpec {
    IsolateSpec {
        tenant_id: "t_test".into(),
        deployment_hash: hash.into(),
        artifact_dir: dir.to_path_buf(),
        limits,
        secrets: Default::default(),
    }
}

pub fn ctx(id: &str) -> RequestCtx {
    RequestCtx {
        request_id: id.into(),
        deadline: Instant::now() + Duration::from_secs(30),
    }
}

pub fn get(path: &str) -> http::Request<Bytes> {
    http::Request::builder()
        .method("GET")
        .uri(format!("https://test.renox.app{path}"))
        .body(Bytes::new())
        .unwrap()
}

pub fn body_json(r: &http::Response<Bytes>) -> serde_json::Value {
    serde_json::from_slice(r.body())
        .unwrap_or_else(|_| panic!("not JSON: {:?}", String::from_utf8_lossy(r.body())))
}

/// Resident set size of this process in bytes (Linux).
pub fn rss_bytes() -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    let line = status.lines().find(|l| l.starts_with("VmRSS:")).unwrap();
    line.split_whitespace()
        .nth(1)
        .unwrap()
        .parse::<u64>()
        .unwrap()
        * 1024
}

pub fn percentile(sorted: &[Duration], p: f64) -> Duration {
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx]
}
