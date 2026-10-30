//! Issue #321: `/_img` (`docs/contracts/ops.md` 1.7.0 section 21; the "M6
//! image pipeline" of `docs/18-build-plan.md`). V8-linked; a `CellManager`
//! with the local file store.
//!
//! A 4000 px JPEG with EXIF and GPS data, asked at 390 px in AVIF: 400 px
//! (the nearest allowed width), AVIF, no metadata, an `image` meter record;
//! the second request comes from the variant cache; the transform rate
//! refuses past its burst while cached variants keep being served; a
//! private original needs a signature on `/_img` too.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::BodyExt;
use renox_cell::cell::LocalSecrets;
use renox_cell::manager::StaticTiers;
use renox_cell::pages::PlatformKey;
use renox_cell::{CellManager, LocalArtifactStore, ManagerConfig, TierName, Tiers};
use renox_data::{DbOptions, TenantDb};
use renox_gateway::{CellDispatcher, RequestCtx};
use renox_meter::{Meter, MeterBatch, MeterConfig, MeterRecord, Sink, SinkError};
use renox_runtime::{Runtime, RuntimeConfig};

static N: AtomicU64 = AtomicU64::new(0);
const TENANT: &str = "t_img";
const KEY: [u8; 32] = [5u8; 32];

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-images-{}-{name}-{}",
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
}

fn node(name: &str, rate: Option<(f64, f64)>) -> Node {
    let root = scratch(name);
    let (data, store) = (root.join("data"), root.join("artifacts"));
    std::fs::create_dir_all(&store).unwrap();
    open(&data).close().unwrap();
    let hash = artifact(&store);
    let records = Records::default();
    let meter = Meter::start(
        MeterConfig {
            flush_interval: Duration::from_millis(20),
            ..MeterConfig::new("t_img@test", "test", &data)
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
    if let Some((per_second, burst)) = rate {
        manager.set_image_rate(per_second, burst);
    }
    Node {
        manager,
        records,
        hash,
    }
}

impl Node {
    async fn call(
        &self,
        method: &str,
        uri: &str,
        body: Vec<u8>,
    ) -> (String, u16, http::HeaderMap, Vec<u8>) {
        self.call_with(method, uri, body, "*/*").await
    }

    async fn call_with(
        &self,
        method: &str,
        uri: &str,
        body: Vec<u8>,
        accept: &str,
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
            .header("accept", accept)
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
}

const GPS_MARKER: &[u8] = b"GPS-LAT-25.2048-LON-55.2708";

/// A 4000x3000 JPEG with an APP1 Exif segment that carries a GPS marker.
fn photo() -> Vec<u8> {
    let img = image::RgbImage::from_fn(4000, 3000, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
    });
    let mut jpeg = std::io::Cursor::new(Vec::new());
    img.write_to(&mut jpeg, image::ImageFormat::Jpeg).unwrap();
    let jpeg = jpeg.into_inner();
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(GPS_MARKER);
    let mut out = jpeg[..2].to_vec(); // SOI
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&jpeg[2..]);
    out
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn image_records(n: &Node) -> Vec<MeterRecord> {
    n.records
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.kind == Some(renox_meter::MeterKind::Image))
        .cloned()
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_4000px_jpeg_asked_at_400_avif_is_resized_stripped_cached_and_metered() {
    let n = node("pipeline", None);
    let original = photo();
    assert!(contains(&original, GPS_MARKER));
    let (_, f) = n
        .put(
            "app/products/chair.jpg",
            "image/jpeg",
            "&public=1",
            &original,
        )
        .await;
    assert_eq!(f["width"], 4000, "{f}");
    assert_eq!(f["height"], 3000);

    let t = Instant::now();
    let (_, status, headers, avif) = n
        .call_with(
            "GET",
            "/_img/app/products/chair.jpg?w=390&f=auto",
            vec![],
            "image/avif,image/webp,*/*",
        )
        .await;
    let avif_ms = t.elapsed().as_millis();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&avif));
    assert_eq!(headers["content-type"], "image/avif");
    assert_eq!(
        headers["cache-control"],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(headers["vary"], "Accept");
    assert!(
        headers["etag"].to_str().unwrap().ends_with("-w400-avif\""),
        "{:?}",
        headers["etag"]
    );
    assert_eq!(&avif[4..12], b"ftypavif", "an AVIF file");
    assert!(
        !contains(&avif, GPS_MARKER) && !contains(&avif, b"Exif"),
        "metadata stripped"
    );
    // The AVIF's own size box (ispe) says 400 x 300.
    let ispe = avif
        .windows(4)
        .position(|w| w == b"ispe")
        .expect("ispe box");
    let w = u32::from_be_bytes(avif[ispe + 8..ispe + 12].try_into().unwrap());
    let h = u32::from_be_bytes(avif[ispe + 12..ispe + 16].try_into().unwrap());
    assert_eq!((w, h), (400, 300));
    let mut recs = image_records(&n);
    for _ in 0..100 {
        if !recs.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        recs = image_records(&n);
    }
    assert_eq!(recs.len(), 1);
    assert_eq!(recs[0].route, "IMG 400w avif");
    assert_eq!(recs[0].image_variants, Some(1));
    assert_eq!(recs[0].cpu_ms, 0.0, "the transform is platform time");
    assert!(recs[0].storage_bytes.unwrap() >= original.len() as u64 + avif.len() as u64);

    // From the cache: the same bytes, no transform, no new record.
    let t = Instant::now();
    let (_, status, _, again) = n
        .call_with(
            "GET",
            "/_img/app/products/chair.jpg?w=400&f=auto",
            vec![],
            "image/avif",
        )
        .await;
    let hit_ms = t.elapsed().as_millis();
    assert_eq!(status, 200);
    assert_eq!(again, avif);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(image_records(&n).len(), 1);

    // JPEG and WebP variants: decoded, 400 x 300, no metadata.
    let t = Instant::now();
    let (_, _, h, jpeg) = n
        .call("GET", "/_img/app/products/chair.jpg?w=400&f=jpeg", vec![])
        .await;
    let jpeg_ms = t.elapsed().as_millis();
    assert_eq!(h["content-type"], "image/jpeg");
    let img = image::load_from_memory(&jpeg).unwrap();
    assert_eq!((img.width(), img.height()), (400, 300));
    assert!(!contains(&jpeg, GPS_MARKER) && !contains(&jpeg, b"Exif"));
    let t = Instant::now();
    let (_, _, h, webp) = n
        .call_with(
            "GET",
            "/_img/app/products/chair.jpg?w=800",
            vec![],
            "image/webp",
        )
        .await;
    let webp_ms = t.elapsed().as_millis();
    assert_eq!(h["content-type"], "image/webp");
    let img = image::load_from_memory(&webp).unwrap();
    assert_eq!((img.width(), img.height()), (800, 600));
    eprintln!(
        "transform times (debug build, 4000x3000 JPEG): avif 400w {avif_ms} ms, jpeg 400w {jpeg_ms} ms, webp 800w {webp_ms} ms, cache hit {hit_ms} ms"
    );
    // Bad options are refused without a transform.
    assert_eq!(
        n.call(
            "GET",
            "/_img/app/products/chair.jpg?w=400&fit=stretch",
            vec![]
        )
        .await
        .1,
        400
    );
    assert_eq!(
        n.call("GET", "/_img/app/products/none.jpg?w=400", vec![])
            .await
            .1,
        404
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_transform_rate_refuses_past_its_burst_and_cached_variants_still_serve() {
    let n = node("rate", Some((0.01, 2.0)));
    let small = {
        let img = image::RgbImage::from_pixel(64, 48, image::Rgb([10, 200, 10]));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    };
    n.put("app/s.png", "image/png", "&public=1", &small).await;
    assert_eq!(n.call("GET", "/_img/app/s.png?f=png", vec![]).await.1, 200);
    assert_eq!(n.call("GET", "/_img/app/s.png?f=jpeg", vec![]).await.1, 200);
    let (_, status, headers, body) = n.call("GET", "/_img/app/s.png?f=webp", vec![]).await;
    assert_eq!(status, 429);
    assert!(headers.contains_key("retry-after"));
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["error"]["code"], "RENOX_IMAGE_RATE");
    // Hits never count against the rate.
    assert_eq!(n.call("GET", "/_img/app/s.png?f=png", vec![]).await.1, 200);
    assert_eq!(n.call("GET", "/_img/app/s.png?f=jpeg", vec![]).await.1, 200);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_private_original_needs_a_signature_on_img_too() {
    let n = node("private", None);
    let img = image::RgbImage::from_pixel(32, 32, image::Rgb([1, 2, 3]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    n.put("app/private/id.png", "image/png", "", &out.into_inner())
        .await;
    assert_eq!(
        n.call("GET", "/_img/app/private/id.png?w=200", vec![])
            .await
            .1,
        404
    );
    let (_, signed) = n
        .json("GET", "/?op=sign&key=app/private/id.png&ttl=600", vec![])
        .await;
    let query = signed["url"]
        .as_str()
        .unwrap()
        .split_once('?')
        .unwrap()
        .1
        .to_string();
    let (_, status, headers, _) = n
        .call(
            "GET",
            &format!("/_img/app/private/id.png?w=200&f=png&{query}"),
            vec![],
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(headers["cache-control"], "private, max-age=300");
}
