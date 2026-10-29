//! #265 (ops.md 1.4.0 section 11, steps 4-5; `artifact.md` 1.2 "Entries"):
//! a route module marked `eager: false` is evaluated on its first request,
//! once per isolate, inside that request; a lazy module that throws answers
//! 500 `RENOX_MODULE_EVAL` for its route only, and the isolate keeps
//! answering the others (`docs/23-failure-modes.md`, "Route module fails to
//! evaluate on first use").
#![cfg(feature = "v8")]

mod support;

use std::sync::Arc;

use renox_runtime::isolate::MeterStatus;
use renox_runtime::limits::Limits;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{Runtime, RuntimeConfig};
use support::*;

fn runtime() -> (Runtime, Arc<MemoryLogSink>) {
    let sink = Arc::new(MemoryLogSink::default());
    let rt = Runtime::new(RuntimeConfig {
        log_sink: sink.clone(),
        ..Default::default()
    });
    (rt, sink)
}

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
        "app": { "name": "lazy", "timezone": "Asia/Dubai" },
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

const COUNTER: &str = r#"
    globalThis.__evaluations = (globalThis.__evaluations ?? 0) + 1;
    export function GET() { return Response.json({ evaluations: globalThis.__evaluations }); }
"#;
const PROBE: &str = r#"
    export function GET() { return Response.json({ evaluations: globalThis.__evaluations ?? 0 }); }
"#;

/// The lazy module's top-level code has not run before its first request,
/// runs once on it, and not again.
#[tokio::test]
async fn a_lazy_route_module_is_evaluated_on_its_first_request_only() {
    let (rt, _) = runtime();
    let (dir, hash) = artifact(&[("counter", COUNTER, false), ("probe", PROBE, true)]);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    let probe = iso.dispatch(ctx("req_lazy_probe_01"), get("/probe")).await;
    assert_eq!(body_json(&probe.response)["evaluations"], 0);
    let first = iso
        .dispatch(ctx("req_lazy_first_01"), get("/counter"))
        .await;
    assert_eq!(first.response.status(), 200);
    assert_eq!(body_json(&first.response)["evaluations"], 1);
    let again = iso
        .dispatch(ctx("req_lazy_again_01"), get("/counter"))
        .await;
    assert_eq!(body_json(&again.response)["evaluations"], 1);
    let probe = iso.dispatch(ctx("req_lazy_probe_02"), get("/probe")).await;
    assert_eq!(body_json(&probe.response)["evaluations"], 1);
}

/// The same module marked eager (or with no `entries` at all) is evaluated
/// at isolate creation, as in 1.3.0.
#[tokio::test]
async fn an_eager_module_is_evaluated_at_creation() {
    let (rt, _) = runtime();
    let (dir, hash) = artifact(&[("counter", COUNTER, true), ("probe", PROBE, true)]);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    let probe = iso.dispatch(ctx("req_eager_probe_1"), get("/probe")).await;
    assert_eq!(body_json(&probe.response)["evaluations"], 1);
}

/// docs/23-failure-modes.md "Route module fails to evaluate on first use":
/// 500 RENOX_MODULE_EVAL for that route only, the cause in the tenant log
/// once per isolate (never in the body), other routes keep answering 200.
#[tokio::test]
async fn a_throwing_lazy_module_fails_its_route_only() {
    let (rt, sink) = runtime();
    let bad = r#"
        throw new Error("top-level-secret-detail");
        export function GET() { return new Response("never"); }
    "#;
    let (dir, hash) = artifact(&[("bad", bad, false), ("probe", PROBE, true)]);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    for id in ["req_lazy_bad_00001", "req_lazy_bad_00002"] {
        let out = iso.dispatch(ctx(id), get("/bad")).await;
        assert_eq!(out.response.status(), 500, "{id}");
        assert_eq!(out.meter.status, MeterStatus::Error);
        let body = String::from_utf8(out.response.body().to_vec()).unwrap();
        assert!(!body.contains("secret-detail"), "{body}");
        let v = body_json(&out.response);
        assert_eq!(v["error"]["code"], "RENOX_MODULE_EVAL");
        assert_eq!(v["error"]["request_id"], id);
    }
    let ok = iso.dispatch(ctx("req_lazy_ok_000001"), get("/probe")).await;
    assert_eq!(ok.response.status(), 200);
    let logged: Vec<_> = sink
        .lines()
        .into_iter()
        .filter(|l| l.fields.get("code").and_then(|c| c.as_str()) == Some("RENOX_MODULE_EVAL"))
        .collect();
    assert_eq!(logged.len(), 1, "logged once per isolate");
    assert_eq!(logged[0].request_id.as_deref(), Some("req_lazy_bad_00001"));
    assert!(
        logged[0].fields["cause_message"]
            .as_str()
            .unwrap()
            .contains("top-level-secret-detail")
    );
    assert_eq!(logged[0].fields["module"], "functions/bad");
}

/// A lazy module without the route's export answers RENOX_MODULE_EVAL (the
/// request-time check behind the prepare-time one, artifact V23).
#[tokio::test]
async fn a_lazy_module_without_the_export_answers_module_eval() {
    let (rt, _) = runtime();
    let (dir, hash) = artifact(&[(
        "noexport",
        "export const POST = () => new Response('x');",
        false,
    )]);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    let out = iso
        .dispatch(ctx("req_lazy_noexp_001"), get("/noexport"))
        .await;
    assert_eq!(out.response.status(), 500);
    assert_eq!(
        body_json(&out.response)["error"]["code"],
        "RENOX_MODULE_EVAL"
    );
}

/// The lazy module's top-level code runs inside the request: an op works
/// (and is refused for its own reason, not RENOX_NO_REQUEST), and its CPU
/// is charged to the request that triggered it (ops.md 1.4.0 section 7).
#[tokio::test]
async fn a_lazy_modules_top_level_runs_inside_its_first_request() {
    let (rt, _) = runtime();
    let src = r#"
        let code = "none";
        try { await fetch("https://blocked.example/"); } catch (e) { code = e.code; }
        const end = Date.now() + 40;
        while (Date.now() < end) {}
        export function GET() { return Response.json({ code }); }
    "#;
    let (dir, hash) = artifact(&[("ops", src, false)]);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::PAID))
        .await
        .unwrap();
    let first = iso.dispatch(ctx("req_lazy_ops_00001"), get("/ops")).await;
    assert_eq!(first.response.status(), 200);
    assert_eq!(body_json(&first.response)["code"], "RENOX_FETCH_BLOCKED");
    let second = iso.dispatch(ctx("req_lazy_ops_00002"), get("/ops")).await;
    assert!(
        first.meter.cpu_ms >= 30.0,
        "first request charged {} ms",
        first.meter.cpu_ms
    );
    assert!(
        second.meter.cpu_ms < 20.0,
        "second request charged {} ms",
        second.meter.cpu_ms
    );
}

/// Step 4: every entry must exist, lazy ones included; a missing file
/// fails the creation as in 1.3.0.
#[tokio::test]
async fn a_missing_lazy_entry_fails_isolate_creation() {
    let (rt, _) = runtime();
    let (dir, hash) = artifact(&[("probe", PROBE, true), ("gone", PROBE, false)]);
    let moved = dir.with_extension("moved");
    std::fs::rename(&dir, &moved).unwrap();
    std::fs::remove_file(moved.join("code/functions/gone.js")).unwrap();
    std::fs::rename(&moved, &dir).unwrap();
    let r = rt.create_isolate(spec(&dir, &hash, Limits::FREE)).await;
    assert!(r.is_err(), "creation must fail");
}

/// #157's V8 code cache serves lazy modules too: the third isolate of a
/// deployment compiles its lazy module from the cache the second one
/// stored (this test binary is the only user of the process-wide cache).
#[tokio::test]
async fn the_code_cache_serves_lazy_modules() {
    use renox_runtime::loader::code_cache;
    code_cache().set_enabled(true);
    let (rt, _) = runtime();
    let mut src = String::new();
    for i in 0..200 {
        src.push_str(&format!(
            "const v{i} = (function () {{ return {i} * 7; }})();\n"
        ));
    }
    src.push_str("export function GET() { return Response.json({ last: v199 }); }\n");
    let (dir, hash) = artifact(&[("cached", &src, false)]);
    let scope = format!("t_test/{hash}");
    let mut stored = false;
    for n in 0..3 {
        let mut s = spec(&dir, &hash, Limits::FREE);
        s.max_isolates = 1;
        let iso = rt.create_isolate(s).await.unwrap();
        let hits = code_cache().hits();
        let out = iso
            .dispatch(ctx("req_lazy_cache_001"), get("/cached"))
            .await;
        assert_eq!(body_json(&out.response)["last"], 199 * 7);
        if n == 1 {
            for _ in 0..200 {
                if code_cache().entries_for(&scope) > 0 {
                    stored = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        }
        if n == 2 {
            assert!(
                code_cache().hits() > hits,
                "the lazy module was not served from the cache"
            );
        }
        iso.terminate();
    }
    assert!(
        stored,
        "the second isolate stored no code for the lazy module"
    );
    code_cache().forget(&scope);
}
