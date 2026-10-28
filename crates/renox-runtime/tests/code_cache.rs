//! Issue #157: the V8 code cache of `src/loader.rs`. The second isolate of
//! a deployment compiles its modules from the cache; another tenant never
//! consumes it. V8-linked. The cache and its counters are process-wide, so
//! the tests in this file run one at a time.
#![cfg(feature = "v8")]

mod support;

use std::sync::Arc;
use std::time::Duration;

use renox_runtime::limits::Limits;
use renox_runtime::loader::code_cache;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{IsolateHandle, Runtime, RuntimeConfig};
use support::*;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn runtime() -> Runtime {
    Runtime::new(RuntimeConfig {
        log_sink: Arc::new(MemoryLogSink::default()),
        ..Default::default()
    })
}

/// A module with a large eagerly compiled top level (the shape a bundler
/// emits: parenthesised function expressions run at load).
fn big_source(tag: &str) -> String {
    let mut s = String::new();
    for i in 0..400 {
        s.push_str(&format!(
            "const v{i} = (function () {{ let a = {i}; for (let j = 0; j < 3; j++) {{ a = (a * 31 + j) % 1000003; }} return {{ a, s: 'x{i}' + a }}; }})();\n"
        ));
    }
    s.push_str(&format!(
        "export function GET() {{ return Response.json({{ tag: '{tag}', last: v399.a }}); }}\n"
    ));
    s
}

async fn create(rt: &Runtime, tenant: &str, dir: &std::path::Path, hash: &str) -> IsolateHandle {
    let mut s = spec(dir, hash, Limits::FREE);
    s.tenant_id = tenant.into();
    s.max_isolates = 1;
    rt.create_isolate(s).await.unwrap()
}

/// Wait for the cache to hold `n` entries of `scope`: V8's cache is handed
/// to the loader from the isolate's event loop after the module compiles.
async fn wait_entries(scope: &str, n: usize) {
    for _ in 0..200 {
        if code_cache().entries_for(scope) >= n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("no code cache entry for {scope}");
}

/// Create an isolate of `tenant`, answer one request, and terminate it.
async fn once(rt: &Runtime, tenant: &str, dir: &std::path::Path, hash: &str) -> serde_json::Value {
    let iso = create(rt, tenant, dir, hash).await;
    let out = iso.dispatch(ctx("req_cache_once_01"), get("/")).await;
    assert_eq!(out.response.status(), 200);
    iso.terminate();
    body_json(&out.response)
}

/// A deployment's first isolate leaves no entry (B1: a tenant that only
/// ever runs one isolate pays no memory); the second stores its compiled
/// code; the third loads its module from the cache, V8 accepts it (nothing
/// is stored again), and the handler answers the same.
#[tokio::test]
async fn re_created_isolates_of_a_deployment_use_the_code_cache() {
    let _serial = SERIAL.lock().await;
    code_cache().set_enabled(true);
    let rt = runtime();
    let (dir, hash) = function_artifact(&big_source("cc"), &[("GET", "/")], &[]);
    let scope = format!("t_cache/{hash}");

    let body = once(&rt, "t_cache", &dir, &hash).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        code_cache().entries_for(&scope),
        0,
        "the first isolate stored code"
    );

    let second = create(&rt, "t_cache", &dir, &hash).await;
    let out = second.dispatch(ctx("req_cache_000001"), get("/")).await;
    assert_eq!(out.response.status(), 200);
    wait_entries(&scope, 1).await;
    let cold = second.stats().unwrap().module_time;
    second.terminate();

    let (hits, stores) = (code_cache().hits(), code_cache().stores());
    let third = create(&rt, "t_cache", &dir, &hash).await;
    let out3 = third.dispatch(ctx("req_cache_000002"), get("/")).await;
    assert_eq!(out3.response.status(), 200);
    assert_eq!(body, body_json(&out3.response));
    let warm = third.stats().unwrap().module_time;
    assert_eq!(
        code_cache().hits(),
        hits + 1,
        "module not served from the cache"
    );
    // A rejected cache would make V8 produce and store a new one.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(code_cache().stores(), stores, "V8 rejected the cached code");
    println!("module load + evaluation: without cache {cold:?}, with cache {warm:?}");
    third.terminate();
    code_cache().forget(&scope);
    assert_eq!(code_cache().entries_for(&scope), 0);
}

/// `docs/24-threat-model.md`, "Side channels between isolates"
/// (#157): the cache is scoped by tenant and deployment. A second tenant
/// running the same artifact compiles from source and gets its own entry.
#[tokio::test]
async fn another_tenant_never_consumes_the_cache() {
    let _serial = SERIAL.lock().await;
    code_cache().set_enabled(true);
    let rt = runtime();
    let (dir, hash) = function_artifact(&big_source("iso"), &[("GET", "/")], &[]);
    for _ in 0..2 {
        once(&rt, "t_cache_a", &dir, &hash).await;
    }
    wait_entries(&format!("t_cache_a/{hash}"), 1).await;

    let hits = code_cache().hits();
    for _ in 0..2 {
        once(&rt, "t_cache_b", &dir, &hash).await;
    }
    assert_eq!(
        code_cache().hits(),
        hits,
        "tenant b was served tenant a's cache"
    );
    wait_entries(&format!("t_cache_b/{hash}"), 1).await;
    code_cache().forget(&format!("t_cache_a/{hash}"));
    code_cache().forget(&format!("t_cache_b/{hash}"));
}

/// Turned off, the cache is neither read nor written.
#[tokio::test]
async fn a_disabled_cache_is_not_used() {
    let _serial = SERIAL.lock().await;
    code_cache().set_enabled(false);
    let rt = runtime();
    let (dir, hash) = function_artifact(&big_source("off"), &[("GET", "/")], &[]);
    once(&rt, "t_cache_off", &dir, &hash).await;
    let iso = create(&rt, "t_cache_off", &dir, &hash).await;
    assert_eq!(
        iso.dispatch(ctx("req_cache_off_001"), get("/"))
            .await
            .response
            .status(),
        200
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(code_cache().entries_for(&format!("t_cache_off/{hash}")), 0);
    iso.terminate();
    code_cache().set_enabled(true);
}
