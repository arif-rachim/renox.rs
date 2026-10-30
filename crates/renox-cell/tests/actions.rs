//! Issue #41: page actions end to end through the worker (V8-linked).
//! Sessions and CSRF in the cell, the action's transaction (commit, rollback
//! on throw and on a refused result), action results (object, `Response`,
//! `{ fragments }`), `load` re-run after an object, out-of-band fragments,
//! `.ts`-only and `.html`-only pages, the trailing-slash redirect, and that
//! tenant code never sees the token.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use renox_cell::{Worker, WorkerConfig};
use renox_template::{Compiler, TemplateProject};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-actions-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let target = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &target);
        } else {
            std::fs::copy(e.path(), target).unwrap();
        }
    }
}

const CART_HTML: &str = r##"<!doctype html><html><body>
<x-form action="add" hx-target="#items"><input name="sku"><button>Add</button></x-form>
<span id="cart-badge" r-fragment="cart_badge">{{ count }}</span>
<ul id="items" r-fragment="items"><li r-for="i in items">{{ i.sku }}</li></ul>
<p id="note">{{ added ?? "" }}</p>
</body></html>"##;

const CART_JS: &str = r#"
export async function load({ db, fragment, session }) {
  const items = await db.query("select sku from app__cart order by id");
  return { count: items.length, items, fragment, sid: session.id };
}
export const actions = {
  async add({ form, db, session, headers, action, log }) {
    log.info("add", {
      sid: session.id,
      action,
      cookie: headers.get("cookie"),
      csrf_header: headers.get("x-renox-csrf"),
      form_has_csrf: form.has("_csrf"),
    });
    await db.execute("insert into app__cart (sku) values (?)", [form.get("sku")]);
    return { added: form.get("sku"), fragments: ["cart_badge"] };
  },
  async boom({ db }) {
    await db.execute("insert into app__cart (sku) values ('boom')");
    throw new Error("payment provider down");
  },
  async bad({ db }) {
    await db.execute("insert into app__cart (sku) values ('bad')");
    return 5;
  },
  async go({ db }) {
    await db.execute("insert into app__cart (sku) values ('go')");
    return new Response(null, { status: 303, headers: { location: "/cart" } });
  },
  async ghost() {
    return { fragments: ["nope"] };
  },
  async nested({ db }) {
    // #289: scoped() in the action's transaction, still no transaction().
    const scoped = db.scoped({ user_id: "u" });
    const n = await scoped.queryOne("select count(*) as n from app__cart");
    return Response.json({ has_transaction: typeof db.transaction, has_scoped: typeof db.scoped, scoped_tx: typeof scoped.transaction, n: typeof n.n });
  },
};
"#;

/// `.ts`-only page with an action: it must return a Response.
const TSONLY_JS: &str = r#"
export const actions = {
  async default({ form }) {
    return Response.json({ got: form.get("x") });
  },
  async object() {
    return { a: 1 };
  },
};
export function load() { return new Response("ts-only"); }
"#;

const API_JS: &str = r#"
export function POST() { return Response.json({ ok: true }); }
"#;

fn write_artifact(artifacts: &Path) -> String {
    let mut project = TemplateProject::new();
    project.insert("pages/cart.html", CART_HTML);
    project.insert("pages/about.html", "<p>About</p>");
    let compiled = Compiler::default()
        .compile(&project)
        .unwrap_or_else(|d| panic!("{d:?}"));
    let tmp = scratch("artifact-src");
    for (rel, src) in compiled.files() {
        let p = tmp.join("templates").join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let code = [
        ("pages/cart", CART_JS),
        ("pages/tsonly", TSONLY_JS),
        ("functions/api/x", API_JS),
    ];
    for (id, js) in code {
        let p = tmp.join("code").join(format!("{id}.js"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, js).unwrap();
    }
    let sql = "create table app__cart (id integer primary key, sku text not null);\n";
    std::fs::create_dir_all(tmp.join("migrations/app")).unwrap();
    std::fs::write(tmp.join("migrations/app/001_init.sql"), sql).unwrap();
    let file_sha = {
        use sha2::Digest;
        let d = sha2::Sha256::digest(sql.as_bytes());
        d.iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    std::fs::write(
        tmp.join("migrations/checksums.json"),
        serde_json::json!({ "version": 0, "files": { "app/001_init.sql": file_sha } }).to_string(),
    )
    .unwrap();
    let entry: serde_json::Map<String, serde_json::Value> = code
        .iter()
        .map(|(id, _)| (id.to_string(), format!("{id}.js").into()))
        .collect();
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "shop", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": entry },
        "routes": [
            { "kind": "page", "path": "/cart", "module": "pages/cart", "load": true,
              "actions": ["add", "boom", "bad", "go", "ghost", "nested"], "template": "pages/cart" },
            { "kind": "page", "path": "/tsonly", "module": "pages/tsonly", "load": true, "actions": ["default", "object"] },
            { "kind": "page", "path": "/about", "template": "pages/about" },
            { "kind": "function", "method": "POST", "path": "/api/x", "module": "functions/api/x", "export": "POST" }
        ],
        "templates": compiled.manifest_entries(),
        "permissions": { "network": [], "secrets": [] },
        "security": { "ratelimit": [
            { "method": "POST", "path": "/api/x", "requests": 2, "window_s": 60, "key": "ip" }
        ] }
    });
    std::fs::write(
        tmp.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    renox_cell::Manifest::parse(&tmp.join("manifest.json")).unwrap();
    let hash = renox_runtime::manifest::content_hash(&tmp).unwrap();
    copy_dir(&tmp, &artifacts.join(&hash));
    hash
}

struct Reply {
    status: u16,
    head: String,
    body: String,
}

impl Reply {
    fn set_cookies(&self) -> Vec<String> {
        self.head
            .lines()
            .filter_map(|l| l.strip_prefix("set-cookie: "))
            .map(str::to_string)
            .collect()
    }
}

async fn http(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> Reply {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: shop.test\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    // Set-Cookie values are case-sensitive: keep them; lower-case the names.
    let head = head
        .lines()
        .map(|l| match l.split_once(": ") {
            Some((k, v)) => format!("{}: {v}", k.to_ascii_lowercase()),
            None => l.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n");
    Reply {
        status,
        head,
        body: body.to_string(),
    }
}

const FORM: (&str, &str) = ("content-type", "application/x-www-form-urlencoded");

/// The `_csrf` value of the first form in `body`.
fn rendered_token(body: &str) -> String {
    let needle = "name=\"_csrf\" value=\"";
    let start = body.find(needle).expect("csrf field") + needle.len();
    let len = body[start..].find('"').unwrap();
    body[start..start + len].to_string()
}

fn count(body: &str) -> String {
    let start = body.find("id=\"cart-badge\"").expect("badge") + "id=\"cart-badge\"".len();
    let rest = &body[start..];
    let open = rest.find('>').unwrap() + 1;
    let close = rest.find("</span>").unwrap();
    rest[open..close].to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actions_csrf_and_transactions() {
    let root = scratch("worker");
    std::fs::create_dir_all(root.join("artifacts")).unwrap();
    let text = r#"
listen = "127.0.0.1:0"
data_dir = "data"
artifacts_dir = "artifacts"
routes_file = "routes.json"
meters_dir = "meters"
logs_dir = "logs"
idle_timeout_secs = 60
meter_flush_ms = 50
"#;
    let config = WorkerConfig::parse(text, &root).unwrap();
    let hash = write_artifact(&config.artifacts_dir);
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "shop.test", "tenant_id": "t_shop", "deployment_hash": hash, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(&config.routes_file, routes.to_string()).unwrap();
    let worker = Worker::start(config.clone()).await.unwrap();
    let addr = worker.addr;

    // GET: a fresh session and the double-submit cookie; the form carries
    // the same token, masked for this response (BREACH, #111).
    let first = http(addr, "GET", "/cart", &[], "").await;
    assert_eq!(first.status, 200, "{}", first.body);
    let cookies = first.set_cookies();
    assert_eq!(cookies.len(), 2, "{cookies:?}");
    let sid = cookies[0].split(';').next().unwrap().to_string();
    assert!(sid.starts_with("__Host-renox_sid="), "{sid}");
    assert!(cookies[0].contains("HttpOnly") && cookies[0].contains("Secure"));
    assert!(cookies[0].contains("SameSite=Lax") && cookies[0].contains("Path=/"));
    let csrf = cookies[1].split(';').next().unwrap().to_string();
    let token = csrf.strip_prefix("__Host-renox_csrf=").unwrap().to_string();
    let rendered = rendered_token(&first.body);
    assert_ne!(rendered, token, "the body never carries the cookie's bytes");
    assert!(!first.body.contains(&token), "{}", first.body);
    assert_eq!(
        renox_cell::pages::session::unmask_token(&rendered).as_deref(),
        Some(token.as_str())
    );
    assert!(first.body.contains("action=\"?/add\" hx-post=\"?/add\""));
    assert_eq!(count(&first.body), "0");
    let jar = format!("{sid}; {csrf}");
    let id = sid
        .strip_prefix("__Host-renox_sid=")
        .unwrap()
        .split('.')
        .next()
        .unwrap()
        .to_string();

    // A known session: no new cookies.
    let again = http(addr, "GET", "/cart", &[("cookie", &jar)], "").await;
    assert!(again.set_cookies().is_empty(), "{:?}", again.set_cookies());

    // No token: 403 RENOX_CSRF, the action did not run.
    let r = http(
        addr,
        "POST",
        "/cart?/add",
        &[("cookie", &jar), FORM],
        "sku=a",
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.body);
    assert!(
        r.body.contains("The request could not be verified."),
        "{}",
        r.body
    );
    // A wrong token, and a token without the cookie.
    let r = http(
        addr,
        "POST",
        "/cart?/add",
        &[("cookie", &jar), FORM],
        "sku=a&_csrf=xyz",
    )
    .await;
    assert_eq!(r.status, 403);
    // What a browser submits: the masked token of the rendered form.
    let body = format!("sku=a&_csrf={rendered}");
    let r = http(addr, "POST", "/cart?/add", &[("cookie", &sid), FORM], &body).await;
    assert_eq!(r.status, 403);
    assert_eq!(
        count(
            &http(addr, "GET", "/cart", &[("cookie", &jar)], "")
                .await
                .body
        ),
        "0"
    );

    // Plain form POST with the token: commits, re-runs load, full page with
    // the action's data on top.
    let r = http(addr, "POST", "/cart?/add", &[("cookie", &jar), FORM], &body).await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert!(
        r.body.contains("<html lang=\"en\" dir=\"ltr\">"),
        "full page: {}",
        r.body
    );
    assert!(!r.body.contains("hx-swap-oob"), "{}", r.body);
    assert_eq!(count(&r.body), "1");
    assert!(
        r.body.contains("<p id=\"note\" dir=\"auto\">a</p>") || r.body.contains(">a</p>"),
        "{}",
        r.body
    );

    // htmx POST with the header token: the HX-Target fragment, then the
    // out-of-band badge.
    let r = http(
        addr,
        "POST",
        "/cart?/add",
        &[
            ("cookie", &jar),
            FORM,
            ("x-renox-csrf", &token),
            ("hx-request", "true"),
            ("hx-target", "items"),
        ],
        "sku=b",
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert!(r.body.starts_with("<ul id=\"items\""), "{}", r.body);
    assert!(
        r.body
            .contains("<li dir=\"auto\">a</li><li dir=\"auto\">b</li>")
            || r.body.contains(">b</li>"),
        "{}",
        r.body
    );
    assert!(
        r.body
            .contains("<span hx-swap-oob=\"true\" id=\"cart-badge\""),
        "{}",
        r.body
    );
    assert!(!r.body.contains("<html"));
    // htmx POST without a matching target: only the out-of-band blocks.
    let r = http(
        addr,
        "POST",
        "/cart?/add",
        &[
            ("cookie", &jar),
            FORM,
            ("x-renox-csrf", &token),
            ("hx-request", "true"),
        ],
        "sku=c",
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert!(
        r.body
            .starts_with("<span hx-swap-oob=\"true\" id=\"cart-badge\""),
        "{}",
        r.body
    );
    assert_eq!(count(&r.body), "3");

    let hx = |a: &'static str| {
        let jar = jar.clone();
        let token = token.clone();
        async move {
            http(
                addr,
                "POST",
                &format!("/cart?/{a}"),
                &[("cookie", &jar), FORM, ("x-renox-csrf", &token)],
                "",
            )
            .await
        }
    };
    // A throw rolls back: 500, nothing inserted.
    let r = hx("boom").await;
    assert_eq!(r.status, 500, "{}", r.body);
    assert!(!r.body.contains("payment provider down"));
    // A refused result rolls back too.
    assert_eq!(hx("bad").await.status, 500);
    assert_eq!(
        count(
            &http(addr, "GET", "/cart", &[("cookie", &jar)], "")
                .await
                .body
        ),
        "3"
    );
    // A Response is sent after the commit.
    let r = hx("go").await;
    assert_eq!(r.status, 303);
    assert!(r.head.contains("location: /cart"));
    assert_eq!(
        count(
            &http(addr, "GET", "/cart", &[("cookie", &jar)], "")
                .await
                .body
        ),
        "4"
    );
    // An unknown out-of-band fragment: 500 (after the commit).
    assert_eq!(hx("ghost").await.status, 500);
    // The action's db is the transaction: no nested transaction().
    let r = hx("nested").await;
    assert_eq!(r.status, 200);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&r.body).unwrap(),
        serde_json::json!({ "has_transaction": "undefined", "has_scoped": "function", "scoped_tx": "undefined", "n": "number" })
    );
    // An unknown action is 404 with no tenant code; `default` exists only
    // where declared.
    assert_eq!(hx("nope").await.status, 404);
    let r = http(
        addr,
        "POST",
        "/cart",
        &[("cookie", &jar), FORM, ("x-renox-csrf", &token)],
        "",
    )
    .await;
    assert_eq!(r.status, 404);

    // .ts-only page: `default` without `?/`, a Response; an object is 500.
    let r = http(
        addr,
        "POST",
        "/tsonly",
        &[("cookie", &jar), FORM, ("x-renox-csrf", &token)],
        "x=1",
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(r.body, "{\"got\":\"1\"}");
    let r = http(
        addr,
        "POST",
        "/tsonly?/object",
        &[("cookie", &jar), FORM, ("x-renox-csrf", &token)],
        "",
    )
    .await;
    assert_eq!(r.status, 500);
    assert_eq!(http(addr, "GET", "/tsonly", &[], "").await.body, "ts-only");

    // .html-only page: GET only; POST is 405.
    let r = http(addr, "POST", "/about", &[], "").await;
    assert_eq!(r.status, 405);
    assert!(r.head.contains("allow: GET, HEAD"), "{}", r.head);
    let r = http(addr, "PUT", "/cart", &[], "").await;
    assert_eq!(r.status, 405);
    assert!(r.head.contains("allow: GET, HEAD, POST"), "{}", r.head);

    // Function routes are not CSRF-checked.
    let r = http(addr, "POST", "/api/x", &[], "").await;
    assert_eq!(r.status, 200, "{}", r.body);
    // #47: the per-route bucket (2 per minute per IP) stops the third.
    assert_eq!(http(addr, "POST", "/api/x", &[], "").await.status, 200);
    let limited = http(addr, "POST", "/api/x", &[], "").await;
    assert_eq!(limited.status, 429);
    assert!(limited.head.contains("retry-after: "), "{}", limited.head);

    // Trailing slash: 308 for pages (query kept), never for functions.
    let r = http(addr, "GET", "/cart/?q=1", &[], "").await;
    assert_eq!(r.status, 308);
    assert!(r.head.contains("location: /cart?q=1"), "{}", r.head);
    assert_eq!(http(addr, "POST", "/api/x/", &[], "").await.status, 404);

    // Tenant code saw the session id, never the token, the signature, or
    // the CSRF header; the refusals are logged.
    let logs = std::fs::read_to_string(config.logs_dir.join("tenant.ndjson")).unwrap();
    assert!(logs.contains(&format!("\"sid\":\"{id}\"")), "{logs}");
    assert!(logs.contains("\"csrf_header\":null"), "{logs}");
    assert!(logs.contains("\"form_has_csrf\":false"), "{logs}");
    assert!(logs.contains("\"cookie\":null"), "{logs}");
    assert!(
        !logs.contains(&token),
        "the token never reaches tenant code"
    );
    assert!(
        logs.contains("RENOX_CSRF") && logs.contains("\"reason\":\"missing\""),
        "{logs}"
    );
    assert!(logs.contains("\"reason\":\"mismatch\""), "{logs}");
    assert!(
        logs.contains("\"reason\":\"threw\"") || logs.contains("payment provider down"),
        "{logs}"
    );
    assert!(logs.contains("\"reason\":\"action_result\""), "{logs}");

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
