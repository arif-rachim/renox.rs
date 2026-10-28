//! Concurrent requests per deployment (`docs/contracts/ops.md` section 10):
//! a semaphore per deployment; a request queues up to its deadline, then
//! gets 503 `RENOX_BUSY` with `Retry-After: 1`
//! (`docs/23-failure-modes.md`, "Too many concurrent requests").
//!
//! The semaphore belongs to the deployment, not to an isolate: with an
//! isolate pool (#156, `isolate.rs`) every member draws from the same
//! slots, so growing the pool never raises the limit.

use std::sync::Arc;
use std::time::Instant;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Debug)]
pub struct ConcurrencyLimit {
    semaphore: Arc<Semaphore>,
    limit: u32,
}

/// No slot became free before the deadline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Busy;

impl ConcurrencyLimit {
    pub fn new(limit: u32) -> ConcurrencyLimit {
        ConcurrencyLimit {
            semaphore: Arc::new(Semaphore::new(limit.max(1) as usize)),
            limit: limit.max(1),
        }
    }

    pub fn limit(&self) -> u32 {
        self.limit
    }

    /// Slots currently free.
    pub fn available(&self) -> usize {
        self.semaphore.available_permits()
    }

    /// Wait for a slot until `deadline`.
    pub async fn acquire(&self, deadline: Instant) -> Result<OwnedSemaphorePermit, Busy> {
        let fut = self.semaphore.clone().acquire_owned();
        match tokio::time::timeout_at(deadline.into(), fut).await {
            Ok(Ok(permit)) => Ok(permit),
            _ => Err(Busy),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn the_extra_request_waits_then_gets_busy() {
        let c = ConcurrencyLimit::new(2);
        let far = Instant::now() + Duration::from_secs(5);
        let a = c.acquire(far).await.unwrap();
        let _b = c.acquire(far).await.unwrap();
        let t = Instant::now();
        assert_eq!(
            c.acquire(Instant::now() + Duration::from_millis(30))
                .await
                .unwrap_err(),
            Busy
        );
        assert!(t.elapsed() >= Duration::from_millis(25));
        drop(a);
        assert!(c.acquire(far).await.is_ok());
    }
}
