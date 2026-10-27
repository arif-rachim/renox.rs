//! The meter: a bounded channel in front of a background batching task.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::record::{MAX_BATCH_RECORDS, MeterBatch, MeterRecord, SCHEMA_VERSION};
use crate::sink::{NdjsonFileSink, Sink};

/// How often the "records dropped" warning may be logged.
const DROP_LOG_INTERVAL: Duration = Duration::from_secs(60);

/// Configuration of one meter (one per cell).
#[derive(Debug, Clone)]
pub struct MeterConfig {
    pub cell_id: String,
    pub node_id: String,
    /// Capacity of the channel between `record()` and the batching task.
    pub channel_capacity: usize,
    /// Flush when this many records are buffered (contract: 1,000).
    pub max_batch: usize,
    /// Flush this long after the first buffered record (contract: 5 s).
    pub flush_interval: Duration,
    /// Total attempts per batch before it goes to the dead-letter file.
    pub retry_attempts: u32,
    /// Wait before the second attempt; doubles for each further attempt.
    pub retry_backoff: Duration,
    /// Where batches go when every attempt failed.
    pub dead_letter: NdjsonFileSink,
}

impl MeterConfig {
    /// Contract defaults; dead letters under `<data_dir>/meters/<cell_id>/dead/`.
    pub fn new(
        cell_id: impl Into<String>,
        node_id: impl Into<String>,
        data_dir: &std::path::Path,
    ) -> Self {
        let cell_id = cell_id.into();
        let dead_letter = NdjsonFileSink::dead_letter_for_cell(data_dir, &cell_id);
        Self {
            cell_id,
            node_id: node_id.into(),
            channel_capacity: 10_000,
            max_batch: MAX_BATCH_RECORDS,
            flush_interval: Duration::from_secs(5),
            retry_attempts: 3,
            retry_backoff: Duration::from_secs(1),
            dead_letter,
        }
    }
}

/// Counters exposed for tests and node metrics.
#[derive(Debug, Default)]
struct Counters {
    dropped: AtomicU64,
    batches_written: AtomicU64,
    batches_dead_lettered: AtomicU64,
    batches_lost: AtomicU64,
    /// Milliseconds since `started` at which "dropped" was last logged, plus one
    /// (0 = never logged).
    last_drop_log: AtomicU64,
}

/// Handle to a running meter. Cheap to clone; every clone feeds the same task.
#[derive(Clone)]
pub struct Meter {
    tx: mpsc::Sender<MeterRecord>,
    counters: Arc<Counters>,
    started: Instant,
    shutdown: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    task: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl Meter {
    /// Starts the batching task on the current Tokio runtime.
    ///
    /// # Panics
    /// Outside a Tokio runtime, or if `max_batch` is 0 or above 1,000.
    pub fn start<S: Sink>(config: MeterConfig, sink: S) -> Self {
        assert!(
            (1..=MAX_BATCH_RECORDS).contains(&config.max_batch),
            "max_batch must be 1..=1000"
        );
        let (tx, rx) = mpsc::channel(config.channel_capacity.max(1));
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let counters = Arc::new(Counters::default());
        let worker = Worker {
            config,
            sink,
            counters: counters.clone(),
        };
        let task = tokio::spawn(worker.run(rx, shutdown_rx));
        Self {
            tx,
            counters,
            started: Instant::now(),
            shutdown: Arc::new(Mutex::new(Some(shutdown_tx))),
            task: Arc::new(Mutex::new(Some(task))),
        }
    }

    /// Queues one record. Never blocks and never awaits.
    ///
    /// When the channel is full the record is dropped, `dropped()` is
    /// incremented, and a warning is logged at most once per minute. A drop is
    /// a bug to fix with a bigger `channel_capacity` or a faster sink, not
    /// expected behaviour: the contract (section 4) does not allow shedding.
    /// The request path must still never wait on metering.
    pub fn record(&self, record: MeterRecord) {
        if self.tx.try_send(record).is_err() {
            let total = self.counters.dropped.fetch_add(1, Ordering::Relaxed) + 1;
            self.maybe_log_drop(total);
        }
    }

    /// Records dropped because the channel was full or the meter was closed.
    pub fn dropped(&self) -> u64 {
        self.counters.dropped.load(Ordering::Relaxed)
    }

    /// Batches the sink accepted.
    pub fn batches_written(&self) -> u64 {
        self.counters.batches_written.load(Ordering::Relaxed)
    }

    /// Batches written to the dead-letter file after every attempt failed.
    pub fn batches_dead_lettered(&self) -> u64 {
        self.counters.batches_dead_lettered.load(Ordering::Relaxed)
    }

    /// Batches that could not be written to the sink nor to the dead-letter file.
    pub fn batches_lost(&self) -> u64 {
        self.counters.batches_lost.load(Ordering::Relaxed)
    }

    /// Stops accepting records, writes everything already queued, and waits
    /// for the batching task to end. Later calls return immediately.
    pub async fn flush_and_close(&self) {
        if let Some(tx) = self.shutdown.lock().expect("meter mutex").take() {
            let _ = tx.send(());
        }
        let task = self.task.lock().expect("meter mutex").take();
        if let Some(task) = task
            && let Err(e) = task.await
        {
            tracing::error!(error = %e, "meter task ended abnormally");
        }
    }

    fn maybe_log_drop(&self, total: u64) {
        let now = self.started.elapsed().as_millis() as u64 + 1;
        let last = self.counters.last_drop_log.load(Ordering::Relaxed);
        let due = last == 0 || now.saturating_sub(last) >= DROP_LOG_INTERVAL.as_millis() as u64;
        if due
            && self
                .counters
                .last_drop_log
                .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            tracing::warn!(
                dropped_total = total,
                "meter channel full, records dropped; this is a bug: raise channel_capacity"
            );
        }
    }
}

struct Worker<S> {
    config: MeterConfig,
    sink: S,
    counters: Arc<Counters>,
}

impl<S: Sink> Worker<S> {
    async fn run(self, mut rx: mpsc::Receiver<MeterRecord>, mut shutdown: oneshot::Receiver<()>) {
        let mut buf: Vec<MeterRecord> = Vec::with_capacity(self.config.max_batch);
        let mut deadline: Option<Instant> = None;
        loop {
            tokio::select! {
                biased;
                _ = &mut shutdown => {
                    rx.close();
                    while let Some(record) = rx.recv().await {
                        self.push(&mut buf, &mut deadline, record).await;
                    }
                    break;
                }
                received = rx.recv() => match received {
                    Some(record) => self.push(&mut buf, &mut deadline, record).await,
                    None => break,
                },
                _ = sleep_until(deadline), if deadline.is_some() => {
                    self.flush(&mut buf, &mut deadline).await;
                }
            }
        }
        self.flush(&mut buf, &mut deadline).await;
    }

    async fn push(
        &self,
        buf: &mut Vec<MeterRecord>,
        deadline: &mut Option<Instant>,
        record: MeterRecord,
    ) {
        if buf.is_empty() {
            *deadline = Some(Instant::now() + self.config.flush_interval);
        }
        buf.push(record);
        if buf.len() >= self.config.max_batch {
            self.flush(buf, deadline).await;
        }
    }

    async fn flush(&self, buf: &mut Vec<MeterRecord>, deadline: &mut Option<Instant>) {
        *deadline = None;
        if buf.is_empty() {
            return;
        }
        let batch = MeterBatch {
            schema_version: SCHEMA_VERSION,
            cell_id: self.config.cell_id.clone(),
            node_id: self.config.node_id.clone(),
            records: std::mem::replace(buf, Vec::with_capacity(self.config.max_batch)),
        };
        self.deliver(batch).await;
    }

    /// Up to `retry_attempts` attempts with exponential backoff, then the
    /// dead-letter file (`docs/23-failure-modes.md`, "Meter batch cannot be shipped").
    async fn deliver(&self, batch: MeterBatch) {
        let attempts = self.config.retry_attempts.max(1);
        let mut backoff = self.config.retry_backoff;
        for attempt in 1..=attempts {
            match self.sink.write_batch(&batch).await {
                Ok(()) => {
                    self.counters
                        .batches_written
                        .fetch_add(1, Ordering::Relaxed);
                    return;
                }
                Err(e) => {
                    tracing::warn!(attempt, attempts, error = %e, records = batch.records.len(), "meter batch write failed");
                    if attempt < attempts {
                        tokio::time::sleep(backoff).await;
                        backoff = backoff.saturating_mul(2);
                    }
                }
            }
        }
        match self.config.dead_letter.write_batch(&batch).await {
            Ok(()) => {
                self.counters
                    .batches_dead_lettered
                    .fetch_add(1, Ordering::Relaxed);
                tracing::error!(
                    records = batch.records.len(),
                    dir = %self.config.dead_letter.dir().display(),
                    "meter batch written to dead-letter file"
                );
            }
            Err(e) => {
                self.counters.batches_lost.fetch_add(1, Ordering::Relaxed);
                tracing::error!(error = %e, records = batch.records.len(), "meter batch lost: dead-letter write failed");
            }
        }
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}
