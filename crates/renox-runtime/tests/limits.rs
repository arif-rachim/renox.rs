//! Issue #26: CPU watchdog, wall-clock deadline, heap limit, concurrency
//! semaphore, isolate recycling (`docs/contracts/ops.md` section 10).
//! V8-linked. The CPU-sensitive tests run one at a time.
#![cfg(feature = "v8")]

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use renox_runtime::isolate::{CreateError, MeterStatus};
use renox_runtime::limits::Limits;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{RequestCtx, Runtime, RuntimeConfig};
use support::*;

/// Serialises tests that measure CPU or RSS.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn runtime() -> (Runtime, Arc<MemoryLogSink>) {
    let sink = Arc::new(MemoryLogSink::default());
    (
        Runtime::new(RuntimeConfig {
            log_sink: sink.clone(),
        }),
        sink,
    )
}

fn ctx_ms(id: &str, ms: u64) -> RequestCtx {
    RequestCtx {
        request_id: id.into(),
        deadline: Instant::now() + Duration::from_millis(ms),
    }
}

/// `docs/23-failure-modes.md`, "Infinite loop / CPU over limit"
/// (`docs/24-threat-model.md`, "CPU, memory, wall-clock exhaustion"):
/// `while(true){}` is terminated at 50 ms ± 5 ms of CPU, the request gets
/// 503 `RENOX_CPU_LIMIT`, and the next request on the same deployment
/// succeeds on a new isolate.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn infinite_loop_is_terminated_at_the_cpu_limit_and_the_next_request_succeeds() {
    let _serial = SERIAL.lock().await;
    let (rt, sink) = runtime();
    let src = r#"
        export function GET({ params }) {
            if (params.kind === "sync") { while (true) {} }
            return (async () => { await null; while (true) {} })();
        }
        export function POST() { return Response.json({ ok: true }); }
    "#;
    let (dir, hash) = function_artifact(src, &[("GET", "/loop/:kind"), ("POST", "/ok")], &[]);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    for (i, kind) in ["sync", "async"].iter().enumerate() {
        let started = Instant::now();
        let out = iso
            .dispatch(
                ctx(&format!("req_cpu_{i:08}")),
                get(&format!("/loop/{kind}")),
            )
            .await;
        assert_eq!(out.response.status(), 503, "{kind}");
        assert_eq!(body_json(&out.response)["error"]["code"], "RENOX_CPU_LIMIT");
        assert_eq!(out.meter.status, MeterStatus::CpuLimit);
        println!(
            "[{kind}] cpu_ms charged at termination: {:.3} (wall {:?})",
            out.meter.cpu_ms,
            started.elapsed()
        );
        assert!(
            out.meter.cpu_ms >= 50.0 && out.meter.cpu_ms <= 55.0,
            "{kind}: cpu_ms {}",
            out.meter.cpu_ms
        );

        let post = http::Request::builder()
            .method("POST")
            .uri("https://test.renox.app/ok")
            .body(Bytes::new())
            .unwrap();
        let out = iso.dispatch(ctx(&format!("req_cpu_ok_{i:05}")), post).await;
        assert_eq!(out.response.status(), 200);
        assert_eq!(out.meter.status, MeterStatus::Ok);
    }
    assert_eq!(rt.metrics().recycles(), 2);
    let line = sink
        .lines()
        .into_iter()
        .find(|l| l.fields.get("code").and_then(|c| c.as_str()) == Some("RENOX_CPU_LIMIT"))
        .expect("logged");
    assert_eq!(line.fields["limit_ms"], 50);
    assert_eq!(line.fields["route"], "GET /loop/:kind");
}

/// Module evaluation runs under its own CPU limit (500 ms free): a
/// top-level infinite loop fails isolate creation with `RENOX_CPU_LIMIT`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn top_level_infinite_loop_fails_creation_with_cpu_limit() {
    let _serial = SERIAL.lock().await;
    let (rt, _) = runtime();
    let (dir, hash) = function_artifact(
        "while (true) {}\nexport const GET = () => new Response('');",
        &[("GET", "/x")],
        &[],
    );
    let started = Instant::now();
    let err = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .err()
        .expect("must fail");
    assert!(
        matches!(
            err,
            CreateError::Limit(renox_runtime::error::ErrorCode::CpuLimit)
        ),
        "{err}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}

/// `docs/23-failure-modes.md`, "Handler never resolves": with a 100 ms
/// deadline the request gets 504 `RENOX_DEADLINE` at the deadline, the
/// isolate is kept, and the request's ops stop working.
#[tokio::test]
async fn never_resolving_handler_gets_a_timeout_at_the_deadline() {
    let (rt, _) = runtime();
    let src = r#"
        let after = "pending";
        export async function GET(ctx) {
            setTimeout(() => { try { ctx.deadline.remainingMs(); after = "worked"; } catch (e) { after = e.code; } }, 150);
            await new Promise(() => {});
        }
        export async function POST() {
            await new Promise((r) => setTimeout(r, 200));
            return Response.json({ after });
        }
    "#;
    let (dir, hash) = function_artifact(src, &[("GET", "/hang"), ("POST", "/after")], &[]);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    let started = Instant::now();
    let out = iso
        .dispatch(ctx_ms("req_wall_0000001", 100), get("/hang"))
        .await;
    let waited = started.elapsed();
    assert_eq!(out.response.status(), 504);
    assert_eq!(body_json(&out.response)["error"]["code"], "RENOX_DEADLINE");
    assert_eq!(out.meter.status, MeterStatus::Timeout);
    assert!(
        waited >= Duration::from_millis(95) && waited < Duration::from_millis(400),
        "{waited:?}"
    );
    // The isolate is kept, and the timed-out request's token is dead.
    let post = http::Request::builder()
        .method("POST")
        .uri("https://test.renox.app/after")
        .body(Bytes::new())
        .unwrap();
    let out = iso.dispatch(ctx("req_wall_0000002"), post).await;
    assert_eq!(
        body_json(&out.response),
        serde_json::json!({ "after": "RENOX_NO_REQUEST" })
    );
    assert_eq!(rt.metrics().recycles(), 0);
}

/// `docs/23-failure-modes.md`, "Unbounded allocation": with a 32 MB heap
/// limit the request gets 503 `RENOX_OOM`, the process survives, the
/// isolate is disposed, and RSS is back within 10 MB of the baseline.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unbounded_allocation_hits_the_heap_limit_and_memory_is_returned() {
    let _serial = SERIAL.lock().await;
    let (rt, sink) = runtime();
    let src = r#"
        export function GET() { const a = []; while (true) a.push(new Array(1e6).fill(1)); }
        export function POST() { return Response.json({ ok: true }); }
    "#;
    let (dir, hash) = function_artifact(src, &[("GET", "/oom"), ("POST", "/ok")], &[]);
    let limits = Limits {
        heap_bytes: 32 * 1024 * 1024,
        cpu_ms: 5_000,
        ..Limits::FREE
    };
    let iso = rt.create_isolate(spec(&dir, &hash, limits)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let baseline = rss_bytes();
    let out = iso.dispatch(ctx("req_oom_00000001"), get("/oom")).await;
    assert_eq!(out.response.status(), 503);
    assert_eq!(body_json(&out.response)["error"]["code"], "RENOX_OOM");
    assert_eq!(out.meter.status, MeterStatus::Oom);
    assert!(
        out.meter.peak_heap_bytes > 16 * 1024 * 1024,
        "{}",
        out.meter.peak_heap_bytes
    );
    // The poisoned isolate is disposed on its own thread; give it a moment.
    let mut after = rss_bytes();
    for _ in 0..50 {
        if after <= baseline + 10 * 1024 * 1024 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        after = rss_bytes();
    }
    println!(
        "RSS baseline {:.1} MB, after OOM and disposal {:.1} MB",
        baseline as f64 / 1048576.0,
        after as f64 / 1048576.0
    );
    assert!(
        after <= baseline + 10 * 1024 * 1024,
        "RSS {} MB over baseline",
        (after as i64 - baseline as i64) / 1048576
    );
    // The process survived and the deployment serves again.
    let post = http::Request::builder()
        .method("POST")
        .uri("https://test.renox.app/ok")
        .body(Bytes::new())
        .unwrap();
    assert_eq!(
        iso.dispatch(ctx("req_oom_00000002"), post)
            .await
            .response
            .status(),
        200
    );
    assert!(
        sink.lines()
            .iter()
            .any(|l| l.fields.get("code").and_then(|c| c.as_str()) == Some("RENOX_OOM"))
    );
}

/// `docs/23-failure-modes.md`, "Too many concurrent requests": with a limit
/// of 50, the 51st request waits for a slot; one that cannot get a slot
/// before its deadline gets 503 `RENOX_BUSY` with `Retry-After: 1`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_request_over_the_concurrency_limit_waits() {
    let (rt, _) = runtime();
    let src = r#"export async function GET() { await new Promise((r) => setTimeout(r, 300)); return Response.json({ ok: true }); }"#;
    let (dir, hash) = function_artifact(src, &[("GET", "/slow")], &[]);
    let iso = Arc::new(
        rt.create_isolate(spec(&dir, &hash, Limits::FREE))
            .await
            .unwrap(),
    );
    assert_eq!(iso.limits().concurrency, 50);
    let mut first = Vec::new();
    for i in 0..50 {
        let iso = iso.clone();
        first.push(tokio::spawn(async move {
            iso.dispatch(ctx(&format!("req_conc_{i:08}")), get("/slow"))
                .await
        }));
    }
    // Let the 50 take their slots.
    let t = Instant::now();
    while iso.available_slots() > 0 && t.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(iso.available_slots(), 0);
    // A request whose deadline passes while queued: 503 RENOX_BUSY.
    let busy = iso
        .dispatch(ctx_ms("req_conc_busy0001", 50), get("/slow"))
        .await;
    assert_eq!(busy.response.status(), 503);
    assert_eq!(busy.response.headers()["retry-after"], "1");
    assert_eq!(body_json(&busy.response)["error"]["code"], "RENOX_BUSY");
    assert_eq!(busy.meter.status, MeterStatus::Busy);
    // The 51st waits for a slot, then succeeds.
    let started = Instant::now();
    let out = iso.dispatch(ctx("req_conc_51st0001"), get("/slow")).await;
    assert_eq!(out.response.status(), 200);
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "did not wait: {:?}",
        started.elapsed()
    );
    for f in first {
        assert_eq!(f.await.unwrap().response.status(), 200);
    }
}

/// The meter fields the runtime owns are populated (`ops.md` section 7):
/// `cpu_ms` from the thread CPU clock, `peak_heap_bytes`, `status`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn meter_fields_are_populated() {
    let _serial = SERIAL.lock().await;
    let (rt, _) = runtime();
    let src = r#"
        export function GET() {
            const until = Date.now() + 20;
            let x = 0;
            while (Date.now() < until) x++;
            const keep = new Array(200000).fill(x);
            return Response.json({ n: keep.length });
        }
        export async function POST() { await new Promise((r) => setTimeout(r, 50)); return new Response("idle"); }
    "#;
    let (dir, hash) = function_artifact(src, &[("GET", "/burn"), ("POST", "/idle")], &[]);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    let out = iso.dispatch(ctx("req_meter_000001"), get("/burn")).await;
    assert_eq!(out.response.status(), 200);
    assert_eq!(out.meter.status, MeterStatus::Ok);
    assert!(
        out.meter.cpu_ms >= 15.0 && out.meter.cpu_ms < 50.0,
        "cpu_ms {}",
        out.meter.cpu_ms
    );
    assert!(
        out.meter.peak_heap_bytes > 1_000_000,
        "peak {}",
        out.meter.peak_heap_bytes
    );
    // Waiting is wall time, not CPU.
    let post = http::Request::builder()
        .method("POST")
        .uri("https://test.renox.app/idle")
        .body(Bytes::new())
        .unwrap();
    let out = iso.dispatch(ctx("req_meter_000002"), post).await;
    assert!(
        out.meter.cpu_ms < 15.0,
        "idle request charged {} ms",
        out.meter.cpu_ms
    );
}
