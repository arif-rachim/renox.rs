//! Artifact 1.6, "An app with no code" (#499): a deployment with an empty
//! `code.entry` is served by the worker without any V8 thread. Its `.html`
//! pages render through the full path, the meter shows no tenant CPU, and
//! the runtime has created no isolate.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use renox_cell::{Worker, WorkerConfig};
use renox_template::{Compiler, TemplateProject};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-nocode-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let target = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &target);
        } else {
            std::fs::copy(e.path(), target).unwrap();
        }
    }
}

/// A code-less version 1 artifact: two `.html` pages in a layout.
fn write_artifact(artifacts: &Path) -> String {
    let mut project = TemplateProject::new();
    project.insert(
        "pages/_layouts/main.html",
        "<!DOCTYPE html><html><body><main><slot /></main></body></html>",
    );
    project.insert(
        "pages/index.html",
        "<r-layout use=\"main\"><h1>Welcome home</h1></r-layout>",
    );
    project.insert(
        "pages/about.html",
        "<r-layout use=\"main\"><p>About us</p></r-layout>",
    );
    let compiled = Compiler::default()
        .compile(&project)
        .unwrap_or_else(|d| panic!("{d:?}"));

    let tmp = scratch("artifact-src");
    for (rel, src) in compiled.files() {
        let p = tmp.join("templates").join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "static", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": {} },
        "routes": [
            { "kind": "page", "path": "/", "template": "pages/index" },
            { "kind": "page", "path": "/about", "template": "pages/about" }
        ],
        "templates": compiled.manifest_entries(),
        "permissions": { "network": [], "secrets": [] }
    });
    std::fs::write(
        tmp.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    renox_cell::Manifest::parse(&tmp.join("manifest.json")).unwrap();
    let hash = renox_runtime::manifest::content_hash(&tmp).unwrap();
    copy_dir(&tmp, &artifacts.join(&hash));
    hash
}

struct Env {
    root: PathBuf,
    config: WorkerConfig,
}

fn env() -> Env {
    let root = scratch("worker");
    std::fs::create_dir_all(root.join("artifacts")).unwrap();
    let text = r#"
listen = "127.0.0.1:0"
data_dir = "data"
artifacts_dir = "artifacts"
routes_file = "routes.json"
meters_dir = "meters"
logs_dir = "logs"
idle_timeout_secs = 60
meter_flush_ms = 50
"#;
    std::fs::write(root.join("worker.toml"), text).unwrap();
    let config = WorkerConfig::parse(text, &root).unwrap();
    Env { root, config }
}

struct Reply {
    status: u16,
    body: String,
}

async fn http(addr: SocketAddr, method: &str, path: &str) -> Reply {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!("{method} {path} HTTP/1.1\r\nHost: static.test\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    Reply {
        status,
        body: body.to_string(),
    }
}

fn records(meters: &Path) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(meters) {
        for e in entries.flatten() {
            let text = std::fs::read_to_string(e.path()).unwrap_or_default();
            for line in text.lines() {
                if let Ok(batch) = serde_json::from_str::<serde_json::Value>(line) {
                    out.extend(batch["records"].as_array().cloned().unwrap_or_default());
                }
            }
        }
    }
    out
}

async fn record_for(meters: &Path, route: &str, n: usize) -> Vec<serde_json::Value> {
    let start = Instant::now();
    loop {
        let found: Vec<serde_json::Value> = records(meters)
            .into_iter()
            .filter(|r| r["route"] == route)
            .collect();
        if found.len() >= n {
            return found;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "{} of {n} meter records for {route}; all: {:?}",
            found.len(),
            records(meters)
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_code_less_app_serves_its_pages_without_an_isolate() {
    let e = env();
    let hash = write_artifact(&e.config.artifacts_dir);
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "static.test", "tenant_id": "t_static", "deployment_hash": hash, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(&e.config.routes_file, routes.to_string()).unwrap();
    let worker = Worker::start(e.config.clone()).await.unwrap();
    let addr = worker.addr;

    let home = http(addr, "GET", "/").await;
    assert_eq!(home.status, 200, "{}", home.body);
    assert!(home.body.contains("Welcome home"), "{}", home.body);
    let about = http(addr, "GET", "/about").await;
    assert_eq!(about.status, 200, "{}", about.body);
    assert!(about.body.contains("About us"), "{}", about.body);
    let api = http(addr, "GET", "/api/x").await;
    assert_eq!(api.status, 404, "{}", api.body);

    let rec = &record_for(&e.config.meters_dir, "GET /", 1).await[0];
    assert_eq!(rec["cpu_ms"], serde_json::json!(0.0), "{rec}");
    assert!(rec["render_fuel"].as_u64().unwrap() > 0, "{rec}");

    assert_eq!(
        worker
            .manager
            .runtime()
            .metrics()
            .isolates_created
            .load(Ordering::Relaxed),
        0,
        "no isolate was created"
    );

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&e.root);
}
