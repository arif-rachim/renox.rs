//! Issue #156: an isolate pool per hot deployment. A termination ends only
//! the requests on one member; the concurrency limit stays per deployment.
//! V8-linked. `limits.rs` and `termination.rs` run per member with
//! `RENOX_TEST_POOL=2` (support::spec).
#![cfg(feature = "v8")]

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use renox_runtime::isolate::MeterStatus;
use renox_runtime::limits::Limits;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{IsolateHandle, Runtime, RuntimeConfig};
use support::*;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const SRC: &str = r#"
    export async function GET({ url }) {
        const ms = Number(url.searchParams.get("ms") ?? "0");
        await new Promise((r) => setTimeout(r, ms));
        return Response.json({ ok: true });
    }
    export async function POST() {
        await null;
        while (true) {}
    }
"#;

fn runtime() -> Runtime {
    Runtime::new(RuntimeConfig {
        log_sink: Arc::new(MemoryLogSink::default()),
        ..Default::default()
    })
}

async fn pooled(rt: &Runtime, max: usize) -> Arc<IsolateHandle> {
    let (dir, hash) = function_artifact(SRC, &[("GET", "/wait"), ("POST", "/hog")], &[]);
    let mut s = spec(&dir, &hash, Limits::FREE);
    s.max_isolates = max;
    Arc::new(rt.create_isolate(s).await.unwrap())
}

fn spawn_wait(iso: &Arc<IsolateHandle>, id: String, ms: u64) -> tokio::task::JoinHandle<u16> {
    let iso = iso.clone();
    tokio::spawn(async move {
        iso.dispatch(ctx(&id), get(&format!("/wait?ms={ms}")))
            .await
            .response
            .status()
            .as_u16()
    })
}

/// Load the deployment until the pool has `n` members and a spare.
async fn grow_to(iso: &Arc<IsolateHandle>, n: usize) {
    let t = Instant::now();
    let mut i = 0;
    while (iso.pool_size() < n || !iso.has_spare()) && t.elapsed() < Duration::from_secs(20) {
        let batch: Vec<_> = (0..8)
            .map(|_| {
                i += 1;
                spawn_wait(iso, format!("req_grow_{i:08}"), 50)
            })
            .collect();
        for h in batch {
            assert_eq!(h.await.unwrap(), 200);
        }
    }
    assert_eq!(iso.pool_size(), n, "pool did not grow");
    assert!(iso.has_spare(), "no spare");
}

fn hog() -> http::Request<Bytes> {
    http::Request::builder()
        .method("POST")
        .uri("https://test.renox.app/hog")
        .body(Bytes::new())
        .unwrap()
}

/// A cold deployment runs one isolate and no spare (density, B2/B3).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cold_deployment_keeps_one_isolate() {
    let _serial = SERIAL.lock().await;
    let rt = runtime();
    let iso = pooled(&rt, 4).await;
    for i in 0..5 {
        let out = iso
            .dispatch(ctx(&format!("req_cold_{i:08}")), get("/wait?ms=1"))
            .await;
        assert_eq!(out.response.status(), 200);
    }
    assert_eq!(iso.pool_size(), 1);
    assert!(!iso.has_spare());
}

/// `docs/23-failure-modes.md`, "Infinite loop / CPU over limit", blast
/// radius (#156; `docs/24-threat-model.md`, "CPU, memory, wall-clock
/// exhaustion"): with two members, a request that hits the CPU limit ends
/// only the requests on its own member. The requests on the other member
/// finish with 200, the spare takes the dead member's place at once, and
/// the next request succeeds.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cpu_kill_ends_only_the_requests_on_that_member() {
    let _serial = SERIAL.lock().await;
    let rt = runtime();
    let iso = pooled(&rt, 2).await;
    grow_to(&iso, 2).await;
    let recycles = rt.metrics().recycles();

    // Six slow requests, spread 3 + 3 by least-loaded dispatch.
    let slow: Vec<_> = (0..6)
        .map(|i| spawn_wait(&iso, format!("req_slow_{i:08}"), 1_000))
        .collect();
    let t = Instant::now();
    while iso.available_slots() > Limits::FREE.concurrency as usize - 6
        && t.elapsed() < Duration::from_secs(5)
    {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let out = iso.dispatch(ctx("req_hog_00000001"), hog()).await;
    assert_eq!(out.response.status(), 503);
    assert_eq!(out.meter.status, MeterStatus::CpuLimit);

    let mut ok = 0;
    let mut killed = 0;
    for h in slow {
        match h.await.unwrap() {
            200 => ok += 1,
            503 => killed += 1,
            s => panic!("unexpected status {s}"),
        }
    }
    println!("slow requests: {ok} ok, {killed} ended with the hog's member");
    assert_eq!((ok, killed), (3, 3));

    // The spare replaced the dead member without a cold start.
    let started = Instant::now();
    let out = iso
        .dispatch(ctx("req_after_000001"), get("/wait?ms=0"))
        .await;
    assert_eq!(out.response.status(), 200);
    assert_eq!(iso.pool_size(), 2);
    assert!(rt.metrics().recycles() > recycles);
    println!("first request after the kill: {:?}", started.elapsed());
}

/// `docs/23-failure-modes.md`, "Too many concurrent requests": the
/// concurrency limit is per deployment, not per member. With a limit of 4
/// and two members, the fifth request waits and gets 503 `RENOX_BUSY`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_concurrency_limit_is_shared_by_the_members() {
    let _serial = SERIAL.lock().await;
    let rt = runtime();
    let (dir, hash) = function_artifact(SRC, &[("GET", "/wait"), ("POST", "/hog")], &[]);
    let mut s = spec(
        &dir,
        &hash,
        Limits {
            concurrency: 4,
            ..Limits::FREE
        },
    );
    s.max_isolates = 2;
    let iso = Arc::new(rt.create_isolate(s).await.unwrap());
    let held: Vec<_> = (0..4)
        .map(|i| spawn_wait(&iso, format!("req_hold_{i:08}"), 500))
        .collect();
    let t = Instant::now();
    while iso.available_slots() > 0 && t.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(iso.available_slots(), 0);
    let busy = iso
        .dispatch(
            renox_runtime::RequestCtx {
                request_id: "req_busy_00000001".into(),
                deadline: Instant::now() + Duration::from_millis(100),
            },
            get("/wait?ms=0"),
        )
        .await;
    assert_eq!(busy.response.status(), 503);
    assert_eq!(body_json(&busy.response)["error"]["code"], "RENOX_BUSY");
    for h in held {
        assert_eq!(h.await.unwrap(), 200);
    }
    assert!(iso.pool_size() <= 2);
}

/// `docs/23-failure-modes.md`, "Infinite loop / CPU over limit": requests
/// sent to a member while it is being terminated, which never started on
/// it, run on another member (here: the fresh isolate) instead of failing
/// with 500.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn requests_queued_on_a_dying_member_run_elsewhere() {
    let _serial = SERIAL.lock().await;
    let rt = runtime();
    let iso = pooled(&rt, 1).await;
    let hog_iso = iso.clone();
    let hog = tokio::spawn(async move {
        hog_iso
            .dispatch(ctx("req_hog_00000002"), hog())
            .await
            .response
            .status()
            .as_u16()
    });
    // The hog spins for 50 ms after a 0-ms await: queue requests behind it.
    tokio::time::sleep(Duration::from_millis(20)).await;
    let queued: Vec<_> = (0..3)
        .map(|i| spawn_wait(&iso, format!("req_queued_{i:06}"), 0))
        .collect();
    assert_eq!(hog.await.unwrap(), 503);
    for h in queued {
        assert_eq!(h.await.unwrap(), 200);
    }
}
