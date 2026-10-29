//! Per-handle database counters for the meter record (`docs/contracts/meter.md`:
//! `db_ms`, `db_rows`).

use std::time::Duration;

/// Counters since the handle was opened. The cell takes a snapshot before
/// and after a request and records the difference (`DbStats::since`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct DbStats {
    /// Calls of `query`, `query_one`, and `execute` (on the handle or a `Tx`).
    pub statements: u64,
    /// Rows returned to the caller.
    pub rows_read: u64,
    /// Rows changed (`changes`) by statements that write.
    pub rows_written: u64,
    /// Statements that gave up with `Busy` after the busy wait.
    pub busy_waits: u64,
    /// Statements stopped with `Timeout`.
    pub timeouts: u64,
    /// Wall time spent in statements, including waits for the write lock.
    pub total_ms: f64,
}

impl DbStats {
    /// `db_ms` of the meter record.
    pub fn db_ms(&self) -> f64 {
        self.total_ms
    }

    /// `db_rows` of the meter record: rows returned plus rows changed.
    pub fn db_rows(&self) -> u64 {
        self.rows_read + self.rows_written
    }

    /// Counters accumulated since `earlier`, a snapshot of the same handle.
    pub fn since(&self, earlier: &DbStats) -> DbStats {
        DbStats {
            statements: self.statements - earlier.statements,
            rows_read: self.rows_read - earlier.rows_read,
            rows_written: self.rows_written - earlier.rows_written,
            busy_waits: self.busy_waits - earlier.busy_waits,
            timeouts: self.timeouts - earlier.timeouts,
            total_ms: self.total_ms - earlier.total_ms,
        }
    }

    pub(crate) fn record(&mut self, elapsed: Duration, outcome: Outcome) {
        self.statements += 1;
        self.total_ms += elapsed.as_secs_f64() * 1000.0;
        match outcome {
            Outcome::Rows { read, written } => {
                self.rows_read += read;
                self.rows_written += written;
            }
            Outcome::Busy => self.busy_waits += 1,
            Outcome::Timeout => self.timeouts += 1,
            Outcome::Failed => {}
        }
    }
}

pub(crate) enum Outcome {
    Rows { read: u64, written: u64 },
    Busy,
    Timeout,
    Failed,
}

/// Gauges of the durable event outbox (`outbox::stats`), exposed by the
/// worker per tenant (`docs/23-failure-modes.md`, "Outbox or logs grow
/// unbounded").
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OutboxStats {
    /// Rows of `renox__outbox`: deliveries (and fan-outs) not done yet.
    pub pending: u64,
    /// Rows of `renox__outbox_dead`.
    pub dead: u64,
    /// Payload and error bytes of the dead letters (the cap's byte bound).
    pub dead_bytes: u64,
    /// Dead letters deleted by the cap since the file was created.
    pub dead_pruned: u64,
}
