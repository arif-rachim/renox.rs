//! `op_renox_fetch`, `op_fetch_body_read`, `op_fetch_body_close`
//! (`docs/contracts/ops.md` section 2): the only outbound network path of
//! tenant code. Backs the global `fetch` and `ctx.fetch`.
//!
//! Every hop runs the contract's order of checks: allowlist (scheme, host,
//! port) → DNS resolved here, every address checked → connect to one of the
//! checked addresses with the original `Host` and SNI → on a 3xx, the same
//! checks for the `Location` target. The whole fetch, including body reads,
//! is bounded by the request deadline, and the bytes on the wire count
//! against the request's egress limit.

use std::borrow::Cow;
use std::cell::RefCell;
use std::net::{IpAddr, SocketAddr};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use deno_core::{
    ByteString, CancelFuture, CancelHandle, JsBuffer, OpState, Resource, ResourceId, ToJsBuffer,
    op2,
};
use deno_error::JsErrorBox;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use url::Url;

pub use crate::ops::fetch_connector::{FetchConfig, HickoryResolver};
pub use crate::ops::net_policy::Resolve;

use crate::ops::fetch_connector::{EgressCounter, FetchFailure, connect, resolve_checked};
use crate::ops::net_policy::{
    Allowlist, BlockReason, Blocked, CREDENTIAL_HEADERS, RedirectError, Target, TargetHost,
    is_redirect, method_blocked, redirect_target,
};
use crate::ops::request::{live_request, op_error};
use crate::runtime::{LogLine, LogSink};

/// Concurrent fetches per request (`ops.md` section 2, "Limits").
pub const MAX_CONCURRENT_FETCHES: u32 = 16;
/// Fetches in flight plus response bodies still open, per request: an
/// unread body keeps its connection open, so it counts as a fetch.
pub const MAX_OPEN_FETCHES: u32 = 32;

/// Request headers per fetch.
pub const MAX_HEADERS: usize = 64;
/// Total request header bytes per fetch.
pub const MAX_HEADER_BYTES: usize = 16 * 1024;

// ---------------------------------------------------------------------------
// Per-isolate and per-request state

/// What `op_renox_fetch` needs from the isolate, put into its `OpState` at creation.
pub(crate) struct FetchEnv {
    /// The app's allowlist (`manifest.permissions.network`).
    pub allowlist: Allowlist,
    /// Each module's own list (ops.md 1.3.0 section 2, `FetchRequest.module`).
    pub modules: Arc<crate::ops::modules::ModuleRegistry>,
    pub config: FetchConfig,
    pub tls: Arc<rustls::ClientConfig>,
    pub tenant_id: String,
    pub deployment_hash: String,
    pub log_sink: Arc<dyn LogSink>,
}

impl FetchEnv {
    pub fn new(
        allowlist: Allowlist,
        config: FetchConfig,
        tenant_id: String,
        deployment_hash: String,
        log_sink: Arc<dyn LogSink>,
        modules: Arc<crate::ops::modules::ModuleRegistry>,
    ) -> FetchEnv {
        let tls = config.tls();
        FetchEnv {
            allowlist,
            modules,
            config,
            tls,
            tenant_id,
            deployment_hash,
            log_sink,
        }
    }
}

// ---------------------------------------------------------------------------
// Errors

/// The op error for a failure: the contract's code, `details`, and a fixed
/// message (no address, no internal detail).
fn failure_error(f: FetchFailure) -> JsErrorBox {
    match f {
        FetchFailure::Blocked { host, reason, hop } => op_error(
            "RENOX_FETCH_BLOCKED",
            serde_json::json!({ "host": host, "reason": reason.as_str(), "hop": hop }),
            "The request was blocked by the outbound network policy.",
        ),
        FetchFailure::Failed { host, reason } => op_error(
            "RENOX_FETCH_FAILED",
            serde_json::json!({ "host": host, "reason": reason }),
            "The outbound request failed.",
        ),
        FetchFailure::EgressLimit { host, limit } => op_error(
            "RENOX_FETCH_EGRESS_LIMIT",
            serde_json::json!({ "host": host, "limitBytes": limit }),
            "The request's outbound byte limit was reached.",
        ),
        FetchFailure::Deadline => op_error(
            "RENOX_DEADLINE",
            serde_json::Value::Null,
            "The request's deadline passed.",
        ),
    }
}

// ---------------------------------------------------------------------------
// One hop

/// A response whose body is still on the wire.
pub(crate) struct HopResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(ByteString, ByteString)>,
    pub body: Incoming,
    conn: tokio::task::JoinHandle<()>,
}

const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
];

#[allow(clippy::too_many_arguments)]
async fn send_hop(
    env: &FetchEnv,
    addrs: &[SocketAddr],
    target: &Target,
    url: &Url,
    method: &str,
    headers: &[(ByteString, ByteString)],
    body: &Option<Bytes>,
    counter: Arc<EgressCounter>,
) -> Result<HopResponse, FetchFailure> {
    let host = target.host.display();
    let failed = |reason| FetchFailure::Failed {
        host: host.clone(),
        reason,
    };
    let io = connect(&env.config, &env.tls, addrs, target, counter.clone()).await?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(io))
        .await
        .map_err(|_| failed("connect"))?;
    let conn = tokio::spawn(async move {
        let _ = conn.await;
    });
    let path = match url.query() {
        Some(q) => format!("{}?{}", url.path(), q),
        None => url.path().to_string(),
    };
    let authority = match (url.port(), &target.host) {
        (Some(p), TargetHost::Ip(IpAddr::V6(v6))) => format!("[{v6}]:{p}"),
        (None, TargetHost::Ip(IpAddr::V6(v6))) => format!("[{v6}]"),
        (Some(p), _) => format!("{}:{p}", target.host.display()),
        (None, _) => target.host.display(),
    };
    let mut b = http::Request::builder()
        .method(method)
        .uri(path)
        .header(http::header::HOST, authority);
    for (k, v) in headers {
        let name = String::from_utf8_lossy(k).to_ascii_lowercase();
        if HOP_BY_HOP.contains(&name.as_str()) {
            continue;
        }
        b = b.header(k.as_slice(), v.as_slice());
    }
    let req = b
        .body(Full::new(body.clone().unwrap_or_default()))
        .map_err(|_| failed("headers"))?;
    let resp = sender.send_request(req).await.map_err(|_| {
        if counter.exceeded() {
            FetchFailure::EgressLimit {
                host: host.clone(),
                limit: counter.limit,
            }
        } else {
            failed("reset")
        }
    })?;
    let status = resp.status();
    let headers = resp
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                ByteString::from(k.as_str().as_bytes().to_vec()),
                ByteString::from(v.as_bytes().to_vec()),
            )
        })
        .collect();
    Ok(HopResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body: resp.into_body(),
        conn,
    })
}

fn header_value<'a>(headers: &'a [(ByteString, ByteString)], name: &str) -> Option<Cow<'a, str>> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name.as_bytes()))
        .map(|(_, v)| String::from_utf8_lossy(v))
}

/// The redirect loop: run one hop per URL, re-checking the policy every
/// time, until a non-redirect response (or `manual`/`error` mode).
pub(crate) struct FetchResult {
    pub final_url: Url,
    pub redirected: bool,
    pub response: HopResponse,
}

async fn fetch_with_policy(
    env: &FetchEnv,
    allowlist: &Allowlist,
    req: FetchRequest,
    counter: Arc<EgressCounter>,
) -> Result<FetchResult, FetchFailure> {
    let mut url = Url::parse(&req.url).map_err(|_| FetchFailure::Blocked {
        host: String::new(),
        reason: BlockReason::Scheme,
        hop: 0,
    })?;
    let mut method = req.method.to_ascii_uppercase();
    let mut headers = req.headers;
    let mut body: Option<Bytes> = req.body.map(|b| Bytes::copy_from_slice(&b));
    let host0 = url.host_str().unwrap_or("").to_string();
    if method_blocked(&method) {
        return Err(FetchFailure::Blocked {
            host: host0,
            reason: BlockReason::Method,
            hop: 0,
        });
    }
    let header_bytes: usize = headers.iter().map(|(k, v)| k.len() + v.len()).sum();
    if headers.len() > MAX_HEADERS || header_bytes > MAX_HEADER_BYTES {
        return Err(FetchFailure::Failed {
            host: host0,
            reason: "headers",
        });
    }
    let mut hop = 0usize;
    loop {
        // Step 1.
        let target = allowlist
            .check_url(&url)
            .map_err(|Blocked { host, reason }| FetchFailure::Blocked { host, reason, hop })?;
        // Step 2.
        let addrs = resolve_checked(&env.config, &target, hop).await?;
        // Step 3.
        let response = send_hop(
            env,
            &addrs,
            &target,
            &url,
            &method,
            &headers,
            &body,
            counter.clone(),
        )
        .await?;
        if !is_redirect(response.status) || req.redirect == "manual" {
            return Ok(FetchResult {
                final_url: url,
                redirected: hop > 0,
                response,
            });
        }
        if req.redirect == "error" {
            response.conn.abort();
            return Err(FetchFailure::Failed {
                host: target.host.display(),
                reason: "redirect",
            });
        }
        // Step 4.
        let location = header_value(&response.headers, "location").map(|l| l.into_owned());
        response.conn.abort();
        hop += 1;
        let next = redirect_target(
            &url,
            &method,
            response.status,
            location.as_deref(),
            hop,
            allowlist,
        )
        .map_err(|e| match e {
            RedirectError::BadLocation => FetchFailure::Failed {
                host: target.host.display(),
                reason: "redirect",
            },
            RedirectError::Blocked(Blocked { host, reason }) => {
                FetchFailure::Blocked { host, reason, hop }
            }
        })?;
        if !next.keep_body {
            body = None;
            headers.retain(|(k, _)| {
                !k.eq_ignore_ascii_case(b"content-type")
                    && !k.eq_ignore_ascii_case(b"content-encoding")
            });
        }
        if next.strip_credentials {
            headers.retain(|(k, _)| {
                !CREDENTIAL_HEADERS
                    .iter()
                    .any(|c| k.eq_ignore_ascii_case(c.as_bytes()))
            });
        }
        method = next.method;
        url = next.url;
    }
}

// ---------------------------------------------------------------------------
// Ops

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchRequest {
    method: String,
    url: String,
    headers: Vec<(ByteString, ByteString)>,
    body: Option<JsBuffer>,
    redirect: String,
    /// ops.md 1.3.0: whose allowlist applies; `None` = the app.
    #[serde(default)]
    module: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchResponseHead {
    status: u16,
    status_text: String,
    headers: Vec<(ByteString, ByteString)>,
    url: String,
    redirected: bool,
    body: Option<ResourceId>,
}

/// A response body being read by tenant code.
pub(crate) struct FetchBody {
    body: RefCell<Option<Incoming>>,
    conn: tokio::task::JoinHandle<()>,
    host: String,
    token: u32,
    open: Rc<std::cell::Cell<u32>>,
}

impl Drop for FetchBody {
    fn drop(&mut self) {
        self.conn.abort();
        self.open.set(self.open.get().saturating_sub(1));
    }
}

impl Resource for FetchBody {
    fn name(&self) -> Cow<'_, str> {
        "renoxFetchBody".into()
    }

    fn close(self: Rc<Self>) {
        self.conn.abort();
        self.body.borrow_mut().take();
    }
}

fn log_blocked(env: &FetchEnv, request_id: Option<String>, host: &str, reason: &str) {
    let mut fields = serde_json::Map::new();
    fields.insert("code".into(), "RENOX_FETCH_BLOCKED".into());
    fields.insert("host".into(), host.into());
    fields.insert("reason".into(), reason.into());
    env.log_sink.log(LogLine {
        level: "warn",
        tenant_id: env.tenant_id.clone(),
        deployment_hash: env.deployment_hash.clone(),
        request_id,
        message: "fetch blocked".into(),
        fields,
    });
}

/// Run `fut` until the request's deadline or cancellation.
async fn bounded<T>(
    fut: impl std::future::Future<Output = Result<T, FetchFailure>>,
    deadline: Instant,
    cancel: Rc<CancelHandle>,
) -> Result<T, FetchFailure> {
    let timed = tokio::time::timeout_at(deadline.into(), fut);
    match timed.or_cancel(cancel).await {
        Ok(Ok(r)) => r,
        Ok(Err(_elapsed)) => Err(FetchFailure::Deadline),
        Err(_cancelled) => Err(FetchFailure::Deadline),
    }
}

/// Close a resource without holding the table borrow across `close`.
fn close_rid(state: &mut OpState, rid: ResourceId) {
    if let Ok(r) = state.resource_table.take_any(rid) {
        r.close();
    }
}

#[op2]
#[serde]
pub(crate) async fn op_renox_fetch(
    state: Rc<RefCell<OpState>>,
    token: u32,
    #[serde] req: FetchRequest,
) -> Result<FetchResponseHead, JsErrorBox> {
    let head_request = req.method.eq_ignore_ascii_case("HEAD");
    let (request, env) = {
        let s = state.borrow();
        let request = live_request(&s, token)?;
        let env = s.borrow::<Rc<FetchEnv>>().clone();
        (request, env)
    };
    let (deadline, cancel, counter, request_id) = {
        let mut r = request.borrow_mut();
        if r.fetches_in_flight >= MAX_CONCURRENT_FETCHES
            || r.fetches_in_flight + r.open_bodies.get() >= MAX_OPEN_FETCHES
        {
            let host = Url::parse(&req.url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_default();
            return Err(failure_error(FetchFailure::Failed {
                host,
                reason: "concurrency",
            }));
        }
        r.fetches_in_flight += 1;
        (
            r.deadline,
            r.cancel.clone(),
            r.egress.clone(),
            r.request_id.clone(),
        )
    };
    // A module's fetch is checked against its own list only (ops.md 1.3.0
    // section 2); an unknown module name gets nothing.
    let module_list = match req.module.as_deref() {
        None | Some(crate::ops::modules::APP) => None,
        Some(m) => match env.modules.allowlist(m) {
            Ok(list) => list,
            Err(_) => {
                request.borrow_mut().fetches_in_flight -= 1;
                return Err(failure_error(FetchFailure::Blocked {
                    host: Url::parse(&req.url)
                        .ok()
                        .and_then(|u| u.host_str().map(str::to_string))
                        .unwrap_or_default(),
                    reason: BlockReason::NotAllowlisted,
                    hop: 0,
                }));
            }
        },
    };
    let allowlist: &Allowlist = module_list.as_deref().unwrap_or(&env.allowlist);
    let result = bounded(
        fetch_with_policy(&env, allowlist, req, counter.clone()),
        deadline,
        cancel,
    )
    .await;
    request.borrow_mut().fetches_in_flight -= 1;
    let result = result.map_err(|f| match f {
        FetchFailure::Failed { host, .. } if counter.exceeded() => FetchFailure::EgressLimit {
            host,
            limit: counter.limit,
        },
        other => other,
    });
    match result {
        Ok(FetchResult {
            final_url,
            redirected,
            response,
        }) => {
            let host = final_url.host_str().unwrap_or("").to_string();
            // Null-body statuses and HEAD: no body resource (a Response
            // with status 204/205/304 must have a null body).
            let rid = if head_request || matches!(response.status, 101 | 204 | 205 | 304) {
                response.conn.abort();
                None
            } else {
                let open = request.borrow().open_bodies.clone();
                open.set(open.get() + 1);
                let rid = state.borrow_mut().resource_table.add(FetchBody {
                    body: RefCell::new(Some(response.body)),
                    conn: response.conn,
                    host,
                    token,
                    open,
                });
                request.borrow_mut().resources.fetch_bodies.push(rid);
                Some(rid)
            };
            Ok(FetchResponseHead {
                status: response.status,
                status_text: response.status_text,
                headers: response.headers,
                url: final_url.to_string(),
                redirected,
                body: rid,
            })
        }
        Err(failure) => {
            if let FetchFailure::Blocked { host, reason, .. } = &failure {
                request.borrow_mut().fetch_blocked += 1;
                log_blocked(&env, Some(request_id), host, reason.as_str());
            }
            Err(failure_error(failure))
        }
    }
}

/// Next chunk of a response body; `null` at the end.
#[op2]
#[serde]
pub(crate) async fn op_fetch_body_read(
    state: Rc<RefCell<OpState>>,
    token: u32,
    #[smi] rid: ResourceId,
) -> Result<Option<ToJsBuffer>, JsErrorBox> {
    let (request, resource) = {
        let s = state.borrow();
        let request = live_request(&s, token)?;
        let resource = s
            .resource_table
            .get::<FetchBody>(rid)
            .map_err(JsErrorBox::from_err)?;
        (request, resource)
    };
    if resource.token != token {
        return Err(crate::ops::request::no_request());
    }
    let (deadline, cancel, counter) = {
        let r = request.borrow();
        (r.deadline, r.cancel.clone(), r.egress.clone())
    };
    let host = resource.host.clone();
    let read = async {
        let Some(mut body) = resource.body.borrow_mut().take() else {
            return Ok(None);
        };
        let out = loop {
            match body.frame().await {
                None => break Ok(None),
                Some(Ok(frame)) => {
                    if let Ok(data) = frame.into_data() {
                        if data.is_empty() {
                            continue;
                        }
                        break Ok(Some(data.to_vec()));
                    }
                }
                Some(Err(_)) => {
                    break Err(if counter.exceeded() {
                        FetchFailure::EgressLimit {
                            host: host.clone(),
                            limit: counter.limit,
                        }
                    } else {
                        FetchFailure::Failed {
                            host: host.clone(),
                            reason: "reset",
                        }
                    });
                }
            }
        };
        if matches!(out, Ok(Some(_))) {
            *resource.body.borrow_mut() = Some(body);
        }
        out
    };
    match bounded(read, deadline, cancel).await {
        Ok(Some(chunk)) => Ok(Some(chunk.into())),
        Ok(None) => {
            close_rid(&mut state.borrow_mut(), rid);
            Ok(None)
        }
        Err(f) => {
            close_rid(&mut state.borrow_mut(), rid);
            Err(failure_error(f))
        }
    }
}

/// Close a response body the tenant no longer reads. Only the request that
/// owns the body may close it.
#[op2(fast)]
pub(crate) fn op_fetch_body_close(state: &mut OpState, token: u32, #[smi] rid: ResourceId) {
    let owned = state
        .resource_table
        .get::<FetchBody>(rid)
        .map(|b| b.token == token)
        .unwrap_or(false);
    if owned {
        close_rid(state, rid);
    }
}
