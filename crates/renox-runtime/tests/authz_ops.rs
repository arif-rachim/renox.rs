//! Issue #279: the principal, `guard`, `op_authz_*`, `ctx.authz`,
//! `ctx.db.scoped()`, the role ops, and the audit row
//! (`docs/contracts/ops.md` 1.5.0 section 17). V8-linked; the engine is
//! built here as the cell builds it (`renox-cell/src/authz`).
//!
//! Proves the `docs/23-failure-modes.md` F5 rows "Policy denies" (the guard
//! answers 403 before the handler; `require` throws `ForbiddenError`) and
//! "Unscoped query on an owned table" (`RENOX_DB_SCOPE`, `unscoped`), and
//! the `docs/24-threat-model.md` rows "guard on every route" and
//! "Decisions for sensitive actions are audited".
#![cfg(feature = "v8")]

mod support;

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use renox_authz::{AttrType, AuthzBlock, Engine, MergedSchema, Owner, PolicySet};
use renox_data::{AuthorizerPolicy, DbOptions, TenantDb};
use renox_runtime::isolate::MeterStatus;
use renox_runtime::limits::Limits;
use renox_runtime::ops::authz::{AuthzState, PrincipalCache};
use renox_runtime::ops::db::DbHandle;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{IsolateHandle, Runtime, RuntimeConfig};
use support::*;

/// `auth.principal` of a fixture `auth`: the user id from a `uid` cookie;
/// counts its calls (the cache test reads the counter).
const AUTH: &str = r#"
let calls = 0;
export async function principal(ctx, sessionId) {
  calls++;
  const m = /(?:^|;\s*)uid=([a-z_0-9]+)/.exec(ctx.headers.get("cookie") ?? "");
  if (!m) return null;
  const org = /(?:^|;\s*)org=([a-z_0-9]+)/.exec(ctx.headers.get("cookie") ?? "");
  return { id: m[1], attrs: { org: org ? org[1] : "o_1", mfa_verified: /mfa=1/.test(ctx.headers.get("cookie") ?? "") } };
}
export async function calls_() { return calls; }
"#;

/// The `shop` module: an owned table, a role it may assign.
const SHOP: &str = r#"
const attempt = async (f) => { try { return { ok: await f() }; } catch (e) { return { error: { name: e.name, code: e.code, details: e.details } }; } };
export async function unscoped(ctx) { return attempt(() => ctx.db.query("select id from shop__orders")); }
export async function mine(ctx) {
  return attempt(() => ctx.db.scoped({ user_id: ctx.principal.id }).query("select id from shop__orders order by id"));
}
export async function insertMine(ctx) {
  return attempt(async () => {
    await ctx.db.scoped({ user_id: ctx.principal.id }).execute("insert into shop__orders (id, total) values (99, 5)");
    return ctx.db.scoped({ user_id: ctx.principal.id }).query("select id, user_id from shop__orders where id = 99");
  });
}
export async function assign(ctx, user, role) { return attempt(() => ctx.authz.roles.assign(user, role)); }
"#;

const APP: &str = r#"
import { auth, shop } from "renox:modules";
const err = (e) => ({ name: e.name, code: e.code, details: e.details });
const attempt = async (f) => { try { return { ok: await f() }; } catch (e) { return { error: err(e) }; } };
export async function GET(ctx) {
  const c = ctx.url.searchParams.get("case");
  const doc = (id) => ctx.db.queryOne("select id, owner, org from app__docs where id = ?", [id]).then((r) => ({ type: "Doc", ...r }));
  switch (c) {
    case "principal":
      return Response.json({ principal: ctx.principal, frozen: Object.isFrozen(ctx.principal), calls: await auth.calls_() });
    case "can":
      return Response.json({
        report: await ctx.authz.can("report.read"),
        mine: await ctx.authz.can("doc.read", await doc("d1")),
        theirs: await ctx.authz.can("doc.read", await doc("d2")),
        batch: await ctx.authz.canBatch("doc.read", [await doc("d1"), await doc("d2")]),
        unknown: await ctx.authz.can("nope.nope"),
        missing: await ctx.authz.can("doc.read", { type: "Doc", id: "d1" }),
      });
    case "require-denied":
      return Response.json(await attempt(() => ctx.authz.require("doc.delete", { type: "Doc", id: "d2", owner: "u_bob", org: "o_1" })));
    case "require-uncaught":
      await ctx.authz.require("doc.delete", { type: "Doc", id: "d2", owner: "u_bob", org: "o_1" });
      return new Response("unreachable");
    case "require-allowed": {
      await ctx.authz.require("doc.delete", await doc("d1"));
      return Response.json({ ok: true });
    }
    case "forbid":
      return Response.json(await attempt(() => ctx.authz.require("doc.read", { type: "Doc", id: "d3", owner: "u_alice", org: "o_locked" })));
    case "explain":
      return Response.json(await attempt(async () => ctx.authz.explain("doc.read", await doc("d2"))));
    case "assign":
      return Response.json({
        app: await attempt(() => ctx.authz.roles.assign("u_carol", "auditor")),
        shopOwn: await shop.assign("u_carol", "clerk"),
        shopOther: await shop.assign("u_carol", "admin"),
        list: await ctx.authz.roles.list("u_carol"),
      });
    case "scoped":
      return Response.json({ unscoped: await shop.unscoped(), mine: await shop.mine(), insert: await shop.insertMine() });
    default:
      return new Response("unknown", { status: 400 });
  }
}
"#;

/// `GET /docs/:id`, guarded by `doc.read` on the doc: the handler writes a
/// row, so a denied guard leaves none.
const DOC: &str = r#"
export async function GET(ctx) {
  await ctx.db.execute("insert into app__seen (id) values (?)", [ctx.params.id]);
  return Response.json({ id: ctx.params.id });
}
"#;

const POLICIES: &str = r#"
@id("app.own_docs")
permit (principal is Renox::User, action in [Renox::Action::"doc.read", Renox::Action::"doc.delete"], resource is App::Doc)
when { resource.owner == principal.id };

@id("app.locked")
forbid (principal, action == Renox::Action::"doc.read", resource is App::Doc)
when { resource.org == "o_locked" };

@id("app.reports")
permit (principal in Renox::Role::"auditor", action == Renox::Action::"report.read", resource);
"#;

fn module(name: &str, exports: serde_json::Value, authz: serde_json::Value) -> serde_json::Value {
    let perms = serde_json::json!({ "tables": format!("{name}__*"), "network": [], "secrets": [], "slots": [], "hooks": [] });
    serde_json::json!({
        "name": name, "version": "1.0.0", "hash": "0".repeat(64), "source": format!("path:modules/{name}"),
        "mount": format!("/{name}"), "isolation": "shared", "dependencies": [], "config": {},
        "permissions": perms, "approved": perms, "exports": exports, "authz": authz,
    })
}

fn app_authz() -> serde_json::Value {
    serde_json::json!({
        "actions": ["doc.read", "doc.delete", "report.read"],
        "sensitive": ["doc.delete"],
        "entities": { "Doc": { "table": "app__docs", "attrs": ["owner", "org"] } },
        "default_roles": { "auditor": ["report.read"] },
    })
}

fn shop_authz() -> serde_json::Value {
    serde_json::json!({
        "actions": ["order.read"],
        "ownership": { "shop__orders": { "owner": "user_id" } },
        "default_roles": { "clerk": ["order.read"] },
    })
}

fn artifact() -> (std::path::PathBuf, String) {
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "test", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": {
            "functions/f": "functions/f.js", "functions/docs/[id]": "functions/docs/[id].js",
            "modules/auth/services": "modules/auth/services.js", "modules/shop/services": "modules/shop/services.js",
        } },
        "routes": [
            { "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" },
            { "kind": "function", "method": "GET", "path": "/docs/:id", "module": "functions/docs/[id]", "export": "GET",
              "guard": { "action": "doc.read", "resource": { "type": "Doc", "id": ":id" } } },
            { "kind": "function", "method": "GET", "path": "/reports", "module": "functions/docs/[id]", "export": "GET",
              "guard": { "action": "report.read" } },
        ],
        "permissions": { "network": [], "secrets": [] },
        "authz": app_authz(),
        "modules": [
            module("auth", serde_json::json!({ "services": ["principal", "calls_"] }), serde_json::json!({ "actions": [] })),
            module("shop", serde_json::json!({ "services": ["unscoped", "mine", "insertMine", "assign"] }), shop_authz()),
        ],
    });
    let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
    write_artifact(&[
        ("manifest.json", &manifest),
        ("code/functions/f.js", APP.as_bytes()),
        ("code/functions/docs/[id].js", DOC.as_bytes()),
        ("code/modules/auth/services.js", AUTH.as_bytes()),
        ("code/modules/shop/services.js", SHOP.as_bytes()),
        ("policies/app/default.cedar", POLICIES.as_bytes()),
    ])
}

fn tenant_db() -> (DbHandle, std::path::PathBuf) {
    let dir = scratch("authz-db");
    let path = dir.join("t.db");
    let db = TenantDb::open(&path, DbOptions::default()).unwrap();
    for sql in [
        "create table app__docs (id text primary key, owner text, org text)",
        "create table app__seen (id text)",
        "create table shop__orders (id integer primary key, user_id text not null, total integer)",
        "insert into app__docs values ('d1', 'u_alice', 'o_1'), ('d2', 'u_bob', 'o_1')",
        "insert into shop__orders values (1, 'u_alice', 10), (2, 'u_bob', 20), (3, 'u_alice', 30)",
    ] {
        db.execute(sql, &[]).unwrap();
    }
    let db = db.with_authorizer(AuthorizerPolicy::module("app")).unwrap();
    (DbHandle::spawn(db).unwrap(), path)
}

fn state(dev: bool) -> Arc<AuthzState> {
    let app: AuthzBlock = serde_json::from_value(app_authz()).unwrap();
    let shop: AuthzBlock = serde_json::from_value(shop_authz()).unwrap();
    let owners = [
        Owner::new("app", app).with_type("Doc", "owner", AttrType::String),
        Owner::new("shop", shop),
    ];
    let schema = MergedSchema::build(&owners, None).unwrap();
    let set = PolicySet::load(
        &[("policies/app/default.cedar".into(), POLICIES.into())],
        &schema,
    )
    .unwrap();
    Arc::new(AuthzState {
        engine: Arc::new(Engine::new(schema, set)),
        dev,
        cache: Arc::new(PrincipalCache::new(Duration::from_secs(60))),
        module_roles: [("shop".to_string(), ["clerk".to_string()].into())].into(),
        decisions: Default::default(),
    })
}

struct Fx {
    iso: IsolateHandle,
    sink: Arc<MemoryLogSink>,
    path: std::path::PathBuf,
    state: Arc<AuthzState>,
}

async fn fixture(dev: bool) -> Fx {
    let sink = Arc::new(MemoryLogSink::default());
    let rt = Runtime::new(RuntimeConfig {
        log_sink: sink.clone(),
        ..Default::default()
    });
    let (dir, hash) = artifact();
    let (db, path) = tenant_db();
    let mut s = spec(&dir, &hash, Limits::FREE);
    s.db = Some(db);
    let iso = rt.create_isolate(s).await.unwrap();
    let st = state(dev);
    *iso.authz_slot().write().unwrap() = Some(st.clone());
    Fx {
        iso,
        sink,
        path,
        state: st,
    }
}

fn req(path: &str, cookie: Option<&str>) -> http::Request<Bytes> {
    let mut b = http::Request::builder()
        .method("GET")
        .uri(format!("https://test.renox.app{path}"));
    if let Some(c) = cookie {
        b = b.header("cookie", c);
    }
    b.body(Bytes::new()).unwrap()
}

const ALICE: &str = "uid=u_alice; org=o_1";

impl Fx {
    async fn call(&self, path: &str, cookie: Option<&str>) -> renox_runtime::Dispatched {
        self.iso.dispatch(ctx("req_authz"), req(path, cookie)).await
    }

    async fn json(&self, path: &str, cookie: Option<&str>) -> serde_json::Value {
        let out = self.call(path, cookie).await;
        assert_eq!(
            out.response.status(),
            200,
            "{path}: {:?}",
            self.sink.lines()
        );
        body_json(&out.response)
    }

    fn rows(&self, sql: &str) -> Vec<renox_data::Row> {
        TenantDb::open(&self.path, DbOptions::default())
            .unwrap()
            .query(sql, &[])
            .unwrap()
    }
}

/// Without cookies, and with an `auth` that answers `null`, the principal
/// is anonymous: `ctx.principal` is `null` and RBAC checks deny.
#[tokio::test]
async fn anonymous_without_a_session() {
    let fx = fixture(false).await;
    let v = fx.json("/?case=principal", None).await;
    assert_eq!(v["principal"], serde_json::Value::Null);
    assert_eq!(v["calls"], 0, "no cookie: auth.principal is not called");
    let v = fx.json("/?case=principal", Some("other=1")).await;
    assert_eq!(
        v["principal"],
        serde_json::Value::Null,
        "auth answered null"
    );
    let v = fx.json("/?case=can", None).await;
    assert_eq!(v["report"], false);
}

/// The principal from `auth.principal`, with the roles of
/// `renox__role_assignments` added by the platform; frozen; cached per
/// session until a role change drops it.
#[tokio::test]
async fn principal_from_auth_with_roles_and_cache() {
    let fx = fixture(false).await;
    TenantDb::open(&fx.path, DbOptions::default())
        .unwrap()
        .execute("insert into renox__role_assignments values ('u_alice', 'auditor', 'global', '', 'u_admin', 1)", &[])
        .unwrap();
    let v = fx.json("/?case=principal", Some(ALICE)).await;
    assert_eq!(v["principal"]["id"], "u_alice");
    assert_eq!(v["principal"]["kind"], "user");
    assert_eq!(v["principal"]["attrs"]["org"], "o_1");
    assert_eq!(
        v["principal"]["roles"],
        serde_json::json!([{ "role": "auditor", "scope_type": "global", "scope_id": null }])
    );
    assert_eq!(v["frozen"], true);
    let first_calls = v["calls"].as_i64().unwrap();
    // A second request with the same cookies is served from the cache.
    let v = fx.json("/?case=principal", Some(ALICE)).await;
    assert_eq!(
        v["calls"].as_i64().unwrap(),
        first_calls,
        "cache hit: auth.principal not called again"
    );
    assert!(fx.state.cache.stats().0 >= 1);
    // A role change drops it (the cell does this on the outbox event).
    assert_eq!(fx.state.cache.invalidate_user("u_alice"), 1);
    let v = fx.json("/?case=principal", Some(ALICE)).await;
    assert_eq!(v["calls"].as_i64().unwrap(), first_calls + 1);
}

/// `guard` runs before the handler: a deny is 403 `RENOX_FORBIDDEN`, the
/// handler's write never happens, the meter says `forbidden`; on a
/// missing row too (no probing ids through the guard).
#[tokio::test]
async fn guard_denies_before_the_handler() {
    let fx = fixture(false).await;
    let ok = fx.call("/docs/d1", Some(ALICE)).await;
    assert_eq!(ok.response.status(), 200, "{:?}", fx.sink.lines());
    assert_eq!(ok.meter.authz_evals, 1);
    for (path, cookie) in [
        ("/docs/d2", Some(ALICE)),
        ("/docs/d1", None),
        ("/docs/nope", Some(ALICE)),
        ("/reports", Some(ALICE)),
    ] {
        let out = fx.call(path, cookie).await;
        assert_eq!(out.response.status(), 403, "{path}");
        assert_eq!(body_json(&out.response)["error"]["code"], "RENOX_FORBIDDEN");
        assert_eq!(out.meter.status, MeterStatus::Forbidden);
        assert!(out.meter.authz_evals >= 1 || path == "/docs/nope");
    }
    let seen = fx.rows("select id from app__seen");
    assert_eq!(
        seen.len(),
        1,
        "only the allowed request reached the handler"
    );
}

/// `can`, `canBatch`; an unknown action and a resource without its
/// declared attributes deny; evaluations are counted.
#[tokio::test]
async fn can_and_can_batch() {
    let fx = fixture(false).await;
    let out = fx.call("/?case=can", Some(ALICE)).await;
    assert_eq!(out.response.status(), 200, "{:?}", fx.sink.lines());
    let v = body_json(&out.response);
    assert_eq!(v["report"], false);
    assert_eq!(v["mine"], true);
    assert_eq!(v["theirs"], false);
    assert_eq!(v["batch"], serde_json::json!([true, false]));
    assert_eq!(v["unknown"], false);
    assert_eq!(v["missing"], false);
    // report, d1, d2, the unknown action; the batch's d1 and d2 and the
    // attribute-less d1 were asked already in this request: not counted
    // again (ops.md section 17, "cached per (action, resource.id)").
    assert_eq!(out.meter.authz_evals, 4);
}

/// `require` throws `ForbiddenError` with the contract's details (no policy
/// outside dev mode); uncaught it is a 403, not a 500; decisions on a
/// sensitive action are audited, allowed and denied.
#[tokio::test]
async fn require_and_the_audit_row() {
    let fx = fixture(false).await;
    let v = fx.json("/?case=require-denied", Some(ALICE)).await;
    assert_eq!(v["error"]["name"], "ForbiddenError");
    assert_eq!(v["error"]["code"], "RENOX_FORBIDDEN");
    assert_eq!(v["error"]["details"]["reason"], "deny");
    assert_eq!(v["error"]["details"]["action"], "doc.delete");
    assert_eq!(
        v["error"]["details"]["resource"],
        serde_json::json!({ "type": "Doc", "id": "d2" })
    );
    assert_eq!(v["error"]["details"]["policy"], serde_json::Value::Null);
    let out = fx.call("/?case=require-uncaught", Some(ALICE)).await;
    assert_eq!(out.response.status(), 403);
    assert_eq!(body_json(&out.response)["error"]["code"], "RENOX_FORBIDDEN");
    assert_eq!(
        out.meter.status,
        MeterStatus::Ok,
        "meter.md 0.3: a handler's 403 is ok"
    );
    fx.json("/?case=require-allowed", Some(ALICE)).await;
    let rows = fx.rows("select principal, action, resource_type, resource_id, result, policy from renox__authz_audit order by id");
    let got: Vec<(String, String)> = rows
        .iter()
        .map(|r| {
            (
                format!("{:?}", r.get("result").unwrap()),
                format!("{:?}", r.get("resource_id").unwrap()),
            )
        })
        .collect();
    assert_eq!(rows.len(), 3, "{got:?}");
    assert_eq!(
        rows[2].get("result"),
        Some(&renox_data::Value::from("allow"))
    );
    assert_eq!(
        rows[2].get("policy"),
        Some(&renox_data::Value::from("app.own_docs"))
    );
    assert_eq!(
        rows[0].get("principal"),
        Some(&renox_data::Value::from("u_alice"))
    );
}

/// `forbid` wins over `permit` end to end.
#[tokio::test]
async fn forbid_beats_permit() {
    let fx = fixture(false).await;
    let v = fx.json("/?case=forbid", Some(ALICE)).await;
    assert_eq!(v["error"]["code"], "RENOX_FORBIDDEN");
}

/// `explain` is dev only; in dev mode it answers and `RENOX_FORBIDDEN`
/// names the policy.
#[tokio::test]
async fn explain_is_dev_only() {
    let fx = fixture(false).await;
    let v = fx.json("/?case=explain", Some(ALICE)).await;
    assert_eq!(v["error"]["details"]["reason"], "dev_only");
    let dev = fixture(true).await;
    let v = dev.json("/?case=explain", Some(ALICE)).await;
    assert_eq!(v["ok"]["decision"], "deny", "{v}");
    let v = dev.json("/?case=forbid", Some(ALICE)).await;
    assert_eq!(v["error"]["details"]["policy"], "app.locked");
}

/// Role ops: the app assigns any role; a module only those its
/// `[authz.default_roles]` names; each change emits `authz.roles_changed`.
#[tokio::test]
async fn role_ops_and_their_event() {
    let fx = fixture(false).await;
    let v = fx.json("/?case=assign", Some(ALICE)).await;
    // `{ ok: undefined }`: resolved, nothing returned.
    assert_eq!(v["app"], serde_json::json!({}));
    assert_eq!(v["shopOwn"], serde_json::json!({}));
    assert_eq!(v["shopOther"]["error"]["code"], "RENOX_MODULE_UNDECLARED");
    assert_eq!(v["shopOther"]["error"]["details"]["target"], "role:admin");
    let roles: Vec<&str> = v["list"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, vec!["auditor", "clerk"]);
    assert_eq!(v["list"][0]["granted_by"], "u_alice");
    let events = fx.rows("select name, module, payload from renox__outbox order by created_at");
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0].get("name"),
        Some(&renox_data::Value::from("authz.roles_changed"))
    );
}

/// `db.scoped()`: module code reaching an owned table without a scope is
/// refused; a scoped query returns the owner's rows only; a scoped insert
/// gets the owner column.
#[tokio::test]
async fn db_scoped_for_module_code() {
    let fx = fixture(false).await;
    let v = fx.json("/?case=scoped", Some(ALICE)).await;
    assert_eq!(v["unscoped"]["error"]["code"], "RENOX_DB_SCOPE");
    assert_eq!(v["unscoped"]["error"]["name"], "DbScopeError");
    assert_eq!(
        v["unscoped"]["error"]["details"],
        serde_json::json!({ "table": "shop__orders", "module": "shop", "reason": "unscoped" })
    );
    assert_eq!(
        v["mine"]["ok"],
        serde_json::json!([{ "id": 1 }, { "id": 3 }])
    );
    assert_eq!(
        v["insert"]["ok"],
        serde_json::json!([{ "id": 99, "user_id": "u_alice" }])
    );
}
