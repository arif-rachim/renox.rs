//! Per-invocation meter records for Renox cells.
//!
//! Implements `docs/contracts/meter.md` version 0: the record and batch
//! envelope ([`MeterRecord`], [`MeterBatch`]), batching (1,000 records or 5 s
//! after the first buffered record), retries with a dead-letter file, and the
//! F1 sinks ([`NdjsonFileSink`], [`StdoutSink`]). The HTTP sink is F3.
//!
//! Leaf crate: no `renox-*` dependencies and no V8.

mod meter;
mod record;
mod sink;

pub use meter::{Meter, MeterConfig};
pub use record::{
    MAX_BATCH_RECORDS, MeterBatch, MeterRecord, MeterStatus, SCHEMA_VERSION, round_millis,
};
pub use sink::{NdjsonFileSink, Sink, SinkError, StdoutSink};
