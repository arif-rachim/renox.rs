//! Issue #157: cold-start levers on a real artifact. Isolate creation time,
//! module evaluation time, V8 heap and RSS per isolate for the artifact as
//! `renox build` writes it (`esm-dir` with shared chunks) against the same
//! modules packed into `bundle.eszip`, each with the V8 code cache of
//! `src/loader.rs` off and on. V8-linked, and ignored by default: it needs
//! a built artifact.
//!
//! ```text
//! (cd examples/shop && bun ../../cli/src/main.ts build --out /tmp/a)
//! RENOX_COLD_START_ARTIFACT=/tmp/a/<hash> \
//!   cargo test --release -p renox-runtime --test cold_start -- --ignored --nocapture
//! ```
//!
//! The numbers are printed (`bench/results/*-B4-cold-start-levers-*.md`);
//! the assertions only check that every variant creates isolates.
#![cfg(feature = "v8")]

mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use renox_runtime::limits::Limits;
use renox_runtime::loader::code_cache;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{Runtime, RuntimeConfig};
use support::*;

fn files_under(root: &Path, rel: &str, out: &mut Vec<(String, Vec<u8>)>) {
    for e in std::fs::read_dir(root.join(rel)).unwrap() {
        let e = e.unwrap();
        let name = e.file_name().to_string_lossy().into_owned();
        let r = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        if e.file_type().unwrap().is_dir() {
            files_under(root, &r, out);
        } else {
            out.push((r, std::fs::read(e.path()).unwrap()));
        }
    }
}

/// The same artifact with `code/` packed into `code/bundle.eszip`.
fn as_eszip(dir: &Path) -> (PathBuf, String) {
    let mut files = Vec::new();
    files_under(dir, "", &mut files);
    let mut archive = eszip::EszipV2::default();
    let mut out: Vec<(String, Vec<u8>)> = Vec::new();
    for (path, bytes) in files {
        if let Some(code) = path.strip_prefix("code/") {
            let kind = if code.ends_with(".json") {
                eszip::ModuleKind::Json
            } else {
                eszip::ModuleKind::JavaScript
            };
            archive.add_to_front(kind, format!("file:///{code}"), bytes, Vec::new());
        } else if path == "manifest.json" {
            let mut m: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            m["code"]["format"] = "eszip".into();
            out.push((path, serde_json::to_vec_pretty(&m).unwrap()));
        } else {
            out.push((path, bytes));
        }
    }
    out.push(("code/bundle.eszip".into(), archive.into_bytes()));
    let refs: Vec<(&str, &[u8])> = out
        .iter()
        .map(|(p, b)| (p.as_str(), b.as_slice()))
        .collect();
    write_artifact(&refs)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs RENOX_COLD_START_ARTIFACT (a built artifact directory)"]
async fn cold_start_levers_on_a_real_artifact() {
    let Some(dir) = std::env::var_os("RENOX_COLD_START_ARTIFACT").map(PathBuf::from) else {
        println!("RENOX_COLD_START_ARTIFACT not set: nothing measured");
        return;
    };
    let hash = dir.file_name().unwrap().to_string_lossy().into_owned();
    let (eszip_dir, eszip_hash) = as_eszip(&dir);
    let rt = Runtime::new(RuntimeConfig {
        log_sink: Arc::new(MemoryLogSink::default()),
        ..Default::default()
    });
    let n: usize = std::env::var("RENOX_COLD_START_N")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);
    let mut tenant = 0;
    let mut formats = vec![
        ("esm-dir", dir.clone(), hash.clone()),
        ("eszip", eszip_dir.clone(), eszip_hash.clone()),
    ];
    // The first series also pays for process-wide pages touched on first
    // use: RENOX_COLD_START_ESZIP_FIRST=1 swaps the order to check RSS.
    if std::env::var_os("RENOX_COLD_START_ESZIP_FIRST").is_some() {
        formats.reverse();
    }
    for (format, dir, hash) in formats {
        for cache in [false, true] {
            code_cache().set_enabled(cache);
            // One tenant per variant: with the cache on, the warm-up isolate
            // fills it and the measured ones are re-creations of the same
            // deployment (pool members, the spare, after an eviction).
            tenant += 1;
            let tenant_id = format!("t_cold_{tenant}");
            let make = || {
                let mut s = spec(&dir, &hash, Limits::FREE);
                s.tenant_id = tenant_id.clone();
                s.max_isolates = 1;
                s
            };
            drop(rt.create_isolate(make()).await.unwrap());
            tokio::time::sleep(Duration::from_millis(100)).await;
            let mut created = Vec::with_capacity(n);
            let mut inner = Vec::with_capacity(n);
            let mut module = Vec::with_capacity(n);
            let mut kept = Vec::with_capacity(n);
            let rss_before = rss_bytes();
            for _ in 0..n {
                let t = Instant::now();
                let iso = rt.create_isolate(make()).await.unwrap();
                created.push(t.elapsed());
                let s = iso.stats().unwrap();
                inner.push(s.create_time);
                module.push(s.module_time);
                kept.push(iso);
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
            let rss_after = rss_bytes();
            let heap = kept[0].stats().unwrap().used_heap_bytes as f64 / 1048576.0;
            created.sort();
            inner.sort();
            module.sort();
            let rss = rss_after.saturating_sub(rss_before) as f64 / n as f64 / 1048576.0;
            println!(
                "[{format}, code cache {}] create_isolate p50 {:.2} ms p99 {:.2} ms; isolate thread p50 {:.2} ms p99 {:.2} ms; module eval p50 {:.2} ms; V8 heap used {heap:.2} MB; RSS delta per isolate {rss:.2} MB ({n} isolates); cache {} KB",
                if cache { "on" } else { "off" },
                ms(percentile(&created, 0.5)),
                ms(percentile(&created, 0.99)),
                ms(percentile(&inner, 0.5)),
                ms(percentile(&inner, 0.99)),
                ms(percentile(&module, 0.5)),
                code_cache().bytes() / 1024,
            );
            for iso in kept {
                iso.terminate();
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
    code_cache().set_enabled(true);
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}
