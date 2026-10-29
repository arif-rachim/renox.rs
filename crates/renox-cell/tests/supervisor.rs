//! Issue #254: process tiers. A tenant placed in a process of its own is
//! served from a child `renox-worker --child`, restarted after a crash,
//! refuses other tenants, and is drained and reaped when its route goes;
//! a shared tenant stays in the supervisor's process.
//!
//! `docs/24-threat-model.md` "Isolate escape (V8 bug)" (paid tier: one
//! process per tenant) and `docs/23-failure-modes.md` "Worker process
//! crashes".
#![cfg(target_os = "linux")]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use renox_cell::{Worker, WorkerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HELLO_HASH: &str = "802957869194e4c16e462dfcb50bfa6b3e435fca606b96a1223e2b7e21271d7a";

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    // Short: the children's Unix sockets live under it (108-byte limit).
    let dir = PathBuf::from(format!(
        "/tmp/rnx-sv-{}-{name}-{}",
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

fn routes(root: &Path, hosts: &[(&str, &str)]) {
    let entries: Vec<_> = hosts
        .iter()
        .map(|(host, tenant)| serde_json::json!({ "hostname": host, "tenant_id": tenant, "deployment_hash": HELLO_HASH, "status": "active", "updated_at": 1 }))
        .collect();
    std::fs::write(
        root.join("routes.json"),
        serde_json::json!({ "version": 0, "entries": entries }).to_string(),
    )
    .unwrap();
}

fn config(root: &Path) -> WorkerConfig {
    copy_dir(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/contracts/examples/hello-artifact")
            .join(HELLO_HASH),
        &root.join("artifacts").join(HELLO_HASH),
    );
    routes(root, &[("own.test", "t_own"), ("shared.test", "t_shared")]);
    let text = format!(
        r#"
listen = "127.0.0.1:0"
data_dir = "data"
artifacts_dir = "artifacts"
routes_file = "routes.json"
meters_dir = "meters"
logs_dir = "logs"
meter_flush_ms = 50
[process]
enabled = true
own_tenants = ["t_own"]
restart_backoff_ms = 200
child_idle_secs = 600
run_dir = "run"
worker_bin = "{bin}"
"#,
        bin = env!("CARGO_BIN_EXE_renox-worker")
    );
    let path = root.join("worker.toml");
    std::fs::write(&path, text).unwrap();
    WorkerConfig::load(&path).unwrap()
}

/// One HTTP/1.1 request; returns (status, body).
async fn http(addr: SocketAddr, host: &str, path: &str) -> (u16, String) {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).to_string();
    let status = text
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    (status, body)
}

async fn eventually(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(start.elapsed() < within, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn alive(pid: u32) -> bool {
    // A reaped child has no /proc entry; a zombie is not alive either.
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map(|s| !s.split(") ").nth(1).unwrap_or("").starts_with('Z'))
        .unwrap_or(false)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn own_tenant_runs_in_a_child_that_restarts_refuses_others_and_drains() {
    let root = scratch("tiers");
    let worker = Worker::start(config(&root)).await.unwrap();
    let sv = worker.supervisor.clone().expect("[process] enabled");

    // 1. Served from a child: a pid that is not ours, and a socket.
    let (status, body) = http(worker.addr, "own.test", "/api/hello").await;
    assert_eq!((status, body.as_str()), (200, r#"{"ok":true}"#));
    let child = sv.child("t_own").expect("a child for t_own");
    let pid = child.pid.unwrap();
    assert_ne!(pid, std::process::id());
    assert!(child.socket.exists(), "{}", child.socket.display());

    // 2. The shared tenant stays in this process; t_own has no cell here.
    let (status, _) = http(worker.addr, "shared.test", "/api/hello").await;
    assert_eq!(status, 200);
    let tenants: Vec<String> = worker
        .manager
        .cells()
        .into_iter()
        .map(|k| k.tenant_id)
        .collect();
    assert!(tenants.contains(&"t_shared".to_string()), "{tenants:?}");
    assert!(!tenants.contains(&"t_own".to_string()), "{tenants:?}");
    assert!(sv.child("t_shared").is_none());

    // 3. A request for another tenant on t_own's socket is 403.
    let mut req = http::Request::builder()
        .uri("/api/hello")
        .body(axum::body::Body::empty())
        .unwrap();
    let ctx = renox_gateway::RequestCtx {
        tenant_id: "t_shared".into(),
        deployment_hash: HELLO_HASH.into(),
        request_id: "01JBQ3Z7MA0000000000000099".into(),
        deadline: Instant::now() + Duration::from_secs(5),
        client_ip: "127.0.0.1".parse().unwrap(),
        csp_nonce: String::new(),
    };
    renox_cell::supervisor::ipc::encode_ctx(req.headers_mut(), &ctx);
    let resp = renox_cell::supervisor::ipc::send(&child.socket, req)
        .await
        .unwrap();
    assert_eq!(resp.status(), 403);
    let body = axum::body::to_bytes(resp.into_body(), 1 << 16)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("RENOX_TENANT_MISMATCH"));

    // 4. SIGKILL: the next request is served by a new child after the backoff.
    assert!(
        std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .unwrap()
            .success()
    );
    eventually(
        "the supervisor sees the crash",
        Duration::from_secs(5),
        || sv.children().iter().all(|c| c.pid != Some(pid)),
    )
    .await;
    let started = Instant::now();
    let (status, _) = http(worker.addr, "own.test", "/api/hello").await;
    assert_eq!(status, 200);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "restart took {:?}",
        started.elapsed()
    );
    let restarted = sv.child("t_own").expect("restarted child");
    assert_ne!(restarted.pid, Some(pid));
    assert_eq!(restarted.restarts, 1);

    // 5. The route goes: the child drains and is reaped.
    let new_pid = restarted.pid.unwrap();
    routes(&root, &[("shared.test", "t_shared")]);
    worker.reload_routes().unwrap();
    eventually("the child is reaped", Duration::from_secs(15), || {
        sv.child("t_own").is_none() && !alive(new_pid)
    })
    .await;
    assert_eq!(http(worker.addr, "shared.test", "/api/hello").await.0, 200);
    assert_eq!(http(worker.addr, "own.test", "/api/hello").await.0, 404);

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

/// With a writable cgroup v2 tree (CI under sudo; skipped elsewhere): the
/// child's cgroup carries the configured `cpu.max`, `memory.max`,
/// `pids.max`; with `RENOX_TEST_FORK` set, a fork bomb in the child stops
/// at `pids.max` while the shared tenant keeps being served.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn child_cgroup_limits_and_a_fork_bomb() {
    if let Err(why) = renox_cell::supervisor::cgroup::CgroupTree::open(None) {
        eprintln!("skipped: no writable cgroup v2 tree ({why})");
        return;
    }
    let root = scratch("cgroup");
    let mut config = config(&root);
    config.process.child_pids = 64;
    let worker = Worker::start(config).await.unwrap();
    let sv = worker.supervisor.clone().unwrap();
    assert_eq!(http(worker.addr, "own.test", "/api/hello").await.0, 200);
    let child = sv.child("t_own").unwrap();
    let dir = child.cgroup.clone().expect("the child's cgroup");
    use renox_cell::supervisor::cgroup::read;
    assert_eq!(read(&dir, "cpu.max").as_deref(), Some("200000 100000"));
    assert_eq!(read(&dir, "memory.max").as_deref(), Some("1073741824"));
    assert_eq!(read(&dir, "pids.max").as_deref(), Some("64"));
    if std::env::var_os("RENOX_TEST_FORK").is_none() {
        eprintln!("fork bomb not run: set RENOX_TEST_FORK=1");
    } else {
        let (status, body) =
            renox_cell::supervisor::ipc::call(&child.socket, "test-fork", Vec::new())
                .await
                .unwrap();
        assert_eq!(status, 200);
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(v["started"].as_u64().unwrap() < 64, "{v}");
        assert!(v["refused"].is_string(), "{v}");
        let events = read(&dir, "pids.events").unwrap_or_default();
        assert!(!events.contains("max 0"), "{events}");
        assert_eq!(http(worker.addr, "shared.test", "/api/hello").await.0, 200);
    }
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
