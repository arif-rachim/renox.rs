//! Issue #749: `db.scoped()` and `db.transaction` (`docs/contracts/ops.md`
//! 1.15.0, sections 1 and 17). V8-linked; drives a `CellManager` over a
//! local artifact store like `tests/jobs.rs`.
//!
//! `tx.scoped(scope)` runs on the transaction with the ownership fence of
//! `ctx.db.scoped()` (#612); the app's `ctx.db.scoped()` used while the
//! request holds a transaction is refused at once with `RENOX_DB_TX_STATE`,
//! where it used to wait for the request's own writer and fail with
//! `RENOX_DB_BUSY`.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use http_body_util::BodyExt;
use renox_cell::cell::LocalSecrets;
use renox_cell::manager::StaticTiers;
use renox_cell::pages::PlatformKey;
use renox_cell::{CellManager, LocalArtifactStore, ManagerConfig, TierName, Tiers};
use renox_data::{DbOptions, TenantDb, Value};
use renox_gateway::{CellDispatcher, RequestCtx};
use renox_meter::{Meter, MeterBatch, MeterConfig, Sink, SinkError};
use renox_runtime::{Runtime, RuntimeConfig};

static N: AtomicU64 = AtomicU64::new(0);
const TENANT: &str = "t_scoped_tx";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-scoped-tx-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[derive(Clone, Default)]
struct Discard;

impl Sink for Discard {
    async fn write_batch(&self, _batch: &MeterBatch) -> Result<(), SinkError> {
        Ok(())
    }
}

const APP: &str = r#"
const err = (e) => ({ code: e.code ?? null, message: e.message, reason: (e.details && e.details.reason) ?? null });

export async function GET(ctx) {
  const q = ctx.url.searchParams;
  if (q.get("case") === "tx_scoped") {
    // tx.scoped(): on the transaction, behind the ownership fence.
    const out = await ctx.db.transaction(async (tx) => {
      const out = { type: typeof tx.scoped };
      const s = tx.scoped({ user_id: "u1" });
      out.tx = typeof s.transaction;
      out.again = typeof s.scoped;
      await s.execute("insert into app__owned (id, note) values (1, 'mine')");
      out.insert_ok = true;
      try {
        await s.execute("insert into app__owned (id, user_id, note) values (2, 'u2', 'theirs')");
      } catch (e) {
        out.refused = err(e);
      }
      await tx.execute("insert into app__owned (id, user_id, note) values (3, 'u2', 'other')");
      out.update_changes = (await s.execute("update app__owned set note = 'x' where id = 3")).changes;
      out.visible = (await s.query("select id from app__owned order by id")).map((r) => r.id);
      out.all = (await tx.query("select id from app__owned order by id")).map((r) => r.id);
      // A savepoint's tx has it too, on the same transaction.
      out.nested = await ctx.db.transaction(async (sp) => {
        await sp.scoped({ user_id: "u1" }).execute("insert into app__owned (id, note) values (4, 'nested')");
        return (await sp.scoped({ user_id: "u1" }).query("select id from app__owned order by id")).map((r) => r.id);
      });
      return out;
    });
    return Response.json(out);
  }
  if (q.get("case") === "misuse") {
    // ctx.db.scoped() inside a transaction: made before the transaction
    // opens, and made inside it; both refused when the statement runs.
    const before = ctx.db.scoped({ user_id: "u1" });
    const out = await ctx.db.transaction(async (tx) => {
      const out = {};
      const t0 = Date.now();
      try {
        await before.execute("insert into app__owned (id, note) values (10, 'misuse')");
        out.execute = "ran";
      } catch (e) {
        out.execute = err(e);
      }
      try {
        await ctx.db.scoped({ user_id: "u1" }).query("select id from app__owned");
        out.query = "ran";
      } catch (e) {
        out.query = err(e);
      }
      out.elapsed_ms = Date.now() - t0;
      // The transaction itself goes on.
      await tx.scoped({ user_id: "u1" }).execute("insert into app__owned (id, note) values (11, 'after')");
      return out;
    });
    // Outside the transaction the same scoped Db works again.
    await before.execute("insert into app__owned (id, note) values (12, 'outside')");
    out.outside = (await before.query("select id from app__owned order by id")).map((r) => r.id);
    return Response.json(out);
  }
  return Response.json({});
}
"#;

fn artifact(store: &Path) -> String {
    let tmp = scratch("artifact");
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "scoped-tx", "timezone": "UTC" },
        "code": { "format": "esm-dir", "entry": { "functions/f": "functions/f.js" } },
        "routes": [
            { "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" },
        ],
        "permissions": { "network": [], "secrets": [] },
        "authz": { "actions": [], "ownership": { "app__owned": { "owner": "user_id" } } },
        "modules": [],
    });
    let files: Vec<(&str, String)> = vec![
        (
            "manifest.json",
            serde_json::to_string_pretty(&manifest).unwrap(),
        ),
        ("code/functions/f.js", APP.into()),
    ];
    for (p, src) in &files {
        let path = tmp.join(p);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, src).unwrap();
    }
    let hash = renox_cell::artifact::canonical_hash(&tmp).unwrap();
    std::fs::rename(&tmp, store.join(&hash)).unwrap();
    hash
}

fn open(data: &Path) -> TenantDb {
    let dir = data.join(TENANT);
    std::fs::create_dir_all(&dir).unwrap();
    TenantDb::open(dir.join("app.db"), DbOptions::default()).unwrap()
}

fn owners(data: &Path) -> Vec<(i64, String)> {
    let db = open(data);
    db.query("select id, user_id from app__owned order by id", &[])
        .unwrap()
        .iter()
        .map(|r| match (r.get("id"), r.get("user_id")) {
            (Some(Value::Integer(i)), Some(Value::Text(u))) => (*i, u.clone()),
            other => panic!("{other:?}"),
        })
        .collect()
}

struct Node {
    manager: CellManager,
    hash: String,
}

fn setup() -> (PathBuf, Node) {
    let data = scratch("data");
    let artifacts = scratch("artifacts");
    let hash = artifact(&artifacts);
    let db = open(&data);
    db.execute(
        "create table if not exists app__owned (id integer, user_id text, note text)",
        &[],
    )
    .unwrap();
    db.close().unwrap();
    let meter = Meter::start(MeterConfig::new("t_scoped_tx@test", "test", &data), Discard);
    let manager = CellManager::new(
        Runtime::new(RuntimeConfig::default()),
        meter,
        ManagerConfig {
            data_dir: data.clone(),
            artifacts: Arc::new(LocalArtifactStore::new(&artifacts)),
            idle_timeout: Duration::from_secs(600),
            tiers: Tiers::default(),
            deployments: Arc::new(StaticTiers {
                default_tier: TierName::Free,
                tenant_tiers: BTreeMap::new(),
            }),
            secrets: Arc::new(LocalSecrets {
                data_dir: data.clone(),
            }),
            platform_key: PlatformKey::random(),
        },
    );
    (data, Node { manager, hash })
}

impl Node {
    async fn get(&self, query: &str) -> serde_json::Value {
        let ctx = RequestCtx {
            tenant_id: TENANT.into(),
            deployment_hash: self.hash.clone(),
            request_id: format!("req_{}", N.fetch_add(1, Ordering::SeqCst)),
            deadline: Instant::now() + Duration::from_secs(30),
            client_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            csp_nonce: "n".into(),
        };
        let req = http::Request::builder()
            .uri(format!("https://t.renox.app/?{query}"))
            .header("host", "t.renox.app")
            .body(axum::body::Body::empty())
            .unwrap();
        let res = self.manager.dispatch(ctx, req).await;
        let body = res.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&body)
            .unwrap_or_else(|_| serde_json::json!({ "raw": String::from_utf8_lossy(&body) }))
    }
}

/// `tx.scoped()` writes through the fence on the transaction: the owner is
/// filled in, a row for another owner is refused (`RENOX_DB_SCOPE`,
/// `owner_mismatch`), another owner's row is not updated, and a scoped read
/// sees the owner's rows only, uncommitted ones included.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tx_scoped_runs_in_the_transaction_with_the_ownership_fence() {
    let (data, n) = setup();
    let v = n.get("case=tx_scoped").await;
    assert_eq!(
        v,
        serde_json::json!({
            "type": "function", "tx": "undefined", "again": "undefined", "insert_ok": true,
            "refused": { "code": "RENOX_DB_SCOPE", "message": v["refused"]["message"], "reason": "owner_mismatch" },
            "update_changes": 0, "visible": [1], "all": [1, 3], "nested": [1, 4],
        }),
        "{v}"
    );
    assert_eq!(
        owners(&data),
        vec![(1, "u1".into()), (3, "u2".into()), (4, "u1".into())]
    );
}

/// The app's `ctx.db.scoped()` inside `ctx.db.transaction` is refused at
/// once with `RENOX_DB_TX_STATE` (no wait for the writer), whether the
/// scoped `Db` was made before the transaction or inside it; the
/// transaction goes on, and the same scoped `Db` works again after it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ctx_db_scoped_inside_a_transaction_is_refused_at_once() {
    let (data, n) = setup();
    let t = Instant::now();
    let v = n.get("case=misuse").await;
    let elapsed = t.elapsed();
    let refusal = serde_json::json!({
        "code": "RENOX_DB_TX_STATE",
        "message": "use tx.scoped(...) inside a transaction",
        "reason": null,
    });
    assert_eq!(v["execute"], refusal, "{v}");
    assert_eq!(v["query"], refusal, "{v}");
    assert!(v["elapsed_ms"].as_i64().unwrap() < 100, "{v}");
    assert!(elapsed < Duration::from_secs(5), "{elapsed:?}");
    assert_eq!(v["outside"], serde_json::json!([11, 12]), "{v}");
    assert_eq!(owners(&data), vec![(11, "u1".into()), (12, "u1".into())]);
}
