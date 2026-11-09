//! Issue #582: images in `ctx.pdf` (`docs/contracts/ops.md` 1.13.0 section
//! 24) through the cell. V8-linked; a `CellManager` with the local file store.
//!
//! One deployment, two tenants. Tenant A stores a private PNG; its PDF
//! embeds it by `/_img/<key>?w=` with no signature (the render runs as the
//! tenant), and a second render comes from the variant cache. Tenant B asks
//! for the same key: it does not resolve in B's store, so B's PDF holds no
//! image and the render still succeeds.
#![cfg(all(feature = "pdf", feature = "media"))]

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
use renox_data::{DbOptions, TenantDb};
use renox_gateway::{CellDispatcher, RequestCtx};
use renox_meter::{Meter, MeterBatch, MeterConfig, Sink, SinkError};
use renox_runtime::{Runtime, RuntimeConfig};
use renox_template::{Compiler, TemplateProject};

static N: AtomicU64 = AtomicU64::new(0);
const KEY: [u8; 32] = [7u8; 32];

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-pdf-images-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct Discard;

impl Sink for Discard {
    async fn write_batch(&self, _batch: &MeterBatch) -> Result<(), SinkError> {
        Ok(())
    }
}

/// `POST /?key=…&type=…` stores the body (private); `GET /?src=…` renders
/// `partials/report` with that `<img src>` and says whether the PDF holds an
/// image XObject.
const APP: &str = r#"
export async function POST(ctx) {
  const q = ctx.url.searchParams;
  const bytes = new Uint8Array(await ctx.req.arrayBuffer());
  try {
    return Response.json(await ctx.storage.put(q.get("key"), bytes, { contentType: q.get("type") }));
  } catch (e) {
    return Response.json({ error: e.code ?? e.name });
  }
}
export async function GET(ctx) {
  try {
    const bytes = await ctx.pdf.render("partials/report", { src: ctx.url.searchParams.get("src") });
    const text = new TextDecoder("latin1").decode(bytes);
    return Response.json({ ok: true, xobject: text.includes("/XObject"), len: bytes.length });
  } catch (e) {
    return Response.json({ ok: false, code: e.code ?? null, name: e.name });
  }
}
"#;

fn artifact(store: &Path) -> String {
    let mut project = TemplateProject::new();
    project.insert(
        "partials/report.html",
        "<h1>Visit report</h1><p>Signature:</p><img :src=\"src\" width=\"160\"><p>Signed by Amina</p>",
    );
    let compiled = Compiler::default()
        .compile(&project)
        .unwrap_or_else(|d| panic!("{d:?}"));
    let tmp = scratch("artifact");
    for (rel, src) in compiled.files() {
        let p = tmp.join("templates").join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "reports", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": { "functions/f": "functions/f.js" } },
        "routes": [
            { "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" },
            { "kind": "function", "method": "POST", "path": "/", "module": "functions/f", "export": "POST" },
        ],
        "templates": compiled.manifest_entries(),
        "permissions": { "network": [], "secrets": [] },
        "storage": { "allowed_types": ["image/png", "image/jpeg"] },
    });
    std::fs::write(
        tmp.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let p = tmp.join("code/functions/f.js");
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, APP).unwrap();
    let hash = renox_cell::artifact::canonical_hash(&tmp).unwrap();
    std::fs::rename(&tmp, store.join(&hash)).unwrap();
    hash
}

struct Node {
    manager: CellManager,
    hash: String,
}

fn node() -> Node {
    let root = scratch("node");
    let (data, store) = (root.join("data"), root.join("artifacts"));
    std::fs::create_dir_all(&store).unwrap();
    for tenant in ["t_pdf_a", "t_pdf_b"] {
        let dir = data.join(tenant);
        std::fs::create_dir_all(&dir).unwrap();
        TenantDb::open(dir.join("app.db"), DbOptions::default())
            .unwrap()
            .close()
            .unwrap();
    }
    let hash = artifact(&store);
    let meter = Meter::start(
        MeterConfig {
            flush_interval: Duration::from_millis(20),
            ..MeterConfig::new("t_pdf@test", "test", &data)
        },
        Discard,
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
    Node { manager, hash }
}

impl Node {
    async fn call(
        &self,
        tenant: &str,
        method: &str,
        uri: &str,
        body: Vec<u8>,
    ) -> serde_json::Value {
        let ctx = RequestCtx {
            tenant_id: tenant.into(),
            deployment_hash: self.hash.clone(),
            request_id: format!("req_{}", N.fetch_add(1, Ordering::SeqCst)),
            deadline: Instant::now() + Duration::from_secs(30),
            client_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            csp_nonce: "n".into(),
        };
        let req = http::Request::builder()
            .method(method)
            .uri(format!("https://r.renox.app{uri}"))
            .header("host", "r.renox.app")
            .body(axum::body::Body::from(body))
            .unwrap();
        let res = self.manager.dispatch(ctx, req).await;
        let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null)
    }
}

fn signature_png() -> Vec<u8> {
    let img = image::RgbImage::from_fn(400, 120, |x, y| {
        if (y as i64 - 60 - ((x as f64 / 9.0).sin() * 20.0) as i64).abs() < 3 {
            image::Rgb([20, 20, 60])
        } else {
            image::Rgb([255, 255, 255])
        }
    });
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_private_key_renders_in_its_tenants_pdf_and_another_tenants_key_does_not_resolve() {
    let n = node();
    let stored = n
        .call(
            "t_pdf_a",
            "POST",
            "/?key=app/visits/7/signature.png&type=image/png",
            signature_png(),
        )
        .await;
    assert!(
        stored.get("error").is_none() && !stored.is_null(),
        "{stored}"
    );
    let src = "/_img/app/visits/7/signature.png?w=400";
    let uri = format!(
        "/?src={}",
        src.replace('?', "%3F")
            .replace('=', "%3D")
            .replace('&', "%26")
    );

    // Tenant A: no signature in the URL, the private file is embedded.
    let a = n.call("t_pdf_a", "GET", &uri, vec![]).await;
    assert_eq!(a["ok"], true, "{a}");
    assert_eq!(a["xobject"], true, "the private key renders: {a}");
    // Again: from the variant cache, the same document.
    let again = n.call("t_pdf_a", "GET", &uri, vec![]).await;
    assert_eq!(again["xobject"], true, "{again}");

    // Tenant B, same deployment, same key: not in B's store.
    let b = n.call("t_pdf_b", "GET", &uri, vec![]).await;
    assert_eq!(b["ok"], true, "the render does not fail: {b}");
    assert_eq!(
        b["xobject"], false,
        "another tenant's key does not resolve: {b}"
    );
}
