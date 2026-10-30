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

/// Tracing (the sidecar's own log lines among it) into the captured test
/// output: printed only when a test fails.
fn logs() {
    let _ = tracing_subscriber::fmt()
        .with_test_writer()
        .with_env_filter("renox_cell=info")
        .try_init();
}

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

/// Waits until the file replica of `t_repl` under `root` has files; on a
/// timeout the panic carries the sidecar state, the sidecar count and the
/// replica listing, so a CI failure says where it stopped.
async fn frames_shipped(
    root: &Path,
    repl: &renox_cell::replication::Replication,
    within: Duration,
) {
    let start = Instant::now();
    while !has_files(&root.join("replica/t_repl")) {
        if start.elapsed() >= within {
            let listing: Vec<String> = walk(&root.join("replica"))
                .iter()
                .map(|p| p.display().to_string())
                .collect();
            panic!(
                "timed out waiting for frames shipped: state {:?}, sidecars started {}, replica {:?}, wal {:?}",
                repl.state("t_repl"),
                repl.sidecars_started(),
                listing,
                std::fs::metadata(root.join("data/t_repl/app.db-wal"))
                    .map(|m| m.len())
                    .ok(),
            );
        }
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
    // Since #103 the damaged file is restored in the background: 503
    // `RENOX_DB_UNAVAILABLE` until then (`tests/integrity.rs`).
    let (status, body) = http(
        worker.addr,
        "GET",
        "repl.test",
        "/api/hits?write=0",
        &[],
        "",
    )
    .await;
    assert_eq!(status, 503, "{body}");
    assert!(body.contains("RENOX_DB_UNAVAILABLE"), "{body}");
    eventually("the restore", Duration::from_secs(30), || {
        repl.unavailable("t_repl").is_none()
    })
    .await;
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
    logs();
    if no_litestream() {
        return;
    }
    let root = scratch("listener");
    let worker = Worker::start(worker_config(&root, true)).await.unwrap();
    let repl = worker.replication.clone().unwrap();
    assert_eq!(hits(worker.addr, true).await, 1);
    frames_shipped(&root, &repl, Duration::from_secs(10)).await;
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
        microvm_hook: None,
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
    // FO4: a drop drains the tenant's cells and answers tenant_dropped.
    let (status, answer) = http(
        addr,
        "DELETE",
        "node",
        "/nodes/node-local/tenants/t_repl",
        &[auth],
        "",
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let dropped: serde_json::Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(dropped["type"], "tenant_dropped");
    assert_eq!(dropped["cells_drained"], 1);
    assert!(!worker.manager.db_open("t_repl"));
    // #308 (deploy-api.md 0.4.1): the erasure's drop also purges every
    // generation of the tenant from the replica store, and says when.
    let replica = root.join("replica").join("t_repl");
    assert!(replica.exists(), "the replica of t_repl before the purge");
    std::fs::create_dir_all(root.join("replica/t_other/generations/g")).unwrap();
    let (status, answer) = http(
        addr,
        "DELETE",
        "node",
        "/nodes/node-local/tenants/t_repl?purge_replica=true",
        &[auth],
        "",
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let purged: serde_json::Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(purged["type"], "tenant_dropped");
    assert!(
        purged["replica_generations_deleted"].as_u64().unwrap() >= 1,
        "{purged}"
    );
    assert!(
        purged["replica_purged_at"].as_u64().unwrap() > 0,
        "{purged}"
    );
    assert!(!replica.exists(), "every generation of t_repl is gone");
    assert!(
        root.join("replica/t_other").exists(),
        "another tenant's replica stays"
    );

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

/// The first write after the file opened is noticed, whatever the timing:
/// the sidecar is wanted (`starting`, or `replicating` when `litestream`
/// runs). Needs no `litestream`: without it the state stays `starting`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_write_is_noticed() {
    for round in 0..5 {
        let root = scratch(&format!("first-write-{round}"));
        let worker = Worker::start(worker_config(&root, true)).await.unwrap();
        let repl = worker.replication.clone().unwrap();
        assert_eq!(hits(worker.addr, true).await, 1);
        eventually("the first write noticed", Duration::from_secs(5), || {
            repl.state("t_repl") != State::Off
        })
        .await;
        worker.shutdown().await;
        let _ = std::fs::remove_dir_all(&root);
    }
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

/// #258: a point-in-time restore into a new database holds the rows written
/// before the chosen time and none written after it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn point_in_time_restore_into_a_new_database() {
    logs();
    if no_litestream() {
        return;
    }
    let root = scratch("pitr");
    let worker = Worker::start(worker_config(&root, true)).await.unwrap();
    let repl = worker.replication.clone().unwrap();
    for n in 1..=3 {
        assert_eq!(hits(worker.addr, true).await, n);
    }
    frames_shipped(&root, &repl, Duration::from_secs(10)).await;
    // Past two sync intervals, so the three rows are in the replica before `at`.
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    for n in 4..=5 {
        assert_eq!(hits(worker.addr, true).await, n);
    }
    // The replica must cover `at` before the restore asks for it: the WAL
    // segment of rows 4 and 5 ships within the sync interval, but on a slow
    // runner a fixed sleep was not always enough (`PointUnknown`, CI on #300).
    let config = repl.config_for("t_repl").unwrap();
    let source = repl.file_of("t_repl");
    let start = Instant::now();
    loop {
        let gens = renox_cell::replication::restore::generations(repl.section(), &config, &source)
            .unwrap_or_default();
        if gens.iter().any(|g| g.start_ms <= at && at <= g.end_ms) {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "the replica never covered {at}: {gens:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let r2 = repl.clone();
    let restored = tokio::task::spawn_blocking(move || {
        r2.restore_blocking("t_repl.pitr", Some("t_repl"), Some(at))
    })
    .await
    .unwrap();
    assert!(restored.is_ok(), "{:?}", restored.err());
    let file = repl.file_of("t_repl.pitr");
    let db = renox_data::TenantDb::open(&file, renox_data::DbOptions::default()).unwrap();
    let n = db
        .query_one("select count(*) as n from app__hits", &[])
        .unwrap()
        .unwrap();
    assert_eq!(
        n.get("n"),
        Some(&renox_data::Value::Integer(3)),
        "the rows before `at`, none after"
    );
    let _ = db.close();
    // The source database is untouched.
    assert_eq!(hits(worker.addr, false).await, 5);

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

/// #258: the node listener's snapshot (a consistent copy with its SHA-256)
/// and import (checks before the swap) work without Litestream.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn node_listener_snapshot_and_import() {
    let root = scratch("snapshot");
    let worker = Worker::start(worker_config(&root, false)).await.unwrap();
    assert_eq!(hits(worker.addr, true).await, 1);
    assert_eq!(hits(worker.addr, true).await, 2);
    let token = Arc::new(renox_cell::control::node_listener::CallbackToken::default());
    token.set(Some("renox_cb_abcdefghijklmnopqrstuvwxyz234567".into()));
    let listener = Arc::new(renox_cell::control::node_listener::NodeListener {
        node_id: "node-local".into(),
        token,
        replication: None,
        manager: worker.manager.clone(),
        microvm_hook: None,
    });
    let (addr, _task) = listener
        .serve("127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let auth = "Bearer renox_cb_abcdefghijklmnopqrstuvwxyz234567";

    // Snapshot: raw bytes, so a raw request.
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    s.write_all(format!("POST /nodes/node-local/tenants/t_repl/snapshot HTTP/1.1\r\nHost: node\r\nAuthorization: {auth}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&buf[..split]).to_string();
    let body = &buf[split + 4..];
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    let sha = head
        .lines()
        .find_map(|l| l.strip_prefix("x-renox-sha256: "))
        .unwrap()
        .trim()
        .to_string();
    use sha2::Digest;
    let actual: String = sha2::Sha256::digest(body)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        actual, sha,
        "the x-renox-sha256 header is the SHA-256 of the body"
    );
    let body = body.to_vec();
    let copy = root.join("copy.db");
    std::fs::write(&copy, &body).unwrap();
    let db = renox_data::TenantDb::open(&copy, renox_data::DbOptions::default()).unwrap();
    let n = db
        .query_one("select count(*) as n from app__hits", &[])
        .unwrap()
        .unwrap();
    assert_eq!(n.get("n"), Some(&renox_data::Value::Integer(2)));
    let _ = db.close();

    let put = |path: &'static str, bytes: Vec<u8>| async move {
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        s.write_all(format!("PUT {path} HTTP/1.1\r\nHost: node\r\nAuthorization: {auth}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).as_bytes()).await.unwrap();
        s.write_all(&bytes).await.unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await.unwrap();
        let text = String::from_utf8_lossy(&buf).to_string();
        let status: u16 = text
            .split(' ')
            .nth(1)
            .and_then(|c| c.parse().ok())
            .unwrap_or(0);
        (
            status,
            text.split_once("\r\n\r\n")
                .map(|(_, b)| b.to_string())
                .unwrap_or_default(),
        )
    };
    // Into the tenant's shared file: refused.
    let (status, answer) = put(
        "/nodes/node-local/tenants/t_repl/import?database=t_repl",
        body.clone(),
    )
    .await;
    assert_eq!(status, 422, "{answer}");
    assert!(answer.contains("RENOX_IMPORT_REJECTED"));
    // Into a staging database: swapped in.
    let (status, answer) = put(
        "/nodes/node-local/tenants/t_repl/import?database=t_repl.staging",
        body.clone(),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let r: serde_json::Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(r["type"], "import_result");
    let tables: Vec<&str> = r["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap())
        .collect();
    assert!(tables.contains(&"app__hits"), "{tables:?}");
    assert!(tables.contains(&"renox__migrations"), "{tables:?}");
    // Tables only: no index name.
    assert!(
        tables.iter().all(|t| !t.ends_with("_next_at")),
        "{tables:?}"
    );
    assert!(root.join("data/t_repl.staging/app.db").exists());
    // A table outside the naming rules, and a file that is not SQLite: refused.
    let bad = root.join("bad.db");
    let db = renox_data::TenantDb::open(&bad, renox_data::DbOptions::default()).unwrap();
    db.execute("create table notes (id integer primary key)", &[])
        .unwrap();
    db.checkpoint(renox_data::CheckpointMode::Truncate).unwrap();
    let _ = db.close();
    let (status, answer) = put(
        "/nodes/node-local/tenants/t_repl/import?database=t_repl.staging",
        std::fs::read(&bad).unwrap(),
    )
    .await;
    assert_eq!(status, 422, "{answer}");
    assert!(answer.contains("notes"), "{answer}");
    let (status, _) = put(
        "/nodes/node-local/tenants/t_repl/import?database=t_repl.staging",
        vec![0xAB; 4096],
    )
    .await;
    assert_eq!(status, 422);
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
