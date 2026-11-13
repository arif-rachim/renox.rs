//! Issue #763: a module service gets its caller as `ctx.caller`
//! (`docs/contracts/ops.md` section 15.2, "Caller"). V8-linked.
//!
//! The broker sets it from the caller's identity before the callee runs, in
//! `shared` and `isolate` mode: the app's code gives `"app"`, module A's
//! call into B gives B `"a"`, and a nested call A -> B -> C gives C `"b"`.
//! A callee cannot assign or redefine it, and trying does not change what
//! the next callee sees. A module's own entry point (here an in-memory
//! event handler) sees its own name; the app's own handler `undefined`.
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

const A: &str = r#"
import { b, c } from "renox:modules";
export async function toB(ctx) { return b.who(); }
export async function nested(ctx) { return { mine: ctx.caller, b: await b.viaC(), after: ctx.caller }; }
export async function tamperThenC(ctx) { const t = await b.tamper(); return { t, c: await c.who(), mine: ctx.caller }; }
export async function ping(ctx) { await ctx.events.emit("a.ping", {}, { durable: false }); return globalThis.__seen ?? null; }
"#;

const B: &str = r#"
import { c } from "renox:modules";
export async function who(ctx) { return { caller: ctx.caller, module: ctx.module }; }
export async function viaC(ctx) { const before = ctx.caller; const inner = await c.who(); return { before, c: inner, after: ctx.caller }; }
export async function tamper(ctx) {
  const t = {};
  try { ctx.caller = "app"; t.assign = "allowed"; } catch (e) { t.assign = e.name; }
  try { Object.defineProperty(ctx, "caller", { value: "app" }); t.define = "allowed"; } catch (e) { t.define = e.name; }
  try { t.deleted = delete ctx.caller; } catch (e) { t.deleted = e.name; }
  t.still = ctx.caller;
  t.c = await c.who();
  return t;
}
"#;

const C: &str = r#"
export async function who(ctx) { return { caller: ctx.caller, module: ctx.module }; }
"#;

/// An in-memory handler of `c` (shared mode only: it records in a global of the app's isolate).
const C_HOOKS: &str = r#"
export const on = {
  "a.ping": (ctx) => { globalThis.__seen = { caller: ctx.caller, module: ctx.module }; },
};
"#;

const APP: &str = r#"
import { a, b, c } from "renox:modules";
export async function GET(ctx) {
  const which = ctx.url.searchParams.get("case");
  switch (which) {
    case "app": return Response.json({ own: ctx.caller === undefined ? "undefined" : ctx.caller, c: await c.who(), b: await b.who() });
    case "ab": return Response.json(await a.toB());
    case "nested": return Response.json(await a.nested());
    case "tamper": return Response.json({ a: await a.tamperThenC(), c: await c.who() });
    case "event": return Response.json(await a.ping());
    default: return new Response("unknown", { status: 400 });
  }
}
"#;

/// Modules `a` -> `b` -> `c` (and `a` -> `c`) with the given isolation modes.
fn artifact(modes: [&str; 3], with_event: bool) -> (std::path::PathBuf, String) {
    let [ma, mb, mc] = modes;
    let c_exports = serde_json::json!({ "services": ["who"] });
    let mut a_exports = serde_json::json!({ "services": ["toB", "nested", "tamperThenC", "ping"] });
    if with_event {
        a_exports["events"] = serde_json::json!({ "a.ping": { "type": "object" } });
    }
    // Dependencies first (the manifest's order).
    let modules = vec![
        module("c", mc, &[], c_exports),
        module(
            "b",
            mb,
            &["c"],
            serde_json::json!({ "services": ["who", "viaC", "tamper"] }),
        ),
        module("a", ma, &["b", "c"], a_exports),
    ];
    let mut entry = serde_json::json!({
        "functions/f": "functions/f.js",
        "modules/a/services": "modules/a/services.js",
        "modules/b/services": "modules/b/services.js",
        "modules/c/services": "modules/c/services.js",
    });
    if with_event {
        entry["modules/c/hooks"] = serde_json::json!("modules/c/hooks.js");
    }
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "test", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": entry },
        "routes": [{ "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] },
        "modules": modules,
    });
    let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
    let mut files: Vec<(&str, &[u8])> = vec![
        ("manifest.json", &manifest),
        ("code/functions/f.js", APP.as_bytes()),
        ("code/modules/a/services.js", A.as_bytes()),
        ("code/modules/b/services.js", B.as_bytes()),
        ("code/modules/c/services.js", C.as_bytes()),
    ];
    if with_event {
        files.push(("code/modules/c/hooks.js", C_HOOKS.as_bytes()));
    }
    write_artifact(&files)
}

async fn isolate(modes: [&str; 3], with_event: bool) -> (IsolateHandle, Arc<MemoryLogSink>) {
    let sink = Arc::new(MemoryLogSink::default());
    let rt = Runtime::new(RuntimeConfig {
        log_sink: sink.clone(),
        ..Default::default()
    });
    let (dir, hash) = artifact(modes, with_event);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    (iso, sink)
}

async fn case(iso: &IsolateHandle, sink: &MemoryLogSink, name: &str) -> serde_json::Value {
    let out = iso
        .dispatch(
            ctx(&format!("req_caller_{name}")),
            get(&format!("/?case={name}")),
        )
        .await;
    assert_eq!(out.response.status(), 200, "{name}: {:?}", sink.lines());
    body_json(&out.response)
}

/// The four cases of the issue, for one combination of isolation modes.
async fn callers_are_set_by_the_broker(modes: [&str; 3]) {
    let (iso, sink) = isolate(modes, false).await;

    // app -> module gives "app"; the app's own handler sees undefined.
    let v = case(&iso, &sink, "app").await;
    assert_eq!(v["own"], "undefined", "{modes:?}: {v}");
    assert_eq!(
        v["c"],
        serde_json::json!({ "caller": "app", "module": "c" }),
        "{modes:?}: {v}"
    );
    assert_eq!(v["b"]["caller"], "app", "{modes:?}: {v}");

    // module a -> module b gives "a".
    let v = case(&iso, &sink, "ab").await;
    assert_eq!(
        v,
        serde_json::json!({ "caller": "a", "module": "b" }),
        "{modes:?}"
    );

    // a -> b -> c: c sees "b", b sees "a" before and after its own call,
    // and a still sees the app.
    let v = case(&iso, &sink, "nested").await;
    assert_eq!(v["mine"], "app", "{modes:?}: {v}");
    assert_eq!(v["after"], "app", "{modes:?}: {v}");
    assert_eq!(v["b"]["before"], "a", "{modes:?}: {v}");
    assert_eq!(v["b"]["after"], "a", "{modes:?}: {v}");
    assert_eq!(
        v["b"]["c"],
        serde_json::json!({ "caller": "b", "module": "c" }),
        "{modes:?}: {v}"
    );

    // A callee that assigns, redefines or deletes ctx.caller fails and
    // changes nothing: its own next callee sees "b", a's next callee "a",
    // the app's next callee "app".
    let v = case(&iso, &sink, "tamper").await;
    let t = &v["a"]["t"];
    assert_eq!(t["assign"], "TypeError", "{modes:?}: {v}");
    assert_eq!(t["define"], "TypeError", "{modes:?}: {v}");
    assert_eq!(t["deleted"], "TypeError", "{modes:?}: {v}");
    assert_eq!(t["still"], "a", "{modes:?}: {v}");
    assert_eq!(t["c"]["caller"], "b", "{modes:?}: {v}");
    assert_eq!(v["a"]["c"]["caller"], "a", "{modes:?}: {v}");
    assert_eq!(v["a"]["mine"], "app", "{modes:?}: {v}");
    assert_eq!(v["c"]["caller"], "app", "{modes:?}: {v}");
}

#[tokio::test]
async fn shared_mode_callers() {
    callers_are_set_by_the_broker(["shared", "shared", "shared"]).await;
}

#[tokio::test]
async fn isolate_mode_callers() {
    callers_are_set_by_the_broker(["isolate", "isolate", "isolate"]).await;
}

/// `a` in the app's isolate, `b` in its own, `c` back in the app's: the
/// caller crosses both ways.
#[tokio::test]
async fn mixed_mode_callers() {
    callers_are_set_by_the_broker(["shared", "isolate", "shared"]).await;
}

/// A module's own entry point (an in-memory event handler of `c`, run
/// while `a`'s service emits) sees its own name, not the emitter's caller.
#[tokio::test]
async fn a_modules_own_event_handler_sees_its_own_name() {
    let (iso, sink) = isolate(["shared", "shared", "shared"], true).await;
    let v = case(&iso, &sink, "event").await;
    assert_eq!(
        v,
        serde_json::json!({ "caller": "c", "module": "c" }),
        "{:?}",
        sink.lines()
    );
}
