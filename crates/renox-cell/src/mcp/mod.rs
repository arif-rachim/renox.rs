//! App MCP: `/mcp` per app (#285; `docs/contracts/ops.md` 1.5.0 section 19;
//! `docs/20-ai-agents-mcp.md` sections 2 and 5).
//!
//! JSON-RPC 2.0 over Streamable HTTP, stateless: `POST /mcp` with one
//! request (`initialize`, `notifications/initialized`, `tools/list`,
//! `tools/call`); `GET /mcp` is 405. Every app has the reserved paths; they
//! answer 404 when the `auth` module (the authorization server, #286) is not
//! installed.
//!
//! One `tools/call`, in order:
//!
//! 1. the agent token (`Authorization: Bearer`): `auth.verifyAgentToken`,
//!    cached per token hash for 60 s and dropped on `auth.agent_token_revoked`
//!    (401 with `WWW-Authenticate` otherwise);
//! 2. the token's scopes (403 `RENOX_TOOL_SCOPE`);
//! 3. the per-token rate limit (429, `Retry-After`);
//! 4. the input against the tool's JSON Schema (400 `RENOX_TOOL_INPUT`);
//! 5. `confirm` tools: a preview run (always rolled back) and a sealed
//!    confirmation token, then the real call (409 `RENOX_TOOL_CONFIRM` for a
//!    missing, expired, replayed or mismatched token);
//! 6. the Cedar action as the token's user and `run`, in the isolate
//!    (403 `RENOX_FORBIDDEN`, audited when sensitive);
//! 7. the output: at most 256 KB of JSON, secrets redacted, `untrusted`.
//!
//! One meter record (`kind: "tool"`, `TOOL <name>`) per call that reached
//! `run`, the preview included.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use hmac::{Hmac, Mac};
use http::{HeaderValue, Response, StatusCode, header};
use renox_gateway::RequestCtx;
use renox_meter::{MeterKind, MeterRecord};
use renox_runtime::isolate::{Invoke, InvokeOutcome};
use renox_runtime::manifest::ToolRoute;
use sha2::{Digest, Sha256};

use crate::cell::Cell;

pub const MCP_PATH: &str = "/mcp";
pub const RESOURCE_METADATA_PATH: &str = "/.well-known/oauth-protected-resource/mcp";
/// The authorization server metadata (RFC 8414), served for the `auth`
/// module: `/.well-known/oauth-authorization-server<mount>/oauth`, and the
/// same document under `<mount>/oauth/.well-known/oauth-authorization-server`.
pub const AS_METADATA: &str = "/.well-known/oauth-authorization-server";

/// Whether the cell answers `path` itself rather than the app.
pub fn handles(path: &str) -> bool {
    path == MCP_PATH
        || path == RESOURCE_METADATA_PATH
        || path.starts_with(AS_METADATA)
        || path.ends_with("/oauth/.well-known/oauth-authorization-server")
}
/// `ops.md` section 19: the MCP revision the server answers.
pub const PROTOCOL_VERSION: &str = "2025-06-18";
/// How long a verified token is trusted without asking `auth` again.
pub const TOKEN_TTL: Duration = Duration::from_secs(60);
/// Calls per minute per token (`ops.md` Open 16, *proposed*).
pub const CALLS_PER_MINUTE: u32 = 60;
/// How long a confirmation token is valid.
pub const CONFIRM_TTL: Duration = Duration::from_secs(600);
/// The event that drops a token from the cache.
pub const REVOKED_EVENT: &str = "auth.agent_token_revoked";

type HmacSha256 = Hmac<Sha256>;

/// What `auth.verifyAgentToken` answered for a token.
#[derive(Debug, Clone)]
pub struct Agent {
    pub principal: Arc<renox_authz::Principal>,
    pub scopes: Vec<String>,
    pub client: serde_json::Value,
}

impl Agent {
    /// `tools:*`, `tools:<name>`, or the bare tool name.
    fn covers(&self, tool: &str) -> bool {
        self.scopes
            .iter()
            .any(|s| s == "tools:*" || s == tool || s.strip_prefix("tools:") == Some(tool))
    }
}

/// A token bucket: `CALLS_PER_MINUTE` per minute, burst the same.
#[derive(Debug, Clone, Copy)]
struct Bucket {
    tokens: f64,
    at: Instant,
}

/// The MCP state of one cell.
pub struct Mcp {
    tokens: Mutex<HashMap<[u8; 32], (Agent, Instant)>>,
    buckets: Mutex<HashMap<[u8; 32], Bucket>>,
    /// Confirmation tokens already used (`ops.md` section 19: no replay).
    used: Mutex<HashSet<String>>,
    key: [u8; 32],
}

impl std::fmt::Debug for Mcp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Mcp").finish_non_exhaustive()
    }
}

impl Default for Mcp {
    fn default() -> Self {
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).expect("random key");
        Mcp {
            tokens: Mutex::default(),
            buckets: Mutex::default(),
            used: Mutex::default(),
            key,
        }
    }
}

fn sha(s: &[u8]) -> [u8; 32] {
    Sha256::digest(s).into()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Mcp {
    /// The outbox delivered `auth.agent_token_revoked`: drop the token
    /// (`token_hash`, hex SHA-256 of the token) or every token of `user_id`;
    /// without either, every cached token.
    pub fn on_event(&self, name: &str, payload: &str) -> bool {
        if name != REVOKED_EVENT {
            return false;
        }
        let v: serde_json::Value = serde_json::from_str(payload).unwrap_or_default();
        let mut tokens = self.tokens.lock().expect("mcp lock");
        match (
            v.get("token_hash").and_then(|h| h.as_str()),
            v.get("user_id").and_then(|u| u.as_str()),
        ) {
            (Some(h), _) => tokens.retain(|k, _| hex(k) != h),
            (None, Some(u)) => tokens.retain(|_, (a, _)| a.principal.id != u),
            (None, None) => tokens.clear(),
        }
        true
    }

    /// Takes one call from the token's bucket; `Err(seconds)` when empty.
    fn take(&self, token: &[u8; 32]) -> Result<(), u64> {
        let mut buckets = self.buckets.lock().expect("mcp lock");
        let now = Instant::now();
        let rate = f64::from(CALLS_PER_MINUTE) / 60.0;
        let b = buckets.entry(*token).or_insert(Bucket {
            tokens: f64::from(CALLS_PER_MINUTE),
            at: now,
        });
        b.tokens = (b.tokens + now.duration_since(b.at).as_secs_f64() * rate)
            .min(f64::from(CALLS_PER_MINUTE));
        b.at = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            Ok(())
        } else {
            Err(((1.0 - b.tokens) / rate).ceil() as u64)
        }
    }

    /// A confirmation token binding the tool, the arguments and the agent
    /// token, valid for `CONFIRM_TTL`: `<expires ms>.<hex mac>`.
    fn seal(&self, tool: &str, args: &[u8], agent: &[u8; 32], expires: u64) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("hmac key");
        mac.update(tool.as_bytes());
        mac.update(b"\0");
        mac.update(&sha(args));
        mac.update(agent);
        mac.update(&expires.to_be_bytes());
        format!("{expires}.{}", hex(&mac.finalize().into_bytes()))
    }

    /// Checks and consumes a confirmation token.
    fn redeem(
        &self,
        token: &str,
        tool: &str,
        args: &[u8],
        agent: &[u8; 32],
    ) -> Result<(), &'static str> {
        let (exp, _) = token.split_once('.').ok_or("malformed")?;
        let expires: u64 = exp.parse().map_err(|_| "malformed")?;
        if expires < now_ms() {
            return Err("expired");
        }
        let want = self.seal(tool, args, agent, expires);
        if !bool::from(subtle::ConstantTimeEq::ct_eq(
            want.as_bytes(),
            token.as_bytes(),
        )) {
            return Err("mismatch");
        }
        if !self
            .used
            .lock()
            .expect("mcp lock")
            .insert(token.to_string())
        {
            return Err("replayed");
        }
        Ok(())
    }
}

/// A JSON response.
fn json(status: StatusCode, body: serde_json::Value, request_id: &str) -> Response<Bytes> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-renox-request-id", request_id)
        .body(Bytes::from(body.to_string()))
        .expect("valid response")
}

/// A JSON-RPC error carrying a platform code (`ops.md` section 19,
/// "Errors before run").
fn rpc_error(
    status: StatusCode,
    id: &serde_json::Value,
    code: &str,
    message: &str,
    request_id: &str,
    details: Option<serde_json::Value>,
) -> Response<Bytes> {
    let mut data = serde_json::json!({ "code": code, "request_id": request_id });
    if let Some(d) = details {
        data["details"] = d;
    }
    json(
        status,
        serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": message, "data": data } }),
        request_id,
    )
}

/// A JSON-RPC protocol error (`-32600`, `-32601`, `-32602`, `-32700`).
fn rpc_protocol(
    id: &serde_json::Value,
    code: i64,
    message: &str,
    request_id: &str,
) -> Response<Bytes> {
    json(
        StatusCode::OK,
        serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        request_id,
    )
}

fn result(id: &serde_json::Value, r: serde_json::Value, request_id: &str) -> Response<Bytes> {
    json(
        StatusCode::OK,
        serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        request_id,
    )
}

/// A tool result (`ops.md` section 19, "Output"): text content, structured
/// content, `untrusted`.
fn tool_result(value: serde_json::Value, is_error: bool) -> serde_json::Value {
    let text = if is_error {
        value.as_str().unwrap_or_default().to_string()
    } else {
        value.to_string()
    };
    let mut r = serde_json::json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
        "_meta": { "untrusted": true },
    });
    if !is_error {
        r["structuredContent"] = value;
    }
    r
}

/// The `WWW-Authenticate` of a 401 (RFC 9728).
fn unauthorized(host: &str, id: &serde_json::Value, request_id: &str) -> Response<Bytes> {
    let mut r = rpc_error(
        StatusCode::UNAUTHORIZED,
        id,
        "RENOX_UNAUTHORIZED",
        "An agent token is required.",
        request_id,
        None,
    );
    if let Ok(v) = HeaderValue::from_str(&format!(
        "Bearer resource_metadata=\"https://{host}{RESOURCE_METADATA_PATH}\""
    )) {
        r.headers_mut().insert(header::WWW_AUTHENTICATE, v);
    }
    r
}

fn not_found(rid: &str) -> Response<Bytes> {
    json(
        StatusCode::NOT_FOUND,
        serde_json::json!({ "error": { "code": "RENOX_NOT_FOUND", "request_id": rid } }),
        rid,
    )
}

/// The `auth` module's mount (`/auth`), when it is installed and exports
/// `verifyAgentToken`.
fn auth_mount(cell: &Cell) -> Option<String> {
    if !cell.isolate.has_service("auth", "verifyAgentToken") {
        return None;
    }
    cell.isolate
        .manifest()
        .modules
        .as_ref()
        .and_then(|m| m.as_array())
        .and_then(|m| {
            m.iter()
                .find(|e| e.get("name").and_then(|n| n.as_str()) == Some("auth"))
        })
        .and_then(|e| e.get("mount").and_then(|m| m.as_str()))
        .map(str::to_string)
}

/// Checks `value` against a tool's JSON Schema (the keyword subset the SDK
/// records); the problems as `{ field, reason }`, `field` a JSON Pointer.
pub fn validate(schema: &serde_json::Value, value: &serde_json::Value) -> Vec<serde_json::Value> {
    match jsonschema::validator_for(schema) {
        Ok(v) => v
            .iter_errors(value)
            .map(|e| {
                let path = e.instance_path().to_string();
                serde_json::json!({ "field": if path.is_empty() { "/".to_string() } else { path }, "reason": e.to_string() })
            })
            .collect(),
        Err(e) => vec![serde_json::json!({ "field": "/", "reason": format!("the tool's input schema does not compile: {e}") })],
    }
}

/// The record of one `run` (`meter.md` 0.3, `kind: "tool"`).
fn record(
    manager: &crate::CellManager,
    ctx: &RequestCtx,
    tool: &str,
    meter: &renox_runtime::isolate::InvocationMeter,
    t0: Instant,
    started_at: u64,
) {
    manager.record_realtime(MeterRecord {
        request_id: ctx.request_id.clone(),
        tenant_id: ctx.tenant_id.clone(),
        deployment_hash: ctx.deployment_hash.clone(),
        route: format!("TOOL {tool}"),
        started_at,
        cpu_ms: meter.cpu_ms,
        wall_ms: t0.elapsed().as_secs_f64() * 1000.0,
        peak_heap_bytes: meter.peak_heap_bytes,
        ingress_bytes: 0,
        egress_bytes: 0,
        fetch_sent_bytes: meter.fetch_sent_bytes,
        fetch_received_bytes: meter.fetch_received_bytes,
        fetch_blocked: meter.fetch_blocked,
        db_ms: meter.db_ms,
        db_rows: meter.db_rows,
        render_fuel: meter.render_fuel,
        render_ms: (meter.render_fuel > 0).then_some(meter.render_ms),
        logs_dropped: meter.logs_dropped,
        http_status: 200,
        status: crate::manager::meter_status(meter.status),
        kind: Some(MeterKind::Tool),
        authz_evals: Some(meter.authz_evals).filter(|n| *n > 0),
        realtime_conn_seconds: None,
        realtime_messages: None,
        storage_bytes: None,
        image_variants: None,
        ai_tokens_in: None,
        ai_tokens_out: None,
        render_pdf_ms: None,
    });
}

/// Serves `/mcp` and its resource metadata. `body` is the request body.
pub(crate) async fn serve(
    manager: &crate::CellManager,
    cell: &Cell,
    ctx: RequestCtx,
    parts: &http::request::Parts,
    body: Bytes,
) -> Response<Bytes> {
    let rid = ctx.request_id.clone();
    let host = parts
        .headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost")
        .to_string();
    let Some(mount) = auth_mount(cell) else {
        return not_found(&rid);
    };
    let issuer_path = format!("{mount}/oauth");
    let path = parts.uri.path();
    if path == format!("{AS_METADATA}{issuer_path}")
        || path == format!("{issuer_path}{AS_METADATA}")
    {
        if parts.method != http::Method::GET {
            return Response::builder()
                .status(StatusCode::METHOD_NOT_ALLOWED)
                .header(header::ALLOW, "GET")
                .body(Bytes::new())
                .expect("valid");
        }
        let rt = renox_runtime::RequestCtx {
            request_id: rid.clone(),
            deadline: ctx.deadline,
        };
        let out = cell
            .isolate
            .invoke(
                rt,
                Invoke::Service {
                    module: "auth".into(),
                    name: "oauthMetadata".into(),
                    args_json: serde_json::json!([format!("https://{host}{issuer_path}")])
                        .to_string(),
                },
            )
            .await;
        return match out.outcome {
            InvokeOutcome::Ok(doc) => match serde_json::from_str::<serde_json::Value>(&doc) {
                Ok(v) if v.is_object() => json(StatusCode::OK, v, &rid),
                _ => not_found(&rid),
            },
            _ => not_found(&rid),
        };
    }
    if path != MCP_PATH && path != RESOURCE_METADATA_PATH {
        return not_found(&rid);
    }
    let tools = cell.isolate.tools();
    if parts.uri.path() == RESOURCE_METADATA_PATH {
        if parts.method != http::Method::GET {
            return Response::builder()
                .status(StatusCode::METHOD_NOT_ALLOWED)
                .header(header::ALLOW, "GET")
                .body(Bytes::new())
                .expect("valid");
        }
        let mut scopes = vec!["tools:*".to_string()];
        scopes.extend(tools.iter().map(|t| format!("tools:{}", t.name)));
        return json(
            StatusCode::OK,
            serde_json::json!({
                "resource": format!("https://{host}{MCP_PATH}"),
                "authorization_servers": [format!("https://{host}{mount}/oauth")],
                "scopes_supported": scopes,
                "bearer_methods_supported": ["header"],
            }),
            &rid,
        );
    }
    if parts.method != http::Method::POST {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "POST")
            .body(Bytes::new())
            .expect("valid");
    }
    let msg: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return rpc_protocol(&serde_json::Value::Null, -32700, "Parse error", &rid),
    };
    if msg.is_array() {
        return rpc_protocol(
            &serde_json::Value::Null,
            -32600,
            "Batches are not supported",
            &rid,
        );
    }
    let id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let method = msg
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or_default()
        .to_string();
    // 1. The agent token.
    let bearer = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let Some(bearer) = bearer else {
        return unauthorized(&host, &id, &rid);
    };
    let token_hash = sha(bearer.as_bytes());
    let cached = {
        let tokens = cell.mcp.tokens.lock().expect("mcp lock");
        tokens
            .get(&token_hash)
            .filter(|(_, at)| at.elapsed() < TOKEN_TTL)
            .map(|(a, _)| a.clone())
    };
    let agent = match cached {
        Some(a) => a,
        None => {
            let rt = renox_runtime::RequestCtx {
                request_id: rid.clone(),
                deadline: ctx.deadline,
            };
            let out = cell
                .isolate
                .invoke(
                    rt,
                    Invoke::Service {
                        module: "auth".into(),
                        name: "verifyAgentToken".into(),
                        args_json: serde_json::json!([bearer]).to_string(),
                    },
                )
                .await;
            let verified = match out.outcome {
                InvokeOutcome::Ok(json) => serde_json::from_str::<serde_json::Value>(&json)
                    .ok()
                    .and_then(|v| agent_of(&v)),
                _ => None,
            };
            let Some(agent) = verified else {
                return unauthorized(&host, &id, &rid);
            };
            cell.mcp
                .tokens
                .lock()
                .expect("mcp lock")
                .insert(token_hash, (agent.clone(), Instant::now()));
            agent
        }
    };
    match method.as_str() {
        "initialize" => {
            let m = cell.isolate.manifest();
            result(
                &id,
                serde_json::json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": m.app.name, "version": ctx.deployment_hash.chars().take(12).collect::<String>() },
                }),
                &rid,
            )
        }
        "notifications/initialized" => Response::builder()
            .status(StatusCode::ACCEPTED)
            .body(Bytes::new())
            .expect("valid"),
        "tools/list" => {
            let list: Vec<serde_json::Value> = tools
                .iter()
                .filter(|t| agent.covers(&t.name))
                .map(|t| {
                    serde_json::json!({
                        "name": t.name,
                        "description": t.description,
                        "inputSchema": t.input,
                        "annotations": { "readOnlyHint": !t.confirm, "destructiveHint": t.confirm },
                    })
                })
                .collect();
            result(&id, serde_json::json!({ "tools": list }), &rid)
        }
        "tools/call" => {
            let params = msg.get("params").cloned().unwrap_or_default();
            // #295: the tool's name only, never its arguments.
            let span = tracing::info_span!(
                "mcp.tool",
                tool = params
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or_default()
            );
            let _trace = renox_runtime::trace::register(
                &ctx.request_id,
                span.clone(),
                crate::telemetry::trace_id(&span),
            );
            tracing::Instrument::instrument(
                call(
                    manager,
                    cell,
                    &ctx,
                    &id,
                    params,
                    &agent,
                    &token_hash,
                    &tools,
                ),
                span,
            )
            .await
        }
        _ => rpc_protocol(&id, -32601, "Method not found", &rid),
    }
}

/// `{ principal: { id, attrs?, roles? }, scopes, client: { name, model? } }`.
fn agent_of(v: &serde_json::Value) -> Option<Agent> {
    let p = v.get("principal")?;
    let id = p.get("id")?.as_str()?;
    let mut principal = renox_authz::Principal::user(id);
    for (k, val) in p
        .get("attrs")
        .and_then(|a| a.as_object())
        .into_iter()
        .flatten()
    {
        principal = principal.with_attr(k, val.clone());
    }
    for r in p
        .get("roles")
        .and_then(|r| r.as_array())
        .into_iter()
        .flatten()
    {
        if let Some(role) = r.as_str() {
            principal = principal.with_role(role, "global", None);
        }
    }
    let scopes = v
        .get("scopes")?
        .as_array()?
        .iter()
        .filter_map(|s| s.as_str().map(str::to_string))
        .collect();
    let client = v
        .get("client")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({ "name": "unknown" }));
    Some(Agent {
        principal: Arc::new(principal),
        scopes,
        client,
    })
}

#[allow(clippy::too_many_arguments)]
async fn call(
    manager: &crate::CellManager,
    cell: &Cell,
    ctx: &RequestCtx,
    id: &serde_json::Value,
    params: serde_json::Value,
    agent: &Agent,
    token_hash: &[u8; 32],
    tools: &[ToolRoute],
) -> Response<Bytes> {
    let rid = ctx.request_id.as_str();
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or_default();
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let Some(tool) = tools.iter().find(|t| t.name == name) else {
        return rpc_protocol(id, -32602, "Unknown tool", rid);
    };
    // 2. Scope.
    if !agent.covers(&tool.name) {
        return rpc_error(
            StatusCode::FORBIDDEN,
            id,
            "RENOX_TOOL_SCOPE",
            "The token does not allow this tool.",
            rid,
            None,
        );
    }
    // 3. Rate limit (no body code, like the gateway's).
    if let Err(retry) = cell.mcp.take(token_hash) {
        return Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .header(header::RETRY_AFTER, retry.max(1))
            .body(Bytes::new())
            .expect("valid");
    }
    // 4. Input.
    let problems = validate(&tool.input, &args);
    if !problems.is_empty() {
        return rpc_error(
            StatusCode::BAD_REQUEST,
            id,
            "RENOX_TOOL_INPUT",
            "The tool input is invalid.",
            rid,
            Some(serde_json::Value::Array(problems)),
        );
    }
    let args_json = args.to_string();
    // 5. Confirmation.
    let mut preview = false;
    if tool.confirm {
        match params
            .get("_meta")
            .and_then(|m| m.get("renox/confirmation"))
            .and_then(|t| t.as_str())
        {
            None => preview = true,
            Some(t) => {
                if let Err(why) = cell
                    .mcp
                    .redeem(t, &tool.name, args_json.as_bytes(), token_hash)
                {
                    return rpc_error(
                        StatusCode::CONFLICT,
                        id,
                        "RENOX_TOOL_CONFIRM",
                        "The confirmation is missing, expired, or already used.",
                        rid,
                        Some(serde_json::json!({ "reason": why })),
                    );
                }
            }
        }
    }
    // 6. The Cedar action and run, in the isolate.
    let t0 = Instant::now();
    let started_at = now_ms();
    let rt = renox_runtime::RequestCtx {
        request_id: ctx.request_id.clone(),
        deadline: ctx.deadline,
    };
    let out = cell
        .isolate
        .invoke(
            rt,
            Invoke::Tool {
                name: tool.name.clone(),
                input_json: args_json.clone(),
                client_json: agent.client.to_string(),
                preview,
                principal: agent.principal.clone(),
            },
        )
        .await;
    if out.outcome == InvokeOutcome::Forbidden {
        return rpc_error(
            StatusCode::FORBIDDEN,
            id,
            "RENOX_FORBIDDEN",
            "You are not allowed to do this.",
            rid,
            None,
        );
    }
    if out.outcome == InvokeOutcome::NoHandler {
        return rpc_protocol(id, -32602, "Unknown tool", rid);
    }
    record(manager, ctx, &tool.name, &out.meter, t0, started_at);
    // 7. The output.
    let body = match out.outcome {
        InvokeOutcome::Ok(json) => {
            let value: serde_json::Value =
                serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
            if preview {
                let expires = now_ms() + CONFIRM_TTL.as_millis() as u64;
                let token = cell
                    .mcp
                    .seal(&tool.name, args_json.as_bytes(), token_hash, expires);
                tool_result(
                    serde_json::json!({ "preview": value, "confirmation": { "token": token, "expires_at": expires } }),
                    false,
                )
            } else {
                tool_result(value, false)
            }
        }
        InvokeOutcome::OutputTooLarge => {
            tool_result(serde_json::json!("The tool output is too large."), true)
        }
        InvokeOutcome::Failed(code) => tool_result(serde_json::json!(code.message()), true),
        InvokeOutcome::Threw { .. } | InvokeOutcome::Forbidden | InvokeOutcome::NoHandler => {
            tool_result(serde_json::json!("The tool failed."), true)
        }
    };
    result(id, body, rid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_validation() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": { "q": { "type": "string", "minLength": 1 }, "n": { "type": "integer", "exclusiveMinimum": 0 } },
            "required": ["q"],
            "additionalProperties": false,
        });
        assert!(validate(&schema, &serde_json::json!({ "q": "x", "n": 2 })).is_empty());
        let p = validate(&schema, &serde_json::json!({ "n": 0, "x": 1 }));
        let fields: std::collections::BTreeSet<&str> =
            p.iter().map(|v| v["field"].as_str().unwrap()).collect();
        assert!(fields.contains("/n") && fields.contains("/"), "{p:?}");
        assert!(p.len() >= 3, "{p:?}");
    }

    #[test]
    fn confirmation_tokens() {
        let m = Mcp::default();
        let agent = sha(b"tok");
        let t = m.seal("delete", b"{}", &agent, now_ms() + 1000);
        assert_eq!(
            m.redeem(&t, "delete", b"{\"x\":1}", &agent),
            Err("mismatch")
        );
        assert_eq!(m.redeem(&t, "delete", b"{}", &agent), Ok(()));
        assert_eq!(m.redeem(&t, "delete", b"{}", &agent), Err("replayed"));
        let old = m.seal("delete", b"{}", &agent, now_ms() - 1);
        assert_eq!(m.redeem(&old, "delete", b"{}", &agent), Err("expired"));
    }
}
