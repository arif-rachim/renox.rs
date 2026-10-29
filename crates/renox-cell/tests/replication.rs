//! Issue #255: Litestream per tenant file, with a `file` replica.
//!
//! `docs/23-failure-modes.md` rows "SQLite file corrupted, WAL unreadable"
//! (a corrupt local file is quarantined and restored) and "Replica lagging
//! / Litestream behind" (the status reports the last sync and the lag).
//!
//! Skipped, with the reason, when `litestream` is not on `PATH` (CI's rust
//! job installs the pinned release, `ops/scripts/fetch-litestream.sh`).
#![cfg(target_os = "linux")]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use renox_cell::replication::State;
use renox_cell::{Worker, WorkerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(format!(
        "/tmp/rnx-repl-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn no_litestream() -> bool {
    let ok = std::process::Command::new("litestream")
        .arg("version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !ok {
        eprintln!(
            "skipped: litestream is not on PATH (ops/scripts/fetch-litestream.sh installs the pinned release)"
        );
    }
    !ok
}

/// An artifact whose function writes a row and answers the row count.
fn db_artifact(artifacts: &Path) -> String {
    let src = scratch("artifact");
    let migration = "create table app__hits (id integer primary key, at integer not null);\n";
    let sums = serde_json::json!({ "version": 0, "files": { "app/001_hits.sql": renox_data::checksum(migration) } });
    let manifest = serde_json::json!({
        "artifact": { "version": 0 },
        "app": { "name": "replicated", "timezone": "UTC" },
        "code": { "format": "esm-dir", "entry": { "functions/api/hits": "functions/api/hits.js" } },
        "routes": [{ "kind": "function", "method": "GET", "path": "/api/hits", "module": "functions/api/hits", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] }
    });
    let code = r#"
        export async function GET({ url, db }) {
            if (url.searchParams.get("write") !== "0") {
                await db.execute("insert into app__hits (at) values (?)", [Date.now()]);
            }
            const n = (await db.queryOne("select count(*) as n from app__hits")).n;
            return Response.json({ n });
        }
    "#;
    let files = [
        ("manifest.json", manifest.to_string()),
        ("code/functions/api/hits.js", code.to_string()),
        ("migrations/app/001_hits.sql", migration.to_string()),
        ("migrations/checksums.json", sums.to_string()),
    ];
    for (rel, content) in &files {
        let p = src.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }
    let hash = renox_runtime::manifest::content_hash(&src).unwrap();
    for (rel, _) in &files {
        let to = artifacts.join(&hash).join(rel);
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::copy(src.join(rel), to).unwrap();
    }
    hash
}

fn worker_config(root: &Path, replication: bool) -> WorkerConfig {
    std::fs::create_dir_all(root.join("artifacts")).unwrap();
    let hash = db_artifact(&root.join("artifacts"));
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "repl.test", "tenant_id": "t_repl", "deployment_hash": hash, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(root.join("routes.json"), routes.to_string()).unwrap();
    let section = if replication {
        "[replication]\nenabled = true\nreplica = \"file\"\npath = \"replica\"\nsync_interval_ms = 200\nstop_grace_ms = 1500\nsnapshot_interval_secs = 3600\n"
    } else {
        ""
    };
    let text = format!(
        "listen = \"127.0.0.1:0\"\ndata_dir = \"data\"\nartifacts_dir = \"artifacts\"\nroutes_file = \"routes.json\"\nmeters_dir = \"meters\"\nlogs_dir = \"logs\"\nmeter_flush_ms = 50\n[process]\nrun_dir = \"run\"\n{section}"
    );
    let path = root.join("worker.toml");
    std::fs::write(&path, text).unwrap();
    WorkerConfig::load(&path).unwrap()
}

async fn http(
    addr: SocketAddr,
    method: &str,
    host: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, String) {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
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

async fn hits(addr: SocketAddr, write: bool) -> u64 {
    let path = if write {
        "/api/hits"
    } else {
        "/api/hits?write=0"
    };
    let (status, body) = http(addr, "GET", "repl.test", path, &[], "").await;
    assert_eq!(status, 200, "{body}");
    serde_json::from_str::<serde_json::Value>(&body).unwrap()["n"]
        .as_u64()
        .unwrap()
}

async fn eventually(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(start.elapsed() < within, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn has_files(dir: &Path) -> bool {
    walk(dir).iter().any(|p| p.is_file())
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            }
            out.push(p);
        }
    }
    out
}

async fn evict(worker: &Worker) {
    worker
        .manager
        .set_idle_timeout_for_tests(Some(Duration::ZERO));
    eventually("eviction", Duration::from_secs(10), || {
        worker.manager.cell_count() == 0 && !worker.manager.db_open("t_repl")
    })
    .await;
    worker.manager.set_idle_timeout_for_tests(None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writes_replicate_and_a_missing_or_corrupt_file_is_restored() {
    if no_litestream() {
        return;
    }
    let root = scratch("main");
    let worker = Worker::start(worker_config(&root, true)).await.unwrap();
    let repl = worker.replication.clone().expect("[replication] enabled");
    let replica = root.join("replica").join("t_repl");

    // A write starts the sidecar; after the sync interval the replica has frames.
    assert_eq!(hits(worker.addr, true).await, 1);
    eventually("the sidecar replicates", Duration::from_secs(10), || {
        repl.state("t_repl") == State::Replicating
    })
    .await;
    assert_eq!(repl.sidecars_started(), 1);
    eventually(
        "frames in the file replica",
        Duration::from_secs(10),
        || has_files(&replica),
    )
    .await;

    // Status: one generation, a last sync, a lag.
    let status = repl.status("t_repl", "t_repl");
    assert_eq!(status["replication"], "litestream");
    assert_eq!(status["replica"]["kind"], "file");
    assert!(
        !status["generations"].as_array().unwrap().is_empty(),
        "{status}"
    );
    assert!(status["last_sync_at"].is_u64(), "{status}");
    assert!(status["db"]["size_bytes"].as_u64().unwrap() > 0, "{status}");

    // Eviction stops the sidecar after the grace period.
    evict(&worker).await;
    eventually(
        "the sidecar stops after the grace",
        Duration::from_secs(10),
        || repl.state("t_repl") == State::Stopped,
    )
    .await;

    // The local file is deleted: the next request restores it first.
    let file = root.join("data/t_repl/app.db");
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", file.display()));
    }
    assert_eq!(
        hits(worker.addr, false).await,
        1,
        "the row written before is read back"
    );
    assert_eq!(hits(worker.addr, true).await, 2);

    // A corrupt file is quarantined and restored.
    eventually("replicating again", Duration::from_secs(10), || {
        repl.state("t_repl") == State::Replicating
    })
    .await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    evict(&worker).await;
    eventually("stopped again", Duration::from_secs(10), || {
        repl.state("t_repl") == State::Stopped
    })
    .await;
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", file.display()));
    }
    std::fs::write(&file, vec![0xAB; 8192]).unwrap();
    assert_eq!(hits(worker.addr, false).await, 2);
    let quarantined = std::fs::read_dir(root.join("data/t_repl"))
        .unwrap()
        .flatten()
        .any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("app.db.corrupt-")
        });
    assert!(quarantined, "the corrupt file is kept aside");

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

/// The node listener's restore and replication endpoints
/// (`schemas/node-listener.yaml`), with the callback token.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn node_listener_restores_before_serving() {
    if no_litestream() {
        return;
    }
    let root = scratch("listener");
    let worker = Worker::start(worker_config(&root, true)).await.unwrap();
    let repl = worker.replication.clone().unwrap();
    assert_eq!(hits(worker.addr, true).await, 1);
    eventually("frames shipped", Duration::from_secs(10), || {
        has_files(&root.join("replica/t_repl"))
    })
    .await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    evict(&worker).await;
    eventually("stopped", Duration::from_secs(10), || {
        repl.state("t_repl") == State::Stopped
    })
    .await;
    let file = root.join("data/t_repl/app.db");
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", file.display()));
    }

    let token = Arc::new(renox_cell::control::node_listener::CallbackToken::default());
    token.set(Some("renox_cb_abcdefghijklmnopqrstuvwxyz234567".into()));
    let listener = Arc::new(renox_cell::control::node_listener::NodeListener {
        node_id: "node-local".into(),
        token,
        replication: Some(repl.clone()),
        manager: worker.manager.clone(),
    });
    let (addr, _task) = listener
        .serve("127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let auth = (
        "authorization",
        "Bearer renox_cb_abcdefghijklmnopqrstuvwxyz234567",
    );
    let body = serde_json::json!({ "type": "restore_request", "schema_version": 0, "tenant_id": "t_repl", "database": "t_repl", "timestamp": null, "reason": "failover", "deadline_ms": 20000 }).to_string();

    let (status, _) = http(
        addr,
        "POST",
        "node",
        "/nodes/node-local/tenants/t_repl/restore",
        &[],
        &body,
    )
    .await;
    assert_eq!(status, 401, "no callback token");
    let (status, answer) = http(
        addr,
        "POST",
        "node",
        "/nodes/node-local/tenants/t_repl/restore",
        &[auth, ("content-type", "application/json")],
        &body,
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let r: serde_json::Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(r["type"], "restore_result");
    assert_eq!(r["source"], "replica");
    assert!(file.exists());
    // Idempotent: a second call keeps the file.
    let (status, answer) = http(
        addr,
        "POST",
        "node",
        "/nodes/node-local/tenants/t_repl/restore",
        &[auth],
        &body,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&answer).unwrap()["source"],
        "local"
    );
    let (status, answer) = http(
        addr,
        "GET",
        "node",
        "/nodes/node-local/tenants/t_repl/replication",
        &[auth],
        "",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&answer).unwrap()["type"],
        "replication_status"
    );
    assert_eq!(
        http(
            addr,
            "GET",
            "node",
            "/nodes/other-node/tenants/t_repl/replication",
            &[auth],
            ""
        )
        .await
        .0,
        404
    );
    assert_eq!(
        hits(worker.addr, false).await,
        1,
        "served from the restored file"
    );

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

/// A tenant with replication off never starts `litestream`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replication_off_never_spawns_litestream() {
    let root = scratch("off");
    let worker = Worker::start(worker_config(&root, false)).await.unwrap();
    assert_eq!(hits(worker.addr, true).await, 1);
    assert_eq!(hits(worker.addr, true).await, 2);
    assert!(worker.replication.is_none());
    assert!(
        !root.join("run/litestream").exists(),
        "no sidecar config was written"
    );
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
