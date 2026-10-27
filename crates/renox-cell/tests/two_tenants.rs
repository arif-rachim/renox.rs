//! Issue #29: the worker end to end through the gateway (V8-linked). Two
//! tenants on one node (F1 done criterion), idle eviction (scale to zero),
//! the deployment switch with drain, meters and logs written, and the
//! `renox-worker` binary run from the command line.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use renox_cell::{Worker, WorkerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HELLO_HASH: &str = "802957869194e4c16e462dfcb50bfa6b3e435fca606b96a1223e2b7e21271d7a";

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-test-{}-{name}-{}",
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

/// The `examples/hello` artifact (the worked example of `artifact.md`).
fn hello_artifact() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/contracts/examples/hello-artifact")
        .join(HELLO_HASH)
}

/// Write an artifact under `artifacts` named by its content hash.
fn write_artifact(artifacts: &Path, files: &[(&str, String)]) -> String {
    let tmp = scratch("artifact-src");
    for (rel, content) in files {
        let p = tmp.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }
    let hash = renox_runtime::manifest::content_hash(&tmp).unwrap();
    copy_dir(&tmp, &artifacts.join(&hash));
    hash
}

fn route(host: &str, tenant: &str, hash: &str, status: &str) -> serde_json::Value {
    serde_json::json!({ "hostname": host, "tenant_id": tenant, "deployment_hash": hash, "status": status, "updated_at": 1 })
}

fn write_routes(path: &Path, entries: Vec<serde_json::Value>) {
    let v = serde_json::json!({ "version": 0, "entries": entries });
    std::fs::write(path, serde_json::to_vec_pretty(&v).unwrap()).unwrap();
}

struct Env {
    root: PathBuf,
    config: WorkerConfig,
}

fn env(idle_secs: f64) -> Env {
    let root = scratch("worker");
    std::fs::create_dir_all(root.join("artifacts")).unwrap();
    let text = format!(
        r#"
listen = "127.0.0.1:0"
data_dir = "data"
artifacts_dir = "artifacts"
routes_file = "routes.json"
meters_dir = "meters"
logs_dir = "logs"
idle_timeout_secs = {idle_secs}
meter_flush_ms = 50
"#
    );
    std::fs::write(root.join("worker.toml"), &text).unwrap();
    let config = WorkerConfig::parse(&text, &root).unwrap();
    Env { root, config }
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

async fn wait_until(what: &str, timeout: Duration, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(start.elapsed() < timeout, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn read_all(dir: &Path) -> String {
    let mut out = String::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                out.push_str(&std::fs::read_to_string(e.path()).unwrap_or_default());
            }
        }
    }
    out
}

fn wal_size(db: &Path) -> u64 {
    let wal = PathBuf::from(format!("{}-wal", db.display()));
    std::fs::metadata(wal).map(|m| m.len()).unwrap_or(0)
}

/// F1 done criterion: two tenants (`a.test`, `b.test`) on one node, both on
/// the `examples/hello` artifact. Each answers 200, the meter file has a
/// record per tenant, and after `idle_timeout` every isolate is gone and
/// each tenant's WAL is truncated.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_tenants_serve_meter_and_scale_to_zero() {
    let e = env(1.0);
    copy_dir(&hello_artifact(), &e.config.artifacts_dir.join(HELLO_HASH));
    write_routes(
        &e.config.routes_file,
        vec![
            route("a.test", "t_a", HELLO_HASH, "active"),
            route("b.test", "t_b", HELLO_HASH, "active"),
        ],
    );
    let worker = Worker::start(e.config.clone()).await.unwrap();
    for host in ["a.test", "b.test"] {
        let (status, body) = http(worker.addr, host, "/api/hello").await;
        assert_eq!(status, 200, "{host}: {body}");
        assert_eq!(body, r#"{"ok":true}"#);
    }
    let (status, _) = http(worker.addr, "unknown.test", "/api/hello").await;
    assert_eq!(status, 404);
    assert_eq!(worker.manager.cell_count(), 2);
    assert_eq!(worker.manager.open_databases(), 2);

    let meters = e.config.meters_dir.clone();
    wait_until("meter records", Duration::from_secs(5), || {
        let m = read_all(&meters);
        m.contains(r#""tenant_id":"t_a""#) && m.contains(r#""tenant_id":"t_b""#)
    })
    .await;
    let m = read_all(&meters);
    let batch: serde_json::Value = serde_json::from_str(m.lines().next().unwrap()).unwrap();
    let rec = &batch["records"][0];
    assert_eq!(rec["route"], "GET /api/hello");
    assert_eq!(rec["http_status"], 200);
    assert_eq!(rec["status"], "ok");
    assert_eq!(rec["deployment_hash"], HELLO_HASH);
    assert!(rec["egress_bytes"].as_u64().unwrap() > 0);

    // Scale to zero: isolates released, files closed with the WAL truncated.
    let manager = worker.manager.clone();
    wait_until("idle eviction", Duration::from_secs(5), || {
        manager.cell_count() == 0 && manager.open_databases() == 0
    })
    .await;
    assert_eq!(manager.cells_evicted(), 2);
    for t in ["t_a", "t_b"] {
        let db = e.config.data_dir.join(t).join("app.db");
        assert!(db.exists());
        assert_eq!(wal_size(&db), 0, "{t}: WAL not truncated");
    }
    // A request after eviction gets a fresh cell.
    let (status, _) = http(worker.addr, "a.test", "/api/hello").await;
    assert_eq!(status, 200);
    assert_eq!(worker.manager.cell_count(), 1);
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&e.root);
}

fn versioned_artifact(artifacts: &Path, version: u32) -> String {
    let migration = "create table app__hits (id integer primary key, v integer not null);\n";
    let sums = serde_json::json!({ "version": 0, "files": { "app/001_hits.sql": renox_data::checksum(migration) } });
    let manifest = serde_json::json!({
        "artifact": { "version": 0 },
        "app": { "name": "switch", "timezone": "UTC" },
        "code": { "format": "esm-dir", "entry": { "functions/api/v": "functions/api/v.js" } },
        "routes": [{ "kind": "function", "method": "GET", "path": "/api/v", "module": "functions/api/v", "export": "GET" }],
        "permissions": { "network": [], "secrets": ["GREETING"] }
    });
    let code = format!(
        r#"
        export async function GET({{ url, db, secrets, log }}) {{
            const slow = Number(url.searchParams.get("slow") ?? 0);
            if (slow) await new Promise((r) => setTimeout(r, slow));
            await db.execute("insert into app__hits (v) values (?)", [{version}]);
            const n = (await db.queryOne("select count(*) as n from app__hits")).n;
            log.info("hit", {{ v: {version} }});
            return Response.json({{ v: {version}, n, greeting: secrets.GREETING ?? null }});
        }}
        "#
    );
    write_artifact(
        artifacts,
        &[
            ("manifest.json", manifest.to_string()),
            ("code/functions/api/v.js", code),
            ("migrations/app/001_hits.sql", migration.to_string()),
            ("migrations/checksums.json", sums.to_string()),
        ],
    )
}

/// `docs/05-tenant-lifecycle.md`, "Deployment switch": a route hash change
/// sends new requests to a new cell for the new hash; the old cell finishes
/// its in-flight request and is then evicted, long before its idle timeout.
/// Also: migrations from the artifact run, the tenant's database is shared
/// by both deployments, and secrets come from `secrets.json` (0600).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deployment_switch_drains_the_old_cell() {
    let e = env(60.0);
    let v1 = versioned_artifact(&e.config.artifacts_dir, 1);
    let v2 = versioned_artifact(&e.config.artifacts_dir, 2);
    let tenant_dir = e.config.data_dir.join("t_c");
    std::fs::create_dir_all(&tenant_dir).unwrap();
    let secrets = tenant_dir.join("secrets.json");
    std::fs::write(&secrets, r#"{"GREETING":"salaam-alaikum"}"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&secrets, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    write_routes(
        &e.config.routes_file,
        vec![route("c.test", "t_c", &v1, "active")],
    );
    let worker = Worker::start(e.config.clone()).await.unwrap();
    let (status, body) = http(worker.addr, "c.test", "/api/v").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({ "v": 1, "n": 1, "greeting": "salaam-alaikum" })
    );

    // A slow request is in flight on v1 when the route switches to v2.
    let addr = worker.addr;
    let slow = tokio::spawn(async move { http(addr, "c.test", "/api/v?slow=800").await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    write_routes(
        &e.config.routes_file,
        vec![
            route("c.test", "t_c", &v2, "active"),
            route("c.test", "t_c", &v1, "draining"),
        ],
    );
    worker.reload_routes().unwrap();
    let (status, body) = http(worker.addr, "c.test", "/api/v").await;
    assert_eq!(status, 200, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["v"], 2);
    assert_eq!(worker.manager.cell_count(), 2, "old cell still draining");

    let (status, body) = slow.await.unwrap();
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["v"],
        1
    );
    let manager = worker.manager.clone();
    let v2c = v2.clone();
    wait_until(
        "old cell evicted after drain",
        Duration::from_secs(3),
        || {
            let cells = manager.cells();
            cells.len() == 1 && cells[0].deployment_hash == v2c
        },
    )
    .await;
    // Both deployments wrote to the one tenant file.
    let (_, body) = http(worker.addr, "c.test", "/api/v").await;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["n"],
        4
    );

    // Tenant logs went to the log file, attributed and without secrets.
    let logs = std::fs::read_to_string(e.config.logs_dir.join("tenant.ndjson")).unwrap();
    let line: serde_json::Value = serde_json::from_str(
        logs.lines()
            .find(|l| l.contains(r#""message":"hit""#))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(line["tenant_id"], "t_c");
    assert!(line["request_id"].as_str().is_some());
    assert!(!logs.contains("salaam-alaikum"));
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&e.root);
}

/// A `secrets.json` readable by others is refused: the cell is not created
/// and the request gets 500 `RENOX_INTERNAL`.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn world_readable_secrets_are_refused() {
    use std::os::unix::fs::PermissionsExt;
    let e = env(60.0);
    let v1 = versioned_artifact(&e.config.artifacts_dir, 1);
    let tenant_dir = e.config.data_dir.join("t_d");
    std::fs::create_dir_all(&tenant_dir).unwrap();
    let secrets = tenant_dir.join("secrets.json");
    std::fs::write(&secrets, r#"{"GREETING":"salaam-alaikum"}"#).unwrap();
    std::fs::set_permissions(&secrets, std::fs::Permissions::from_mode(0o644)).unwrap();
    write_routes(
        &e.config.routes_file,
        vec![route("d.test", "t_d", &v1, "active")],
    );
    let worker = Worker::start(e.config.clone()).await.unwrap();
    let (status, body) = http(worker.addr, "d.test", "/api/v").await;
    assert_eq!(status, 500, "{body}");
    assert!(body.contains("RENOX_INTERNAL"));
    assert!(!body.contains("salaam"));
    assert_eq!(worker.manager.cell_count(), 0);
    assert_eq!(worker.manager.open_databases(), 0);
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&e.root);
}

/// `renox-worker --config worker.toml` from the command line against
/// `examples/hello`, including a SIGHUP route reload.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renox_worker_binary_serves_hello() {
    let e = env(60.0);
    copy_dir(&hello_artifact(), &e.config.artifacts_dir.join(HELLO_HASH));
    write_routes(
        &e.config.routes_file,
        vec![route("hello.test", "t_hello", HELLO_HASH, "active")],
    );
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let config = std::fs::read_to_string(e.root.join("worker.toml"))
        .unwrap()
        .replace("127.0.0.1:0", &format!("127.0.0.1:{port}"));
    std::fs::write(e.root.join("worker.toml"), config).unwrap();
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_renox-worker"))
        .arg("--config")
        .arg(e.root.join("worker.toml"))
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let start = Instant::now();
    while tokio::net::TcpStream::connect(addr).await.is_err() {
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "worker did not start"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (status, body) = http(addr, "hello.test", "/api/hello").await;
    assert_eq!((status, body.as_str()), (200, r#"{"ok":true}"#));
    // A second hostname appears after SIGHUP.
    write_routes(
        &e.config.routes_file,
        vec![
            route("hello.test", "t_hello", HELLO_HASH, "active"),
            route("hello2.test", "t_hello", HELLO_HASH, "active"),
        ],
    );
    assert_eq!(http(addr, "hello2.test", "/api/hello").await.0, 404);
    let pid = child.id().to_string();
    assert!(
        std::process::Command::new("kill")
            .args(["-HUP", &pid])
            .status()
            .unwrap()
            .success()
    );
    let start = Instant::now();
    loop {
        if http(addr, "hello2.test", "/api/hello").await.0 == 200 {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "SIGHUP reload not applied"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let _ = child.kill();
    let _ = child.wait();
    assert!(e.config.logs_dir.join("tenant.ndjson").exists());
    let _ = std::fs::remove_dir_all(&e.root);
}
