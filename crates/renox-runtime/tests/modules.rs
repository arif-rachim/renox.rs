//! Issue #230: module contexts in `shared` mode and the broker
//! (`docs/contracts/ops.md` 1.3.0, section 15). V8-linked.
//!
//! Proves the `docs/24-threat-model.md` rows "Module calling a service or
//! hook it did not declare" (`undeclared_service_call_and_hook_run_are_refused`,
//! `undeclared_filler_fails_the_deployment`) and "Module reading secrets it
//! did not declare" (`each_module_gets_its_own_secrets_tables_and_hosts`),
//! and the `docs/23-failure-modes.md` row "Module service throws"
//! (`callee_throw_rolls_back_the_callers_transaction`).
#![cfg(feature = "v8")]

mod support;

use std::collections::BTreeMap;
use std::sync::Arc;

use renox_data::{AuthorizerPolicy, DbOptions, TenantDb};
use renox_runtime::limits::Limits;
use renox_runtime::ops::db::DbHandle;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{IsolateHandle, Runtime, RuntimeConfig};
use support::*;

fn runtime() -> (Runtime, Arc<MemoryLogSink>) {
    let sink = Arc::new(MemoryLogSink::default());
    let rt = Runtime::new(RuntimeConfig {
        log_sink: sink.clone(),
        ..Default::default()
    });
    (rt, sink)
}

/// One module entry of the artifact's `modules` (`artifact.md` section 3).
fn module(
    name: &str,
    deps: &[&str],
    network: &[&str],
    secrets: &[&str],
    hooks: &[&str],
    exports: serde_json::Value,
) -> serde_json::Value {
    let perms = serde_json::json!({ "tables": format!("{name}__*"), "network": network, "secrets": secrets, "slots": [], "hooks": hooks });
    serde_json::json!({
        "name": name, "version": "1.0.0", "hash": "0".repeat(64), "source": format!("path:modules/{name}"),
        "mount": format!("/{name}"), "isolation": "shared", "dependencies": deps, "config": { "greeting": format!("hi from {name}") },
        "permissions": perms, "approved": perms, "exports": exports,
    })
}

const AUTH: &str = r#"
let calls = 0; // module globals live across requests (docs/10-modules.md, rule 4)
export async function register(ctx, email) {
  await ctx.db.execute("insert into auth__users (email) values (?)", [email]);
  return { module: ctx.module, calls: ++calls };
}
export async function fail(ctx) {
  const e = new Error("auth broke");
  e.code = "RENOX_DB_CONSTRAINT";
  throw e;
}
const caught = async (f) => { try { return await f(); } catch (e) { return { error: { code: e.code, details: e.details } }; } };
export async function callBilling(ctx) {
  return caught(() => ctx.services.billing.charge("x"));
}
export async function login(ctx, id) {
  return ctx.hooks.run("auth.after_login", { user_id: id });
}
export async function runForeignHook(ctx) {
  return caught(() => ctx.hooks.run("billing.before_charge", {}));
}
export async function info(ctx) {
  return { module: ctx.module, config: ctx.config, secrets: Object.keys(ctx.secrets), frozen: Object.isFrozen(ctx) };
}
"#;

const BILLING: &str = r#"
import { auth } from "renox:modules";
export async function charge(ctx, email) {
  return ctx.db.transaction(async (tx) => {
    await tx.execute("insert into billing__invoices (email) values (?)", [email]);
    const reg = await auth.register(email);
    const seen = await tx.query("select email from auth__public_users_v1 where email = ?", [email]);
    return { reg, seen: seen.length };
  });
}
const caught = async (f) => { try { return await f(); } catch (e) { return { error: { code: e.code, details: e.details } }; } };
export async function readAuthTable(ctx) {
  return caught(() => ctx.db.query("select * from auth__users"));
}
export async function fetchAppHost(ctx) {
  return caught(() => ctx.fetch("https://only-app.example.com/"));
}
export async function info(ctx) {
  return { module: ctx.module, secrets: Object.keys(ctx.secrets), key: ctx.secrets.BILLING_KEY };
}
"#;

const BILLING_HOOKS: &str = r#"
export const hooks = {
  "auth.after_login": { priority: 200, handle(ctx, args) { globalThis.__order.push("billing:" + ctx.module); return { halt: true, response: new Response("2fa", { status: 303 }) }; } },
};
"#;

const AUDIT_HOOKS: &str = r#"
globalThis.__order = [];
export const hooks = {
  "auth.after_login": { priority: 10, handle(ctx, args) { globalThis.__order.push("audit:" + args.user_id); } },
};
"#;

const ORG_HOOKS: &str = r#"
export const hooks = {
  "auth.after_login": { priority: 300, handle() { globalThis.__order.push("org"); } },
};
"#;

const APP: &str = r#"
import { auth, billing } from "renox:modules";
const err = (e) => ({ name: e.name, code: e.code, details: e.details, module: e.module, service: e.service, message: e.message });
const attempt = async (f) => { try { return { ok: await f() }; } catch (e) { return { error: err(e) }; } };
export async function GET(ctx) {
  const which = ctx.url.searchParams.get("case");
  switch (which) {
    case "isolation":
      return Response.json({
        auth: await auth.info(),
        billing: await billing.info(),
        app: { module: ctx.module, secrets: Object.keys(ctx.secrets), config: ctx.config },
        foreignTable: await billing.readAuthTable(),
        foreignHost: await billing.fetchAppHost(),
      });
    case "undeclared":
      return Response.json({
        service: await auth.callBilling(),
        hook: await auth.runForeignHook(),
        app: await attempt(() => ctx.hooks.run("auth.after_login", {})),
      });
    case "transaction": {
      const r = await billing.charge("a@example.com");
      const rows = await ctx.db.query("select count(*) as n from auth__public_users_v1");
      return Response.json({ r, users: rows[0].n });
    }
    case "rollback": {
      let caught = null;
      const outcome = await attempt(() => ctx.db.transaction(async (tx) => {
        await tx.execute("insert into app__items (name) values ('kept?')");
        try { await auth.fail(); } catch (e) { caught = err(e); }
        return "answered";
      }));
      const left = await ctx.db.query("select count(*) as n from app__items");
      return Response.json({ caught, outcome, items: left[0].n });
    }
    case "hooks": {
      const r = await auth.login("u1");
      return Response.json({ halt: r.halt, module: r.module, status: r.response?.status, order: globalThis.__order });
    }
    case "globals":
      return Response.json(await auth.register("g" + Math.random() + "@example.com"));
    default:
      return new Response("unknown", { status: 400 });
  }
}
"#;

fn artifact(
    extra_modules: Vec<serde_json::Value>,
    extra_files: &[(&str, &str)],
) -> (std::path::PathBuf, String) {
    let mut modules = vec![
        module(
            "auth",
            &[],
            &[],
            &["AUTH_SECRET"],
            &[],
            serde_json::json!({ "services": ["register", "fail", "callBilling", "login", "runForeignHook", "info"], "hooks": ["auth.after_login"], "views": ["auth__public_users_v1"] }),
        ),
        module(
            "billing",
            &["auth"],
            &["api.billing.example.com"],
            &["BILLING_KEY"],
            &["auth.after_login"],
            serde_json::json!({ "services": ["charge", "readAuthTable", "fetchAppHost", "info"], "hooks": ["billing.before_charge"] }),
        ),
        module(
            "audit",
            &[],
            &[],
            &[],
            &["auth.after_login"],
            serde_json::json!({}),
        ),
        module(
            "org",
            &["auth"],
            &[],
            &[],
            &["auth.after_login"],
            serde_json::json!({}),
        ),
    ];
    modules.extend(extra_modules);
    let mut entry = serde_json::json!({
        "functions/f": "functions/f.js",
        "modules/auth/services": "modules/auth/services.js",
        "modules/billing/services": "modules/billing/services.js",
        "modules/billing/hooks": "modules/billing/hooks.js",
        "modules/audit/hooks": "modules/audit/hooks.js",
        "modules/org/hooks": "modules/org/hooks.js",
    });
    for (path, _) in extra_files {
        let id = path.trim_start_matches("code/").trim_end_matches(".js");
        entry[id] = serde_json::Value::String(path.trim_start_matches("code/").to_string());
    }
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "test", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": entry },
        "routes": [{ "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" }],
        "permissions": { "network": ["only-app.example.com"], "secrets": ["APP_SECRET"] },
        "modules": modules,
    });
    let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
    let mut files: Vec<(&str, &[u8])> = vec![
        ("manifest.json", &manifest),
        ("code/functions/f.js", APP.as_bytes()),
        ("code/modules/auth/services.js", AUTH.as_bytes()),
        ("code/modules/billing/services.js", BILLING.as_bytes()),
        ("code/modules/billing/hooks.js", BILLING_HOOKS.as_bytes()),
        ("code/modules/audit/hooks.js", AUDIT_HOOKS.as_bytes()),
        ("code/modules/org/hooks.js", ORG_HOOKS.as_bytes()),
    ];
    for (p, src) in extra_files {
        files.push((p, src.as_bytes()));
    }
    write_artifact(&files)
}

fn tenant_db() -> DbHandle {
    let dir = scratch("modules-db");
    let db = TenantDb::open(dir.join("t.db"), DbOptions::default()).unwrap();
    for sql in [
        "create table app__items (id integer primary key, name text)",
        "create table auth__users (id integer primary key, email text unique)",
        "create view auth__public_users_v1 as select id, email from auth__users",
        "create table billing__invoices (id integer primary key, email text)",
    ] {
        db.execute(sql, &[]).unwrap();
    }
    let db = db.with_authorizer(AuthorizerPolicy::module("app")).unwrap();
    DbHandle::spawn(db).unwrap()
}

async fn isolate(rt: &Runtime) -> IsolateHandle {
    let (dir, hash) = artifact(vec![], &[]);
    let mut s = spec(&dir, &hash, Limits::FREE);
    s.secrets = BTreeMap::from([
        ("APP_SECRET".to_string(), "app-secret-value-123".to_string()),
        (
            "AUTH_SECRET".to_string(),
            "auth-secret-value-123".to_string(),
        ),
        (
            "BILLING_KEY".to_string(),
            "billing-secret-value-1".to_string(),
        ),
    ]);
    s.db = Some(tenant_db());
    rt.create_isolate(s).await.unwrap()
}

async fn case(iso: &IsolateHandle, sink: &MemoryLogSink, name: &str) -> serde_json::Value {
    let out = iso
        .dispatch(
            ctx(&format!("req_mod_{name}")),
            get(&format!("/?case={name}")),
        )
        .await;
    assert_eq!(out.response.status(), 200, "{:?}", sink.lines());
    body_json(&out.response)
}

/// Each module's ctx is its own: authorizer, secrets, network list,
/// config (ops.md 1.3.0 section 15.1). docs/24-threat-model.md "Module
/// reading secrets it did not declare".
#[tokio::test]
async fn each_module_gets_its_own_secrets_tables_and_hosts() {
    let (rt, sink) = runtime();
    let iso = isolate(&rt).await;
    let v = case(&iso, &sink, "isolation").await;
    assert_eq!(v["auth"]["module"], "auth");
    assert_eq!(v["auth"]["config"]["greeting"], "hi from auth");
    assert_eq!(v["auth"]["secrets"], serde_json::json!(["AUTH_SECRET"]));
    assert_eq!(v["auth"]["frozen"], true);
    assert_eq!(v["billing"]["secrets"], serde_json::json!(["BILLING_KEY"]));
    assert_eq!(v["billing"]["key"], "billing-secret-value-1");
    assert_eq!(v["app"]["secrets"], serde_json::json!(["APP_SECRET"]));
    assert_eq!(v["app"]["module"], "app");
    // Another module's table: refused by the authorizer, naming the module.
    let t = &v["foreignTable"]["error"];
    assert_eq!(t["code"], "RENOX_DB_AUTH", "{v}");
    assert_eq!(t["details"]["table"], "auth__users");
    assert_eq!(t["details"]["module"], "billing");
    // A host only the app lists: blocked for the module.
    let f = &v["foreignHost"]["error"];
    assert_eq!(f["code"], "RENOX_FETCH_BLOCKED", "{v}");
    assert_eq!(f["details"]["reason"], "not_allowlisted");
}

/// docs/24-threat-model.md "Module calling a service or hook it did not
/// declare": refused before any callee code runs.
#[tokio::test]
async fn undeclared_service_call_and_hook_run_are_refused() {
    let (rt, sink) = runtime();
    let iso = isolate(&rt).await;
    let v = case(&iso, &sink, "undeclared").await;
    assert_eq!(
        v["service"]["error"]["code"], "RENOX_MODULE_UNDECLARED",
        "{v}"
    );
    assert_eq!(
        v["service"]["error"]["details"],
        serde_json::json!({ "module": "auth", "target": "billing" })
    );
    assert_eq!(v["hook"]["error"]["code"], "RENOX_MODULE_UNDECLARED");
    assert_eq!(
        v["hook"]["error"]["details"]["target"],
        "billing.before_charge"
    );
    // Only the module that exports a hook point runs it, not the app.
    assert_eq!(v["app"]["error"]["code"], "RENOX_MODULE_UNDECLARED");
}

/// ops.md 1.3.0 section 15.2: the callee runs in its own ctx inside the
/// caller's transaction: billing's write and auth's write commit together,
/// and billing sees auth's uncommitted row through the public view.
#[tokio::test]
async fn declared_call_runs_in_the_callees_ctx_within_the_callers_transaction() {
    let (rt, sink) = runtime();
    let iso = isolate(&rt).await;
    let v = case(&iso, &sink, "transaction").await;
    assert_eq!(v["r"]["reg"]["module"], "auth", "{v}");
    assert_eq!(v["r"]["seen"], 1, "{v}");
    assert_eq!(v["users"], 1);
}

/// docs/23-failure-modes.md "Module service throws": the caller gets a
/// RenoxError with module and service, the enclosing transaction is rolled
/// back at once, and its commit then fails with RENOX_DB_TX_STATE.
#[tokio::test]
async fn callee_throw_rolls_back_the_callers_transaction() {
    let (rt, sink) = runtime();
    let iso = isolate(&rt).await;
    let v = case(&iso, &sink, "rollback").await;
    let c = &v["caught"];
    assert_eq!(c["code"], "RENOX_MODULE_SERVICE", "{v}");
    assert_eq!(c["module"], "auth");
    assert_eq!(c["service"], "fail");
    assert_eq!(c["details"]["cause_code"], "RENOX_DB_CONSTRAINT");
    assert!(
        c["message"]
            .as_str()
            .unwrap()
            .starts_with("auth.fail failed"),
        "{v}"
    );
    assert_eq!(v["outcome"]["error"]["code"], "RENOX_DB_TX_STATE", "{v}");
    assert_eq!(v["items"], 0);
    // The callee's error is logged with the callee's module.
    let lines = sink.lines();
    assert!(
        lines.iter().any(|l| l.message.contains("auth.fail threw")),
        "{lines:?}"
    );
}

/// ops.md 1.3.0 section 15.3: fillers in priority order (lower first), a
/// halt stops the chain and names the filler.
#[tokio::test]
async fn hook_fillers_run_in_priority_order_and_halt_stops_the_chain() {
    let (rt, sink) = runtime();
    let iso = isolate(&rt).await;
    let v = case(&iso, &sink, "hooks").await;
    assert_eq!(v["halt"], true, "{v}");
    assert_eq!(v["module"], "billing");
    assert_eq!(v["status"], 303);
    assert_eq!(
        v["order"],
        serde_json::json!(["audit:u1", "billing:billing"])
    );
}

/// Module globals are per module and shared across requests
/// (docs/10-modules.md, rule 4).
#[tokio::test]
async fn module_globals_live_across_requests() {
    let (rt, sink) = runtime();
    let iso = isolate(&rt).await;
    let a = case(&iso, &sink, "globals").await;
    let b = case(&iso, &sink, "globals").await;
    assert_eq!(
        b["calls"].as_i64().unwrap(),
        a["calls"].as_i64().unwrap() + 1
    );
}

/// ops.md 1.3.0 section 11, step 5: a filler the manifest does not declare
/// fails the deployment (fail closed), and so does a declared service that
/// is not a function.
#[tokio::test]
async fn undeclared_filler_fails_the_deployment() {
    let (rt, _) = runtime();
    let rogue = module("rogue", &[], &[], &[], &[], serde_json::json!({}));
    let (dir, hash) = artifact(
        vec![rogue],
        &[(
            "code/modules/rogue/hooks.js",
            r#"export const hooks = { "auth.after_login": { handle() {} } };"#,
        )],
    );
    let s = spec(&dir, &hash, Limits::FREE);
    let e = match rt.create_isolate(s).await {
        Err(e) => e.to_string(),
        Ok(_) => panic!("created"),
    };
    assert!(
        e.contains("fills auth.after_login, which its manifest does not declare"),
        "{e}"
    );

    let lazy = module(
        "lazy",
        &[],
        &[],
        &[],
        &[],
        serde_json::json!({ "services": ["missing"] }),
    );
    let (dir, hash) = artifact(
        vec![lazy],
        &[("code/modules/lazy/services.js", "export const other = 1;")],
    );
    let e = match rt.create_isolate(spec(&dir, &hash, Limits::FREE)).await {
        Err(e) => e.to_string(),
        Ok(_) => panic!("created"),
    };
    assert!(e.contains("service missing is not a function"), "{e}");
}

/// An app with no modules is unchanged: `renox:modules` has no exports and
/// the ctx carries the module fields of the app.
#[tokio::test]
async fn an_app_without_modules_gets_an_empty_broker() {
    let (rt, _) = runtime();
    let src = r#"
        import * as mods from "renox:modules";
        export function GET(ctx) {
            return Response.json({ exports: Object.keys(mods), module: ctx.module, services: Object.keys(ctx.services), config: ctx.config });
        }
    "#;
    let (dir, hash) = function_artifact(src, &[("GET", "/")], &[]);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    let out = iso.dispatch(ctx("req_nomods_1"), get("/")).await;
    assert_eq!(
        body_json(&out.response),
        serde_json::json!({ "exports": [], "module": "app", "services": [], "config": {} })
    );
}
