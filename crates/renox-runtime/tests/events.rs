//! Issue #231: `op_events_emit` and event delivery (`docs/contracts/ops.md`
//! 1.3.0, section 15.4). V8-linked.
//!
//! Proves the `docs/23-failure-modes.md` rows "Event handler fails" (an
//! in-memory handler's throw fails the request, a delivery's throw is a
//! failed attempt with nothing kept) and the outbox's D14 guarantee (a
//! rolled-back transaction never delivers).
#![cfg(feature = "v8")]

mod support;

use std::sync::Arc;

use renox_data::{AuthorizerPolicy, DbOptions, TenantDb};
use renox_runtime::isolate::MeterStatus;
use renox_runtime::limits::Limits;
use renox_runtime::ops::db::DbHandle;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{
    EventEnvelope, EventOutcome, IsolateHandle, RequestCtx, Runtime, RuntimeConfig,
};
use support::*;

/// Serialises the CPU-limit test against the others.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn runtime() -> (Runtime, Arc<MemoryLogSink>) {
    let sink = Arc::new(MemoryLogSink::default());
    let rt = Runtime::new(RuntimeConfig {
        log_sink: sink.clone(),
        ..Default::default()
    });
    (rt, sink)
}

fn module(name: &str, deps: &[&str], exports: serde_json::Value) -> serde_json::Value {
    let perms = serde_json::json!({ "tables": format!("{name}__*"), "network": [], "secrets": [], "slots": [], "hooks": [] });
    serde_json::json!({
        "name": name, "version": "1.0.0", "hash": "0".repeat(64), "source": format!("path:modules/{name}"),
        "mount": format!("/{name}"), "isolation": "shared", "dependencies": deps, "config": {},
        "permissions": perms, "approved": perms, "exports": exports,
    })
}

const BILLING: &str = r#"
const caught = async (f) => { try { return { ok: await f() }; } catch (e) { return { error: { code: e.code, details: e.details, name: e.name } }; } };
export async function paidThenRollback(ctx) {
  return caught(() => ctx.db.transaction(async () => {
    await ctx.events.emit("billing.invoice_paid", { invoice_id: "i1", amount: 5 });
    throw new Error("abort");
  }));
}
export async function paidOutside(ctx) {
  return ctx.events.emit("billing.invoice_paid", { invoice_id: "i2", amount: 7 });
}
export async function badPayload(ctx) {
  return {
    schema: await caught(() => ctx.events.emit("billing.invoice_paid", { amount: 1 })),
    undeclared: await caught(() => ctx.events.emit("billing.nope", {})),
    notJson: await caught(() => ctx.events.emit("billing.invoice_paid", { invoice_id: "x", amount: 10n })),
  };
}
export async function cartChanged(ctx, mode) {
  return ctx.events.emit("billing.cart_changed", { cart_id: mode }, { durable: false });
}
"#;

const EMAIL_HOOKS: &str = r#"
export const on = {
  "billing.invoice_paid": async (ctx, e) => {
    await ctx.db.execute("insert into email__sent (event_id, invoice, attempt, module) values (?, ?, ?, ?)",
      [e.id, e.payload.invoice_id, e.attempt, ctx.module]);
    if (e.payload.invoice_id === "throw") throw new Error("smtp down");
    if (e.payload.invoice_id === "spin") { const t = Date.now(); while (Date.now() - t < 100) {} }
  },
  "billing.cart_changed": async (ctx, e) => {
    globalThis.__seen = (globalThis.__seen ?? []).concat([ctx.module + ":" + e.payload.cart_id + ":" + (ctx.req === undefined)]);
    if (e.payload.cart_id === "throw") throw new Error("handler broke");
  },
};
"#;

const APP: &str = r#"
import { billing } from "renox:modules";
export async function GET(ctx) {
  const which = ctx.url.searchParams.get("case");
  switch (which) {
    case "rollback": return Response.json(await billing.paidThenRollback());
    case "outside": return Response.json({ id: await billing.paidOutside() });
    case "payload": return Response.json(await billing.badPayload());
    case "memory": { const id = await billing.cartChanged("c1"); return Response.json({ id, seen: globalThis.__seen }); }
    case "memory_throw": await billing.cartChanged("throw"); return new Response("unreachable");
    default: return new Response("unknown", { status: 400 });
  }
}
"#;

fn artifact() -> (std::path::PathBuf, String) {
    let paid = serde_json::json!({ "type": "object", "required": ["invoice_id"], "additionalProperties": false,
        "properties": { "invoice_id": { "type": "string" }, "amount": { "type": "integer" } } });
    let modules = vec![
        module(
            "billing",
            &[],
            serde_json::json!({ "services": ["paidThenRollback", "paidOutside", "badPayload", "cartChanged"],
                "events": { "billing.invoice_paid": paid, "billing.cart_changed": { "type": "object" } } }),
        ),
        module("email", &[], serde_json::json!({})),
    ];
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "test", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": {
            "functions/f": "functions/f.js",
            "modules/billing/services": "modules/billing/services.js",
            "modules/email/hooks": "modules/email/hooks.js",
        } },
        "routes": [{ "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] },
        "modules": modules,
    });
    let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
    write_artifact(&[
        ("manifest.json", &manifest),
        ("code/functions/f.js", APP.as_bytes()),
        ("code/modules/billing/services.js", BILLING.as_bytes()),
        ("code/modules/email/hooks.js", EMAIL_HOOKS.as_bytes()),
    ])
}

struct Fixture {
    iso: IsolateHandle,
    sink: Arc<MemoryLogSink>,
    db: DbHandle,
    _rt: Runtime,
}

async fn fixture(limits: Limits) -> Fixture {
    let (rt, sink) = runtime();
    let (dir, hash) = artifact();
    let file = scratch("events-db").join("t.db");
    let db = TenantDb::open(&file, DbOptions::default()).unwrap();
    db.execute(
        "create table email__sent (event_id text, invoice text, attempt integer, module text)",
        &[],
    )
    .unwrap();
    let db = DbHandle::spawn(db.with_authorizer(AuthorizerPolicy::module("app")).unwrap()).unwrap();
    let mut s = spec(&dir, &hash, limits);
    s.db = Some(db.clone());
    let iso = rt.create_isolate(s).await.unwrap();
    Fixture {
        iso,
        sink,
        db,
        _rt: rt,
    }
}

async fn case(f: &Fixture, name: &str) -> (u16, serde_json::Value) {
    let out = f
        .iso
        .dispatch(
            ctx(&format!("req_ev_{name}")),
            get(&format!("/?case={name}")),
        )
        .await;
    let status = out.response.status().as_u16();
    let v = if status == 200 {
        body_json(&out.response)
    } else {
        serde_json::Value::Null
    };
    (status, v)
}

async fn outbox(db: &DbHandle) -> Vec<renox_data::outbox::OutboxRow> {
    db.call(|db| renox_data::outbox::due(db, i64::MAX, 100).unwrap())
        .await
        .unwrap()
}

async fn sent(db: &DbHandle) -> Vec<(String, String, i64)> {
    db.call(|db| {
        db.with_policy(None, || {
            db.query(
                "select event_id, invoice, attempt from email__sent order by rowid",
                &[],
            )
            .unwrap()
        })
        .unwrap()
        .into_iter()
        .map(|r| {
            let s = |c: &str| match r.get(c) {
                Some(renox_data::Value::Text(t)) => t.clone(),
                _ => String::new(),
            };
            let n = match r.get("attempt") {
                Some(renox_data::Value::Integer(i)) => *i,
                _ => 0,
            };
            (s("event_id"), s("invoice"), n)
        })
        .collect()
    })
    .await
    .unwrap()
}

/// D14: an event emitted in a transaction that rolls back is never stored.
#[tokio::test]
async fn emit_inside_a_rolled_back_transaction_leaves_no_row() {
    let _g = SERIAL.lock().await;
    let f = fixture(Limits::FREE).await;
    let (status, v) = case(&f, "rollback").await;
    assert_eq!(status, 200, "{:?}", f.sink.lines());
    assert!(v["error"].is_object(), "{v}");
    assert!(outbox(&f.db).await.is_empty());
}

/// Outside a transaction the emit is its own autocommit write: one row,
/// waiting for its fan-out, with the emitting module and a ULID.
#[tokio::test]
async fn emit_outside_a_transaction_commits_one_row() {
    let _g = SERIAL.lock().await;
    let f = fixture(Limits::FREE).await;
    let (status, v) = case(&f, "outside").await;
    assert_eq!(status, 200, "{:?}", f.sink.lines());
    let rows = outbox(&f.db).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, v["id"].as_str().unwrap());
    assert_eq!(rows[0].id.len(), 26);
    assert_eq!(rows[0].name, "billing.invoice_paid");
    assert_eq!(rows[0].module, "billing");
    assert_eq!(rows[0].target, "");
    assert_eq!(rows[0].payload, r#"{"invoice_id":"i2","amount":7}"#);
}

/// A payload against the exported schema: `RENOX_EVENT_PAYLOAD` with the
/// reason; an event the module does not export: `RENOX_MODULE_UNDECLARED`.
#[tokio::test]
async fn payload_not_matching_the_schema_is_renox_event_payload() {
    let _g = SERIAL.lock().await;
    let f = fixture(Limits::FREE).await;
    let (status, v) = case(&f, "payload").await;
    assert_eq!(status, 200, "{:?}", f.sink.lines());
    assert_eq!(v["schema"]["error"]["code"], "RENOX_EVENT_PAYLOAD", "{v}");
    assert_eq!(
        v["schema"]["error"]["details"],
        serde_json::json!({ "event": "billing.invoice_paid", "reason": "schema" })
    );
    assert_eq!(
        v["notJson"]["error"]["details"]["reason"], "not_json",
        "{v}"
    );
    assert_eq!(v["undeclared"]["error"]["code"], "RENOX_MODULE_UNDECLARED");
    assert!(outbox(&f.db).await.is_empty());
}

/// In-memory: the handlers run before `emit` resolves, with their own
/// module's ctx and no request; a throw fails the request (500).
/// docs/23-failure-modes.md "Event handler fails" (in-memory).
#[tokio::test]
async fn in_memory_handler_runs_now_and_its_throw_fails_the_request() {
    let _g = SERIAL.lock().await;
    let f = fixture(Limits::FREE).await;
    let (status, v) = case(&f, "memory").await;
    assert_eq!(status, 200, "{:?}", f.sink.lines());
    assert_eq!(v["seen"], serde_json::json!(["email:c1:true"]));
    assert!(outbox(&f.db).await.is_empty());
    let (status, _) = case(&f, "memory_throw").await;
    assert_eq!(status, 500);
    let lines = f.sink.lines();
    assert!(
        lines.iter().any(|l| l
            .message
            .contains("email handler of billing.cart_changed threw")),
        "{lines:?}"
    );
    assert!(lines.iter().any(
        |l| l.fields.get("cause_code").and_then(|c| c.as_str()) == Some("RENOX_MODULE_SERVICE")
    ));
}

fn envelope(id: &str, invoice: &str, attempt: u32) -> EventEnvelope {
    EventEnvelope {
        id: id.into(),
        name: "billing.invoice_paid".into(),
        payload_json: format!(r#"{{"invoice_id":"{invoice}","amount":1}}"#),
        attempt,
        module: "email".into(),
        job: None,
    }
}

async fn deliver(f: &Fixture, ev: EventEnvelope) -> renox_runtime::EventDelivered {
    let c = RequestCtx {
        request_id: ev.request_id(),
        ..ctx("unused")
    };
    f.iso.deliver_event(c, ev).await
}

/// The cell's envelope runs the module's `on[name]` in its own transaction;
/// the ack deletes the delivery's outbox row in that same transaction.
#[tokio::test]
async fn an_event_envelope_runs_the_handler_and_acks_in_its_transaction() {
    let _g = SERIAL.lock().await;
    let f = fixture(Limits::FREE).await;
    let (_, v) = case(&f, "outside").await;
    let id = v["id"].as_str().unwrap().to_string();
    f.db.call({
        let id = id.clone();
        move |db| renox_data::outbox::fan_out(db, &id, &["email".to_string()], 0).unwrap()
    })
    .await
    .unwrap();
    let out = deliver(&f, envelope(&id, "i2", 1)).await;
    assert_eq!(out.outcome, EventOutcome::Ok, "{:?}", f.sink.lines());
    assert_eq!(out.meter.status, MeterStatus::Ok);
    assert_eq!(
        out.meter.route.as_deref(),
        Some("EVENT email billing.invoice_paid")
    );
    assert_eq!(sent(&f.db).await, vec![(id.clone(), "i2".to_string(), 1)]);
    assert!(
        outbox(&f.db).await.is_empty(),
        "the ack deleted the delivery row"
    );

    // A throw: a failed attempt, nothing of it kept.
    let out = deliver(&f, envelope("01JBQ3Z7MA0000000000000002", "throw", 3)).await;
    assert_eq!(out.outcome, EventOutcome::Threw);
    assert_eq!(out.meter.status, MeterStatus::Error);
    assert_eq!(sent(&f.db).await.len(), 1);
    assert!(
        f.sink
            .lines()
            .iter()
            .any(|l| l.message == "event handler threw"
                && l.request_id.as_deref() == Some("01JBQ3Z7MA0000000000000002_email_3"))
    );

    // No handler for it any more: dropped, not retried.
    let mut gone = envelope("01JBQ3Z7MA0000000000000003", "i3", 1);
    gone.module = "billing".into();
    assert_eq!(deliver(&f, gone).await.outcome, EventOutcome::NoHandler);
}

/// A delivery attempt runs under the tier's CPU limit: a 100 ms handler
/// under the free tier's 50 ms is `cpu_limit`, and nothing is kept.
#[tokio::test]
async fn a_cpu_heavy_handler_reports_cpu_limit() {
    let _g = SERIAL.lock().await;
    let f = fixture(Limits::FREE).await;
    let out = deliver(&f, envelope("01JBQ3Z7MA0000000000000004", "spin", 1)).await;
    assert_eq!(
        out.meter.status,
        MeterStatus::CpuLimit,
        "{:?}",
        f.sink.lines()
    );
    assert!(matches!(out.outcome, EventOutcome::Failed(_)));
    assert!(sent(&f.db).await.is_empty());
}
