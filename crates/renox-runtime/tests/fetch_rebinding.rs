//! Issue #108: DNS pinning (connect to the checked address), redirect
//! re-validation, and TLS verification without opt-out
//! (`docs/24-threat-model.md` section B, rows "SSRF", "DNS rebinding",
//! "TLS downgrade or invalid certificate on `fetch`").
//!
//! The connector tests run without V8 (`--no-default-features`); the
//! tenant-level tests are V8-linked. A scripted UDP DNS server
//! (`support/dns_stub.rs`) answers a public address first and a private
//! one afterwards. Servers listen on loopback; the `test-hooks` connect
//! override maps the vetted public address to the "public" server.

#[path = "support/dns_stub.rs"]
mod dns_stub;
#[path = "support/http_server.rs"]
mod http_server;
#[cfg(feature = "v8")]
#[allow(clippy::duplicate_mod)]
mod support;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use renox_runtime::ops::fetch_connector::{
    EgressCounter, FetchConfig, FetchFailure, HickoryResolver, connect, resolve_checked,
};
use renox_runtime::ops::net_policy::{Allowlist, BlockReason};
use url::Url;

const PUBLIC: &str = "93.184.216.34";

fn public() -> IpAddr {
    PUBLIC.parse().unwrap()
}

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

/// `docs/24-threat-model.md`, "DNS rebinding": the first answer is public,
/// the second private. The request completes against the first address and
/// never touches the private one (a listener there counts connections); a
/// later resolution that returns the private address is refused.
#[tokio::test]
async fn rebinding_connects_only_to_the_checked_address() {
    let server = http_server::start().await;
    let port = server.addr.port();
    // The "private" side: same port on 127.0.0.2.
    let private_hits = http_server::counting_listener(SocketAddr::new(ip("127.0.0.2"), port)).await;
    let stub = dns_stub::start(HashMap::from([(
        "rebind.test".to_string(),
        vec![vec![public()], vec![ip("127.0.0.2")]],
    )]))
    .await;
    let mut config = FetchConfig::with_resolver(Arc::new(HickoryResolver::nameserver(stub.addr)));
    config
        .connect_override
        .insert(SocketAddr::new(public(), port), server.addr);
    let tls = config.tls();
    let allow = Allowlist::parse(&[format!("http://rebind.test:{port}")]).unwrap();
    let target = allow
        .check_url(&Url::parse(&format!("http://rebind.test:{port}/hello")).unwrap())
        .unwrap();

    // Hop: resolve once (public), connect to that address.
    let addrs = resolve_checked(&config, &target, 0).await.unwrap();
    assert_eq!(addrs, vec![SocketAddr::new(public(), port)]);
    let counter = Arc::new(EgressCounter::new(1 << 20));
    let io = connect(&config, &tls, &addrs, &target, counter)
        .await
        .unwrap();
    drop(io);
    assert_eq!(
        stub.a_queries("rebind.test"),
        1,
        "exactly one lookup per hop"
    );
    // The DNS server now answers the private address: refused.
    let err = resolve_checked(&config, &target, 0).await.unwrap_err();
    assert!(
        matches!(
            err,
            FetchFailure::Blocked {
                reason: BlockReason::BlockedAddress,
                ..
            }
        ),
        "{err:?}"
    );
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        private_hits.load(Ordering::SeqCst),
        0,
        "the private address was never connected to"
    );
}

/// NAT64-mapped private address (`64:ff9b::a00:5` = 10.0.0.5) is refused.
#[tokio::test]
async fn nat64_mapped_private_address_is_blocked() {
    let stub = dns_stub::start(HashMap::from([
        ("nat64.test".to_string(), vec![vec![ip("64:ff9b::a00:5")]]),
        (
            "nat64-local.test".to_string(),
            vec![vec![ip("64:ff9b:1::7f00:1")]],
        ),
    ]))
    .await;
    let config = FetchConfig::with_resolver(Arc::new(HickoryResolver::nameserver(stub.addr)));
    let allow = Allowlist::parse(&["nat64.test", "nat64-local.test"]).unwrap();
    for host in ["nat64.test", "nat64-local.test"] {
        let target = allow
            .check_url(&Url::parse(&format!("https://{host}/")).unwrap())
            .unwrap();
        let err = resolve_checked(&config, &target, 0).await.unwrap_err();
        assert!(
            matches!(
                err,
                FetchFailure::Blocked {
                    reason: BlockReason::BlockedAddress,
                    ..
                }
            ),
            "{host}: {err:?}"
        );
    }
}

/// `docs/24-threat-model.md`, "TLS downgrade or invalid certificate": a
/// self-signed certificate fails with reason `tls`; it is accepted only
/// when the operator adds it as a trust anchor (there is no "insecure").
#[tokio::test]
async fn self_signed_certificate_fails_tls() {
    let (server, cert) = http_server::start_tls(&["selfsigned.test"]).await;
    let port = server.addr.port();
    let allow = Allowlist::parse(&[format!("selfsigned.test:{port}")]).unwrap();
    let target = allow
        .check_url(&Url::parse(&format!("https://selfsigned.test:{port}/hello")).unwrap())
        .unwrap();
    let addrs = vec![SocketAddr::new(public(), port)];

    let mut config = FetchConfig::with_resolver(Arc::new(HickoryResolver::nameserver(
        "127.0.0.1:9".parse().unwrap(),
    )));
    config
        .connect_override
        .insert(SocketAddr::new(public(), port), server.addr);
    let err = connect(
        &config,
        &config.tls(),
        &addrs,
        &target,
        Arc::new(EgressCounter::new(1 << 20)),
    )
    .await
    .err()
    .expect("must fail");
    assert!(
        matches!(err, FetchFailure::Failed { reason: "tls", .. }),
        "{err:?}"
    );

    config.extra_root_certs.push(cert);
    assert!(
        connect(
            &config,
            &config.tls(),
            &addrs,
            &target,
            Arc::new(EgressCounter::new(1 << 20))
        )
        .await
        .is_ok()
    );
}

#[cfg(feature = "v8")]
mod tenant {
    use super::*;

    use renox_runtime::limits::Limits;
    use renox_runtime::runtime::MemoryLogSink;
    use renox_runtime::{IsolateHandle, IsolateSpec, RequestCtx, Runtime, RuntimeConfig};
    use std::time::{Duration, Instant};

    use super::support;

    fn ctx(id: &str) -> RequestCtx {
        RequestCtx {
            request_id: id.into(),
            deadline: Instant::now() + Duration::from_secs(20),
        }
    }

    fn enc(s: &str) -> String {
        s.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect()
    }

    const PROBE: &str = r#"
        export async function GET({ url }) {
            const init = JSON.parse(url.searchParams.get("init") ?? "{}");
            try {
                const r = await fetch(url.searchParams.get("url"), init);
                return Response.json({ ok: true, status: r.status, body: await r.text(), url: r.url });
            } catch (e) {
                return Response.json({ ok: false, code: e.code ?? null, details: e.details ?? null, name: e.name });
            }
        }
    "#;

    async fn iso(rt: &Runtime, network: &[&str]) -> IsolateHandle {
        let (dir, hash) = support::function_artifact(PROBE, &[("GET", "/p")], network);
        rt.create_isolate(IsolateSpec {
            tenant_id: "t_test".into(),
            deployment_hash: hash,
            artifact_dir: dir,
            limits: Limits::FREE,
            secrets: Default::default(),
            db: None,
        })
        .await
        .unwrap()
    }

    async fn probe(iso: &IsolateHandle, target: &str, init: &str) -> serde_json::Value {
        let req = support::get(&format!("/p?url={}&init={}", enc(target), enc(init)));
        let out = iso.dispatch(ctx("req_rebind_00001"), req).await;
        support::body_json(&out.response)
    }

    fn runtime(config: FetchConfig) -> Runtime {
        Runtime::new(RuntimeConfig {
            log_sink: Arc::new(MemoryLogSink::default()),
            fetch: config,
        })
    }

    /// Rebinding through tenant `fetch`: the first fetch completes against
    /// the public answer; the second resolves to the private address and is
    /// blocked; the private listener is never reached.
    #[tokio::test]
    async fn tenant_fetch_is_pinned_to_the_checked_address() {
        let server = http_server::start().await;
        let port = server.addr.port();
        let private_hits =
            http_server::counting_listener(SocketAddr::new(ip("127.0.0.2"), port)).await;
        let stub = dns_stub::start(HashMap::from([(
            "rebind.test".to_string(),
            vec![vec![public()], vec![ip("127.0.0.2")]],
        )]))
        .await;
        let mut config =
            FetchConfig::with_resolver(Arc::new(HickoryResolver::nameserver(stub.addr)));
        config
            .connect_override
            .insert(SocketAddr::new(public(), port), server.addr);
        let rt = runtime(config);
        let iso = iso(&rt, &[&format!("http://rebind.test:{port}")]).await;
        let url = format!("http://rebind.test:{port}/hello");
        let v = probe(&iso, &url, "{}").await;
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["body"], "hello");
        let v = probe(&iso, &url, "{}").await;
        assert_eq!(v["code"], "RENOX_FETCH_BLOCKED", "{v}");
        assert_eq!(v["details"]["reason"], "blocked_address");
        assert_eq!(stub.a_queries("rebind.test"), 2, "one lookup per fetch");
        assert_eq!(private_hits.load(Ordering::SeqCst), 0);
        assert_eq!(server.seen().len(), 1);
    }

    fn redirect_runtime(server: &http_server::TestServer, extra: &[(&str, IpAddr)]) -> Runtime {
        let mut names: HashMap<String, Vec<Vec<IpAddr>>> = HashMap::new();
        for n in ["api.example.com", "other.example.com"] {
            names.insert(n.into(), vec![vec![public()]]);
        }
        for (n, a) in extra {
            names.insert(n.to_string(), vec![vec![*a]]);
        }
        let resolver =
            support::StaticResolver(names.into_iter().map(|(k, v)| (k, v[0].clone())).collect());
        let mut config = FetchConfig::with_resolver(Arc::new(resolver));
        config
            .connect_override
            .insert(SocketAddr::new(public(), 80), server.addr);
        runtime(config)
    }

    /// A redirect chain that ends at a private address is refused at that
    /// hop with `RENOX_FETCH_BLOCKED`, `reason: blocked_address`, and the
    /// hop index; the private target is never contacted.
    #[tokio::test]
    async fn redirect_chain_to_private_address_is_blocked_with_hop_index() {
        let server = http_server::start().await;
        let rt = redirect_runtime(&server, &[("internal.example.com", ip("192.168.1.10"))]);
        let iso = iso(
            &rt,
            &["http://api.example.com", "http://internal.example.com"],
        )
        .await;
        let last = "http://internal.example.com/hello";
        let mid = format!(
            "http://api.example.com/redirect?status=307&to={}",
            enc(last)
        );
        let first = format!(
            "http://api.example.com/redirect?status=302&to={}",
            enc(&mid)
        );
        let v = probe(&iso, &first, "{}").await;
        assert_eq!(v["code"], "RENOX_FETCH_BLOCKED", "{v}");
        assert_eq!(v["details"]["reason"], "blocked_address");
        assert_eq!(v["details"]["hop"], 2);
        assert_eq!(v["details"]["host"], "internal.example.com");
        assert_eq!(server.seen().len(), 2, "{:?}", server.seen());
    }

    /// Credentials are dropped when a redirect changes origin, kept when it
    /// does not.
    #[tokio::test]
    async fn authorization_is_stripped_on_cross_host_redirect() {
        let server = http_server::start().await;
        let rt = redirect_runtime(&server, &[]);
        let iso = iso(&rt, &["http://api.example.com", "http://other.example.com"]).await;
        let init = r#"{"headers":{"authorization":"Bearer s3cret-token-1"}}"#;
        let same = format!(
            "http://api.example.com/redirect?to={}",
            enc("http://api.example.com/echo")
        );
        let v = probe(&iso, &same, init).await;
        let echo: serde_json::Value = serde_json::from_str(v["body"].as_str().unwrap()).unwrap();
        assert_eq!(echo["authorization"], "Bearer s3cret-token-1");
        let cross = format!(
            "http://api.example.com/redirect?to={}",
            enc("http://other.example.com/echo")
        );
        let v = probe(&iso, &cross, init).await;
        let echo: serde_json::Value = serde_json::from_str(v["body"].as_str().unwrap()).unwrap();
        assert_eq!(echo["host"], "other.example.com");
        assert_eq!(echo["authorization"], serde_json::Value::Null);
    }

    /// `https` -> `http` redirects are allowed only to a host declared with
    /// `http://`; a self-signed certificate fails with `RENOX_FETCH_FAILED`
    /// reason `tls`, and no fetch option turns verification off.
    #[tokio::test]
    async fn tls_rules_through_tenant_fetch() {
        let plain = http_server::start().await;
        let (tls_server, cert) =
            http_server::start_tls(&["secure.example.com", "untrusted.example.com"]).await;
        let tport = tls_server.addr.port();
        let mut names = HashMap::new();
        for n in [
            "api.example.com",
            "secure.example.com",
            "untrusted.example.com",
        ] {
            names.insert(n.to_string(), vec![public()]);
        }
        let mut config = FetchConfig::with_resolver(Arc::new(support::StaticResolver(names)));
        config
            .connect_override
            .insert(SocketAddr::new(public(), 80), plain.addr);
        config
            .connect_override
            .insert(SocketAddr::new(public(), tport), tls_server.addr);
        // Trusted: the operator added this anchor (stands in for a real CA).
        let mut trusting = config.clone();
        trusting.extra_root_certs.push(cert);

        // Untrusted self-signed certificate: tls failure, whatever the options say.
        let rt = runtime(config);
        let iso1 = iso(&rt, &[&format!("untrusted.example.com:{tport}")]).await;
        let url = format!("https://untrusted.example.com:{tport}/hello");
        for init in [
            "{}",
            r#"{"insecure":true,"rejectUnauthorized":false,"unsafelyIgnoreCertificateErrors":true}"#,
        ] {
            let v = probe(&iso1, &url, init).await;
            assert_eq!(v["code"], "RENOX_FETCH_FAILED", "{v}");
            assert_eq!(v["details"]["reason"], "tls");
        }
        // Deno's custom HTTP client option is refused before any network
        // (Deno.createHttpClient does not exist here; anything else is a TypeError).
        let v = probe(&iso1, &url, r#"{"client":{"caCerts":[]}}"#).await;
        assert_eq!(v["ok"], false, "{v}");
        assert_eq!(v["name"], "TypeError");

        // https -> http: refused unless the target is declared http://.
        let rt = runtime(trusting);
        let to_http = format!(
            "https://secure.example.com:{tport}/redirect?to={}",
            enc("http://api.example.com/hello")
        );
        let iso2 = iso(
            &rt,
            &[&format!("secure.example.com:{tport}"), "api.example.com"],
        )
        .await;
        let v = probe(&iso2, &to_http, "{}").await;
        assert_eq!(v["code"], "RENOX_FETCH_BLOCKED", "{v}");
        assert_eq!(v["details"]["reason"], "scheme");
        assert_eq!(v["details"]["hop"], 1);
        let iso3 = iso(
            &rt,
            &[
                &format!("secure.example.com:{tport}"),
                "http://api.example.com",
            ],
        )
        .await;
        let v = probe(&iso3, &to_http, "{}").await;
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["body"], "hello");
    }

    /// Review findings: a 204 response is a normal `Response` with a null
    /// body, and unread response bodies count against the per-request cap
    /// on open fetches (each holds a connection).
    #[tokio::test]
    async fn null_body_status_and_open_body_cap() {
        let server = http_server::start().await;
        let rt = redirect_runtime(&server, &[]);
        let src = r#"
            export async function GET() {
                const r = await fetch("http://api.example.com/nocontent");
                const held = [];
                let refused = null;
                for (let i = 0; i < 40; i++) {
                    try { held.push(await fetch("http://api.example.com/hello")); }
                    catch (e) { refused = { at: i, code: e.code, reason: e.details?.reason }; break; }
                }
                return Response.json({ status: r.status, body: r.body, refused });
            }
        "#;
        let (dir, hash) =
            support::function_artifact(src, &[("GET", "/n")], &["http://api.example.com"]);
        let iso = rt
            .create_isolate(IsolateSpec {
                tenant_id: "t_test".into(),
                deployment_hash: hash,
                artifact_dir: dir,
                limits: Limits::FREE,
                secrets: Default::default(),
                db: None,
            })
            .await
            .unwrap();
        let out = iso
            .dispatch(ctx("req_review_00001"), support::get("/n"))
            .await;
        let v = support::body_json(&out.response);
        assert_eq!(v["status"], 204, "{v}");
        assert_eq!(v["body"], serde_json::Value::Null);
        assert_eq!(
            v["refused"],
            serde_json::json!({ "at": 32, "code": "RENOX_FETCH_FAILED", "reason": "concurrency" }),
            "{v}"
        );
    }
}
