//! Issue #322: the `webhook` route kind and `op_webhook_verify`
//! (`docs/contracts/ops.md` 1.7.0 section 22). V8-linked.
//!
//! Proves the `docs/23-failure-modes.md` row "Webhooks: bad signature,
//! replayed id, provider rate limit": each provider's valid and tampered
//! signature, a replayed event id answered 200 without the handler going
//! on, and the bucket that drops only unverified requests.

mod support;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use hmac::{Hmac, KeyInit, Mac};
use renox_data::{AuthorizerPolicy, DbOptions, TenantDb, Value};
use renox_runtime::ops::db::DbHandle;
use renox_runtime::{IsolateHandle, Runtime, RuntimeConfig};
use sha2::Sha256;
use support::{body_json, ctx, scratch, spec, write_artifact};

const PROVIDERS: &[(&str, &str)] = &[
    ("checkout", "cko-signature"),
    ("telr", "x-telr-signature"),
    ("paytabs", "signature"),
    ("ngenius", "x-ngenius-signature"),
    ("tabby", "x-tabby-signature"),
    ("tamara", "tamara-signature"),
];

/// One webhook route per provider; each handler counts its runs.
fn source(provider: &str) -> String {
    format!(
        r#"
export async function POST(ctx) {{
  const e = await ctx.webhook.verify(ctx.req, {opts});
  await ctx.db.execute("insert into app__runs (provider, event_id) values (?, ?)", [e.provider, e.event_id]);
  return Response.json({{ ok: true, id: e.event_id, payload: e.payload }});
}}
"#,
        opts = if provider == "generic" {
            r#"{ secret: ctx.secrets.GENERIC_HOOK_KEY, header: "X-Hook-Signature" }"#.to_string()
        } else {
            format!(r#"{{ provider: "{provider}" }}"#)
        }
    )
}

fn secret_of(provider: &str) -> String {
    format!("WEBHOOK_{}_SECRET", provider.to_uppercase())
}

async fn isolate(rt: &Runtime, db: DbHandle) -> IsolateHandle {
    let mut providers: Vec<&str> = PROVIDERS.iter().map(|(p, _)| *p).collect();
    providers.extend(["stripe", "generic", "apple"]);
    let mut entry = serde_json::Map::new();
    let mut routes = Vec::new();
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for p in &providers {
        let id = format!("functions/webhooks/{p}");
        entry.insert(id.clone(), format!("{id}.js").into());
        routes.push(serde_json::json!({ "kind": "webhook", "path": format!("/webhooks/{p}"), "module": id, "export": "POST", "provider": p }));
        files.push((format!("code/{id}.js"), source(p).into_bytes()));
    }
    let mut secrets: Vec<String> = providers
        .iter()
        .filter(|p| **p != "generic")
        .map(|p| secret_of(p))
        .collect();
    secrets.push("GENERIC_HOOK_KEY".into());
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "hooks", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": entry },
        "routes": routes,
        "permissions": { "network": [], "secrets": secrets },
    });
    files.push((
        "manifest.json".into(),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    ));
    let refs: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(p, b)| (p.as_str(), b.as_slice()))
        .collect();
    let (dir, hash) = write_artifact(&refs);
    let mut s = spec(&dir, &hash, renox_runtime::limits::Limits::FREE);
    s.db = Some(db);
    s.secrets = secrets
        .iter()
        .map(|n| (n.clone(), format!("{}-secret-0123456789", n.to_lowercase())))
        .collect();
    rt.create_isolate(s).await.unwrap()
}

fn key(provider: &str) -> String {
    if provider == "generic" {
        "generic_hook_key-secret-0123456789".into()
    } else {
        format!("{}-secret-0123456789", secret_of(provider).to_lowercase())
    }
}

fn hmac_hex(key: &str, parts: &[&[u8]]) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
    for p in parts {
        m.update(p);
    }
    m.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn db() -> (DbHandle, std::path::PathBuf) {
    let dir = scratch("webhooks-db");
    let path = dir.join("t.db");
    let db = TenantDb::open(&path, DbOptions::default()).unwrap();
    db.execute("create table app__runs (provider text, event_id text)", &[])
        .unwrap();
    let db = db.with_authorizer(AuthorizerPolicy::module("app")).unwrap();
    (DbHandle::spawn(db).unwrap(), path)
}

fn post(path: &str, body: &[u8], headers: &[(&str, String)]) -> http::Request<Bytes> {
    let mut b = http::Request::builder()
        .method("POST")
        .uri(format!("https://hooks.renox.app{path}"))
        .header("content-type", "application/json");
    for (k, v) in headers {
        b = b.header(*k, v.as_str());
    }
    b.body(Bytes::copy_from_slice(body)).unwrap()
}

fn runs(path: &std::path::Path) -> i64 {
    let db = TenantDb::open(path, DbOptions::default()).unwrap();
    match db
        .query_one("select count(*) as n from app__runs", &[])
        .unwrap()
        .and_then(|r| r.get("n").cloned())
    {
        Some(Value::Integer(n)) => n,
        _ => -1,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_provider_accepts_its_signature_and_refuses_a_tampered_one() {
    let rt = Runtime::new(RuntimeConfig::default());
    let (handle, path) = db();
    let iso = isolate(&rt, handle).await;
    let mut n = 0;
    for (provider, header) in PROVIDERS
        .iter()
        .copied()
        .chain([("generic", "x-hook-signature")])
    {
        n += 1;
        let body = format!(r#"{{"id":"evt_{provider}","amount":105}}"#);
        let sig = hmac_hex(&key(provider), &[body.as_bytes()]);
        let ok = iso
            .dispatch(
                ctx(&format!("req_ok_{provider}_00000001")),
                post(
                    &format!("/webhooks/{provider}"),
                    body.as_bytes(),
                    &[(header, sig.clone())],
                ),
            )
            .await;
        assert_eq!(
            ok.response.status(),
            200,
            "{provider}: {:?}",
            String::from_utf8_lossy(ok.response.body())
        );
        let v = body_json(&ok.response);
        assert_eq!(v["id"], format!("evt_{provider}"));
        assert_eq!(v["payload"]["amount"], 105);
        let bad = iso
            .dispatch(
                ctx(&format!("req_bad_{provider}_0000001")),
                post(
                    &format!("/webhooks/{provider}"),
                    br#"{"id":"evt_forged"}"#,
                    &[(header, sig)],
                ),
            )
            .await;
        assert_eq!(bad.response.status(), 401, "{provider}");
        assert_eq!(
            body_json(&bad.response)["error"]["code"],
            "RENOX_WEBHOOK_SIGNATURE"
        );
    }
    // Stripe: `t.body`, v1, and the 300 s tolerance.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let body = br#"{"id":"evt_stripe_1","type":"invoice.paid"}"#;
    let header = |t: u64| {
        format!(
            "t={t},v1={}",
            hmac_hex(&key("stripe"), &[t.to_string().as_bytes(), b".", body])
        )
    };
    let ok = iso
        .dispatch(
            ctx("req_stripe_ok_000001"),
            post(
                "/webhooks/stripe",
                body,
                &[("stripe-signature", header(now))],
            ),
        )
        .await;
    assert_eq!(ok.response.status(), 200);
    let old = iso
        .dispatch(
            ctx("req_stripe_old_00001"),
            post(
                "/webhooks/stripe",
                body,
                &[("stripe-signature", header(now - 3600))],
            ),
        )
        .await;
    assert_eq!(old.response.status(), 401, "outside the tolerance");
    // Apple's JWS is not verified yet: refused, never accepted.
    let apple = iso
        .dispatch(
            ctx("req_apple_00000001"),
            post("/webhooks/apple", b"{}", &[]),
        )
        .await;
    assert_eq!(apple.response.status(), 401);
    // Only verified deliveries reached the handler body.
    assert_eq!(runs(&path), n + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replayed_event_id_answers_200_without_running_the_handler_again() {
    let rt = Runtime::new(RuntimeConfig::default());
    let (handle, path) = db();
    let iso = isolate(&rt, handle).await;
    let body = br#"{"id":"evt_replay","amount":1}"#;
    let sig = hmac_hex(&key("checkout"), &[body]);
    let first = iso
        .dispatch(
            ctx("req_replay_first_01"),
            post(
                "/webhooks/checkout",
                body,
                &[("cko-signature", sig.clone())],
            ),
        )
        .await;
    assert_eq!(body_json(&first.response)["ok"], true);
    let again = iso
        .dispatch(
            ctx("req_replay_again_01"),
            post("/webhooks/checkout", body, &[("cko-signature", sig)]),
        )
        .await;
    assert_eq!(again.response.status(), 200);
    assert_eq!(
        body_json(&again.response),
        serde_json::json!({ "duplicate": true })
    );
    assert_eq!(runs(&path), 1, "the handler ran once");
    let events = TenantDb::open(&path, DbOptions::default()).unwrap();
    let n = events
        .with_policy(None, || {
            events.query_one("select count(*) as n from renox__webhook_events", &[])
        })
        .unwrap()
        .unwrap()
        .and_then(|r| r.get("n").cloned());
    assert_eq!(n, Some(Value::Integer(1)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_bucket_drops_only_unverified_requests() {
    let rt = Runtime::new(RuntimeConfig::default());
    let (handle, _path) = db();
    let iso: Arc<IsolateHandle> = Arc::new(isolate(&rt, handle).await);
    // Exhaust the unverified bucket of `telr` (500, a refill of 50 per second).
    let mut limited = 0;
    for i in 0..700 {
        let r = iso
            .dispatch(
                ctx(&format!("req_flood_{i:08}")),
                post(
                    "/webhooks/telr",
                    b"{\"id\":\"x\"}",
                    &[("x-telr-signature", "00".into())],
                ),
            )
            .await;
        match r.response.status().as_u16() {
            401 => {}
            429 => limited += 1,
            s => panic!("unexpected {s}"),
        }
    }
    assert!(limited > 0, "the flood is rate limited");
    // A verified delivery still goes through.
    let body = br#"{"id":"evt_after_flood"}"#;
    let sig = hmac_hex(&key("telr"), &[body]);
    let ok = iso
        .dispatch(
            ctx("req_after_flood_001"),
            post("/webhooks/telr", body, &[("x-telr-signature", sig)]),
        )
        .await;
    assert_eq!(
        ok.response.status(),
        200,
        "a verified event is never dropped"
    );
}
