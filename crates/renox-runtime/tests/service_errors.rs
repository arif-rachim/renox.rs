//! Issue #769: a module's declared error codes and details reach a caller in
//! another module (`docs/contracts/ops.md` section 15.2, "Errors";
//! `manifest.md` `[exports.errors]`, MF18). V8-linked.
//!
//! Module `b` declares `STEP_UP_REQUIRED`, `BIG`, `LEAKY` and `CYCLE` in
//! `exports.errors`; module `a` calls it and reports what it caught, and so
//! does the app. A declared code crosses as `details.cause_code` with its
//! details as `cause_details`; an undeclared code does not (message only);
//! details over 2 KiB, or not JSON, are dropped with
//! `cause_details_truncated`; a secret-named key is removed at every depth;
//! a `RENOX_*` code keeps today's rule. In `shared` mode the bootstrap's
//! broker applies the rule; in `isolate` mode the host applies it again on
//! the trusted side before the caller's error is built.
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
    deps: &[&str],
    exports: serde_json::Value,
) -> serde_json::Value {
    let perms = serde_json::json!({ "tables": format!("{name}__*"), "network": [], "secrets": [], "slots": [], "hooks": [] });
    serde_json::json!({
        "name": name, "version": "1.0.0", "hash": "0".repeat(64), "source": format!("path:modules/{name}"),
        "mount": format!("/{name}"), "isolation": isolation, "dependencies": deps, "config": {},
        "permissions": perms, "approved": perms, "exports": exports,
    })
}

/// The callee: each case throws an error with a `code` and `details`.
const B: &str = r#"
const fail = (code, details, message = `b says ${code}`) => Object.assign(new Error(message), { code, details });
export async function fails(ctx, which) {
  switch (which) {
    case "declared": throw fail("STEP_UP_REQUIRED", { verify_url: "/2fa/verify?next=%2Fa|b", n: 1, nested: { ok: [1, "two"] } });
    case "undeclared": throw fail("NOT_DECLARED", { verify_url: "/x" });
    case "big": throw fail("BIG", { blob: "x".repeat(3000) });
    case "leaky": throw fail("LEAKY", {
      keep: "ok",
      apiKey: "k1",
      Authorization: "Bearer t1",
      nested: { session_TOKEN: "t2", deeper: [{ password: "p1", v: 1 }], fine: true },
      clientSecret: { all: "gone" },
      fn: () => 1,
    });
    case "cycle": { const d = { a: 1 }; d.self = d; throw fail("CYCLE", d); }
    case "none": throw fail("STEP_UP_REQUIRED", undefined);
    case "renox": throw fail("RENOX_FORBIDDEN", { reason: "x" });
    default: throw new Error("plain");
  }
}
"#;

const REPORT: &str = r#"
const report = (e) => ({
  code: e.code,
  cause_code: e.details?.cause_code ?? null,
  has_details: e.details !== undefined && "cause_details" in e.details,
  cause_details: e.details?.cause_details ?? null,
  truncated: e.details?.cause_details_truncated ?? null,
  module: e.details?.module ?? null,
  service: e.details?.service ?? null,
});
"#;

fn module_a() -> String {
    format!(
        r#"
import {{ b }} from "renox:modules";
{REPORT}
export async function call(ctx, which) {{
  try {{ await b.fails(which); return {{ returned: true }}; }} catch (e) {{ return report(e); }}
}}
"#
    )
}

fn app() -> String {
    format!(
        r#"
import {{ a, b }} from "renox:modules";
{REPORT}
export async function GET(ctx) {{
  const which = ctx.url.searchParams.get("case");
  const viaModule = await a.call(which);
  let direct;
  try {{ await b.fails(which); direct = {{ returned: true }}; }} catch (e) {{ direct = report(e); }}
  return Response.json({{ viaModule, direct }});
}}
"#
    )
}

fn artifact(modes: [&str; 2]) -> (std::path::PathBuf, String) {
    let [ma, mb] = modes;
    let modules = vec![
        module(
            "b",
            mb,
            &[],
            serde_json::json!({ "services": ["fails"], "errors": ["STEP_UP_REQUIRED", "BIG", "LEAKY", "CYCLE"] }),
        ),
        module("a", ma, &["b"], serde_json::json!({ "services": ["call"] })),
    ];
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "test", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": {
            "functions/f": "functions/f.js",
            "modules/a/services": "modules/a/services.js",
            "modules/b/services": "modules/b/services.js",
        } },
        "routes": [{ "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] },
        "modules": modules,
    });
    let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
    let a = module_a();
    let app = app();
    write_artifact(&[
        ("manifest.json", &manifest),
        ("code/functions/f.js", app.as_bytes()),
        ("code/modules/a/services.js", a.as_bytes()),
        ("code/modules/b/services.js", B.as_bytes()),
    ])
}

async fn isolate(modes: [&str; 2]) -> (IsolateHandle, Arc<MemoryLogSink>) {
    let sink = Arc::new(MemoryLogSink::default());
    let rt = Runtime::new(RuntimeConfig {
        log_sink: sink.clone(),
        ..Default::default()
    });
    let (dir, hash) = artifact(modes);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    (iso, sink)
}

/// The caller module's and the app's view of `b.fails(name)`; both must agree.
async fn case(iso: &IsolateHandle, sink: &MemoryLogSink, name: &str) -> serde_json::Value {
    let out = iso
        .dispatch(
            ctx(&format!("req_errors_{name}")),
            get(&format!("/?case={name}")),
        )
        .await;
    assert_eq!(out.response.status(), 200, "{name}: {:?}", sink.lines());
    let v = body_json(&out.response);
    assert_eq!(
        v["viaModule"], v["direct"],
        "{name}: the module and the app see the same: {v}"
    );
    let v = v["viaModule"].clone();
    assert_eq!(v["code"], "RENOX_MODULE_SERVICE", "{name}: {v}");
    assert_eq!(v["module"], "b", "{name}: {v}");
    assert_eq!(v["service"], "fails", "{name}: {v}");
    v
}

async fn declared_codes_cross(modes: [&str; 2]) {
    let (iso, sink) = isolate(modes).await;

    // A declared code crosses with its details, JSON only (a `|` survives).
    let v = case(&iso, &sink, "declared").await;
    assert_eq!(v["cause_code"], "STEP_UP_REQUIRED", "{modes:?}: {v}");
    assert_eq!(
        v["cause_details"],
        serde_json::json!({ "verify_url": "/2fa/verify?next=%2Fa|b", "n": 1, "nested": { "ok": [1, "two"] } }),
        "{modes:?}: {v}"
    );
    assert_eq!(v["truncated"], serde_json::Value::Null, "{modes:?}: {v}");

    // An undeclared code behaves as before: no cause, no details.
    let v = case(&iso, &sink, "undeclared").await;
    assert_eq!(v["cause_code"], serde_json::Value::Null, "{modes:?}: {v}");
    assert_eq!(v["has_details"], false, "{modes:?}: {v}");

    // Over 2 KiB: the code crosses, the details are dropped and marked.
    let v = case(&iso, &sink, "big").await;
    assert_eq!(v["cause_code"], "BIG", "{modes:?}: {v}");
    assert_eq!(v["has_details"], false, "{modes:?}: {v}");
    assert_eq!(v["truncated"], true, "{modes:?}: {v}");

    // Secret-named keys are removed at every depth; a function is not JSON.
    let v = case(&iso, &sink, "leaky").await;
    assert_eq!(v["cause_code"], "LEAKY", "{modes:?}: {v}");
    assert_eq!(
        v["cause_details"],
        serde_json::json!({ "keep": "ok", "nested": { "deeper": [{ "v": 1 }], "fine": true } }),
        "{modes:?}: {v}"
    );
    let text = v.to_string();
    for leaked in ["k1", "t1", "t2", "p1", "gone"] {
        assert!(!text.contains(leaked), "{modes:?}: {leaked} crossed: {v}");
    }

    // Details that are not JSON (a cycle): dropped and marked.
    let v = case(&iso, &sink, "cycle").await;
    assert_eq!(v["cause_code"], "CYCLE", "{modes:?}: {v}");
    assert_eq!(v["has_details"], false, "{modes:?}: {v}");
    assert_eq!(v["truncated"], true, "{modes:?}: {v}");

    // A declared code without details: the code alone.
    let v = case(&iso, &sink, "none").await;
    assert_eq!(v["cause_code"], "STEP_UP_REQUIRED", "{modes:?}: {v}");
    assert_eq!(v["has_details"], false, "{modes:?}: {v}");
    assert_eq!(v["truncated"], serde_json::Value::Null, "{modes:?}: {v}");

    // A RENOX_* code keeps today's rule: the code, never the details.
    let v = case(&iso, &sink, "renox").await;
    assert_eq!(v["cause_code"], "RENOX_FORBIDDEN", "{modes:?}: {v}");
    assert_eq!(v["has_details"], false, "{modes:?}: {v}");

    // No code at all: null, as before.
    let v = case(&iso, &sink, "plain").await;
    assert_eq!(v["cause_code"], serde_json::Value::Null, "{modes:?}: {v}");
    assert_eq!(v["has_details"], false, "{modes:?}: {v}");

    // The secrets never reached the log either (the callee's line is its
    // own error description, which never carries details).
    let lines = format!("{:?}", sink.lines());
    for leaked in ["k1", "t1", "t2", "p1"] {
        assert!(!lines.contains(leaked), "{modes:?}: {leaked} in the log");
    }
}

#[tokio::test]
async fn shared_mode_declared_errors() {
    declared_codes_cross(["shared", "shared"]).await;
}

/// The callee in its own isolate: the host checks the code against the
/// artifact and filters the details again before the caller's error.
#[tokio::test]
async fn isolate_mode_declared_errors() {
    declared_codes_cross(["shared", "isolate"]).await;
}

#[tokio::test]
async fn all_isolate_mode_declared_errors() {
    declared_codes_cross(["isolate", "isolate"]).await;
}
