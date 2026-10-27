//! Statement time limit and request deadline (`docs/04-isolation-security.md`,
//! per-tenant database limits; `docs/contracts/ops.md` section 1, "Limits").
//!
//! A `progress_handler` on every connection checks the clock every
//! `PROGRESS_STEPS` VM instructions and interrupts the statement when its
//! limit or the request deadline has passed.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// VM instructions between two clock checks.
pub(crate) const PROGRESS_STEPS: i32 = 1_000;

/// Per-call context: the request deadline, if the caller has one.
///
/// A statement stops at `min(statement limit, deadline)`; a call whose
/// deadline has already passed fails with `DbError::Timeout` before it runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QueryCtx {
    pub deadline: Option<Instant>,
}

impl QueryCtx {
    pub fn with_deadline(deadline: Instant) -> Self {
        QueryCtx {
            deadline: Some(deadline),
        }
    }

    /// Time left before the deadline; `None` without a deadline.
    pub(crate) fn remaining(&self, now: Instant) -> Option<Duration> {
        self.deadline.map(|d| d.saturating_duration_since(now))
    }

    pub(crate) fn expired(&self, now: Instant) -> bool {
        self.deadline.is_some_and(|d| d <= now)
    }
}

#[derive(Debug, Default)]
struct ClockState {
    running: bool,
    limit: Duration,
    deadline: Option<Instant>,
    /// Set by the first progress callback: the wait for the write lock,
    /// which SQLite takes before the first VM instructions run, is bounded
    /// by the busy wait, not by the statement limit.
    started: Option<Instant>,
}

/// The clock of the statement running on one connection.
#[derive(Debug, Default)]
pub(crate) struct StatementClock {
    state: Mutex<ClockState>,
}

impl StatementClock {
    pub(crate) fn start(&self, limit: Duration, deadline: Option<Instant>) {
        *self.lock() = ClockState {
            running: true,
            limit,
            deadline,
            started: None,
        };
    }

    pub(crate) fn stop(&self) {
        self.lock().running = false;
    }

    /// Called by the progress handler; `true` interrupts the statement.
    pub(crate) fn expired(&self) -> bool {
        let mut s = self.lock();
        if !s.running {
            return false;
        }
        let now = Instant::now();
        let started = *s.started.get_or_insert(now);
        now.duration_since(started) >= s.limit || s.deadline.is_some_and(|d| now >= d)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ClockState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// `PRAGMA wal_checkpoint` modes the platform uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckpointMode {
    /// Copy as many frames as possible without waiting for readers or the writer.
    Passive,
    /// Copy everything, wait for readers, then truncate the WAL file to zero bytes.
    Truncate,
}

/// Result of a checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckpointResult {
    /// Frames in the WAL when the checkpoint ran.
    pub wal_frames: u64,
    /// Frames copied into the database file.
    pub checkpointed_frames: u64,
}
