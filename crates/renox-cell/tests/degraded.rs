//! Issue #98: degraded mode of a controlled worker (`docs/23-failure-modes.md`
//! section 3, "Control plane unreachable from the worker" and "Object
//! storage unreachable"), against the real control API
//! (`support/control_stack.rs`; skipped without `RENOX_TEST_PG`).
//!
//! `RENOX_TEST_DEGRADED_SECS` shortens the 5-minute outage of the first
//! test for local runs; the acceptance criterion is 300 s.

#[path = "support/control_stack.rs"]
mod stack;

use std::net::SocketAddr;
use std::path::Path;
use std::time::{Duration, Instant};

use renox_cell::spool::Queue;
use renox_cell::{Worker, WorkerConfig};
use stack::{Stack, TcpProxy, eventually, hello_dir, http};

async fn get(worker: &Worker, host: &str) -> stack::Reply {
    http(worker.addr, "GET", "/api/hello", host, &[], b"")
        .await
        .unwrap()
}

async fn health(worker: &Worker) -> serde_json::Value {
    http(
        worker.health_addr.unwrap(),
        "GET",
        "/healthz",
        "localhost",
        &[],
        b"",
    )
    .await
    .unwrap()
    .json()
}

async fn start_worker(stack: &Stack, dir: &Path, node: &str, token: &Path) -> Worker {
    start_worker_idle(stack, dir, node, token, 600).await
}

/// With `idle_timeout_secs` set, so a cell can go cold within a test.
async fn start_worker_idle(
    stack: &Stack,
    dir: &Path,
    node: &str,
    token: &Path,
    idle_secs: u64,
) -> Worker {
    let toml = stack.worker_toml(dir, node, token).replace(
        "meter_flush_ms = 200",
        &format!("meter_flush_ms = 200\nidle_timeout_secs = {idle_secs}"),
    );
    Worker::start(WorkerConfig::parse(&toml, dir).unwrap())
        .await
        .unwrap()
}

async fn registered(worker: &Worker) {
    let c = worker.controller.clone().unwrap();
    assert!(
        eventually(Duration::from_secs(15), || async {
            c.is_registered().then_some(())
        })
        .await
        .is_some(),
        "the worker did not register"
    );
}

/// A copy of the hello artifact for another app (different `app.name`, so a
/// different hash).
fn hello_for(root: &Path, app: &str) -> std::path::PathBuf {
    let src = root.join(format!("{app}-src"));
    let _ = std::fs::remove_dir_all(&src);
    std::fs::create_dir_all(src.join("code/functions/api")).unwrap();
    let manifest = std::fs::read_to_string(hello_dir().join("manifest.json")).unwrap();
    std::fs::write(
        src.join("manifest.json"),
        manifest.replace("\"name\": \"hello\"", &format!("\"name\": \"{app}\"")),
    )
    .unwrap();
    std::fs::copy(
        hello_dir().join("code/functions/api/hello.js"),
        src.join("code/functions/api/hello.js"),
    )
    .unwrap();
    let hash = renox_runtime::manifest::content_hash(&src).unwrap();
    let dir = root.join(&hash);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&src, &dir).unwrap();
    dir
}

/// `docs/23-failure-modes.md` section 3, "Control plane unreachable from the
/// worker": cached tenants keep serving, meters are spooled, and the spool
/// drains without duplicates once the API is back. Then a worker restarted
/// while the API is down serves from the route snapshot file.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn control_plane_down_keeps_serving_and_spools_meters() {
    let Some(mut stack) = Stack::start("degraded-cp").await else {
        return;
    };
    let token = stack.tenant_with_app("t_hello", "hello", "free").await;
    let hash = stack.upload(&token, "hello", &hello_dir()).await;
    let token_file = stack.node_token_file("node-dg-1").await;
    let dir = stack.root.join("worker");
    let worker = start_worker(&stack, &dir, "node-dg-1", &token_file).await;
    registered(&worker).await;
    assert_eq!(stack.activate(&token, "hello", &hash).await.status, 200);
    eventually(Duration::from_secs(5), || async {
        worker.routes.lookup("hello.renox.test")
    })
    .await
    .unwrap();
    let mut served = 0u64;
    assert_eq!(get(&worker, "hello.renox.test").await.status, 200);
    served += 1;

    // Outage.
    stack.stop_api().await;
    let outage = Duration::from_secs(
        std::env::var("RENOX_TEST_DEGRADED_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(300),
    );
    let started = Instant::now();
    while started.elapsed() < outage {
        let r = get(&worker, "hello.renox.test").await;
        assert_eq!(
            r.status,
            200,
            "at {:?} into the outage: {}",
            started.elapsed(),
            r.text()
        );
        served += 1;
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    eprintln!(
        "{served} requests served, {} s of them without the control plane",
        outage.as_secs()
    );
    let h = health(&worker).await;
    assert_eq!(h["status"], "degraded", "{h}");
    assert!(h["reasons"].to_string().contains("control_plane"), "{h}");
    // The meters went to the spool (meter retries take about 3 s).
    let meters = Queue::meters(&dir.join("data"));
    assert!(
        eventually(Duration::from_secs(15), || async {
            (meters.pending_lines() > 0).then_some(())
        })
        .await
        .is_some(),
        "no meter batch in the spool"
    );

    // Recovery: the spool drains and every record is counted once.
    stack.start_api().await;
    registered(&worker).await;
    assert!(
        eventually(Duration::from_secs(120), || async {
            (meters.pending_lines() == 0).then_some(())
        })
        .await
        .is_some(),
        "the spool did not drain"
    );
    worker.manager.meter().flush_and_close().await;
    let rows = eventually(Duration::from_secs(30), || async {
        let rows = stack.sql(&format!("select count(*)::int as n, count(distinct request_id)::int as d from meters_raw where deployment_hash = '{hash}'")).await;
        (rows[0]["n"].as_u64() == Some(served)).then_some(rows)
    })
    .await;
    let rows = rows.unwrap_or_else(|| {
        let rejected = std::fs::read_dir(meters.dir.join("rejected"))
            .map(|d| d.count())
            .unwrap_or(0);
        panic!("meters_raw does not hold {served} records; rejected files: {rejected}")
    });
    assert_eq!(
        rows[0]["d"].as_u64(),
        Some(served),
        "duplicates in meters_raw"
    );
    assert_eq!(health(&worker).await["status"], "ok");
    worker.shutdown().await;

    // A worker restarted while the control plane is down serves from the snapshot file.
    stack.stop_api().await;
    assert!(dir.join("data/routes.snapshot.json").is_file());
    let again = start_worker(&stack, &dir, "node-dg-1", &token_file).await;
    let r = get(&again, "hello.renox.test").await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(health(&again).await["status"], "degraded");
    again.shutdown().await;
}

/// `docs/23-failure-modes.md` section 3, "Object storage unreachable": a
/// cached tenant serves, an uncached one gets 503 `RENOX_UNAVAILABLE` with
/// `Retry-After`, and its cold start succeeds once storage is back. Needs
/// `RENOX_TEST_S3`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn object_storage_down_refuses_only_uncached_cold_starts() {
    if std::env::var("RENOX_TEST_PG").is_err() {
        eprintln!("skipped: set RENOX_TEST_PG");
        return;
    }
    let Some(s3) = std::env::var("RENOX_TEST_S3").ok() else {
        eprintln!("skipped: set RENOX_TEST_S3 (an S3 endpoint with the renox-artifacts bucket)");
        return;
    };
    let target: SocketAddr = s3
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .parse()
        .expect("RENOX_TEST_S3 as http://<ip>:<port>");
    let mut proxy = TcpProxy::start(target).await;
    let Some(stack) =
        Stack::start_with("degraded-s3", Some(format!("http://{}", proxy.addr))).await
    else {
        return;
    };
    let a = stack.tenant_with_app("t_cached", "cached", "free").await;
    let b = stack.tenant_with_app("t_cold", "cold", "free").await;
    let hash_a = stack
        .upload(&a, "cached", &hello_for(&stack.root, "cached"))
        .await;
    let hash_b = stack
        .upload(&b, "cold", &hello_for(&stack.root, "cold"))
        .await;
    let token_file = stack.node_token_file("node-dg-2").await;
    let dir = stack.root.join("worker");
    let worker = start_worker_idle(&stack, &dir, "node-dg-2", &token_file, 1).await;
    registered(&worker).await;
    assert_eq!(stack.activate(&a, "cached", &hash_a).await.status, 200);
    assert_eq!(stack.activate(&b, "cold", &hash_b).await.status, 200);
    eventually(Duration::from_secs(5), || async {
        worker.routes.lookup("cold.renox.test")
    })
    .await
    .unwrap();
    assert_eq!(get(&worker, "cached.renox.test").await.status, 200);
    // The cold tenant is cold: its prepared cell (#96) is evicted after the
    // 1 s idle timeout, and its artifact is dropped from the disk cache, as
    // after a disk loss.
    let cold_gone = eventually(Duration::from_secs(10), || async {
        (!worker
            .manager
            .cells()
            .iter()
            .any(|k| k.deployment_hash == hash_b))
        .then_some(())
    })
    .await;
    assert!(cold_gone.is_some(), "the prepared cell was not evicted");
    let _ = std::fs::remove_dir_all(dir.join("artifacts").join(&hash_b));

    proxy.stop();
    assert_eq!(get(&worker, "cached.renox.test").await.status, 200);
    let r = get(&worker, "cold.renox.test").await;
    assert_eq!(r.status, 503, "{}", r.text());
    assert_eq!(r.json()["error"]["code"], "RENOX_UNAVAILABLE");
    assert!(
        r.head.to_ascii_lowercase().contains("retry-after: 5"),
        "{}",
        r.head
    );
    let h = health(&worker).await;
    assert_eq!(h["status"], "degraded");
    assert!(h["reasons"].to_string().contains("object_storage"), "{h}");

    proxy.restart().await;
    let r = get(&worker, "cold.renox.test").await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert!(
        !health(&worker).await["reasons"]
            .to_string()
            .contains("object_storage")
    );
    worker.shutdown().await;
}
