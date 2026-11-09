//! Issue #642, task 1: how many V8 heap bytes the per-module `ctx` facades
//! of `src/js/bootstrap.js` take, measured before any change to it.
//! V8-linked, and ignored by default: it prints numbers for
//! `bench/results/*-B1-lazy-ctx.md` and only checks that they are sane.
//!
//! ```text
//! CARGO_PROFILE_RELEASE_DEBUG=0 cargo test --release -p renox-runtime \
//!   --test ctx_facade_heap -- --ignored --nocapture --test-threads=1
//! ```
//!
//! Two measurements, on artifacts with up to 12 modules (`m01`..`m12`,
//! each with a config and four services, like a small marketplace module):
//!
//! 1. **At isolate creation**: `CreateStats::used_heap_bytes` (the same
//!    `used_heap_size` the meter's `peak_heap_bytes` reads), median of
//!    several isolates per artifact, for every module count from 0 to 12,
//!    for modules with code (`services.js`) and for modules registered with
//!    no code at all. The median step from N to N + 1 is the
//!    per-module cost of creation: `harden`'s frozen module info and
//!    secrets, `buildProxies`' service closures, `register`, and (with
//!    code) the module's evaluation.
//! 2. **The facade itself** (`newRequestState(..).ctxOf(m)`, which
//!    `moduleFields(m)` fills): a request on the 12-module artifact calls
//!    one service of every module, which builds that module's ctx. One
//!    isolate's services keep the ctx they receive in a module global, the
//!    other's drop it. After R such requests, the difference between the
//!    two isolates' heap (the `peak_heap_bytes` of one identical final
//!    request), divided by R x 12, is the retained size of one facade with
//!    its members (db, log, hooks, events, jobs, storage, ai, pdf, render,
//!    authz, realtime).
#![cfg(feature = "v8")]

mod support;

use std::sync::Arc;
use std::time::Duration;

use renox_runtime::limits::Limits;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{IsolateHandle, Runtime, RuntimeConfig};
use support::*;

/// Isolates measured per artifact at creation.
const CREATED: usize = 7;
/// Requests per isolate in the facade measurement.
const ROUNDS: usize = 200;
/// Modules of the facade measurement.
const FACADE_MODULES: usize = 12;

const SERVICES: &str = r#"
const kept = [];
export async function keep(ctx) { kept.push(ctx); return kept.length; }
export async function drop(ctx) { return ctx.module.length; }
export async function info(ctx) { return { module: ctx.module, config: ctx.config, frozen: Object.isFrozen(ctx) }; }
export async function ping() { return "pong"; }
"#;

fn name(i: usize) -> String {
    format!("m{i:02}")
}

/// The app route: `?op=keep|drop|none` calls that service of every module.
fn app_source(n: usize) -> String {
    let names: Vec<String> = (1..=n).map(name).collect();
    let import = if n == 0 {
        String::new()
    } else {
        format!(
            "import {{ {} }} from \"renox:modules\";\n",
            names.join(", ")
        )
    };
    format!(
        r#"{import}const mods = [{list}];
export async function GET(ctx) {{
  const op = ctx.url.searchParams.get("op");
  let out = 0;
  if (op === "keep" || op === "drop") for (const m of mods) out += await m[op]();
  return Response.json({{ out, n: mods.length }});
}}
"#,
        list = names.join(", ")
    )
}

/// An artifact with `n` modules; `with_code` gives each a `services.js`.
fn artifact(n: usize, with_code: bool) -> (std::path::PathBuf, String) {
    let mut modules = Vec::new();
    let mut entry = serde_json::json!({ "functions/f": "functions/f.js" });
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 1..=n {
        let m = name(i);
        let perms = serde_json::json!({ "tables": format!("{m}__*"), "network": [], "secrets": [], "slots": [], "hooks": [] });
        let exports = if with_code {
            serde_json::json!({ "services": ["keep", "drop", "info", "ping"] })
        } else {
            serde_json::json!({})
        };
        modules.push(serde_json::json!({
            "name": m, "version": "1.0.0", "hash": "0".repeat(64), "source": format!("path:modules/{m}"),
            "mount": format!("/{m}"), "isolation": "shared", "dependencies": [],
            "config": { "greeting": format!("hi from {m}"), "limit": 10, "enabled": true },
            "permissions": perms, "approved": perms, "exports": exports,
        }));
        if with_code {
            let id = format!("modules/{m}/services");
            entry[&id] = serde_json::Value::String(format!("{id}.js"));
            files.push((format!("code/{id}.js"), SERVICES.as_bytes().to_vec()));
        }
    }
    // Without code the app cannot import the modules' services.
    let app = app_source(if with_code { n } else { 0 });
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "test", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": entry },
        "routes": [{ "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] },
        "modules": modules,
    });
    files.push((
        "manifest.json".into(),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    ));
    files.push(("code/functions/f.js".into(), app.into_bytes()));
    let refs: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(p, b)| (p.as_str(), b.as_slice()))
        .collect();
    write_artifact(&refs)
}

fn runtime() -> (Runtime, Arc<MemoryLogSink>) {
    let sink = Arc::new(MemoryLogSink::default());
    let rt = Runtime::new(RuntimeConfig {
        log_sink: sink.clone(),
        ..Default::default()
    });
    (rt, sink)
}

static TENANT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

async fn create(rt: &Runtime, dir: &std::path::Path, hash: &str) -> IsolateHandle {
    let mut s = spec(dir, hash, Limits::FREE);
    let t = TENANT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    s.tenant_id = format!("t_facade_{t}");
    s.max_isolates = 1;
    rt.create_isolate(s).await.unwrap()
}

fn median(mut v: Vec<u64>) -> u64 {
    v.sort_unstable();
    v[v.len() / 2]
}

/// Median `used_heap_bytes` at creation of `CREATED` isolates.
async fn creation_heap(rt: &Runtime, n: usize, with_code: bool) -> u64 {
    let (dir, hash) = artifact(n, with_code);
    // A warm-up isolate fills the code cache, as a re-created pool member
    // would find it.
    drop(create(rt, &dir, &hash).await);
    let mut heaps = Vec::with_capacity(CREATED);
    let mut kept = Vec::with_capacity(CREATED);
    for _ in 0..CREATED {
        let iso = create(rt, &dir, &hash).await;
        heaps.push(iso.stats().unwrap().used_heap_bytes);
        kept.push(iso);
    }
    for iso in kept {
        iso.terminate();
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    median(heaps)
}

async fn call(iso: &IsolateHandle, sink: &MemoryLogSink, op: &str, i: usize) -> u64 {
    let out = iso
        .dispatch(
            ctx(&format!("req_facade_{op}_{i}")),
            get(&format!("/?op={op}")),
        )
        .await;
    assert_eq!(out.response.status(), 200, "{:?}", sink.lines());
    out.meter.peak_heap_bytes
}

/// Heap of an isolate after `ROUNDS` requests calling `op` on every module,
/// read as the `peak_heap_bytes` of one final `op=none` request.
async fn heap_after(rt: &Runtime, sink: &MemoryLogSink, op: &str) -> u64 {
    let (dir, hash) = artifact(FACADE_MODULES, true);
    let iso = create(rt, &dir, &hash).await;
    for i in 0..ROUNDS {
        call(&iso, sink, op, i).await;
    }
    let heap = call(&iso, sink, "none", ROUNDS).await;
    iso.terminate();
    heap
}

fn kb(b: f64) -> f64 {
    b / 1024.0
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "measurement for #642: run with --ignored --nocapture"]
async fn ctx_facade_bytes_per_module() {
    let (rt, sink) = runtime();

    // 1. Creation, every N from 0 to 12. `used_heap_size` is read right
    // after creation, with no GC forced: once per run it jumps by about
    // 0.7 MB at a module count that moves between runs (8, 9 or 10), a heap
    // growth step and not a per-module cost. The per-module figure is
    // therefore the median of the 12 steps N -> N + 1, which that one
    // jump does not move.
    for with_code in [true, false] {
        let mut heaps = Vec::with_capacity(13);
        for n in 0..=12 {
            heaps.push(creation_heap(&rt, n, with_code).await);
        }
        let mut steps: Vec<i64> = heaps
            .windows(2)
            .map(|w| w[1] as i64 - w[0] as i64)
            .collect();
        steps.sort_unstable();
        let per = (steps[5] + steps[6]) as f64 / 2.0;
        let line: Vec<String> = heaps
            .iter()
            .enumerate()
            .map(|(n, h)| format!("{n}: {:.1}", kb(*h as f64)))
            .collect();
        println!(
            "[creation, modules {}] used_heap KB by module count: {}; median step per module {:.2} KB ({:.4} MB); 12 - 0: {:.1} KB",
            if with_code {
                "with services.js"
            } else {
                "registered, no code"
            },
            line.join(", "),
            kb(per),
            per / 1048576.0,
            kb(heaps[12] as f64 - heaps[0] as f64),
        );
        assert!(per > 0.0, "a module must cost something at creation");
    }

    // 2. The facade, built per request by ctxOf(m).
    let mut diffs = Vec::new();
    for run in 0..3 {
        let dropped = heap_after(&rt, &sink, "drop").await;
        let kept = heap_after(&rt, &sink, "keep").await;
        let per = (kept as f64 - dropped as f64) / (ROUNDS * FACADE_MODULES) as f64;
        println!(
            "[facade, run {run}] after {ROUNDS} requests x {FACADE_MODULES} modules: kept {kept} B, dropped {dropped} B; retained per facade {:.2} KB",
            kb(per)
        );
        diffs.push(per);
    }
    diffs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let per = diffs[1];
    println!(
        "[facade] median retained bytes per module ctx facade: {per:.0} B ({:.2} KB, {:.4} MB); {FACADE_MODULES} modules: {:.3} MB per request that touches all of them",
        kb(per),
        per / 1048576.0,
        per * FACADE_MODULES as f64 / 1048576.0
    );
    assert!(per > 0.0, "kept facades must take heap");
}
