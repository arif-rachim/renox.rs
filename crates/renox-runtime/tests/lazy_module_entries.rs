//! #640 (ops.md 1.14.0 section 11, steps 4-5, section 15; `artifact.md` 1.9
//! "Entries"; ADR D32): a module's `services` and `hooks` entries marked
//! `eager: false` are evaluated once per isolate, on the first service
//! call, hook run or event that reaches the module, inside that invocation.
//! The broker routes hooks and events by the names the artifact records,
//! so an unused module is never evaluated. A module that fails its first
//! evaluation answers its caller with `RENOX_MODULE_SERVICE` and
//! `cause_code: "RENOX_MODULE_EVAL"`, logged once, while the others keep
//! answering.
#![cfg(feature = "v8")]

mod support;

use std::sync::Arc;

use renox_data::{AuthorizerPolicy, DbOptions, TenantDb};
use renox_runtime::limits::Limits;
use renox_runtime::ops::db::DbHandle;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{
    EventEnvelope, EventOutcome, IsolateHandle, RequestCtx, Runtime, RuntimeConfig,
};
use support::*;

fn runtime() -> (Runtime, Arc<MemoryLogSink>) {
    let sink = Arc::new(MemoryLogSink::default());
    let rt = Runtime::new(RuntimeConfig {
        log_sink: sink.clone(),
        ..Default::default()
    });
    (rt, sink)
}

fn module(
    name: &str,
    deps: &[&str],
    hooks: &[&str],
    exports: serde_json::Value,
) -> serde_json::Value {
    let perms = serde_json::json!({ "tables": format!("{name}__*"), "network": [], "secrets": [], "slots": [], "hooks": hooks });
    serde_json::json!({
        "name": name, "version": "1.0.0", "hash": "0".repeat(64), "source": format!("path:modules/{name}"),
        "mount": format!("/{name}"), "isolation": "shared", "dependencies": deps, "config": {},
        "permissions": perms, "approved": perms, "exports": exports,
    })
}

/// Counts each module part's evaluations in `globalThis.__evals`.
fn counted(key: &str, body: &str) -> String {
    format!(
        "globalThis.__evals = globalThis.__evals ?? {{}};\nglobalThis.__evals[{key:?}] = (globalThis.__evals[{key:?}] ?? 0) + 1;\n{body}"
    )
}

const BILLING: &str = r#"
export async function checkout(ctx) {
  globalThis.__order = [];
  const r = await ctx.hooks.run("billing.checkout", {});
  return { halt: r.halt, order: globalThis.__order };
}
export async function memory(ctx) {
  globalThis.__seen = [];
  await ctx.events.emit("billing.cart", { cart: "c1" }, { durable: false });
  return globalThis.__seen;
}
export async function paid(ctx) {
  return ctx.events.emit("billing.paid", { invoice: "i1" });
}
"#;

/// Lazy. Its top level waits on a timer, so concurrent first calls overlap.
const MAIL_SERVICES: &str = r#"
await new Promise((r) => setTimeout(r, 30));
export async function send(ctx) { return { evals: globalThis.__evals, module: ctx.module }; }
"#;

const MAIL_HOOKS: &str = r#"
export const hooks = {
  "billing.checkout": { priority: 10, async handle(ctx) { globalThis.__order.push("mail:" + ctx.module); } },
};
export const on = {
  "billing.cart": async (ctx, e) => { globalThis.__seen.push("mail:" + e.payload.cart); },
  "billing.paid": async (ctx, e) => {
    await ctx.db.execute("insert into mail__seen (event_id, attempt) values (?, ?)", [e.id, e.attempt]);
  },
};
"#;

/// Eager, priority 50: before the evaluation the lazy `mail` filler's
/// placeholder priority (100) would order it after this one.
const AAA_HOOKS: &str = r#"
export const hooks = {
  "billing.checkout": { priority: 50, async handle() { globalThis.__order.push("aaa"); } },
};
export const on = {};
"#;

const IDLE_SERVICES: &str = "export function nothing() { return 1; }\n";
const IDLE_HOOKS: &str =
    "export const hooks = {};\nexport const on = { \"billing.paid\": async () => {} };\n";

const BROKEN_SERVICES: &str = r#"
throw new Error("broken-top-level-detail");
export function x() {}
"#;

const APP: &str = r#"
import { billing, mail, broken } from "renox:modules";
const caught = async (f) => { try { return { ok: await f() }; } catch (e) { return { error: { code: e.code, name: e.name, details: e.details } }; } };
export async function GET(ctx) {
  switch (ctx.url.searchParams.get("case")) {
    case "evals": return Response.json(globalThis.__evals ?? {});
    case "send": return Response.json(await mail.send());
    case "checkout": return Response.json(await billing.checkout());
    case "memory": return Response.json(await billing.memory());
    case "paid": return Response.json({ id: await billing.paid() });
    case "broken": return Response.json(await caught(() => broken.x()));
    default: return new Response("unknown", { status: 400 });
  }
}
"#;

/// `eager_mail`: whether `mail`'s entries are eager (the `eager = true`
/// opt-out, which the build writes as no `eager: false`).
fn artifact(eager_mail: bool) -> (std::path::PathBuf, String) {
    let lazy_hooks = |hooks: &[&str], on: &[&str]| serde_json::json!({ "exports": ["hooks", "on"], "eager": false, "hooks": hooks, "on": on });
    let mail_services = if eager_mail {
        serde_json::json!({ "exports": ["send"] })
    } else {
        serde_json::json!({ "exports": ["send"], "eager": false })
    };
    let mail_hooks = if eager_mail {
        serde_json::json!({ "exports": ["hooks", "on"] })
    } else {
        lazy_hooks(&["billing.checkout"], &["billing.cart", "billing.paid"])
    };
    let modules = vec![
        module("aaa", &[], &["billing.checkout"], serde_json::json!({})),
        module(
            "billing",
            &[],
            &[],
            serde_json::json!({ "services": ["checkout", "memory", "paid"], "hooks": ["billing.checkout"],
                "events": { "billing.cart": { "type": "object" }, "billing.paid": { "type": "object" } } }),
        ),
        module("broken", &[], &[], serde_json::json!({ "services": ["x"] })),
        module(
            "idle",
            &[],
            &[],
            serde_json::json!({ "services": ["nothing"] }),
        ),
        module(
            "mail",
            &[],
            &["billing.checkout"],
            serde_json::json!({ "services": ["send"] }),
        ),
    ];
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "lazymods", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": {
            "functions/f": "functions/f.js",
            "modules/aaa/hooks": "modules/aaa/hooks.js",
            "modules/billing/services": "modules/billing/services.js",
            "modules/broken/services": "modules/broken/services.js",
            "modules/idle/services": "modules/idle/services.js",
            "modules/idle/hooks": "modules/idle/hooks.js",
            "modules/mail/services": "modules/mail/services.js",
            "modules/mail/hooks": "modules/mail/hooks.js",
        } },
        "entries": {
            "functions/f": { "exports": ["GET"] },
            "modules/aaa/hooks": { "exports": ["hooks", "on"] },
            "modules/billing/services": { "exports": ["checkout", "memory", "paid"], "eager": false },
            "modules/broken/services": { "exports": ["x"], "eager": false },
            "modules/idle/services": { "exports": ["nothing"], "eager": false },
            "modules/idle/hooks": lazy_hooks(&[], &["billing.paid"]),
            "modules/mail/services": mail_services,
            "modules/mail/hooks": mail_hooks,
        },
        "routes": [{ "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] },
        "modules": modules,
    });
    let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
    let files = [
        (
            "code/modules/billing/services.js",
            counted("billing/services", BILLING),
        ),
        ("code/modules/aaa/hooks.js", counted("aaa/hooks", AAA_HOOKS)),
        (
            "code/modules/broken/services.js",
            counted("broken/services", BROKEN_SERVICES),
        ),
        (
            "code/modules/idle/services.js",
            counted("idle/services", IDLE_SERVICES),
        ),
        (
            "code/modules/idle/hooks.js",
            counted("idle/hooks", IDLE_HOOKS),
        ),
        (
            "code/modules/mail/services.js",
            counted("mail/services", MAIL_SERVICES),
        ),
        (
            "code/modules/mail/hooks.js",
            counted("mail/hooks", MAIL_HOOKS),
        ),
    ];
    let mut refs: Vec<(&str, &[u8])> = vec![
        ("manifest.json", &manifest),
        ("code/functions/f.js", APP.as_bytes()),
    ];
    for (p, src) in &files {
        refs.push((p, src.as_bytes()));
    }
    write_artifact(&refs)
}

struct Fixture {
    iso: IsolateHandle,
    sink: Arc<MemoryLogSink>,
    db: DbHandle,
    _rt: Runtime,
}

async fn fixture(eager_mail: bool) -> Fixture {
    let (rt, sink) = runtime();
    let (dir, hash) = artifact(eager_mail);
    let file = scratch("lazy-modules-db").join("t.db");
    let db = TenantDb::open(&file, DbOptions::default()).unwrap();
    db.execute(
        "create table mail__seen (event_id text, attempt integer)",
        &[],
    )
    .unwrap();
    let db = DbHandle::spawn(db.with_authorizer(AuthorizerPolicy::module("app")).unwrap()).unwrap();
    let mut s = spec(&dir, &hash, Limits::PAID);
    s.db = Some(db.clone());
    s.max_isolates = 1;
    let iso = rt.create_isolate(s).await.unwrap();
    Fixture {
        iso,
        sink,
        db,
        _rt: rt,
    }
}

async fn case(f: &Fixture, name: &str, n: u32) -> serde_json::Value {
    let out = f
        .iso
        .dispatch(
            ctx(&format!("req_lazymod_{name}_{n}")),
            get(&format!("/?case={name}")),
        )
        .await;
    assert_eq!(out.response.status(), 200, "{name}: {:?}", f.sink.lines());
    body_json(&out.response)
}

/// A module no invocation reaches is never evaluated; the eager one is.
#[tokio::test]
async fn an_unused_module_is_not_evaluated() {
    let f = fixture(false).await;
    let evals = case(&f, "evals", 0).await;
    assert_eq!(
        evals,
        serde_json::json!({ "aaa/hooks": 1 }),
        "only the eager entry ran"
    );
    // A call into billing evaluates billing's services only, not mail or idle.
    case(&f, "paid", 1).await;
    let evals = case(&f, "evals", 2).await;
    assert_eq!(
        evals,
        serde_json::json!({ "aaa/hooks": 1, "billing/services": 1 })
    );
}

/// The first service call evaluates the entry once, inside the call (the
/// callee's ctx); concurrent first calls wait for that one evaluation, and
/// the `hooks` entry of the same module is not evaluated with it.
#[tokio::test]
async fn the_first_service_call_evaluates_once_and_concurrent_calls_wait() {
    let f = fixture(false).await;
    let a = f
        .iso
        .dispatch(ctx("req_lazymod_send_a"), get("/?case=send"));
    let b = f
        .iso
        .dispatch(ctx("req_lazymod_send_b"), get("/?case=send"));
    let (a, b) = tokio::join!(a, b);
    for out in [&a, &b] {
        assert_eq!(out.response.status(), 200, "{:?}", f.sink.lines());
        let v = body_json(&out.response);
        assert_eq!(v["module"], "mail");
        assert_eq!(v["evals"]["mail/services"], 1, "{v}");
        assert!(v["evals"].get("mail/hooks").is_none(), "{v}");
    }
    let v = case(&f, "send", 3).await;
    assert_eq!(v["evals"]["mail/services"], 1, "{v}");
}

/// A hook run evaluates its lazy fillers first and orders them by their
/// evaluated priority; an in-memory event reaches a lazy handler.
#[tokio::test]
async fn a_hook_and_an_in_memory_event_reach_a_lazy_module() {
    let f = fixture(false).await;
    let v = case(&f, "checkout", 1).await;
    assert_eq!(v["order"], serde_json::json!(["mail:mail", "aaa"]), "{v}");
    let v = case(&f, "checkout", 2).await;
    assert_eq!(v["order"], serde_json::json!(["mail:mail", "aaa"]), "{v}");
    let v = case(&f, "memory", 3).await;
    assert_eq!(v, serde_json::json!(["mail:c1"]));
    let evals = case(&f, "evals", 4).await;
    assert_eq!(evals["mail/hooks"], 1, "{evals}");
    assert!(
        evals.get("idle/hooks").is_none(),
        "idle does not handle billing.cart: {evals}"
    );
}

/// A durable event's delivery to a lazy module evaluates it inside the
/// attempt; the cell learns the handlers from the recorded names.
#[tokio::test]
async fn a_durable_event_reaches_a_lazy_module() {
    let f = fixture(false).await;
    let mut handlers = f.iso.event_handlers("billing.paid");
    handlers.sort();
    assert_eq!(handlers, ["idle", "mail"]);
    assert!(
        f.iso
            .event_handlers("billing.cart")
            .contains(&"mail".to_string())
    );
    let id = case(&f, "paid", 1).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    f.db.call({
        let id = id.clone();
        move |db| renox_data::outbox::fan_out(db, &id, &["mail".to_string()], 0).unwrap()
    })
    .await
    .unwrap();
    let ev = EventEnvelope {
        id: id.clone(),
        name: "billing.paid".into(),
        payload_json: r#"{"invoice":"i1"}"#.into(),
        attempt: 1,
        module: "mail".into(),
        job: None,
    };
    let c = RequestCtx {
        request_id: ev.request_id(),
        ..ctx("unused")
    };
    let out = f.iso.deliver_event(c, ev).await;
    assert_eq!(out.outcome, EventOutcome::Ok, "{:?}", f.sink.lines());
    let evals = case(&f, "evals", 2).await;
    assert_eq!(evals["mail/hooks"], 1, "{evals}");
    assert!(evals.get("mail/services").is_none(), "{evals}");
    let rows =
        f.db.call(|db| {
            db.with_policy(None, || {
                db.query("select event_id from mail__seen", &[]).unwrap()
            })
            .unwrap()
            .len()
        })
        .await
        .unwrap();
    assert_eq!(rows, 1);
}

/// `eager = true` (no `eager: false` in the artifact): evaluated at creation.
#[tokio::test]
async fn an_eager_module_is_evaluated_at_creation() {
    let f = fixture(true).await;
    let evals = case(&f, "evals", 0).await;
    assert_eq!(evals["mail/services"], 1, "{evals}");
    assert_eq!(evals["mail/hooks"], 1, "{evals}");
    assert!(evals.get("billing/services").is_none(), "{evals}");
}

/// A lazy module that throws at its first evaluation: the caller gets
/// RENOX_MODULE_SERVICE with cause_code RENOX_MODULE_EVAL, logged once and
/// cached; other modules keep answering. The thrown detail stays out of
/// the caller's error.
#[tokio::test]
async fn a_throwing_lazy_module_fails_its_callers_only() {
    let f = fixture(false).await;
    for n in 0..2 {
        let v = case(&f, "broken", n).await;
        assert_eq!(v["error"]["code"], "RENOX_MODULE_SERVICE", "{v}");
        assert_eq!(
            v["error"]["details"]["cause_code"], "RENOX_MODULE_EVAL",
            "{v}"
        );
        assert_eq!(v["error"]["details"]["module"], "broken", "{v}");
        assert!(!v.to_string().contains("broken-top-level-detail"), "{v}");
    }
    let logged: Vec<_> = f
        .sink
        .lines()
        .into_iter()
        .filter(|l| l.fields.get("code").and_then(|c| c.as_str()) == Some("RENOX_MODULE_EVAL"))
        .collect();
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert_eq!(logged[0].fields["entry"], "services");
    let evals = case(&f, "evals", 3).await;
    assert_eq!(
        evals["broken/services"], 1,
        "evaluated once, the failure cached: {evals}"
    );
    let v = case(&f, "send", 4).await;
    assert_eq!(v["module"], "mail");
}

/// #157's V8 code cache serves lazy module entries: the third isolate of a
/// deployment compiles the lazy `services` entry from the cache the second
/// one stored (this test binary's only cache user is this test).
#[tokio::test]
async fn the_code_cache_serves_lazy_module_entries() {
    use renox_runtime::loader::code_cache;
    code_cache().set_enabled(true);
    let (rt, _) = runtime();
    let mut src = String::new();
    for i in 0..200 {
        src.push_str(&format!(
            "const v{i} = (function () {{ return {i} * 7; }})();\n"
        ));
    }
    src.push_str("export function last() { return v199; }\n");
    let app = r#"
        import { big } from "renox:modules";
        export async function GET() { return Response.json({ last: await big.last() }); }
    "#;
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "cached", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": {
            "functions/f": "functions/f.js",
            "modules/big/services": "modules/big/services.js",
        } },
        "entries": {
            "functions/f": { "exports": ["GET"] },
            "modules/big/services": { "exports": ["last"], "eager": false },
        },
        "routes": [{ "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] },
        "modules": [module("big", &[], &[], serde_json::json!({ "services": ["last"] }))],
    });
    let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
    let (dir, hash) = write_artifact(&[
        ("manifest.json", &manifest),
        ("code/functions/f.js", app.as_bytes()),
        ("code/modules/big/services.js", src.as_bytes()),
    ]);
    let scope = format!("t_test/{hash}");
    let mut stored_before = 0;
    let mut stored = false;
    for n in 0..3 {
        let mut s = spec(&dir, &hash, Limits::FREE);
        s.max_isolates = 1;
        let iso = rt.create_isolate(s).await.unwrap();
        if n == 1 {
            stored_before = code_cache().entries_for(&scope);
        }
        let hits = code_cache().hits();
        let out = iso.dispatch(ctx("req_lazymod_cache_1"), get("/")).await;
        assert_eq!(body_json(&out.response)["last"], 199 * 7);
        if n == 1 {
            for _ in 0..200 {
                if code_cache().entries_for(&scope) > stored_before {
                    stored = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        }
        if n == 2 {
            assert!(
                code_cache().hits() > hits,
                "the lazy module entry was not served from the cache"
            );
        }
        iso.terminate();
    }
    assert!(
        stored,
        "the second isolate stored no code for the lazy module entry"
    );
    code_cache().forget(&scope);
}
