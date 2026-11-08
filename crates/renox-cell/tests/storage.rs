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
  if (op === "sign_upload") return Response.json(await run(() => ctx.storage.signUpload(q.get("key"), {
    contentType: q.get("type"), maxBytes: Number(q.get("max")),
    ttlSeconds: q.get("ttl") === null ? undefined : Number(q.get("ttl")), public: q.get("public") === "1",
  })));
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
    if cfg!(feature = "media") {
        assert_eq!(f["width"], 8);
        assert_eq!(f["height"], 6);
    } else {
        // Without the image pipeline (#372) the dimensions are unknown.
        assert!(f["width"].is_null() && f["height"].is_null(), "{f}");
    }
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
    // A different last character (replacing it with a fixed one is no
    // change when the signature already ends in it).
    let last = if url.ends_with('0') { '1' } else { '0' };
    let altered = format!("{}{last}", &url[..url.len() - 1]);
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

// ---------------------------------------------------------------------------
// #580: `ctx.storage.signUpload` and the signed `PUT /_files/<key>` (ops.md 1.10.0 section 21)
// ---------------------------------------------------------------------------

impl Node {
    /// `GET /?op=sign_upload&key=…&type=…&max=…[extra]`: the answer of `ctx.storage.signUpload`.
    async fn sign_upload(&self, key: &str, ty: &str, max: u64, extra: &str) -> serde_json::Value {
        let ty = ty.replace('/', "%2F").replace('+', "%2B");
        self.json(
            "GET",
            &format!("/?op=sign_upload&key={key}&type={ty}&max={max}{extra}"),
            vec![],
        )
        .await
        .1
    }

    /// The browser's `PUT`: the status, headers and JSON body. `declare` sets `Content-Length`.
    async fn upload(
        &self,
        url: &str,
        content_type: Option<&str>,
        body: Vec<u8>,
        declare: bool,
    ) -> (u16, http::HeaderMap, serde_json::Value) {
        let request_id = format!("req_{}", N.fetch_add(1, Ordering::SeqCst));
        let ctx = RequestCtx {
            tenant_id: TENANT.into(),
            deployment_hash: self.hash.clone(),
            request_id,
            deadline: Instant::now() + Duration::from_secs(30),
            client_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            csp_nonce: "n".into(),
        };
        let mut req = http::Request::builder()
            .method("PUT")
            .uri(format!("https://f.renox.app{url}"))
            .header("host", "f.renox.app");
        if let Some(ct) = content_type {
            req = req.header("content-type", ct);
        }
        if declare {
            req = req.header("content-length", body.len());
        }
        // A stream of unknown length unless `declare`: the cell must cut it at `max` itself.
        let body = if declare {
            axum::body::Body::from(body)
        } else {
            let chunks: Vec<Result<Vec<u8>, std::io::Error>> =
                body.chunks(64 * 1024).map(|c| Ok(c.to_vec())).collect();
            axum::body::Body::from_stream(futures_util::stream::iter(chunks))
        };
        let res = self.manager.dispatch(ctx, req.body(body).unwrap()).await;
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            headers,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    fn files_rows(&self, sql: &str) -> Vec<renox_data::Row> {
        let db = open(&self.data);
        let rows = db
            .with_policy(None, || db.query(sql, &[]))
            .unwrap()
            .unwrap();
        db.close().unwrap();
        rows
    }
}

/// A PNG of `len` bytes: the real header, then padding (only the first 512 bytes are sniffed).
fn png_of(len: usize) -> Vec<u8> {
    let mut b = png();
    assert!(len >= b.len());
    b.resize(len, 0);
    b
}

fn query_of(url: &str, name: &str) -> String {
    url.split_once('?')
        .unwrap()
        .1
        .split('&')
        .find_map(|p| p.strip_prefix(&format!("{name}=")))
        .unwrap()
        .to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_signed_put_stores_2_mib_once_and_a_second_put_is_409() {
    let n = node("upload_ok");
    let signed = n
        .sign_upload("app/up/a.png", "image/png", 3 * 1024 * 1024, "")
        .await;
    let url = signed["url"].as_str().unwrap().to_string();
    assert!(url.starts_with("/_files/app/up/a.png?exp="), "{signed}");
    assert!(
        url.contains("&max=3145728&ct=image%2Fpng&pub=0&sig="),
        "{url}"
    );
    assert_eq!(signed["max_bytes"], 3 * 1024 * 1024);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let expires = signed["expires_at"].as_u64().unwrap();
    assert!(
        expires > now_ms + 890_000 && expires < now_ms + 910_000,
        "the default ttl is 900 s: {signed}"
    );
    // base64url, 43 characters (SHA-256), never hex padding.
    let sig = query_of(&url, "sig");
    assert_eq!(sig.len(), 43, "{sig}");
    assert!(
        sig.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
        "{sig}"
    );

    let body = png_of(2 * 1024 * 1024);
    let (status, _, f) = n.upload(&url, Some("image/png"), body.clone(), true).await;
    assert_eq!(status, 201, "{f}");
    assert_eq!(f["key"], "app/up/a.png");
    assert_eq!(f["bytes"], 2 * 1024 * 1024);
    assert_eq!(f["content_type"], "image/png");
    assert_eq!(f["public"], false);
    let rows = n.files_rows("select key, module, bytes, public from renox__files");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get("bytes"), Some(&Value::Integer(2 * 1024 * 1024)));
    assert_eq!(rows[0].get("module"), Some(&Value::Text("app".into())));
    assert!(
        n.data
            .join("files/tenants")
            .join(TENANT)
            .join("files/app/up/a.png")
            .exists(),
        "the bytes are in the tenant's prefix of the store"
    );
    // The file is the same one `ctx.storage.get` sees.
    let (_, got) = n.json("GET", "/?op=get&key=app/up/a.png", vec![]).await;
    assert_eq!(got["bytes"], 2 * 1024 * 1024, "{got}");

    // Single use: the same URL again, even with the right bytes.
    let (status, _, again) = n.upload(&url, Some("image/png"), body, true).await;
    assert_eq!(status, 409, "{again}");
    assert_eq!(again["error"]["code"], "RENOX_STORAGE_CONFLICT", "{again}");
    // Only the spent hash is kept, never the signature.
    let sigs = n.files_rows("select sig_hash from renox__upload_sigs");
    assert_eq!(sigs.len(), 1);
    assert_ne!(sigs[0].get("sig_hash"), Some(&Value::Text(sig)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upload_signature_covers_every_parameter_and_expires() {
    let n = node("upload_forged");
    let signed = n
        .sign_upload("app/up/f.png", "image/png", 3 * 1024 * 1024, "")
        .await;
    let url = signed["url"].as_str().unwrap().to_string();
    let body = png_of(1000);
    for (what, forged) in [
        ("max", url.replace("max=3145728", "max=3145729")),
        ("ct", url.replace("ct=image%2Fpng", "ct=text%2Fplain")),
        ("pub", url.replace("pub=0", "pub=1")),
        ("key", url.replace("app/up/f.png", "app/up/g.png")),
        ("exp", url.replacen("exp=", "exp=1", 1)),
        ("sig", {
            let last = if url.ends_with('A') { 'B' } else { 'A' };
            format!("{}{last}", &url[..url.len() - 1])
        }),
        ("no sig", url[..url.find("&sig=").unwrap()].to_string()),
    ] {
        let ty = if what == "ct" {
            "text/plain"
        } else {
            "image/png"
        };
        let (status, headers, r) = n.upload(&forged, Some(ty), body.clone(), true).await;
        assert_eq!(status, 404, "{what}: {r}");
        assert_eq!(r["error"]["code"], "RENOX_STORAGE_NOT_FOUND", "{what}: {r}");
        assert!(
            !headers
                .keys()
                .any(|k| k.as_str().starts_with("access-control-")),
            "same origin only"
        );
    }
    // An expired signature (made with the node's own key).
    let host = CellStorage::new(
        renox_cell::storage::local_store(&n.data),
        &PlatformKey::from_bytes(&KEY).unwrap(),
        TENANT,
        StorageLimits::FREE,
    );
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let sign = |exp: u64| {
        let sig = host.mac_upload("app/up/e.png", exp, 5000, "image%2Fpng", false);
        format!("/_files/app/up/e.png?exp={exp}&max=5000&ct=image%2Fpng&pub=0&sig={sig}")
    };
    let (status, _, r) = n
        .upload(&sign(now - 10), Some("image/png"), body.clone(), true)
        .await;
    assert_eq!(status, 404, "expired: {r}");
    let (status, _, r) = n
        .upload(&sign(now + 600), Some("image/png"), body, true)
        .await;
    assert_eq!(status, 201, "the same key signs what the op signs: {r}");
    // Nothing was stored for the forged attempts.
    assert_eq!(n.files_rows("select key from renox__files").len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_put_does_not_spend_the_url() {
    let n = node("upload_retry");
    let signed = n.sign_upload("app/up/r.png", "image/png", 4096, "").await;
    let url = signed["url"].as_str().unwrap().to_string();

    // A declared length over `max`: refused before the body is read.
    let (status, _, r) = n.upload(&url, Some("image/png"), png_of(5000), true).await;
    assert_eq!(status, 413, "{r}");
    assert_eq!(r["error"]["code"], "RENOX_BODY_TOO_LARGE", "{r}");
    // A stream that grows past `max`: stops there.
    let (status, _, r) = n
        .upload(&url, Some("image/png"), png_of(2 * 1024 * 1024), false)
        .await;
    assert_eq!(status, 413, "{r}");
    assert_eq!(r["error"]["code"], "RENOX_BODY_TOO_LARGE", "{r}");
    // Another type than the signed one.
    let (status, _, r) = n.upload(&url, Some("text/plain"), png_of(1000), true).await;
    assert_eq!(status, 415, "{r}");
    assert_eq!(r["error"]["code"], "RENOX_STORAGE_TYPE", "{r}");
    assert_eq!(r["error"]["details"]["reason"], "mismatch", "{r}");
    let (status, _, r) = n.upload(&url, None, png_of(1000), true).await;
    assert_eq!(
        r["error"]["code"], "RENOX_STORAGE_TYPE",
        "no Content-Type: {r}"
    );
    assert_eq!(status, 415);
    // Bytes the type contradicts (sniffing, as `ctx.storage.put`).
    let (status, _, r) = n
        .upload(
            &url,
            Some("image/png"),
            vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 0],
            true,
        )
        .await;
    assert_eq!(status, 415, "{r}");
    assert_eq!(r["error"]["details"]["reason"], "mismatch", "{r}");
    assert!(n.files_rows("select key from renox__files").is_empty());
    assert!(
        n.files_rows("select sig_hash from renox__upload_sigs")
            .is_empty(),
        "no refused PUT spent the URL"
    );

    // The browser retries until the ttl ends: now it succeeds, once.
    let (status, _, ok) = n.upload(&url, Some("image/png"), png_of(4096), true).await;
    assert_eq!(status, 201, "{ok}");
    assert_eq!(ok["bytes"], 4096);
    let (status, _, r) = n.upload(&url, Some("image/png"), png_of(4096), true).await;
    assert_eq!(status, 409, "{r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_put_over_the_quota_is_refused_and_keeps_the_url() {
    let n = node("upload_quota");
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
    let signed = n.sign_upload("app/up/q.txt", "text/plain", 1000, "").await;
    let url = signed["url"].as_str().unwrap().to_string();
    let (status, _, r) = n
        .upload(&url, Some("text/plain"), b"four".to_vec(), true)
        .await;
    assert_eq!(status, 413, "{r}");
    assert_eq!(r["error"]["code"], "RENOX_STORAGE_QUOTA", "{r}");
    // Room again: the same URL still works.
    n.json("GET", "/?op=delete&key=app/filler.txt", vec![])
        .await;
    let (status, _, r) = n
        .upload(&url, Some("text/plain"), b"four".to_vec(), true)
        .await;
    assert_eq!(status, 201, "{r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_download_signature_and_the_upload_signature_do_not_replay_as_each_other() {
    let n = node("upload_replay");
    n.put("app/private/report.txt", "text/plain", "", b"quarterly")
        .await;
    let (_, dl) = n
        .json("GET", "/?op=sign&key=app/private/report.txt&ttl=60", vec![])
        .await;
    let dl = dl["url"].as_str().unwrap().to_string();
    // The download URL on PUT, with every parameter an upload URL has.
    let (status, _, r) = n
        .upload(&dl, Some("text/plain"), b"changed".to_vec(), true)
        .await;
    assert_eq!(status, 404, "{r}");
    let exp = query_of(&dl, "exp");
    let sig = query_of(&dl, "sig");
    let spliced =
        format!("/_files/app/private/report.txt?exp={exp}&max=100&ct=text%2Fplain&pub=0&sig={sig}");
    let (status, _, r) = n
        .upload(&spliced, Some("text/plain"), b"changed".to_vec(), true)
        .await;
    assert_eq!(status, 404, "{r}");
    let (_, _, _, kept) = n.call("GET", &dl, vec![]).await;
    assert_eq!(kept, b"quarterly", "the file was not touched");

    // And the upload signature on GET serves nothing.
    let signed = n
        .sign_upload("app/private/report.txt", "text/plain", 100, "")
        .await;
    let up = signed["url"].as_str().unwrap().to_string();
    let (_, status, _, _) = n.call("GET", &up, vec![]).await;
    assert_eq!(status, 404, "a GET carrying an upload signature");
    // Replacing an existing key is a put: the same upsert, quota counted without the old bytes.
    let (status, _, r) = n
        .upload(&up, Some("text/plain"), b"replaced".to_vec(), true)
        .await;
    assert_eq!(status, 201, "{r}");
    let (_, read) = n
        .json("GET", "/?op=read&key=app/private/report.txt", vec![])
        .await;
    assert_eq!(read, "replaced");
    // Other methods stay refused, and no preflight is answered.
    for method in ["POST", "DELETE", "OPTIONS"] {
        let (_, status, headers, _) = n.call(method, &up, vec![]).await;
        assert_eq!(status, 405, "{method}");
        assert!(
            !headers
                .keys()
                .any(|k| k.as_str().starts_with("access-control-")),
            "{method}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_public_upload_is_served_unsigned_and_a_private_one_is_not() {
    let n = node("upload_public");
    let pubs = n
        .sign_upload("app/up/pub.png", "image/png", 5000, "&public=1")
        .await;
    assert!(
        pubs["url"].as_str().unwrap().contains("&pub=1&sig="),
        "{pubs}"
    );
    let (status, _, f) = n
        .upload(
            pubs["url"].as_str().unwrap(),
            Some("image/png"),
            png(),
            true,
        )
        .await;
    assert_eq!(status, 201, "{f}");
    assert_eq!(f["public"], true);
    let (_, status, headers, body) = n.call("GET", "/_files/app/up/pub.png", vec![]).await;
    assert_eq!(status, 200);
    assert_eq!(body, png());
    assert_eq!(headers["cache-control"], "public, max-age=300");
    assert_eq!(headers["content-type"], "image/png");

    let privs = n
        .sign_upload("app/up/priv.png", "image/png", 5000, "")
        .await;
    n.upload(
        privs["url"].as_str().unwrap(),
        Some("image/png"),
        png(),
        true,
    )
    .await;
    let (_, status, _, _) = n.call("GET", "/_files/app/up/priv.png", vec![]).await;
    assert_eq!(status, 404, "a private upload needs a download signature");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sign_upload_refuses_what_a_put_would_refuse() {
    let n = node("upload_sign_refusals");
    let err = |v: &serde_json::Value| v["error"].as_str().unwrap_or("").to_string();
    // The type allow-list of the owner (`pdf` is not in the fixture's list; SVG is never
    // uploadable: a browser upload is not sanitised).
    let r = n
        .sign_upload("app/x.pdf", "application/pdf", 1000, "")
        .await;
    assert_eq!(err(&r), "RENOX_STORAGE_TYPE", "{r}");
    assert_eq!(r["details"]["reason"], "not_allowed");
    let r = n.sign_upload("app/x.svg", "image/svg+xml", 1000, "").await;
    assert_eq!(err(&r), "RENOX_STORAGE_TYPE", "{r}");
    assert_eq!(r["details"]["reason"], "svg_unsanitised");
    // `max_bytes` is 1 to the tier's per-file limit.
    let r = n.sign_upload("app/x.png", "image/png", 0, "").await;
    assert_eq!(err(&r), "RENOX_STORAGE_TOO_LARGE", "{r}");
    let over = StorageLimits::FREE.file_bytes + 1;
    let r = n.sign_upload("app/x.png", "image/png", over, "").await;
    assert_eq!(err(&r), "RENOX_STORAGE_TOO_LARGE", "{r}");
    assert_eq!(r["details"]["limit_bytes"], StorageLimits::FREE.file_bytes);
    let r = n
        .sign_upload("app/x.png", "image/png", StorageLimits::FREE.file_bytes, "")
        .await;
    assert_eq!(r["max_bytes"], StorageLimits::FREE.file_bytes, "{r}");
    // The ttl is 60 to 3600 seconds, else a RangeError.
    for ttl in [59, 3601] {
        let r = n
            .sign_upload("app/x.png", "image/png", 1000, &format!("&ttl={ttl}"))
            .await;
        assert_eq!(r["name"], "RangeError", "{ttl}: {r}");
    }
    let r = n
        .sign_upload("app/x.png", "image/png", 1000, "&ttl=60")
        .await;
    assert!(r["url"].is_string(), "{r}");
    // The key rules of `op_storage_put`.
    for key in ["tax/x.png", "app/../tax/x.png", "app//x.png", "App/x.png"] {
        let r = n.sign_upload(key, "image/png", 1000, "").await;
        assert_eq!(err(&r), "RENOX_STORAGE_KEY", "{key}: {r}");
    }
}
