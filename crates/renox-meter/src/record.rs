//! The record and the batch envelope of `docs/contracts/meter.md` version 0.2
//! (`schema_version` 0).
//!
//! Field names and types match `docs/contracts/schemas/meter-record.schema.json`
//! exactly; `tests/schema.rs` validates serialised values against that file.

use serde::{Deserialize, Serialize, Serializer};

/// The `schema_version` written into every batch (contract section 3).
pub const SCHEMA_VERSION: u32 = 0;

/// Maximum number of records in one batch (contract section 3).
pub const MAX_BATCH_RECORDS: usize = 1_000;

/// How an invocation ended, from the platform's point of view (contract section 2, `status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeterStatus {
    Ok,
    Error,
    Timeout,
    CpuLimit,
    Oom,
    BlockedFetch,
    Busy,
    /// Rendering hit a render limit (`RENOX_RENDER_LIMIT`, contract 0.1).
    RenderLimit,
    /// Contract 0.3: the route's `guard` or the tool check denied (403).
    Forbidden,
}

/// What was invoked (contract 0.2, `kind`; absent = a request).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeterKind {
    Request,
    /// One delivery attempt of a durable event: `route` is
    /// `EVENT <module> <name>`, `request_id` `<event id>_<module>_<attempt>`.
    Event,
    /// Contract 0.3: one `tools/call` that reached `run` (`TOOL <name>`).
    Tool,
    /// Contract 0.3: one job attempt (`JOB <module> <name>`).
    Job,
}

/// One invocation record (contract section 2). All fields are required
/// except `render_ms` (0.1), which is omitted when nothing was rendered.
///
/// A record never carries request or response content, header values, query
/// strings, user identifiers, or secrets; `route` is the pattern, never the URL.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MeterRecord {
    pub request_id: String,
    pub tenant_id: String,
    pub deployment_hash: String,
    /// `<METHOD> <pattern>` from the matched manifest route.
    pub route: String,
    /// Unix time in milliseconds.
    pub started_at: u64,
    #[serde(serialize_with = "millis")]
    pub cpu_ms: f64,
    #[serde(serialize_with = "millis")]
    pub wall_ms: f64,
    pub peak_heap_bytes: u64,
    pub ingress_bytes: u64,
    pub egress_bytes: u64,
    pub fetch_sent_bytes: u64,
    pub fetch_received_bytes: u64,
    pub fetch_blocked: u64,
    #[serde(serialize_with = "millis")]
    pub db_ms: f64,
    pub db_rows: u64,
    /// Template render fuel of every render of the invocation; `0` when
    /// nothing was rendered.
    pub render_fuel: u64,
    /// Thread CPU time of rendering on the render pool, outside `cpu_ms`
    /// (contract 0.1). `None` is serialised as an absent field (= 0).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "opt_millis"
    )]
    pub render_ms: Option<f64>,
    pub logs_dropped: u64,
    pub http_status: u16,
    pub status: MeterStatus,
    /// Contract 0.2; `None` is serialised as an absent field (= request).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MeterKind>,
    /// Contract 0.3: Cedar evaluations of the invocation (absent = 0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authz_evals: Option<u64>,
    /// Contract 0.3: a realtime connection's lifetime in seconds, on its
    /// record only (absent = 0).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "opt_millis"
    )]
    pub realtime_conn_seconds: Option<f64>,
    /// Contract 0.3: frames received plus messages delivered to a realtime
    /// connection (absent = 0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realtime_messages: Option<u64>,
}

/// One batch envelope: one line of the ndjson sink (contract section 3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MeterBatch {
    pub schema_version: u32,
    pub cell_id: String,
    pub node_id: String,
    pub records: Vec<MeterRecord>,
}

impl MeterBatch {
    /// Serialises the batch as one ndjson line, including the trailing newline.
    pub fn to_ndjson_line(&self) -> serde_json::Result<Vec<u8>> {
        let mut line = serde_json::to_vec(self)?;
        line.push(b'\n');
        Ok(line)
    }
}

/// Non-negative milliseconds rounded to 3 decimal places (contract section 2).
/// Negative and non-finite inputs are clamped to 0 so a clock glitch never
/// produces a record the schema rejects.
pub fn round_millis(value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        return 0.0;
    }
    (value * 1_000.0).round() / 1_000.0
}

fn opt_millis<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(v) => serializer.serialize_f64(round_millis(*v)),
        None => serializer.serialize_none(),
    }
}

fn millis<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_f64(round_millis(*value))
}
