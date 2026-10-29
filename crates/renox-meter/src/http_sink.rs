//! The HTTP sink reserved in `meter.md` section 5: one batch envelope per
//! `POST /v1/ingest/meters` (`docs/contracts/deploy-api.md` section 11).
//!
//! Batching (1,000 records or 5 s), retries with backoff and the dead-letter
//! file sit in front of every sink, in [`crate::Meter`]; this sink makes one
//! attempt per call. The transport is a [`BatchPoster`] supplied by the
//! worker, so this leaf crate carries no HTTP or TLS stack.
//!
//! | Answer | Meaning | Here |
//! | --- | --- | --- |
//! | 202 `{ accepted, duplicates }` | Persisted (records de-duplicated on `request_id`) | `Ok` |
//! | 400 | Unknown `schema_version` or an invalid record | `Err`: retried, then dead-lettered for replay |
//! | anything else, or no answer | Not persisted | `Err` |

use std::future::Future;

use crate::record::MeterBatch;
use crate::sink::{Sink, SinkError};

/// Sends one JSON body to the ingestion endpoint and returns the HTTP status.
/// `Err` when no status was received (connection refused, timeout).
pub trait BatchPoster: Send + Sync + 'static {
    fn post(&self, body: Vec<u8>) -> impl Future<Output = Result<u16, String>> + Send;
}

/// [`Sink`] over a [`BatchPoster`].
#[derive(Debug, Clone)]
pub struct HttpMeterSink<P> {
    poster: P,
}

impl<P: BatchPoster> HttpMeterSink<P> {
    pub fn new(poster: P) -> Self {
        Self { poster }
    }
}

impl<P: BatchPoster> Sink for HttpMeterSink<P> {
    async fn write_batch(&self, batch: &MeterBatch) -> Result<(), SinkError> {
        let body = serde_json::to_vec(batch)?;
        match self.poster.post(body).await {
            Ok(status) if (200..300).contains(&status) => Ok(()),
            Ok(status) => Err(SinkError::Other(format!(
                "ingestion answered {status}; batch kept"
            ))),
            Err(e) => Err(SinkError::Other(format!("ingestion unreachable: {e}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{MeterRecord, MeterStatus, SCHEMA_VERSION};
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Fake {
        answers: Arc<Mutex<Vec<Result<u16, String>>>>,
        bodies: Arc<Mutex<Vec<Vec<u8>>>>,
    }

    impl BatchPoster for Fake {
        async fn post(&self, body: Vec<u8>) -> Result<u16, String> {
            self.bodies.lock().unwrap().push(body);
            self.answers.lock().unwrap().remove(0)
        }
    }

    fn batch() -> MeterBatch {
        MeterBatch {
            schema_version: SCHEMA_VERSION,
            cell_id: "t_hello@node-1".into(),
            node_id: "node-1".into(),
            records: vec![MeterRecord {
                request_id: "01JBQ3Z7M8K5V6W9X2Y4A1B3C5".into(),
                tenant_id: "t_hello".into(),
                deployment_hash: "8".repeat(64),
                route: "GET /api/hello".into(),
                started_at: 1,
                cpu_ms: 0.5,
                wall_ms: 1.0,
                peak_heap_bytes: 0,
                ingress_bytes: 0,
                egress_bytes: 11,
                fetch_sent_bytes: 0,
                fetch_received_bytes: 0,
                fetch_blocked: 0,
                db_ms: 0.0,
                db_rows: 0,
                render_fuel: 0,
                render_ms: None,
                logs_dropped: 0,
                http_status: 200,
                status: MeterStatus::Ok,
                kind: None,
            }],
        }
    }

    #[tokio::test]
    async fn only_2xx_counts_as_persisted() {
        let fake = Fake {
            answers: Arc::new(Mutex::new(vec![
                Ok(202),
                Ok(400),
                Ok(503),
                Err("connection refused".into()),
            ])),
            bodies: Arc::default(),
        };
        let sink = HttpMeterSink::new(fake.clone());
        assert!(sink.write_batch(&batch()).await.is_ok());
        for _ in 0..3 {
            assert!(sink.write_batch(&batch()).await.is_err());
        }
        // The body is the batch envelope itself (meter-record.schema.json).
        let sent: serde_json::Value =
            serde_json::from_slice(&fake.bodies.lock().unwrap()[0]).unwrap();
        assert_eq!(sent["node_id"], "node-1");
        assert_eq!(sent["records"][0]["route"], "GET /api/hello");
    }
}
