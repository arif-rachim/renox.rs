//! `HttpLogSink`: the runtime's [`LogSink`] in controlled mode. Lines are
//! already redacted by the isolate's wrapper (`ops.md` section 4); they are
//! queued without blocking, batched (at most 1,000 lines, or 1 s after the
//! first), and sent as `log_batch` to `POST /v1/ingest/logs`
//! (`docs/contracts/deploy-api.md` section 11) with retries. A batch that
//! cannot be delivered goes to the failure hook (the spool of #98) or is
//! counted and dropped; logging never blocks or fails a request.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use renox_runtime::{LogLine, LogSink};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::control::http::ControlClient;

/// `$defs/log_batch`: at most this many lines per batch.
pub const MAX_LINES: usize = 1_000;
/// A batch is sent at most this long after its first line.
pub const FLUSH_AFTER: Duration = Duration::from_secs(1);
/// Lines queued before new ones are dropped.
const QUEUE: usize = 20_000;
/// Attempts per batch, with a backoff that doubles from 500 ms.
const ATTEMPTS: u32 = 3;
/// `$defs/log_line.message`: maxLength.
const MAX_MESSAGE_CHARS: usize = 8_300;

/// Called with a serialised `log_batch` body that every attempt failed to deliver.
pub type FailedBatch = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// Counters for the operator (and tests).
#[derive(Default)]
pub struct LogStats {
    pub sent_lines: AtomicU64,
    pub dropped_lines: AtomicU64,
    pub failed_batches: AtomicU64,
}

pub struct HttpLogSink {
    tx: mpsc::Sender<Value>,
    stats: Arc<LogStats>,
}

impl HttpLogSink {
    /// Starts the batching task on the current Tokio runtime.
    pub fn start(client: ControlClient, on_failed: Option<FailedBatch>) -> HttpLogSink {
        let (tx, rx) = mpsc::channel(QUEUE);
        let stats = Arc::new(LogStats::default());
        tokio::spawn(run(client, rx, stats.clone(), on_failed));
        HttpLogSink { tx, stats }
    }

    pub fn stats(&self) -> Arc<LogStats> {
        self.stats.clone()
    }
}

impl LogSink for HttpLogSink {
    fn log(&self, line: LogLine) {
        if self.tx.try_send(to_wire(line)).is_err() {
            self.stats.dropped_lines.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// One `$defs/log_line`. A `source: "client"` field (browser events, #126)
/// becomes the line's `source`.
pub fn to_wire(line: LogLine) -> Value {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let source = if line.fields.get("source").and_then(Value::as_str) == Some("client") {
        "client"
    } else {
        "server"
    };
    let request_id = line.request_id.filter(|r| {
        (8..=64).contains(&r.len())
            && r.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    });
    let level = match line.level {
        "debug" | "info" | "warn" | "error" => line.level,
        _ => "info",
    };
    let message: String = line.message.chars().take(MAX_MESSAGE_CHARS).collect();
    json!({
        "ts": ts,
        "tenant_id": line.tenant_id,
        "deployment_hash": line.deployment_hash,
        "request_id": request_id,
        // F3 runs only the app's own code (module `app`), as the F1 sink.
        "module": "app",
        "level": level,
        "message": message,
        "fields": if line.fields.is_empty() { Value::Null } else { Value::Object(line.fields) },
        "source": source,
    })
}

async fn run(
    client: ControlClient,
    mut rx: mpsc::Receiver<Value>,
    stats: Arc<LogStats>,
    on_failed: Option<FailedBatch>,
) {
    let mut buf: Vec<Value> = Vec::new();
    loop {
        let first = match rx.recv().await {
            Some(l) => l,
            None => return,
        };
        buf.push(first);
        let deadline = tokio::time::Instant::now() + FLUSH_AFTER;
        while buf.len() < MAX_LINES {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(l)) => buf.push(l),
                Ok(None) | Err(_) => break,
            }
        }
        let lines = std::mem::take(&mut buf);
        let n = lines.len() as u64;
        let body = json!({
            "type": "log_batch",
            "schema_version": 0,
            "node_id": client.node_id(),
            "lines": lines,
        });
        let bytes = serde_json::to_vec(&body).unwrap_or_default();
        if deliver(&client, &bytes).await {
            stats.sent_lines.fetch_add(n, Ordering::Relaxed);
            continue;
        }
        stats.failed_batches.fetch_add(1, Ordering::Relaxed);
        match &on_failed {
            Some(hook) => hook(bytes),
            None => {
                stats.dropped_lines.fetch_add(n, Ordering::Relaxed);
                tracing::warn!(lines = n, "log batch dropped: ingestion unreachable");
            }
        }
    }
}

/// Up to [`ATTEMPTS`] posts; true once one is accepted (2xx). A 4xx other
/// than 429 is not retried: the batch would be refused again.
pub async fn deliver(client: &ControlClient, body: &[u8]) -> bool {
    let mut backoff = Duration::from_millis(500);
    for attempt in 1..=ATTEMPTS {
        let status = client
            .send(
                http::Method::POST,
                "/v1/ingest/logs",
                Some(body.to_vec()),
                &[],
                crate::control::http::CALL_TIMEOUT,
            )
            .await
            .map(|a| a.status);
        match status {
            Ok(s) if s.is_success() => return true,
            Ok(s) if s.is_client_error() && s != http::StatusCode::TOO_MANY_REQUESTS => {
                tracing::warn!(
                    status = s.as_u16(),
                    "log batch refused by the control plane"
                );
                return false;
            }
            other => {
                tracing::debug!(attempt, ?other, "log batch not delivered");
            }
        }
        if attempt < ATTEMPTS {
            tokio::time::sleep(backoff).await;
            backoff *= 2;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_lines_follow_the_schema() {
        let mut fields = serde_json::Map::new();
        fields.insert("source".into(), "client".into());
        let v = to_wire(LogLine {
            level: "warn",
            tenant_id: "t_hello".into(),
            deployment_hash: "a".repeat(64),
            request_id: Some("short".into()),
            message: "x".repeat(9000),
            fields,
        });
        assert_eq!(v["source"], "client");
        assert_eq!(v["request_id"], Value::Null);
        assert_eq!(v["message"].as_str().unwrap().len(), MAX_MESSAGE_CHARS);
        let v = to_wire(LogLine {
            level: "log",
            tenant_id: "t_hello".into(),
            deployment_hash: "a".repeat(64),
            request_id: Some("01JBQ3Z7M8K5V6W9X2Y4A1B3C5".into()),
            message: "hi".into(),
            fields: serde_json::Map::new(),
        });
        assert_eq!(v["level"], "info");
        assert_eq!(v["fields"], Value::Null);
        assert_eq!(v["source"], "server");
        assert_eq!(v["request_id"], "01JBQ3Z7M8K5V6W9X2Y4A1B3C5");
    }
}
