#![allow(dead_code)]

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use renox_meter::{MeterBatch, MeterRecord, MeterStatus, Sink, SinkError};

pub fn record(n: u64) -> MeterRecord {
    MeterRecord {
        request_id: format!("01JBQ3Z7M8K5V6W9X2{n:08}"),
        tenant_id: "t_notes".into(),
        deployment_hash: "2b91fc0592294b5d6d0c56500b8c5b38af26ed6c9f75198c497c2f529cdbd8f6".into(),
        route: "GET /api/notes/:id".into(),
        started_at: 1_793_318_400_123 + n,
        cpu_ms: 1.48249,
        wall_ms: 3.9171,
        peak_heap_bytes: 6_291_456,
        ingress_bytes: 0,
        egress_bytes: 41,
        fetch_sent_bytes: 0,
        fetch_received_bytes: 0,
        fetch_blocked: 0,
        db_ms: 0.2114,
        db_rows: 1,
        render_fuel: 0,
        render_ms: None,
        logs_dropped: 0,
        http_status: 200,
        status: MeterStatus::Ok,
        kind: None,
    }
}

/// Keeps every batch it is given.
#[derive(Clone, Default)]
pub struct MemorySink {
    pub batches: Arc<Mutex<Vec<MeterBatch>>>,
}

impl MemorySink {
    pub fn sizes(&self) -> Vec<usize> {
        self.batches
            .lock()
            .unwrap()
            .iter()
            .map(|b| b.records.len())
            .collect()
    }
}

impl Sink for MemorySink {
    async fn write_batch(&self, batch: &MeterBatch) -> Result<(), SinkError> {
        self.batches.lock().unwrap().push(batch.clone());
        Ok(())
    }
}

/// Fails every write and counts the attempts, with the time of each.
#[derive(Clone, Default)]
pub struct FailingSink {
    pub attempts: Arc<AtomicU32>,
    pub at: Arc<Mutex<Vec<tokio::time::Instant>>>,
}

impl FailingSink {
    pub fn attempts(&self) -> u32 {
        self.attempts.load(Ordering::SeqCst)
    }
}

impl Sink for FailingSink {
    async fn write_batch(&self, _batch: &MeterBatch) -> Result<(), SinkError> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        self.at.lock().unwrap().push(tokio::time::Instant::now());
        Err(SinkError::Other("control plane unreachable".into()))
    }
}
