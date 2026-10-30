//! Issue #321: `ctx.storage` (`docs/contracts/ops.md` 1.7.0 section 21).
//! V8-linked; drives a `CellManager` with the local file store.
//!
//! Proves the `docs/23-failure-modes.md` storage rows: a put within the
//! quota and one past it, an oversized file, a disallowed type, SVG with a
//! script, a key of another module, a signed URL that works and one that
//! expired or was altered, and listing under the caller's prefix only.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use http_body_util::BodyExt;
use renox_cell::cell::LocalSecrets;
use renox_cell::manager::StaticTiers;
use renox_cell::pages::PlatformKey;
use renox_cell::storage::CellStorage;
use renox_cell::{CellManager, LocalArtifactStore, ManagerConfig, TierName, Tiers};
use renox_data::{DbOptions, TenantDb, Value};
use renox_gateway::{CellDispatcher, RequestCtx};
use renox_meter::{Meter, MeterBatch, MeterConfig, MeterRecord, Sink, SinkError};
use renox_runtime::ops::storage::StorageLimits;
use renox_runtime::{Runtime, RuntimeConfig};

static N: AtomicU64 = AtomicU64::new(0);
const TENANT: &str = "t_files";
const KEY: [u8; 32] = [9u8; 32];

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-storage-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[derive(Clone, Default)]
struct Records(Arc<Mutex<Vec<MeterRecord>>>);

impl Sink for Records {
    async fn write_batch(&self, batch: &MeterBatch) -> Result<(), SinkError> {
        self.0.lock().unwrap().extend(batch.records.iter().cloned());
        Ok(())
    }
}

/// `POST /?op=put&key=…&type=…[&public=1][&sanitised=1]` with the bytes as the body.
const APP: &str = r#"
const run = async (f) => { try { return await f(); } catch (e) { return { error: e.code ?? e.name, details: e.details ?? null, name: e.name }; } };
export async function POST(ctx) {
  const q = ctx.url.searchParams;
  const bytes = new Uint8Array(await ctx.req.arrayBuffer());
  return Response.json(await run(() => ctx.storage.put(q.get("key"), bytes, {
    contentType: q.get("type"), public: q.get("public") === "1", sanitised: q.get("sanitised") === "1",
  })));
}
export async function GET(ctx) {
  const q = ctx.url.searchParams;
  const op = q.get("op");
  if (op === "get") return Response.json(await run(() => ctx.storage.get(q.get("key"))));
  if (op === "read") return Response.json(await run(async () => new TextDecoder().decode(await ctx.storage.read(q.get("key")))));
  if (op === "delete") return Response.json(await run(() => ctx.storage.delete(q.get("key"))));
  if (op === "sign") return Response.json(await run(() => ctx.storage.sign(q.get("key"), Number(q.get("ttl")))));
  if (op === "list") return Response.json(await run(() => ctx.storage.list(q.get("prefix"), { limit: Number(q.get("limit") ?? 100), cursor: q.get("cursor") })));
  return Response.json({});
}
"#;

fn artifact(store: &Path) -> String {
    let tmp = scratch("artifact");
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "files", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": { "functions/f": "functions/f.js" } },
        "routes": [
            { "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" },
            { "kind": "function", "method": "POST", "path": "/", "module": "functions/f", "export": "POST" },
        ],
        "permissions": { "network": [], "secrets": [] },
        "storage": { "allowed_types": ["image/jpeg", "image/png", "text/plain", "image/svg+xml"] },
    });
    for (p, src) in [
        (
            "manifest.json",
            serde_json::to_string_pretty(&manifest).unwrap(),
        ),
        ("code/functions/f.js", APP.to_string()),
    ] {
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

struct Node {
    manager: CellManager,
    records: Records,
    hash: String,
    data: PathBuf,
}

fn node(name: &str) -> Node {
    let root = scratch(name);
    let (data, store) = (root.join("data"), root.join("artifacts"));
    std::fs::create_dir_all(&store).unwrap();
    open(&data).close().unwrap();
    let hash = artifact(&store);
    let records = Records::default();
    let meter = Meter::start(
        MeterConfig {
            flush_interval: Duration::from_millis(20),
            ..MeterConfig::new("t_files@test", "test", &data)
        },
        records.clone(),
    );
    let manager = CellManager::new(
        Runtime::new(RuntimeConfig::default()),
        meter,
        ManagerConfig {
            data_dir: data.clone(),
            artifacts: Arc::new(LocalArtifactStore::new(&store)),
            idle_timeout: Duration::from_secs(600),
            tiers: Tiers::default(),
            deployments: Arc::new(StaticTiers {
                default_tier: TierName::Free,
                tenant_tiers: BTreeMap::new(),
            }),
            secrets: Arc::new(LocalSecrets {
                data_dir: data.clone(),
            }),
            platform_key: PlatformKey::from_bytes(&KEY).unwrap(),
        },
    );
    Node {
        manager,
        records,
        hash,
        data,
    }
}

impl Node {
    async fn call(
        &self,
        method: &str,
        uri: &str,
        body: Vec<u8>,
    ) -> (String, u16, http::HeaderMap, Vec<u8>) {
        let request_id = format!("req_{}", N.fetch_add(1, Ordering::SeqCst));
        let ctx = RequestCtx {
            tenant_id: TENANT.into(),
            deployment_hash: self.hash.clone(),
            request_id: request_id.clone(),
            deadline: Instant::now() + Duration::from_secs(30),
            client_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            csp_nonce: "n".into(),
        };
        let req = http::Request::builder()
            .method(method)
            .uri(format!("https://f.renox.app{uri}"))
            .header("host", "f.renox.app")
            .body(axum::body::Body::from(body))
            .unwrap();
        let res = self.manager.dispatch(ctx, req).await;
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        (request_id, status, headers, body)
    }

    async fn json(&self, method: &str, uri: &str, body: Vec<u8>) -> (String, serde_json::Value) {
        let (id, _, _, b) = self.call(method, uri, body).await;
        (
            id,
            serde_json::from_slice(&b).unwrap_or(serde_json::Value::Null),
        )
    }

    async fn put(
        &self,
        key: &str,
        ty: &str,
        extra: &str,
        body: &[u8],
    ) -> (String, serde_json::Value) {
        self.json(
            "POST",
            &format!("/?key={key}&type={ty}{extra}"),
            body.to_vec(),
        )
        .await
    }

    async fn record(&self, request_id: &str) -> MeterRecord {
        for _ in 0..100 {
            if let Some(r) = self
                .records
                .0
                .lock()
                .unwrap()
                .iter()
                .find(|r| r.request_id == request_id)
            {
                return r.clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("no meter record for {request_id}");
    }
}

fn png() -> Vec<u8> {
    let img = image::RgbImage::from_pixel(8, 6, image::Rgb([200, 30, 30]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_put_within_the_quota_is_stored_with_its_metadata_and_metered() {
    let n = node("put");
    let (id, f) = n
        .put("app/photos/a.png", "image/png", "&public=1", &png())
        .await;
    assert_eq!(f["key"], "app/photos/a.png", "{f}");
    assert_eq!(f["content_type"], "image/png");
    assert_eq!(f["width"], 8);
    assert_eq!(f["height"], 6);
    assert_eq!(f["public"], true);
    assert_eq!(f["sha256"].as_str().unwrap().len(), 64);
    let rec = n.record(&id).await;
    assert_eq!(
        rec.storage_bytes,
        Some(png().len() as u64),
        "storage_bytes on the put's record"
    );
    let (_, got) = n.json("GET", "/?op=get&key=app/photos/a.png", vec![]).await;
    assert_eq!(got["bytes"], png().len());
    // The bytes are in the tenant's prefix of the store, not in the isolate.
    assert!(
        n.data
            .join("files/tenants/t_files/files/app/photos/a.png")
            .exists()
    );
    let (_, txt) = n.put("app/notes/n.txt", "text/plain", "", b"hello").await;
    assert_eq!(txt["width"], serde_json::Value::Null);
    let (_, read) = n.json("GET", "/?op=read&key=app/notes/n.txt", vec![]).await;
    assert_eq!(read, "hello");
    let (_, del) = n
        .json("GET", "/?op=delete&key=app/notes/n.txt", vec![])
        .await;
    assert_eq!(del, true);
    let (_, gone) = n.json("GET", "/?op=get&key=app/notes/n.txt", vec![]).await;
    assert_eq!(gone["error"], "RENOX_STORAGE_NOT_FOUND", "{gone}");
    assert_eq!(gone["name"], "StorageError");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quota_size_type_svg_and_key_refusals() {
    let n = node("refusals");
    // Past the per-file limit of the free tier.
    let big = vec![b'a'; StorageLimits::FREE.file_bytes as usize + 1];
    let (_, r) = n.put("app/big.txt", "text/plain", "", &big).await;
    assert_eq!(r["error"], "RENOX_STORAGE_TOO_LARGE", "{r}");
    // Past the quota: the tenant already stores almost all of it.
    let db = open(&n.data);
    db.with_policy(None, || {
        db.execute(
            "insert into renox__files (key, module, bytes, content_type, sha256, public, created_at) values (?, 'app', ?, 'text/plain', '', 0, 0)",
            &[Value::Text("app/filler.txt".into()), Value::Integer(StorageLimits::FREE.quota_bytes as i64 - 3)],
        )
    })
    .unwrap()
    .unwrap();
    db.close().unwrap();
    let (_, q) = n.put("app/one.txt", "text/plain", "", b"four").await;
    assert_eq!(q["error"], "RENOX_STORAGE_QUOTA", "{q}");
    // A type outside allowed_types, a declared type the bytes contradict, unsanitised SVG.
    let (_, t) = n
        .put("app/x.pdf", "application/pdf", "", b"%PDF-1.7\n")
        .await;
    assert_eq!(t["error"], "RENOX_STORAGE_TYPE", "{t}");
    assert_eq!(t["details"]["reason"], "not_allowed");
    let (_, m) = n
        .put(
            "app/x.png",
            "image/png",
            "",
            &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0],
        )
        .await;
    assert_eq!(m["details"]["reason"], "mismatch", "{m}");
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#;
    let (_, s) = n.put("app/x.svg", "image/svg%2Bxml", "", svg).await;
    assert_eq!(s["details"]["reason"], "svg_unsanitised", "{s}");
    let (_, disguised) = n.put("app/x.txt", "text/plain", "", svg).await;
    assert_eq!(
        disguised["details"]["reason"], "mismatch",
        "SVG bytes as text/plain: {disguised}"
    );
    // Keys: another module's prefix, a dot segment.
    let (_, k) = n.put("tax/x.txt", "text/plain", "", b"x").await;
    assert_eq!(k["error"], "RENOX_STORAGE_KEY", "{k}");
    let (_, dots) = n.put("app/../tax/x.txt", "text/plain", "", b"x").await;
    assert_eq!(dots["error"], "RENOX_STORAGE_KEY", "{dots}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_signed_url_serves_a_private_file_until_it_expires_and_only_unaltered() {
    let n = node("sign");
    n.put("app/private/report.txt", "text/plain", "", b"quarterly")
        .await;
    // Unsigned: a private file is not found.
    let (_, status, _, _) = n
        .call("GET", "/_files/app/private/report.txt", vec![])
        .await;
    assert_eq!(status, 404);
    let (_, signed) = n
        .json("GET", "/?op=sign&key=app/private/report.txt&ttl=60", vec![])
        .await;
    let url = signed["url"].as_str().unwrap().to_string();
    assert!(
        url.starts_with("/_files/app/private/report.txt?exp="),
        "{url}"
    );
    let (_, status, headers, body) = n.call("GET", &url, vec![]).await;
    assert_eq!(status, 200);
    assert_eq!(body, b"quarterly");
    assert_eq!(headers["content-type"], "text/plain");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["cache-control"], "private, no-store");
    // Altered and expired signatures.
    let altered = format!("{}0", &url[..url.len() - 1]);
    assert_eq!(n.call("GET", &altered, vec![]).await.1, 404);
    let host = CellStorage::new(
        renox_cell::storage::local_store(&n.data),
        &PlatformKey::from_bytes(&KEY).unwrap(),
        TENANT,
        StorageLimits::FREE,
    );
    let past = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        - 10;
    use renox_runtime::ops::storage::StorageHost;
    let sig = host.sign(TENANT, "/_files/app/private/report.txt", past);
    let expired = format!("/_files/app/private/report.txt?exp={past}&sig={sig}");
    assert_eq!(
        n.call("GET", &expired, vec![]).await.1,
        404,
        "an expired signature"
    );
    let fresh = past + 3600;
    let ok = format!(
        "/_files/app/private/report.txt?exp={fresh}&sig={}",
        host.sign(TENANT, "/_files/app/private/report.txt", fresh)
    );
    assert_eq!(
        n.call("GET", &ok, vec![]).await.1,
        200,
        "the same key signs what the op signs"
    );
    let (_, range) = n
        .json("GET", "/?op=sign&key=app/private/report.txt&ttl=5", vec![])
        .await;
    assert_eq!(range["name"], "RangeError", "{range}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_answers_the_callers_prefix_only_in_pages() {
    let n = node("list");
    for i in 0..5 {
        n.put(&format!("app/docs/{i}.txt"), "text/plain", "", b"x")
            .await;
    }
    n.put("app/other/z.txt", "text/plain", "", b"x").await;
    let (_, page) = n
        .json("GET", "/?op=list&prefix=app/docs/&limit=3", vec![])
        .await;
    let keys: Vec<&str> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["key"].as_str().unwrap())
        .collect();
    assert_eq!(
        keys,
        ["app/docs/0.txt", "app/docs/1.txt", "app/docs/2.txt"],
        "{page}"
    );
    let cursor = page["next_cursor"].as_str().unwrap().to_string();
    let (_, next) = n
        .json(
            "GET",
            &format!("/?op=list&prefix=app/docs/&limit=3&cursor={cursor}"),
            vec![],
        )
        .await;
    assert_eq!(next["items"].as_array().unwrap().len(), 2);
    assert_eq!(next["next_cursor"], serde_json::Value::Null);
    let (_, all) = n.json("GET", "/?op=list&prefix=", vec![]).await;
    assert_eq!(all["items"].as_array().unwrap().len(), 6);
    let (_, other) = n.json("GET", "/?op=list&prefix=tax/", vec![]).await;
    assert_eq!(other["error"], "RENOX_STORAGE_KEY", "{other}");
}
