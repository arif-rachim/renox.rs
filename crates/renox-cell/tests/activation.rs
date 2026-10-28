//! Issue #96: activation failure semantics with a real worker answering
//! `prepare` (`docs/contracts/deploy-api.md` section 6;
//! `docs/23-failure-modes.md` section 3, "Migration fails half-way", "New
//! deployment fails its first request", "Rollback to a hash whose
//! migrations are older"). Runs against `control/api`
//! (`support/control_stack.rs`; skipped without `RENOX_TEST_PG`).

#[path = "support/control_stack.rs"]
mod stack;

use std::path::{Path, PathBuf};
use std::time::Duration;

use renox_cell::{Worker, WorkerConfig};
use stack::{Stack, eventually, http};

/// An artifact of app `shop` with `migrations` (name, SQL) and a GET
/// `/api/items` handler (`body` is the module's source).
fn artifact(root: &Path, migrations: &[(&str, &str)], body: &str) -> PathBuf {
    let src = root.join(format!("src-{}", migrations.len()));
    let _ = std::fs::remove_dir_all(&src);
    std::fs::create_dir_all(src.join("code/functions/api")).unwrap();
    std::fs::create_dir_all(src.join("migrations/app")).unwrap();
    let manifest = serde_json::json!({
        "artifact": { "version": 0 },
        "app": { "name": "shop", "timezone": "UTC" },
        "code": { "format": "esm-dir", "entry": { "functions/api/items": "functions/api/items.js" } },
        "routes": [{ "kind": "function", "method": "GET", "path": "/api/items", "module": "functions/api/items", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] }
    });
    std::fs::write(src.join("manifest.json"), manifest.to_string()).unwrap();
    std::fs::write(src.join("code/functions/api/items.js"), body).unwrap();
    let mut sums = serde_json::Map::new();
    for (name, sql) in migrations {
        std::fs::write(src.join("migrations/app").join(name), sql).unwrap();
        sums.insert(format!("app/{name}"), renox_data::checksum(sql).into());
    }
    std::fs::write(
        src.join("migrations/checksums.json"),
        serde_json::json!({ "version": 0, "files": sums }).to_string(),
    )
    .unwrap();
    let hash = renox_runtime::manifest::content_hash(&src).unwrap();
    let dir = root.join(&hash);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&src, &dir).unwrap();
    dir
}

const ITEMS: &str = "create table app__items (id integer primary key, name text not null);\n";
const TAGS: &str = "create table app__tags (id integer primary key);\n";
const BAD: &str = "alter table app__missing add column price integer;\n";
const PRICE: &str = "alter table app__items add column price integer;\n";
/// Reads only the columns it knows, so it tolerates newer ones (D17).
const LIST: &str = "export async function GET({ db }) { return Response.json(await db.query(\"select id, name from app__items\")); }\n";
const THROWS: &str = "export const GET = () => { throw new Error(\"boom\"); };\n";

async fn state(stack: &Stack, token: &str, hash: &str) -> serde_json::Value {
    stack
        .call(
            "GET",
            &format!("/v1/apps/shop/deployments/{hash}"),
            token,
            None,
        )
        .await
        .json()
}

/// The `renox__migrations` rows of the worker's tenant database, as `module/name`.
async fn applied(db: &Path) -> Vec<String> {
    let script = "import { Database } from 'bun:sqlite'; const d = new Database(process.env.DB, { readonly: true }); console.log(JSON.stringify(d.query('select module, name from renox__migrations order by name').all())); d.close();";
    let out = tokio::process::Command::new("bun")
        .args(["-e", script])
        .env("DB", db)
        .output()
        .await
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let rows: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).unwrap();
    rows.iter()
        .map(|r| {
            format!(
                "{}/{}",
                r["module"].as_str().unwrap(),
                r["name"].as_str().unwrap()
            )
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn activation_prepares_on_the_node_and_switches_only_on_success() {
    let Some(stack) = Stack::start("activation").await else {
        return;
    };
    let token = stack.tenant_with_app("t_shop", "shop", "free").await;
    let token_file = stack.node_token_file("node-act-1").await;
    let dir = stack.root.join("worker");
    let config =
        WorkerConfig::parse(&stack.worker_toml(&dir, "node-act-1", &token_file), &dir).unwrap();
    let worker = Worker::start(config).await.unwrap();
    let c = worker.controller.clone().unwrap();
    eventually(Duration::from_secs(15), || async {
        c.is_registered().then_some(())
    })
    .await
    .expect("registered");
    let get = || async {
        http(
            worker.addr,
            "GET",
            "/api/items",
            "shop.renox.test",
            &[],
            b"",
        )
        .await
        .unwrap()
    };
    let active = || async {
        let r = stack
            .call("GET", "/v1/apps/shop", &token, None)
            .await
            .json();
        r["active_deployment"].as_str().map(str::to_owned)
    };
    let db = dir.join("data/t_shop/app.db");

    // v1: one migration; prepare migrates, creates and probes the cell.
    let v1 = stack
        .upload(
            &token,
            "shop",
            &artifact(&stack.root, &[("001_items.sql", ITEMS)], LIST),
        )
        .await;
    let r = stack.activate(&token, "shop", &v1).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(applied(&db).await, ["app/001_items.sql"]);
    eventually(Duration::from_secs(5), || async {
        worker.routes.lookup("shop.renox.test")
    })
    .await
    .unwrap();
    assert_eq!(get().await.status, 200);

    // v2: the third file fails. 422, validated with the error, v1 still
    // serving, and 002 committed (forward-only).
    let v2 = stack
        .upload(
            &token,
            "shop",
            &artifact(
                &stack.root,
                &[
                    ("001_items.sql", ITEMS),
                    ("002_tags.sql", TAGS),
                    ("003_price.sql", BAD),
                ],
                LIST,
            ),
        )
        .await;
    let r = stack.activate(&token, "shop", &v2).await;
    assert_eq!(r.status, 422, "{}", r.text());
    assert_eq!(r.json()["error"]["code"], "RENOX_ACTIVATION_FAILED");
    let d = state(&stack, &token, &v2).await;
    assert_eq!(d["state"], "validated");
    assert_eq!(d["last_error"]["stage"], "migrate");
    assert_eq!(d["last_error"]["module"], "app");
    assert_eq!(d["last_error"]["file"], "app/003_price.sql");
    assert!(
        d["last_error"]["sqlite_error"]
            .as_str()
            .is_some_and(|e| !e.is_empty()),
        "{d}"
    );
    assert_eq!(active().await.as_deref(), Some(v1.as_str()));
    assert_eq!(
        worker
            .routes
            .lookup("shop.renox.test")
            .unwrap()
            .deployment_hash,
        v1
    );
    assert_eq!(get().await.status, 200);
    assert_eq!(
        applied(&db).await,
        ["app/001_items.sql", "app/002_tags.sql"]
    );

    // v3: the file fixed in a new upload; only the remaining file runs.
    let v3 = stack
        .upload(
            &token,
            "shop",
            &artifact(
                &stack.root,
                &[
                    ("001_items.sql", ITEMS),
                    ("002_tags.sql", TAGS),
                    ("003_price.sql", PRICE),
                ],
                LIST,
            ),
        )
        .await;
    let r = stack.activate(&token, "shop", &v3).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(
        applied(&db).await,
        ["app/001_items.sql", "app/002_tags.sql", "app/003_price.sql"]
    );
    assert_eq!(active().await.as_deref(), Some(v3.as_str()));

    // v4: the probe answers 500. Activation fails, v3 stays, audited.
    let v4 = stack
        .upload(
            &token,
            "shop",
            &artifact(
                &stack.root,
                &[
                    ("001_items.sql", ITEMS),
                    ("002_tags.sql", TAGS),
                    ("003_price.sql", PRICE),
                ],
                THROWS,
            ),
        )
        .await;
    let r = stack.activate(&token, "shop", &v4).await;
    assert_eq!(r.status, 422, "{}", r.text());
    let d = state(&stack, &token, &v4).await;
    assert_eq!(d["last_error"]["stage"], "probe");
    assert_eq!(d["last_error"]["http_status"], 500);
    assert_eq!(active().await.as_deref(), Some(v3.as_str()));
    let audit = stack
        .sql(&format!("select action, status from audit where action = 'activateDeployment' and target->>'hash' is null or (action = 'deploymentState' and target->>'hash' = '{v4}') order by id"))
        .await;
    assert!(audit.to_string().contains("\"status\":422"), "{audit}");
    assert!(audit.to_string().contains("deploymentState"), "{audit}");

    // Rollback to v1 after 003 added a column: a pointer switch, no
    // migration; v1's code tolerates the new column (D17).
    let r = stack
        .call(
            "POST",
            "/v1/apps/shop/rollback",
            &token,
            Some(serde_json::json!({ "hash": v1 })),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.text());
    let back = active().await.unwrap();
    assert_eq!(back, v1);
    let served = eventually(Duration::from_secs(5), || async {
        let e = worker.routes.lookup("shop.renox.test")?;
        (e.deployment_hash == back).then_some(())
    })
    .await;
    assert!(served.is_some());
    assert_eq!(get().await.status, 200);
    assert_eq!(applied(&db).await.len(), 3, "a rollback runs no migration");
    worker.shutdown().await;
}
