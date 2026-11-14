//! Issue #828: a hook filler hands data back with `{ result }`
//! (`docs/contracts/ops.md` 1.26.0, section 15.3). V8-linked.
//!
//! `ctx.hooks.run` collects the fillers' results as `results`, the same in
//! `shared` and `isolate` mode: the filler module `filler` runs once in the
//! app's isolate and once in an isolate of its own, and the caller sees the
//! same `results[0]`. A halt from an `isolate` filler still reaches the
//! caller with its status and body. A filler's change to `args` reaches the
//! caller in `shared` mode only (section 15.3, `args`).
#![cfg(feature = "v8")]

mod support;

use std::sync::Arc;

use renox_runtime::limits::Limits;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{IsolateHandle, Runtime, RuntimeConfig};
use support::*;

fn module(
    name: &str,
    isolation: &str,
    hooks: &[&str],
    exports: serde_json::Value,
) -> serde_json::Value {
    let perms = serde_json::json!({ "tables": format!("{name}__*"), "network": [], "secrets": [], "slots": [], "hooks": hooks });
    serde_json::json!({
        "name": name, "version": "1.0.0", "hash": "0".repeat(64), "source": format!("path:modules/{name}"),
        "mount": format!("/{name}"), "isolation": isolation, "dependencies": [], "config": {},
        "permissions": perms, "approved": perms, "exports": exports,
    })
}

/// The module that exports the hook point and runs it.
const POINT: &str = r#"
export async function ask(ctx, kind) {
  const args = { kind };
  const r = await ctx.hooks.run("point.ask", args);
  return {
    halt: r.halt,
    module: r.module ?? null,
    status: r.response?.status ?? null,
    body: r.response ? await r.response.text() : null,
    results: r.results,
    frozen: Object.isFrozen(r.results) && r.results.every((x) => Object.isFrozen(x)),
    touched: args.touched === true,
  };
}
"#;

/// The filler: hands data back, or stops the run.
const FILLER_HOOKS: &str = r#"
export const hooks = {
  "point.ask": {
    handle(ctx, args) {
      args.touched = true;
      if (args.kind === "halt") return { halt: true, response: new Response("stopped", { status: 403 }) };
      return { result: { handled: true, by: ctx.module, at: [1, "two", null] } };
    },
  },
};
"#;

const APP: &str = r#"
import { point } from "renox:modules";
export async function GET(ctx) {
  return Response.json(await point.ask(ctx.url.searchParams.get("case")));
}
"#;

fn artifact(filler_mode: &str) -> (std::path::PathBuf, String) {
    let modules = vec![
        module(
            "point",
            "shared",
            &[],
            serde_json::json!({ "services": ["ask"], "hooks": ["point.ask"] }),
        ),
        module("filler", filler_mode, &["point.ask"], serde_json::json!({})),
    ];
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "test", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": {
            "functions/f": "functions/f.js",
            "modules/point/services": "modules/point/services.js",
            "modules/filler/hooks": "modules/filler/hooks.js",
        } },
        "routes": [{ "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] },
        "modules": modules,
    });
    let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
    write_artifact(&[
        ("manifest.json", &manifest),
        ("code/functions/f.js", APP.as_bytes()),
        ("code/modules/point/services.js", POINT.as_bytes()),
        ("code/modules/filler/hooks.js", FILLER_HOOKS.as_bytes()),
    ])
}

async fn isolate(filler_mode: &str) -> (IsolateHandle, Arc<MemoryLogSink>) {
    let sink = Arc::new(MemoryLogSink::default());
    let rt = Runtime::new(RuntimeConfig {
        log_sink: sink.clone(),
        ..Default::default()
    });
    let (dir, hash) = artifact(filler_mode);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    (iso, sink)
}

async fn case(iso: &IsolateHandle, sink: &MemoryLogSink, name: &str) -> serde_json::Value {
    let out = iso
        .dispatch(
            ctx(&format!("req_hook_{name}")),
            get(&format!("/?case={name}")),
        )
        .await;
    assert_eq!(out.response.status(), 200, "{name}: {:?}", sink.lines());
    body_json(&out.response)
}

/// `run` with one filler in `mode`: `{ result }` and a halt.
async fn run_in(mode: &str) -> (serde_json::Value, serde_json::Value) {
    let (iso, sink) = isolate(mode).await;
    let result = case(&iso, &sink, "result").await;
    let halt = case(&iso, &sink, "halt").await;
    iso.terminate();
    (result, halt)
}

#[tokio::test]
async fn a_filler_result_reaches_the_caller_the_same_in_both_modes() {
    let (shared, shared_halt) = run_in("shared").await;
    let (isolated, isolated_halt) = run_in("isolate").await;
    let expected = serde_json::json!({
        "module": "filler",
        "result": { "handled": true, "by": "filler", "at": [1, "two", null] },
    });
    for (mode, v) in [("shared", &shared), ("isolate", &isolated)] {
        assert_eq!(v["halt"], false, "{mode}: {v}");
        assert_eq!(v["results"], serde_json::json!([expected]), "{mode}: {v}");
        assert_eq!(v["frozen"], true, "{mode}: {v}");
    }
    assert_eq!(shared["results"][0], isolated["results"][0]);
    // `args` are shared by reference in `shared` mode only.
    assert_eq!(shared["touched"], true, "{shared}");
    assert_eq!(isolated["touched"], false, "{isolated}");
    // A halt from the filler reaches the caller with its status and body.
    for (mode, v) in [("shared", &shared_halt), ("isolate", &isolated_halt)] {
        assert_eq!(v["halt"], true, "{mode}: {v}");
        assert_eq!(v["module"], "filler", "{mode}: {v}");
        assert_eq!(v["status"], 403, "{mode}: {v}");
        assert_eq!(v["body"], "stopped", "{mode}: {v}");
        assert_eq!(v["results"], serde_json::json!([]), "{mode}: {v}");
    }
}
