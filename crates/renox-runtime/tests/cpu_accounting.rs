//! Issue #155: CPU accounting under concurrency. Each request in flight on
//! one isolate is charged the CPU of its own JavaScript, not every slice it
//! was in flight for (`docs/contracts/ops.md` section 10; B12 finding of
//! #146). V8-linked. The tests measure CPU, so they run one at a time.
#![cfg(feature = "v8")]

mod support;

use std::sync::Arc;
use std::time::Instant;

use renox_runtime::isolate::MeterStatus;
use renox_runtime::limits::Limits;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{Runtime, RuntimeConfig};
use support::*;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn runtime() -> Runtime {
    Runtime::new(RuntimeConfig {
        log_sink: Arc::new(MemoryLogSink::default()),
        ..Default::default()
    })
}

/// Four rounds of a fixed amount of work, each followed by a timer: a
/// request in flight across many slices that mostly run other requests.
const LIGHT: &str = r#"
    function work() {
        let x = 0;
        for (let i = 0; i < 40000; i++) x = (x + i * i) % 1000003;
        return x;
    }
    export async function GET() {
        let x = 0;
        for (let round = 0; round < 4; round++) {
            x += work();
            await new Promise((r) => setTimeout(r, 1));
        }
        return Response.json({ x });
    }
    export function PUT() {
        let x = 0;
        for (let round = 0; round < 4; round++) x += work();
        return Response.json({ x });
    }
    export async function POST() {
        await new Promise((r) => setTimeout(r, 5));
        while (true) {}
    }
"#;

/// The deployment on exactly one isolate, whatever `RENOX_TEST_POOL` says:
/// these tests are about requests sharing one isolate thread.
fn one_isolate(dir: &std::path::Path, hash: &str) -> renox_runtime::IsolateSpec {
    let mut s = spec(dir, hash, Limits::FREE);
    s.max_isolates = 1;
    s
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

/// `docs/23-failure-modes.md`, "Infinite loop / CPU over limit", negative
/// side (#155): 16 concurrent light requests on one isolate are each
/// charged at most 2× the CPU the same request uses alone, and none is
/// ended with `RENOX_CPU_LIMIT`. No request is charged less than its own
/// JavaScript work, within 20 % measurement noise (the same work run
/// without `await`, which has no event
/// loop overhead to share); the rest of a request's solo cost is per-slice
/// platform work, which concurrent requests share.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_light_requests_are_charged_their_own_cpu() {
    let _serial = SERIAL.lock().await;
    let rt = runtime();
    let (dir, hash) = function_artifact(
        LIGHT,
        &[("GET", "/light"), ("POST", "/hog"), ("PUT", "/sync")],
        &[],
    );
    let iso = Arc::new(rt.create_isolate(one_isolate(&dir, &hash)).await.unwrap());
    // Warm up the JIT, then measure the request alone.
    for i in 0..10 {
        iso.dispatch(ctx(&format!("req_warm_{i:08}")), get("/light"))
            .await;
    }
    let mut alone = Vec::new();
    for i in 0..9 {
        let out = iso
            .dispatch(ctx(&format!("req_alone_{i:07}")), get("/light"))
            .await;
        assert_eq!(out.response.status(), 200);
        alone.push(out.meter.cpu_ms);
    }
    let own = median(alone.clone());
    println!("alone: median {own:.3} ms, all {alone:?}");
    let mut sync = Vec::new();
    for i in 0..9 {
        let put = http::Request::builder()
            .method("PUT")
            .uri("https://test.renox.app/sync")
            .body(bytes::Bytes::new())
            .unwrap();
        let out = iso.dispatch(ctx(&format!("req_sync_{i:08}")), put).await;
        assert_eq!(out.response.status(), 200);
        sync.push(out.meter.cpu_ms);
    }
    // The fastest run: the work itself, with the least noise on top.
    let work = sync.iter().cloned().fold(f64::MAX, f64::min);
    println!("same work without await: fastest {work:.3} ms, all {sync:?}");

    let mut worst_ratio: f64 = 0.0;
    for round in 0..3 {
        let started = Instant::now();
        let handles: Vec<_> = (0..16)
            .map(|i| {
                let iso = iso.clone();
                tokio::spawn(async move {
                    iso.dispatch(ctx(&format!("req_c{round}_{i:07}")), get("/light"))
                        .await
                })
            })
            .collect();
        let mut charged = Vec::new();
        for h in handles {
            let out = h.await.unwrap();
            assert_eq!(out.response.status(), 200, "{:?}", out.meter);
            assert_eq!(out.meter.status, MeterStatus::Ok);
            charged.push(out.meter.cpu_ms);
        }
        let max = charged.iter().cloned().fold(0.0, f64::max);
        let min = charged.iter().cloned().fold(f64::MAX, f64::min);
        let sum: f64 = charged.iter().sum();
        println!(
            "round {round}: 16 concurrent in {:?}; charged min {min:.3} max {max:.3} ms, sum {sum:.3} ms, {charged:?}",
            started.elapsed()
        );
        worst_ratio = worst_ratio.max(max / own);
        assert!(
            max <= 2.0 * own,
            "a request was charged {max:.3} ms, its own CPU is {own:.3} ms"
        );
        assert!(
            min >= 0.8 * work,
            "a request was charged {min:.3} ms for {work:.3} ms of its own JavaScript"
        );
    }
    println!("worst charged / own: {worst_ratio:.2}");
}

/// `docs/23-failure-modes.md`, "Infinite loop / CPU over limit" (#155,
/// "never under-count"): an infinite loop that starts while 15 light
/// requests are in flight on the same isolate is still terminated at its
/// own 50 ms (+ 5 ms), and its meter shows its own CPU.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn infinite_loop_among_concurrent_requests_is_terminated_at_its_own_limit() {
    let _serial = SERIAL.lock().await;
    let rt = runtime();
    let (dir, hash) = function_artifact(
        LIGHT,
        &[("GET", "/light"), ("POST", "/hog"), ("PUT", "/sync")],
        &[],
    );
    let iso = Arc::new(rt.create_isolate(one_isolate(&dir, &hash)).await.unwrap());
    let lights: Vec<_> = (0..15)
        .map(|i| {
            let iso = iso.clone();
            tokio::spawn(async move {
                iso.dispatch(ctx(&format!("req_l_{i:09}")), get("/light"))
                    .await
            })
        })
        .collect();
    let post = http::Request::builder()
        .method("POST")
        .uri("https://test.renox.app/hog")
        .body(bytes::Bytes::new())
        .unwrap();
    let hog = iso.dispatch(ctx("req_hog_00000001"), post).await;
    assert_eq!(hog.response.status(), 503);
    assert_eq!(hog.meter.status, MeterStatus::CpuLimit);
    println!("hog charged {:.3} ms", hog.meter.cpu_ms);
    assert!(
        hog.meter.cpu_ms >= 50.0 && hog.meter.cpu_ms <= 55.0,
        "hog cpu_ms {}",
        hog.meter.cpu_ms
    );
    for h in lights {
        // Requests still in flight on the terminated isolate end with it
        // (ops.md section 10, collateral rule); finished ones are 200.
        let out = h.await.unwrap();
        assert!(matches!(out.response.status().as_u16(), 200 | 503));
    }
    // The next request runs on a fresh isolate.
    let out = iso.dispatch(ctx("req_after_000001"), get("/light")).await;
    assert_eq!(out.response.status(), 200);
}
