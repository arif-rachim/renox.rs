//! Wall-clock limit per request (`docs/contracts/ops.md` sections 5 and 10).
//! The deadline is a duration from the gateway, turned into an `Instant`
//! once, so a skewed wall clock cannot extend it. The cell's deadline is
//! further capped by the deployment's `wall_ms`.

use std::time::{Duration, Instant};

/// The effective deadline: the earlier of the gateway's and `now + wall_ms`.
pub fn effective_deadline(requested: Instant, wall_ms: u64, now: Instant) -> Instant {
    requested.min(now + Duration::from_millis(wall_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_earlier_deadline_wins() {
        let now = Instant::now();
        assert_eq!(
            effective_deadline(now + Duration::from_secs(90), 30_000, now),
            now + Duration::from_secs(30)
        );
        assert_eq!(
            effective_deadline(now + Duration::from_secs(5), 30_000, now),
            now + Duration::from_secs(5)
        );
    }
}
