//! Issue #55: a controlled worker against the real control API (Postgres,
//! and MinIO or another S3 server when `RENOX_TEST_S3` is set; see
//! `support/control_stack.rs`). Deploy `examples/hello` through the API and
//! get a 200 from the worker; meter batches reach `meters_raw`; tenant log
//! lines reach `POST /v1/ingest/logs`; a route update reaches the gateway and a
//! new cell serves within 1 s; `/healthz` answers.

#[path = "support/control_stack.rs"]
mod stack;

use std::time::{Duration, Instant};

use renox_cell::{Worker, WorkerConfig};
use stack::{Stack, eventually, hello_dir, http};

/// A second deployment of the hello app that writes a log line per request.
fn hello_v2(root: &std::path::Path) -> std::path::PathBuf {
    let src = root.join("hello-v2-src");
    copy_dir(&hello_dir(), &src);
    std::fs::write(
        src.join("code/functions/api/hello.js"),
        "export const GET = () => { console.log(\"hello v2\"); return Response.json({ ok: true }); };\n",
    )
    .unwrap();
    let hash = renox_runtime::manifest::content_hash(&src).unwrap();
    let dir = root.join(&hash);
    std::fs::rename(&src, &dir).unwrap();
    dir
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &to.join(e.file_name()));
        } else {
            std::fs::copy(e.path(), to.join(e.file_name())).unwrap();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deploy_through_the_api_and_serve_from_the_worker() {
    let Some(stack) = Stack::start("controlled").await else {
        return;
    };
    let token = stack.tenant_with_app("t_hello", "hello", "free").await;
    let hash = stack.upload(&token, "hello", &hello_dir()).await;
    let token_file = stack.node_token_file("node-it-1").await;
    let dir = stack.root.join("worker");
    let config =
        WorkerConfig::parse(&stack.worker_toml(&dir, "node-it-1", &token_file), &dir).unwrap();
    let worker = Worker::start(config).await.unwrap();
    let controller = worker.controller.clone().unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            controller.is_registered().then_some(())
        })
        .await
        .is_some(),
        "the worker did not register"
    );

    // Activation publishes the route; the worker serves it.
    let r = stack.activate(&token, "hello", &hash).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let started = Instant::now();
    let routed = eventually(Duration::from_secs(5), || async {
        worker.routes.lookup("hello.renox.test")
    })
    .await;
    assert_eq!(routed.unwrap().deployment_hash, hash);
    let res = http(
        worker.addr,
        "GET",
        "/api/hello",
        "hello.renox.test",
        &[],
        b"",
    )
    .await
    .unwrap();
    assert_eq!(res.status, 200, "{}", res.text());
    eprintln!(
        "first deployment: route and first 200 after {} ms",
        started.elapsed().as_millis()
    );
    // The artifact came from the control plane: through S3 (307) or the API (200).
    assert!(
        dir.join("artifacts")
            .join(&hash)
            .join("manifest.json")
            .is_file()
    );

    // Meter batches appear in the control plane's raw meter table.
    let rows = eventually(Duration::from_secs(10), || async {
        let rows = stack.sql(&format!("select request_id, node_id, record->>'route' as route, (record->>'http_status')::int as http_status from meters_raw where deployment_hash = '{hash}'")).await;
        (rows.as_array().is_some_and(|a| !a.is_empty())).then_some(rows)
    })
    .await
    .expect("no meter record reached meters_raw");
    assert_eq!(rows[0]["route"], "GET /api/hello");
    assert_eq!(rows[0]["http_status"], 200);
    assert_eq!(rows[0]["node_id"], "node-it-1");

    // Route update -> new cell within 1 s.
    let v2 = hello_v2(&stack.root);
    let hash2 = stack.upload(&token, "hello", &v2).await;
    let r = stack.activate(&token, "hello", &hash2).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let switched = Instant::now();
    let served = eventually(Duration::from_secs(5), || async {
        let routed = worker.routes.lookup("hello.renox.test")?;
        if routed.deployment_hash != hash2 {
            return None;
        }
        let res = http(
            worker.addr,
            "GET",
            "/api/hello",
            "hello.renox.test",
            &[],
            b"",
        )
        .await
        .ok()?;
        (res.status == 200).then_some(())
    })
    .await;
    let elapsed = switched.elapsed();
    assert!(served.is_some(), "the new deployment was not served");
    eprintln!(
        "route update -> new cell serving: {} ms",
        elapsed.as_millis()
    );
    assert!(
        elapsed < Duration::from_secs(1),
        "route update to new cell took {elapsed:?}"
    );
    assert!(
        worker
            .manager
            .cells()
            .iter()
            .any(|k| k.deployment_hash == hash2)
    );

    // The v2 request's log line reached the log ingestion (HttpLogSink).
    let logged = eventually(Duration::from_secs(10), || async {
        let rows = stack
            .sql("select actor from audit where action = 'ingestLogs' and status = 202")
            .await;
        (rows.as_array().is_some_and(|a| !a.is_empty())).then_some(rows)
    })
    .await
    .expect("no log batch reached POST /v1/ingest/logs");
    assert_eq!(logged[0]["actor"], "node:node-it-1");

    // #97: the periodic resync is conditional; an unchanged table is a 304
    // and keeps the table as it is.
    let version = controller.routes.version();
    assert!(version > 0);
    assert_eq!(controller.fetch_snapshot(true).await.unwrap(), version);
    assert_eq!(controller.fetch_snapshot(false).await.unwrap(), version);
    // The gateway's entry carries the control plane's version.
    let entry_version = worker
        .routes
        .lookup("hello.renox.test")
        .unwrap()
        .version
        .unwrap();
    assert!(entry_version > 0 && entry_version <= version);

    // The operator health endpoint.
    let health = http(
        worker.health_addr.unwrap(),
        "GET",
        "/healthz",
        "localhost",
        &[],
        b"",
    )
    .await
    .unwrap();
    assert_eq!(health.status, 200);
    assert_eq!(health.json()["status"], "ok");
    worker.shutdown().await;
}

/// A node token of the wrong form, or a token file other users can read,
/// stops the worker at start (no token in the error).
#[tokio::test]
async fn bad_node_token_files_refuse_to_start() {
    let dir = std::env::temp_dir().join(format!("renox-controlled-token-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("node.token");
    let toml = format!(
        "mode = \"controlled\"\nlisten = \"127.0.0.1:0\"\nnode_id = \"n1\"\ndata_dir = \"d\"\nartifacts_dir = \"a\"\nmeters_dir = \"m\"\nlogs_dir = \"l\"\nfetch_blocked_addresses = [\"203.0.113.250\"]\n[control]\nurl = \"http://127.0.0.1:1\"\nnode_token_file = \"{}\"\n",
        file.display()
    );
    use std::os::unix::fs::PermissionsExt;
    let value = stack::token("renox_node_");
    for (content, mode) in [
        (value.as_str(), 0o644),
        ("renox_pat_abc", 0o600),
        ("", 0o600),
    ] {
        std::fs::write(&file, content).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
        let config = WorkerConfig::parse(&toml, &dir).unwrap();
        let err = Worker::start(config)
            .await
            .err()
            .expect("start must fail")
            .to_string();
        assert!(err.contains("node token"), "{err}");
        assert!(!err.contains(&value), "the token leaked into the error");
    }
    // A valid file starts the worker; the control plane is not needed for that.
    std::fs::write(&file, &value).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let worker = Worker::start(WorkerConfig::parse(&toml, &dir).unwrap())
        .await
        .unwrap();
    // No route yet: every host is unknown.
    let res = http(
        worker.addr,
        "GET",
        "/api/hello",
        "hello.renox.test",
        &[],
        b"",
    )
    .await
    .unwrap();
    assert_eq!(res.status, 404);
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// ADR D23 follow-up (#218), `docs/24-threat-model.md` B, "Tenant code
/// reaches the control plane's node-facing endpoints": a controlled worker
/// whose `[control] url` resolves to an address tenant `fetch` could reach
/// refuses to start, naming the address and the config key; the same URL
/// with the address listed in `fetch_blocked_addresses` starts. `1.2.3.4` is
/// a public address outside every blocked range (the RFC 5737 documentation
/// ranges, such as `203.0.113.0/24`, are blocked already); plain `http://` is
/// refused for a non-loopback host by `WorkerConfig::parse`, so the URL is
/// `https://`.
#[tokio::test]
async fn control_url_reachable_by_tenant_fetch_refuses_to_start() {
    let dir = std::env::temp_dir().join(format!("renox-controlled-url-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("node.token");
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(&file, stack::token("renox_node_")).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let toml = |url: &str, blocked: &str| {
        format!(
            "mode = \"controlled\"\nlisten = \"127.0.0.1:0\"\nnode_id = \"n1\"\ndata_dir = \"d\"\nartifacts_dir = \"a\"\nmeters_dir = \"m\"\nlogs_dir = \"l\"\nfetch_blocked_addresses = [{blocked}]\n[control]\nurl = \"{url}\"\nnode_token_file = \"{}\"\n",
            file.display()
        )
    };
    let url = "https://1.2.3.4:8443";

    let err = Worker::start(WorkerConfig::parse(&toml(url, "\"203.0.113.250\""), &dir).unwrap())
        .await
        .err()
        .expect("a control URL tenant fetch can reach must refuse to start")
        .to_string();
    assert!(err.contains("control.url"), "{err}");
    assert!(err.contains("1.2.3.4"), "{err}");
    assert!(err.contains("fetch_blocked_addresses"), "{err}");

    // Its IPv4-mapped IPv6 form on the list counts as the same address.
    for blocked in ["\"203.0.113.250\", \"1.2.3.4\"", "\"::ffff:1.2.3.4\""] {
        let worker = Worker::start(WorkerConfig::parse(&toml(url, blocked), &dir).unwrap())
            .await
            .unwrap_or_else(|e| panic!("listed {blocked}: {e}"));
        worker.shutdown().await;
    }

    // A host that does not resolve cannot be checked: refused.
    let err = Worker::start(
        WorkerConfig::parse(
            &toml("https://control.renox-218.invalid", "\"203.0.113.250\""),
            &dir,
        )
        .unwrap(),
    )
    .await
    .err()
    .expect("an unresolvable control URL must refuse to start")
    .to_string();
    assert!(err.contains("does not resolve"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}
