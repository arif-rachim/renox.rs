//! `/__renox/events`: browser errors and CSP reports
//! (`docs/contracts/client-events.md`, #126).
//!
//! The endpoint lives entirely in the gateway: no cell, no isolate, no
//! meter record. It always answers `204` (405 for a method other than
//! `POST`), so a flood learns nothing about what was dropped. In order:
//!
//! 1. `[client] events = false` (manifest `client.events`) → `disabled`.
//! 2. An `Origin` that is not the request's own → `invalid`.
//! 3. 60 requests per minute per client IP per tenant → `ip_rate`.
//! 4. The body, read up to 32 KB and no further → `body_size`.
//! 5. A batch envelope (or, with `?kind=csp`, a browser CSP report,
//!    normalised to `csp.violation`), validated against
//!    `docs/contracts/schemas/client-event.schema.json` → `batch_size` for
//!    more than 20 events, `invalid` for anything else (including
//!    `js.console.error`, which is dev only).
//! 6. Per tenant: the daily cap → `daily_cap`; over 1,000 events a minute
//!    one in ten is kept → `sampled`.
//!
//! Each accepted event becomes one tenant log line with `source: "client"`
//! through the [`ClientEventSink`] the worker attaches (`renox-cell`, which
//! redacts the tenant's secrets like every other tenant line). Drops are
//! counted in [`ClientEventStats`] and summarised in the tenant log as
//! `RENOX_CLIENT_EVENTS_DROPPED`, at most one line per reason per minute.
//! The client IP is used for the per-IP limit only and never logged.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode, header};
use serde_json::{Map, Value};

/// The endpoint's path.
pub const EVENTS_PATH: &str = "/__renox/events";
/// Rule CE1: request body limit.
pub const MAX_BODY_BYTES: usize = 32 * 1024;
/// Events per batch (the schema's `maxItems`).
pub const MAX_BATCH_EVENTS: usize = 20;
/// `RENOX_CLIENT_EVENTS_DROPPED` (`errors.md`).
pub const DROPPED_CODE: &str = "RENOX_CLIENT_EVENTS_DROPPED";

const SCHEMA: &str = include_str!("../../../docs/contracts/schemas/client-event.schema.json");
const WINDOW: Duration = Duration::from_secs(60);
const DAY: Duration = Duration::from_secs(86_400);
/// Above this many `(tenant, ip)` windows the table is cleared (an attacker
/// rotating addresses cannot grow it without bound).
const MAX_IP_WINDOWS: usize = 100_000;

/// The limits of `client-events.md` section 7.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClientEventLimits {
    /// Requests per minute per client IP per tenant.
    pub requests_per_ip_per_min: u32,
    /// Events per minute per tenant before sampling starts.
    pub events_per_tenant_per_min: u32,
    /// Over the per-minute count, one event in this many is kept.
    pub sample_one_in: u32,
    /// Events per tenant per day. The gateway does not know the tier, so
    /// this is the free tier's cap (10 % of 1,000 lines a minute for a day,
    /// *proposed* in the contract).
    pub events_per_tenant_per_day: u64,
}

impl Default for ClientEventLimits {
    fn default() -> Self {
        Self {
            requests_per_ip_per_min: 60,
            events_per_tenant_per_min: 1_000,
            sample_one_in: 10,
            events_per_tenant_per_day: 144_000,
        }
    }
}

/// Why events were dropped (the `reason` of `RENOX_CLIENT_EVENTS_DROPPED`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DropReason {
    BodySize,
    BatchSize,
    Invalid,
    IpRate,
    Sampled,
    DailyCap,
    Disabled,
}

impl DropReason {
    const ALL: [DropReason; 7] = [
        DropReason::BodySize,
        DropReason::BatchSize,
        DropReason::Invalid,
        DropReason::IpRate,
        DropReason::Sampled,
        DropReason::DailyCap,
        DropReason::Disabled,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            DropReason::BodySize => "body_size",
            DropReason::BatchSize => "batch_size",
            DropReason::Invalid => "invalid",
            DropReason::IpRate => "ip_rate",
            DropReason::Sampled => "sampled",
            DropReason::DailyCap => "daily_cap",
            DropReason::Disabled => "disabled",
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// Counters for the operator (`client_events_total` and
/// `client_events_dropped_total{reason}`; Prometheus is #77). A drop of a
/// whole request counts once, whatever it contained.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ClientEventStats {
    /// Events written to a tenant log.
    pub accepted: u64,
    pub dropped_body_size: u64,
    pub dropped_batch_size: u64,
    pub dropped_invalid: u64,
    pub dropped_ip_rate: u64,
    pub dropped_sampled: u64,
    pub dropped_daily_cap: u64,
    pub dropped_disabled: u64,
}

impl ClientEventStats {
    pub fn dropped(&self, reason: DropReason) -> u64 {
        match reason {
            DropReason::BodySize => self.dropped_body_size,
            DropReason::BatchSize => self.dropped_batch_size,
            DropReason::Invalid => self.dropped_invalid,
            DropReason::IpRate => self.dropped_ip_rate,
            DropReason::Sampled => self.dropped_sampled,
            DropReason::DailyCap => self.dropped_daily_cap,
            DropReason::Disabled => self.dropped_disabled,
        }
    }
}

/// One tenant log line produced by the endpoint (`client-events.md`
/// section 9). The sink adds `ts` (receive time) and `module`.
#[derive(Clone, Debug, PartialEq)]
pub struct ClientLogLine {
    pub tenant_id: String,
    pub deployment_hash: String,
    /// The event's `request_id` (the page or fragment it happened on).
    pub request_id: Option<String>,
    /// `error` or `warn`.
    pub level: &'static str,
    pub message: String,
    /// `source: "client"`, `kind`, `client_ts`, `url`, `ua`,
    /// `session_fingerprint`, `code`, `extra`, `detail`; or the drop summary.
    pub fields: Map<String, Value>,
}

/// Where accepted events go: the tenant's log sink. The gateway is a leaf
/// crate and has none; `renox-cell` implements this over the runtime's
/// redacting log sink.
pub trait ClientEventSink: Send + Sync + 'static {
    fn write(&self, line: ClientLogLine);
}

/// What the endpoint needs to know about the request's deployment.
pub struct Target<'a> {
    pub tenant_id: &'a str,
    /// The active deployment for the hostname.
    pub deployment_hash: &'a str,
    /// Every deployment the hostname routes to (active and draining): an
    /// event naming one of them keeps it as `deployment_hash`.
    pub known_hashes: &'a [String],
    /// `manifest.client.events` (default `true`).
    pub enabled: bool,
    /// The request host (lowercase, no port) and whether it came over TLS,
    /// for the same-origin check.
    pub host: &'a str,
    pub tls: bool,
    pub client_ip: IpAddr,
}

#[derive(Debug)]
struct Window {
    start: Instant,
    count: u64,
}

impl Window {
    fn new(now: Instant) -> Self {
        Self {
            start: now,
            count: 0,
        }
    }

    /// Counts one; false once `limit` was reached in the current window.
    fn admit(&mut self, now: Instant, length: Duration, limit: u64) -> bool {
        if now.duration_since(self.start) >= length {
            *self = Window::new(now);
        }
        if self.count >= limit {
            return false;
        }
        self.count += 1;
        true
    }
}

#[derive(Debug)]
struct TenantState {
    minute: Window,
    /// Events seen past the per-minute count, for 1-in-N sampling.
    over: u64,
    day: Window,
    /// Drops not yet summarised in the tenant log, per reason.
    drops: [u64; 7],
    last_summary: Option<Instant>,
}

impl TenantState {
    fn new(now: Instant) -> Self {
        Self {
            minute: Window::new(now),
            over: 0,
            day: Window::new(now),
            drops: [0; 7],
            last_summary: None,
        }
    }
}

/// The endpoint's state, one per gateway.
#[derive(Default)]
pub struct ClientEvents {
    limits: ClientEventLimits,
    sink: OnceLock<std::sync::Arc<dyn ClientEventSink>>,
    ips: Mutex<HashMap<(String, IpAddr), Window>>,
    tenants: Mutex<HashMap<String, TenantState>>,
    accepted: AtomicU64,
    dropped: [AtomicU64; 7],
}

impl std::fmt::Debug for ClientEvents {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientEvents")
            .field("limits", &self.limits)
            .field("sink", &self.sink.get().is_some())
            .finish_non_exhaustive()
    }
}

impl ClientEvents {
    pub fn new(limits: ClientEventLimits) -> Self {
        Self {
            limits,
            ..Self::default()
        }
    }

    /// Attaches the tenant log sink; only the first call has an effect.
    pub fn set_sink(&self, sink: std::sync::Arc<dyn ClientEventSink>) -> bool {
        self.sink.set(sink).is_ok()
    }

    pub fn stats(&self) -> ClientEventStats {
        let d = |r: DropReason| self.dropped[r.index()].load(Ordering::Relaxed);
        ClientEventStats {
            accepted: self.accepted.load(Ordering::Relaxed),
            dropped_body_size: d(DropReason::BodySize),
            dropped_batch_size: d(DropReason::BatchSize),
            dropped_invalid: d(DropReason::Invalid),
            dropped_ip_rate: d(DropReason::IpRate),
            dropped_sampled: d(DropReason::Sampled),
            dropped_daily_cap: d(DropReason::DailyCap),
            dropped_disabled: d(DropReason::Disabled),
        }
    }

    /// Handles one request to [`EVENTS_PATH`].
    pub async fn handle(&self, target: Target<'_>, req: Request<Body>) -> Response<Body> {
        if req.method() != Method::POST {
            return Response::builder()
                .status(StatusCode::METHOD_NOT_ALLOWED)
                .header(header::ALLOW, "POST")
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::empty())
                .expect("valid response");
        }
        if let Err(reason) = self.receive(&target, req).await {
            self.drop_request(target.tenant_id, reason, Instant::now());
        }
        no_content()
    }

    async fn receive(&self, target: &Target<'_>, req: Request<Body>) -> Result<(), DropReason> {
        if !target.enabled {
            return Err(DropReason::Disabled);
        }
        if !same_origin(req.headers(), target.host, target.tls) {
            return Err(DropReason::Invalid);
        }
        if !self.admit_ip(target.tenant_id, target.client_ip) {
            return Err(DropReason::IpRate);
        }
        let csp = req
            .uri()
            .query()
            .is_some_and(|q| q.split('&').any(|p| p == "kind=csp"));
        let user_agent = req
            .headers()
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let body = read_body(req).await?;
        let events = if csp {
            csp_events(&body, &user_agent)?
        } else {
            batch_events(&body)?
        };
        let now = Instant::now();
        for event in events {
            match self.admit_event(target.tenant_id, now) {
                Ok(()) => {
                    self.accepted.fetch_add(1, Ordering::Relaxed);
                    if let Some(sink) = self.sink.get() {
                        sink.write(log_line(target, event));
                    }
                }
                Err(reason) => self.drop_request(target.tenant_id, reason, now),
            }
        }
        Ok(())
    }

    fn admit_ip(&self, tenant: &str, ip: IpAddr) -> bool {
        let mut ips = self.ips.lock().unwrap_or_else(|e| e.into_inner());
        if ips.len() >= MAX_IP_WINDOWS && !ips.contains_key(&(tenant.to_owned(), ip)) {
            ips.clear();
        }
        let now = Instant::now();
        ips.entry((tenant.to_owned(), ip))
            .or_insert_with(|| Window::new(now))
            .admit(now, WINDOW, u64::from(self.limits.requests_per_ip_per_min))
    }

    fn admit_event(&self, tenant: &str, now: Instant) -> Result<(), DropReason> {
        let l = &self.limits;
        let mut tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
        let t = tenants
            .entry(tenant.to_owned())
            .or_insert_with(|| TenantState::new(now));
        // The daily cap counts kept events only: it bounds log lines.
        if now.duration_since(t.day.start) >= DAY {
            t.day = Window::new(now);
        }
        if t.day.count >= l.events_per_tenant_per_day {
            return Err(DropReason::DailyCap);
        }
        if now.duration_since(t.minute.start) >= WINDOW {
            t.over = 0;
        }
        if !t
            .minute
            .admit(now, WINDOW, u64::from(l.events_per_tenant_per_min))
        {
            t.over += 1;
            if !t.over.is_multiple_of(u64::from(l.sample_one_in.max(1))) {
                return Err(DropReason::Sampled);
            }
        }
        t.day.count += 1;
        Ok(())
    }

    /// Counts a drop and writes the tenant's summary lines when a minute
    /// has passed since the last ones. `disabled` drops are counted for the
    /// operator only: the tenant turned the endpoint off.
    fn drop_request(&self, tenant: &str, reason: DropReason, now: Instant) {
        self.dropped[reason.index()].fetch_add(1, Ordering::Relaxed);
        if reason == DropReason::Disabled {
            return;
        }
        let summary = {
            let mut tenants = self.tenants.lock().unwrap_or_else(|e| e.into_inner());
            let t = tenants
                .entry(tenant.to_owned())
                .or_insert_with(|| TenantState::new(now));
            t.drops[reason.index()] += 1;
            if t.last_summary
                .is_some_and(|s| now.duration_since(s) < WINDOW)
            {
                return;
            }
            t.last_summary = Some(now);
            std::mem::take(&mut t.drops)
        };
        let Some(sink) = self.sink.get() else { return };
        for r in DropReason::ALL {
            let dropped = summary[r.index()];
            if dropped == 0 {
                continue;
            }
            let mut fields = Map::new();
            fields.insert("source".into(), "client".into());
            fields.insert("code".into(), DROPPED_CODE.into());
            fields.insert("reason".into(), r.as_str().into());
            fields.insert("dropped".into(), dropped.into());
            sink.write(ClientLogLine {
                tenant_id: tenant.to_owned(),
                // The summary is about the endpoint, not one deployment.
                deployment_hash: String::new(),
                request_id: None,
                level: "warn",
                message: "client events dropped".into(),
                fields,
            });
        }
    }
}

fn no_content() -> Response<Body> {
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = StatusCode::NO_CONTENT;
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

/// No `Origin`, or one naming the request's own scheme and host. The
/// port is not compared: the gateway sits behind the node's listener and
/// sees the host without it.
fn same_origin(headers: &HeaderMap, host: &str, tls: bool) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let scheme = if tls { "https://" } else { "http://" };
    let Some(authority) = origin.strip_prefix(scheme) else {
        return false;
    };
    crate::route_table::parse_host(authority).is_ok_and(|h| h == host)
}

/// The body, refusing anything over [`MAX_BODY_BYTES`] without reading
/// past it.
async fn read_body(req: Request<Body>) -> Result<axum::body::Bytes, DropReason> {
    let declared = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > MAX_BODY_BYTES as u64) {
        return Err(DropReason::BodySize);
    }
    axum::body::to_bytes(req.into_body(), MAX_BODY_BYTES)
        .await
        .map_err(|_| DropReason::BodySize)
}

struct Validators {
    batch: jsonschema::Validator,
    event: jsonschema::Validator,
    csp_report: jsonschema::Validator,
    reports_json: jsonschema::Validator,
}

fn validators() -> &'static Validators {
    static V: OnceLock<Validators> = OnceLock::new();
    V.get_or_init(|| {
        let root: Value = serde_json::from_str(SCHEMA).expect("client-event schema is JSON");
        let def = |name: &str| {
            let schema = serde_json::json!({
                "$schema": root["$schema"],
                "$defs": root["$defs"],
                "$ref": format!("#/$defs/{name}"),
            });
            jsonschema::validator_for(&schema).expect("client-event schema compiles")
        };
        Validators {
            batch: jsonschema::validator_for(&root).expect("client-event schema compiles"),
            event: def("event"),
            csp_report: def("cspReport"),
            reports_json: def("reportsJson"),
        }
    })
}

/// A batch envelope: its events, or why it was dropped.
fn batch_events(body: &[u8]) -> Result<Vec<Value>, DropReason> {
    let batch: Value = serde_json::from_slice(body).map_err(|_| DropReason::Invalid)?;
    if batch
        .get("events")
        .and_then(Value::as_array)
        .is_some_and(|e| e.len() > MAX_BATCH_EVENTS)
    {
        return Err(DropReason::BatchSize);
    }
    if !validators().batch.is_valid(&batch) {
        return Err(DropReason::Invalid);
    }
    let Value::Object(mut batch) = batch else {
        return Err(DropReason::Invalid);
    };
    let Some(Value::Array(events)) = batch.remove("events") else {
        return Err(DropReason::Invalid);
    };
    for e in &events {
        // Rule CE2: `extra` is at most 1 KB of JSON.
        if e.get("extra").is_some_and(|x| x.to_string().len() > 1024) {
            return Err(DropReason::Invalid);
        }
        // Dev only: the production gateway never accepts it.
        if e.get("kind").and_then(Value::as_str) == Some("js.console.error") {
            return Err(DropReason::Invalid);
        }
    }
    Ok(events)
}

/// A browser CSP report body (`application/csp-report` or
/// `application/reports+json`), normalised to `csp.violation` events
/// (`client-events.md` section 6).
fn csp_events(body: &[u8], user_agent: &str) -> Result<Vec<Value>, DropReason> {
    let raw: Value = serde_json::from_slice(body).map_err(|_| DropReason::Invalid)?;
    let v = validators();
    let ua = ua_family(user_agent);
    let events: Vec<Value> = if v.csp_report.is_valid(&raw) {
        let r = &raw["csp-report"];
        vec![csp_event(
            ua,
            r.get("document-uri"),
            r.get("blocked-uri"),
            r.get("violated-directive"),
            r.get("effective-directive"),
            r.get("source-file"),
            r.get("line-number"),
            r.get("column-number"),
            r.get("disposition"),
        )]
    } else if v.reports_json.is_valid(&raw) {
        raw.as_array()
            .into_iter()
            .flatten()
            .map(|report| {
                let b = &report["body"];
                csp_event(
                    ua,
                    b.get("documentURL"),
                    b.get("blockedURL"),
                    b.get("effectiveDirective"),
                    b.get("effectiveDirective"),
                    b.get("sourceFile"),
                    b.get("lineNumber"),
                    b.get("columnNumber"),
                    b.get("disposition"),
                )
            })
            .collect()
    } else {
        return Err(DropReason::Invalid);
    };
    // What normalisation produced must be a valid event, like a batch.
    if events.iter().all(|e| v.event.is_valid(e)) {
        Ok(events)
    } else {
        Err(DropReason::Invalid)
    }
}

#[allow(clippy::too_many_arguments)]
fn csp_event(
    ua: &str,
    document: Option<&Value>,
    blocked: Option<&Value>,
    violated: Option<&Value>,
    effective: Option<&Value>,
    source: Option<&Value>,
    line: Option<&Value>,
    column: Option<&Value>,
    disposition: Option<&Value>,
) -> Value {
    let s = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or("").to_owned();
    let page = document
        .and_then(Value::as_str)
        .and_then(page_url)
        .unwrap_or_else(|| "/".to_owned());
    let effective = s(effective);
    let violated = match s(violated) {
        v if v.is_empty() => effective.clone(),
        v => v,
    };
    serde_json::json!({
        "kind": "csp.violation",
        "ts": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        "url": page,
        "request_id": null,
        "deployment": null,
        "ua": ua,
        "session_fingerprint": fingerprint(),
        "detail": {
            "blocked_uri": blocked_uri(&s(blocked)),
            "violated_directive": violated,
            "effective_directive": effective,
            "source_file": source.and_then(Value::as_str).and_then(resource_url),
            "line": line.and_then(Value::as_u64),
            "column": column.and_then(Value::as_u64),
            "disposition": match s(disposition).as_str() {
                "report" => "report",
                _ => "enforce",
            },
        },
    })
}

/// `scheme://host[:port]` and the rest of an absolute URL.
fn split_absolute(url: &str) -> Option<(&str, &str)> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let origin_len = url.len() - rest.len() + end;
    Some((&url[..origin_len], &url[origin_len..]))
}

/// The page `url` of an event: path and query, no fragment.
fn page_url(document: &str) -> Option<String> {
    let (_, rest) = split_absolute(document)?;
    let rest = rest.split('#').next().unwrap_or("");
    let rest = if rest.starts_with('/') {
        rest.to_owned()
    } else {
        format!("/{rest}")
    };
    (!rest.chars().any(char::is_whitespace) && rest.len() <= 2048).then_some(rest)
}

/// A resource URL as the contract keeps it: origin and path, no query or
/// fragment. Browser reports only carry absolute URLs; the gateway does not
/// know which are same-origin, so it keeps the origin (the script, which
/// does, reduces same-origin URLs to the path).
fn resource_url(url: &str) -> Option<String> {
    let (origin, rest) = split_absolute(url)?;
    let path = rest.split(['?', '#']).next().unwrap_or("");
    let out = format!("{origin}{path}");
    (!out.chars().any(char::is_whitespace) && out.len() <= 2048).then_some(out)
}

/// `blocked_uri`: a CSP keyword, a scheme keyword, or a resource URL; empty
/// for anything else.
fn blocked_uri(raw: &str) -> String {
    match raw {
        "inline" | "eval" | "wasm-eval" | "trusted-types-policy" | "trusted-types-sink" => {
            raw.to_owned()
        }
        _ if raw == "data" || raw.starts_with("data:") => "data".into(),
        _ if raw == "blob" || raw.starts_with("blob:") => "blob".into(),
        _ => resource_url(raw).unwrap_or_default(),
    }
}

/// The browser family from a `User-Agent`, never more.
pub fn ua_family(user_agent: &str) -> &'static str {
    if user_agent.contains("SamsungBrowser/") {
        "samsung"
    } else if user_agent.contains("Edg/") || user_agent.contains("EdgA/") {
        "edge"
    } else if user_agent.contains("Firefox/") || user_agent.contains("FxiOS/") {
        "firefox"
    } else if user_agent.contains("Chrome/") || user_agent.contains("CriOS/") {
        "chrome"
    } else if user_agent.contains("Safari/") {
        "safari"
    } else {
        "other"
    }
}

/// A fresh `session_fingerprint` for a browser report (one per report).
fn fingerprint() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("the OS random source is available");
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, b)
}

/// `error` for `js.*`, `htmx.*`, and enforced CSP violations; `warn` for
/// `realtime.*` and report-only violations.
fn level(kind: &str, detail: &Value) -> &'static str {
    if kind.starts_with("realtime.")
        || (kind == "csp.violation" && detail["disposition"] == "report")
    {
        "warn"
    } else {
        "error"
    }
}

/// The tenant log line of one valid event (`client-events.md` section 9).
fn log_line(target: &Target<'_>, event: Value) -> ClientLogLine {
    let Value::Object(mut e) = event else {
        unreachable!("validated events are objects")
    };
    let kind = e
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let detail = e.remove("detail").unwrap_or(Value::Null);
    let deployment_hash = match e.get("deployment").and_then(Value::as_str) {
        Some(h) if target.known_hashes.iter().any(|k| k == h) => h.to_owned(),
        _ => target.deployment_hash.to_owned(),
    };
    let request_id = e
        .get("request_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let message = match detail
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| detail.get("violated_directive").and_then(Value::as_str))
    {
        Some(m) => format!("{kind}: {m}"),
        None => kind.clone(),
    };
    let mut fields = Map::new();
    fields.insert("source".into(), "client".into());
    fields.insert("kind".into(), kind.clone().into());
    fields.insert("client_ts".into(), e.remove("ts").unwrap_or(Value::Null));
    for key in ["url", "ua", "session_fingerprint", "code", "extra"] {
        if let Some(v) = e.remove(key) {
            fields.insert(key.into(), v);
        }
    }
    fields.insert("detail".into(), detail.clone());
    ClientLogLine {
        tenant_id: target.tenant_id.to_owned(),
        deployment_hash,
        request_id,
        level: level(&kind, &detail),
        message,
        fields,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ua_families() {
        let chrome = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
        assert_eq!(ua_family(chrome), "chrome");
        assert_eq!(ua_family(&format!("{chrome} Edg/130.0")), "edge");
        assert_eq!(
            ua_family("Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/131.0"),
            "firefox"
        );
        assert_eq!(
            ua_family("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Safari/604.1"),
            "safari"
        );
        assert_eq!(ua_family("curl/8"), "other");
    }

    #[test]
    fn urls_are_reduced() {
        assert_eq!(
            page_url("https://shop.renox.app/p/42?x=1#token").as_deref(),
            Some("/p/42?x=1")
        );
        assert_eq!(page_url("https://shop.renox.app").as_deref(), Some("/"));
        assert_eq!(page_url("about:blank"), None);
        assert_eq!(
            resource_url("https://cdn.example/a.js?v=1#x").as_deref(),
            Some("https://cdn.example/a.js")
        );
        assert_eq!(blocked_uri("inline"), "inline");
        assert_eq!(blocked_uri("data:image/png;base64,AAAA"), "data");
        assert_eq!(blocked_uri("self"), "");
    }

    #[test]
    fn origin_check() {
        let mut h = HeaderMap::new();
        assert!(same_origin(&h, "shop.renox.app", true));
        h.insert(header::ORIGIN, "https://shop.renox.app".parse().unwrap());
        assert!(same_origin(&h, "shop.renox.app", true));
        assert!(!same_origin(&h, "shop.renox.app", false));
        assert!(!same_origin(&h, "other.renox.app", true));
        h.insert(header::ORIGIN, "null".parse().unwrap());
        assert!(!same_origin(&h, "shop.renox.app", true));
    }

    #[test]
    fn sampling_keeps_one_in_ten_over_the_minute_count() {
        let ce = ClientEvents::new(ClientEventLimits {
            events_per_tenant_per_min: 5,
            ..ClientEventLimits::default()
        });
        let now = Instant::now();
        let kept = (0..105)
            .filter(|_| ce.admit_event("t", now).is_ok())
            .count();
        assert_eq!(kept, 5 + 10);
        // A new minute starts the count again.
        assert!(ce.admit_event("t", now + WINDOW).is_ok());
    }

    #[test]
    fn daily_cap() {
        let ce = ClientEvents::new(ClientEventLimits {
            events_per_tenant_per_day: 3,
            ..ClientEventLimits::default()
        });
        let now = Instant::now();
        for _ in 0..3 {
            assert_eq!(ce.admit_event("t", now), Ok(()));
        }
        assert_eq!(ce.admit_event("t", now), Err(DropReason::DailyCap));
        assert_eq!(ce.admit_event("other", now), Ok(()));
    }
}
