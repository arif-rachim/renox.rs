//! #342: the cold request. The first run of the request path (the
//! bootstrap's dispatch, `Request`, `URL`, `Response`, the response ops) is
//! platform work of cell creation and runs at isolate creation
//! (`isolate.rs`, `warm_request_path`), so an isolate's first request is
//! charged about what a warm one is, plus its own code. The tenant's code
//! keeps the plain limit on every request, the first included
//! (`docs/24-threat-model.md` B, "CPU, memory, wall-clock exhaustion"): an
//! infinite loop on a cold lazy route is stopped at the limit. The eager
//! case is `tests/limits.rs`, unchanged.
#![cfg(feature = "v8")]

mod support;

use renox_runtime::isolate::MeterStatus;
use renox_runtime::limits::Limits;
use support::*;

/// One function module per `(id, source, eager)`, each serving `GET /<id>`.
fn artifact(modules: &[(&str, &str, bool)]) -> (std::path::PathBuf, String) {
    let mut entry = serde_json::Map::new();
    let mut entries = serde_json::Map::new();
    let mut routes = Vec::new();
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for (id, src, eager) in modules {
        let module = format!("functions/{id}");
        entry.insert(module.clone(), format!("{module}.js").into());
        entries.insert(
            module.clone(),
            serde_json::json!({ "exports": ["GET"], "eager": eager }),
        );
        routes.push(serde_json::json!({ "kind": "function", "method": "GET", "path": format!("/{id}"), "module": module, "export": "GET" }));
        files.push((format!("code/{module}.js"), src.as_bytes().to_vec()));
    }
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "cold", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": entry },
        "entries": entries,
        "routes": routes,
        "permissions": { "network": [], "secrets": [] }
    });
    files.push((
        "manifest.json".into(),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    ));
    let refs: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(p, b)| (p.as_str(), b.as_slice()))
        .collect();
    write_artifact(&refs)
}

const LOOP: &str = r#"
    export function GET() { while (true) {} }
"#;
const HELLO: &str = r#"
    export function GET(ctx) { return Response.json({ path: ctx.url.pathname }); }
"#;

/// `docs/24-threat-model.md` B: the cold request of a lazy route gets no
/// more CPU than any other; the loop is stopped at 50 ms (+ 5 ms).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_infinite_loop_on_a_cold_lazy_route_is_stopped_at_the_limit() {
    let rt = renox_runtime::Runtime::new(Default::default());
    let (dir, hash) = artifact(&[("loop", LOOP, false)]);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    let out = iso.dispatch(ctx("req_cold_loop_00001"), get("/loop")).await;
    assert_eq!(out.response.status(), 503);
    assert_eq!(body_json(&out.response)["error"]["code"], "RENOX_CPU_LIMIT");
    assert_eq!(out.meter.status, MeterStatus::CpuLimit);
    assert!(
        out.meter.cpu_ms >= 50.0 && out.meter.cpu_ms <= 55.0,
        "cpu_ms {}",
        out.meter.cpu_ms
    );
}

/// The first request of a fresh isolate is not charged the platform's
/// first run of the request path: before #342 it was about 5 ms on top of
/// a 1 ms warm request, on every host. The lowest of three isolates is
/// taken on both sides, so a host stall counted as CPU (`limits/cpu.rs`)
/// in one of them cannot decide the test.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cold_request_is_not_charged_the_platforms_first_run() {
    let rt = renox_runtime::Runtime::new(Default::default());
    let (dir, hash) = artifact(&[("hello", HELLO, true)]);
    let (mut cold, mut warm) = (f64::INFINITY, f64::INFINITY);
    for i in 0..3 {
        let iso = rt
            .create_isolate(spec(&dir, &hash, Limits::FREE))
            .await
            .unwrap();
        let first = iso
            .dispatch(ctx(&format!("req_cold_hello_0{i}0")), get("/hello"))
            .await;
        assert_eq!(first.response.status(), 200);
        cold = cold.min(first.meter.cpu_ms);
        for j in 1..=3 {
            let r = iso
                .dispatch(ctx(&format!("req_cold_hello_0{i}{j}")), get("/hello"))
                .await;
            assert_eq!(r.response.status(), 200);
            warm = warm.min(r.meter.cpu_ms);
        }
    }
    assert!(
        cold <= 2.0 * warm + 1.5,
        "cold request {cold} ms, warm {warm} ms"
    );
}
