//! Issue #28: `ctx.db`, `ctx.secrets`, `ctx.log`, `console`, and
//! `ctx.deadline` backed by the `renox` ops (`docs/contracts/ops.md`
//! sections 1, 3, 4, 5). V8-linked.
#![cfg(feature = "v8")]

mod support;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use renox_data::{AuthorizerPolicy, DbOptions, TenantDb};
use renox_runtime::isolate::MeterStatus;
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

/// A tenant file with `app__items` and another module's `auth__users`,
/// handed to the isolate under the `app` authorizer.
fn tenant_db() -> (DbHandle, PathBuf) {
    let dir = scratch("db");
    let path = dir.join("app.db");
    let db = TenantDb::open(&path, DbOptions::default()).unwrap();
    db.execute(
        "create table app__items (id integer primary key, name text not null unique, n integer, blob blob)",
        &[],
    )
    .unwrap();
    db.execute(
        "create table auth__users (id integer primary key, email text)",
        &[],
    )
    .unwrap();
    let db = db.with_authorizer(AuthorizerPolicy::module("app")).unwrap();
    (DbHandle::spawn(db).unwrap(), dir)
}

async fn isolate(
    rt: &Runtime,
    src: &str,
    routes: &[(&str, &str)],
    secrets_declared: &[&str],
    secrets: BTreeMap<String, String>,
    db: Option<DbHandle>,
) -> IsolateHandle {
    let (dir, hash) = function_artifact_with_secrets(src, routes, secrets_declared);
    let mut s = spec(&dir, &hash, Limits::FREE);
    s.secrets = secrets;
    s.db = db;
    rt.create_isolate(s).await.unwrap()
}

/// Every `Param` type of `ops.md` section 1 binds and comes back as the
/// matching `Value`: null, integer, real, bigint (beyond 2^53), text, blob,
/// boolean (as 1).
#[tokio::test]
async fn every_param_type_round_trips_through_db_query() {
    let (rt, _) = runtime();
    let (db, _dir) = tenant_db();
    let src = r#"
        export async function GET({ db }) {
            const big = 2n ** 60n;
            const row = await db.queryOne(
                "select ? as a, ? as b, ? as c, ? as d, ? as e, ? as f, ? as g, ? as h",
                [null, 42, 2.5, big, "dates ✓", new Uint8Array([1, 2, 255]), true, -(2n ** 63n)],
            );
            await db.execute("insert into app__items (name, n, blob) values (?, ?, ?)", ["x", big, new Uint8Array([7])]);
            const back = await db.query("select n, blob from app__items where name = ?", ["x"]);
            return Response.json({
                a: row.a, b: row.b, c: row.c,
                d: typeof row.d + ":" + String(row.d),
                e: row.e,
                f: Array.from(row.f), fIsBytes: row.f instanceof Uint8Array,
                g: row.g,
                h: typeof row.h + ":" + String(row.h),
                keys: Object.keys(row),
                backN: typeof back[0].n + ":" + String(back[0].n),
                backBlob: Array.from(back[0].blob),
            });
        }
    "#;
    let iso = isolate(&rt, src, &[("GET", "/")], &[], BTreeMap::new(), Some(db)).await;
    let out = iso.dispatch(ctx("req_params_0001"), get("/")).await;
    assert_eq!(out.response.status(), 200, "{:?}", out.response.body());
    assert_eq!(
        body_json(&out.response),
        serde_json::json!({
            "a": null, "b": 42, "c": 2.5,
            "d": "bigint:1152921504606846976",
            "e": "dates ✓",
            "f": [1, 2, 255], "fIsBytes": true,
            "g": 1,
            "h": "bigint:-9223372036854775808",
            "keys": ["a", "b", "c", "d", "e", "f", "g", "h"],
            "backN": "bigint:1152921504606846976",
            "backBlob": [7],
        })
    );
}

/// Parameters the contract refuses reject with `RENOX_DB_PARAM` and the
/// parameter index.
#[tokio::test]
async fn invalid_params_reject_with_db_param() {
    let (rt, _) = runtime();
    let (db, _dir) = tenant_db();
    let src = r#"
        export async function GET({ db }) {
            const out = [];
            for (const p of [undefined, NaN, Infinity, 2n ** 64n, "\uD800", {}, new Date(0), new Uint16Array(2)]) {
                try { await db.query("select ? as v", [p]); out.push("ok"); }
                catch (e) { out.push(e.code + ":" + e.details?.index); }
            }
            return Response.json(out);
        }
    "#;
    let iso = isolate(&rt, src, &[("GET", "/")], &[], BTreeMap::new(), Some(db)).await;
    let out = iso.dispatch(ctx("req_params_0002"), get("/")).await;
    let v = body_json(&out.response);
    for item in v.as_array().unwrap() {
        assert_eq!(item, "RENOX_DB_PARAM:0", "{v}");
    }
}

/// `docs/24-threat-model.md` section B ("module reads another module's
/// table"): the authorizer refusal arrives in JavaScript as
/// `RenoxError{code:"RENOX_DB_AUTH", details:{table:"auth__users"}}`, with no
/// file path in the message.
#[tokio::test]
async fn another_modules_table_is_refused_as_db_auth() {
    let (rt, _) = runtime();
    let (db, dir) = tenant_db();
    let src = r#"
        export async function GET({ db }) {
            try { await db.query("select email from auth__users", []); return Response.json({ ok: true }); }
            catch (e) { return Response.json({ name: e.name, code: e.code, details: e.details, message: e.message, stack: e.stack }); }
        }
    "#;
    let iso = isolate(&rt, src, &[("GET", "/")], &[], BTreeMap::new(), Some(db)).await;
    let out = iso.dispatch(ctx("req_auth_00001"), get("/")).await;
    let v = body_json(&out.response);
    assert_eq!(v["name"], "RenoxError");
    assert_eq!(v["code"], "RENOX_DB_AUTH");
    assert_eq!(v["details"]["table"], "auth__users");
    let text = v.to_string();
    assert!(!text.contains(dir.to_str().unwrap()), "{text}");
    assert!(!text.contains("app.db"), "{text}");
}

/// Acceptance: no file path or connection detail in any JS-visible database
/// error (`docs/23-failure-modes.md` rule 2). Triggers every error the
/// tenant can cause and greps the messages and stacks.
#[tokio::test]
async fn no_database_error_shows_a_path() {
    let (rt, _) = runtime();
    let (db, dir) = tenant_db();
    let src = r#"
        export async function GET({ db }) {
            const cases = [
                () => db.query("select * from nope"),
                () => db.query("selec 1"),
                () => db.query("select 1; select 2"),
                () => db.query("select ? as a", [1, 2]),
                () => db.query("select :name as a", [1]),
                () => db.query("select 1 as a, 2 as a"),
                () => db.query("pragma database_list"),
                () => db.query("attach database 'x.db' as x"),
                () => db.execute("insert into app__items (name) values (null)"),
                () => (async () => {
                    await db.execute("insert into app__items (name) values ('dup')");
                    await db.execute("insert into app__items (name) values ('dup')");
                })(),
                () => db.query("with recursive c(x) as (select 1 union all select x + 1 from c) select x from c limit 20000"),
                () => db.query("select randomblob(9000000) as b"),
                () => db.transaction(async (tx) => db.transaction(async () => {})),
            ];
            const out = [];
            for (const c of cases) {
                try { await c(); out.push({ code: "none" }); }
                catch (e) { out.push({ code: e.code, message: e.message, stack: e.stack, details: e.details }); }
            }
            return Response.json(out);
        }
    "#;
    let iso = isolate(&rt, src, &[("GET", "/")], &[], BTreeMap::new(), Some(db)).await;
    let out = iso.dispatch(ctx("req_errs_00001"), get("/")).await;
    let v = body_json(&out.response);
    let codes: Vec<&str> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["code"].as_str().unwrap())
        .collect();
    assert_eq!(
        codes,
        [
            "RENOX_DB_SQL",
            "RENOX_DB_SQL",
            "RENOX_DB_MULTI_STATEMENT",
            "RENOX_DB_PARAM",
            "RENOX_DB_PARAM",
            "RENOX_DB_COLUMN_NAME",
            "RENOX_DB_AUTH",
            "RENOX_DB_AUTH",
            "RENOX_DB_CONSTRAINT",
            "RENOX_DB_CONSTRAINT",
            "RENOX_DB_RESULT_LIMIT",
            "RENOX_DB_RESULT_LIMIT",
            "RENOX_DB_TX_STATE",
        ],
        "{v}"
    );
    assert_eq!(v[9]["details"]["kind"], "unique");
    let text = v.to_string();
    for needle in [dir.to_str().unwrap(), "app.db", "/tmp", "renox-rt-test"] {
        assert!(!text.contains(needle), "{needle} in {text}");
    }
}

/// `ops.md` section 3: `ctx.secrets` is frozen and holds only declared,
/// set secrets; `console.log` of a secret reaches the sink as `[redacted]`
/// (`docs/24-threat-model.md`, "secret in logs").
#[tokio::test]
async fn secrets_are_frozen_and_redacted_in_console_and_log() {
    let (rt, sink) = runtime();
    let src = r#"
        console.log("top level");
        export function GET({ secrets, log }) {
            console.log(secrets.STRIPE_KEY);
            console.log(`key=${secrets.STRIPE_KEY}`, { nested: [secrets.STRIPE_KEY] });
            console.error(new Error("failed with " + secrets.STRIPE_KEY));
            log.warn("ctx.log " + secrets.STRIPE_KEY, { k: secrets.STRIPE_KEY, tenant_id: "spoof", n: 10n });
            return Response.json({
                frozen: Object.isFrozen(secrets),
                keys: Object.keys(secrets),
                has: "UNDECLARED" in secrets || "UNSET" in secrets,
                same: secrets.STRIPE_KEY === "sk_live_0123456789",
            });
        }
        export function POST({ secrets }) {
            throw new Error("boom " + secrets.STRIPE_KEY);
        }
    "#;
    let secrets: BTreeMap<String, String> = [
        ("STRIPE_KEY".to_string(), "sk_live_0123456789".to_string()),
        (
            "UNDECLARED".to_string(),
            "undeclared-secret-value".to_string(),
        ),
    ]
    .into();
    let iso = isolate(
        &rt,
        src,
        &[("GET", "/"), ("POST", "/")],
        &["STRIPE_KEY", "UNSET"],
        secrets,
        None,
    )
    .await;
    let out = iso.dispatch(ctx("req_secret_001"), get("/")).await;
    assert_eq!(
        body_json(&out.response),
        serde_json::json!({ "frozen": true, "keys": ["STRIPE_KEY"], "has": false, "same": true })
    );
    let post = http::Request::builder()
        .method("POST")
        .uri("https://test.renox.app/")
        .body(bytes::Bytes::new())
        .unwrap();
    let out = iso.dispatch(ctx("req_secret_002"), post).await;
    assert_eq!(out.response.status(), 500);
    assert!(!String::from_utf8_lossy(out.response.body()).contains("sk_live"));

    let lines = sink.lines();
    let all = format!("{lines:?}");
    assert!(!all.contains("sk_live_0123456789"), "{all}");
    assert!(all.contains("[redacted]"));
    let top = lines.iter().find(|l| l.message == "top level").unwrap();
    assert_eq!(top.request_id, None);
    let first = lines
        .iter()
        .find(|l| l.request_id.as_deref() == Some("req_secret_001"))
        .unwrap();
    assert_eq!(first.message, "[redacted]");
    assert_eq!(first.level, "info");
    assert_eq!(first.tenant_id, "t_test");
    let warn = lines
        .iter()
        .find(|l| l.message.starts_with("ctx.log"))
        .unwrap();
    assert_eq!(warn.level, "warn");
    assert_eq!(warn.fields["k"], "[redacted]");
    assert_eq!(warn.fields["user_tenant_id"], "spoof");
    assert_eq!(warn.fields["n"], "10");
    assert!(
        lines
            .iter()
            .any(|l| l.level == "error" && l.message.contains("failed with [redacted]"))
    );
    // The dispatch wrapper's own line for the throw is redacted too.
    let threw = lines.iter().find(|l| l.message == "handler threw").unwrap();
    assert_eq!(threw.fields["cause_message"], "boom [redacted]");
}

/// `ops.md` section 3: a declared secret shorter than 8 bytes fails isolate
/// creation, and the log names the secret, not its value.
#[tokio::test]
async fn short_secret_fails_creation_by_name() {
    let (rt, sink) = runtime();
    let (dir, hash) = function_artifact_with_secrets(
        "export function GET() { return new Response('x'); }",
        &[("GET", "/")],
        &["PIN"],
    );
    let mut s = spec(&dir, &hash, Limits::FREE);
    s.secrets = [("PIN".to_string(), "1234".to_string())].into();
    assert!(rt.create_isolate(s).await.is_err());
    let all = format!("{:?}", sink.lines());
    assert!(all.contains("PIN"));
    assert!(!all.contains("1234"));
}

/// `ops.md` section 1: a transaction still open when the handler returns
/// is rolled back by Rust and logged; the next request can write at once.
#[tokio::test]
async fn open_transaction_is_rolled_back_when_the_handler_returns() {
    let (rt, sink) = runtime();
    let (db, _dir) = tenant_db();
    let src = r#"
        export function POST({ db }) {
            db.transaction(async (tx) => {
                await tx.execute("insert into app__items (name) values ('left-open')");
                await new Promise(() => {});
            });
            return new Promise((r) => setTimeout(() => r(new Response("returned")), 50));
        }
        export async function GET({ db }) {
            await db.execute("insert into app__items (name) values ('after')");
            const rows = await db.query("select name from app__items order by id");
            const n = await db.transaction(async (tx) => {
                await tx.execute("insert into app__items (name) values ('in-tx')");
                return (await tx.queryOne("select count(*) as n from app__items")).n;
            });
            return Response.json({ rows: rows.map((r) => r.name), n });
        }
    "#;
    let iso = isolate(
        &rt,
        src,
        &[("GET", "/"), ("POST", "/")],
        &[],
        BTreeMap::new(),
        Some(db),
    )
    .await;
    let post = http::Request::builder()
        .method("POST")
        .uri("https://test.renox.app/")
        .body(bytes::Bytes::new())
        .unwrap();
    let out = iso.dispatch(ctx("req_tx_open_01"), post).await;
    assert_eq!(out.response.status(), 200);
    let out = iso.dispatch(ctx("req_tx_open_02"), get("/")).await;
    assert_eq!(
        body_json(&out.response),
        serde_json::json!({ "rows": ["after"], "n": 2 })
    );
    assert!(
        sink.lines()
            .iter()
            .any(|l| l.request_id.as_deref() == Some("req_tx_open_01")
                && l.message.contains("rolled back"))
    );
    assert_eq!(rt.metrics().rolled_back_transactions(), 1);
}

/// A transaction whose function throws is rolled back by the SDK glue; a
/// committed one is visible.
#[tokio::test]
async fn transaction_commits_on_resolve_and_rolls_back_on_throw() {
    let (rt, _) = runtime();
    let (db, _dir) = tenant_db();
    let src = r#"
        export async function GET({ db }) {
            await db.transaction(async (tx) => { await tx.execute("insert into app__items (name) values ('kept')"); });
            try {
                await db.transaction(async (tx) => {
                    await tx.execute("insert into app__items (name) values ('dropped')");
                    throw new Error("no");
                });
            } catch {}
            const rows = await db.query("select name from app__items");
            return Response.json(rows.map((r) => r.name));
        }
    "#;
    let iso = isolate(&rt, src, &[("GET", "/")], &[], BTreeMap::new(), Some(db)).await;
    let out = iso.dispatch(ctx("req_tx_commit1"), get("/")).await;
    assert_eq!(body_json(&out.response), serde_json::json!(["kept"]));
    assert_eq!(rt.metrics().rolled_back_transactions(), 0);
}

/// `ops.md` section 7: `db_ms` and `db_rows` of the meter record.
#[tokio::test]
async fn db_ms_and_db_rows_are_metered() {
    let (rt, _) = runtime();
    let (db, _dir) = tenant_db();
    let src = r#"
        export async function GET({ db }) {
            for (let i = 0; i < 5; i++) await db.execute("insert into app__items (name) values (?)", ["n" + i]);
            const rows = await db.query("select * from app__items");
            return Response.json({ n: rows.length });
        }
    "#;
    let iso = isolate(&rt, src, &[("GET", "/")], &[], BTreeMap::new(), Some(db)).await;
    let out = iso.dispatch(ctx("req_meter_0001"), get("/")).await;
    assert_eq!(body_json(&out.response), serde_json::json!({ "n": 5 }));
    assert_eq!(out.meter.status, MeterStatus::Ok);
    assert_eq!(out.meter.db_rows, 10, "5 rows written + 5 read");
    assert!(out.meter.db_ms > 0.0);
}

/// `ops.md` section 4: over the per-tenant rate limit lines are dropped and
/// counted in `logs_dropped`; `ctx.deadline.remainingMs()` counts down.
#[tokio::test]
async fn log_rate_limit_counts_dropped_lines_and_deadline_is_visible() {
    let (rt, sink) = runtime();
    let src = r#"
        export function GET({ log, deadline }) {
            for (let i = 0; i < 1005; i++) log.info("line " + i);
            const left = deadline.remainingMs();
            return Response.json({ ok: left > 20000 && left <= 30000 && Number.isInteger(left) });
        }
    "#;
    let iso = isolate(&rt, src, &[("GET", "/")], &[], BTreeMap::new(), None).await;
    let out = iso.dispatch(ctx("req_ratelim_01"), get("/")).await;
    assert_eq!(body_json(&out.response), serde_json::json!({ "ok": true }));
    assert_eq!(out.meter.logs_dropped, 5);
    let n = sink
        .lines()
        .iter()
        .filter(|l| l.message.starts_with("line "))
        .count();
    assert_eq!(n, 1000);
}

/// Without a database the calls fail with a fixed message, no detail.
#[tokio::test]
async fn ctx_db_without_a_database_fails_closed() {
    let (rt, _) = runtime();
    let src = r#"
        export async function GET({ db }) {
            try { await db.query("select 1"); return new Response("ran"); }
            catch (e) { return Response.json({ code: e.code, message: e.message }); }
        }
    "#;
    let iso = isolate(&rt, src, &[("GET", "/")], &[], BTreeMap::new(), None).await;
    let out = iso.dispatch(ctx("req_nodb_00001"), get("/")).await;
    assert_eq!(
        body_json(&out.response),
        serde_json::json!({ "code": "RENOX_INTERNAL", "message": "The database is not available." })
    );
}
