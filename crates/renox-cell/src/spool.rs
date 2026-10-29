//! The spool of a controlled worker (#98): meter batches and log batches
//! that could not be shipped to the control plane, kept on disk under
//! `<data_dir>/spool/` and replayed with backoff once it answers again
//! (`docs/23-failure-modes.md` section 3, "Control plane unreachable from
//! the worker").
//!
//! - `spool/meters/`: the meter's dead-letter files (`renox-meter`'s
//!   `NdjsonFileSink`, one batch envelope per line); no new buffer format.
//! - `spool/logs/`: `log_batch` bodies, one per line, in the same layout.
//!
//! A replay round claims each file by renaming it to `*.replaying` (new
//! dead letters then go to a fresh file), posts its lines in order, and
//! rewrites it with the lines not yet accepted, or deletes it when none is
//! left. Meter records are de-duplicated on `request_id` by the ingestion
//! (`meter.md` section 4), so a line posted twice is never counted twice.
//! A line the control plane refuses with a 4xx other than 429 is moved to
//! `rejected/` so it does not block the rest.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use http::{Method, StatusCode};
use tokio::task::JoinHandle;

use crate::control::health::Health;
use crate::control::http::{CALL_TIMEOUT, ControlClient};

/// Wait before the first replay round after a failed one; doubles up to [`MAX_BACKOFF`].
pub const MIN_BACKOFF: Duration = Duration::from_secs(1);
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Spool directories above this size drop their oldest file (an alert).
pub const MAX_SPOOL_BYTES: u64 = 256 * 1024 * 1024;

/// One kind of spooled batch and the endpoint it replays to.
#[derive(Debug, Clone)]
pub struct Queue {
    /// `meters` or `logs`: the health component and the directory name.
    pub name: &'static str,
    pub dir: PathBuf,
    pub endpoint: &'static str,
}

impl Queue {
    pub fn meters(data_dir: &Path) -> Queue {
        Queue {
            name: "meters",
            dir: data_dir.join("spool").join("meters"),
            endpoint: "/v1/ingest/meters",
        }
    }

    pub fn logs(data_dir: &Path) -> Queue {
        Queue {
            name: "logs",
            dir: data_dir.join("spool").join("logs"),
            endpoint: "/v1/ingest/logs",
        }
    }

    /// Appends one body as a line (the log sink's failure hook). Never
    /// panics; a failed write is logged and the batch is lost.
    pub fn append(&self, body: &[u8]) {
        let result = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(&self.dir)?;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.dir.join(format!("{}.ndjson", now_ms())))?;
            let mut line = body.to_vec();
            line.push(b'\n');
            f.write_all(&line)?;
            f.sync_data()
        })();
        if let Err(e) = result {
            tracing::error!(queue = self.name, error = %e, "spool write failed; batch lost");
        }
    }

    /// Files waiting, oldest first (names sort by time).
    pub fn pending(&self) -> Vec<PathBuf> {
        let Ok(rd) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut files: Vec<PathBuf> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && p.extension()
                        .is_some_and(|x| x == "ndjson" || x == "replaying")
            })
            .collect();
        files.sort();
        files
    }

    /// Lines waiting in the spool.
    pub fn pending_lines(&self) -> usize {
        self.pending()
            .iter()
            .filter_map(|p| std::fs::read(p).ok())
            .map(|b| b.split(|&c| c == b'\n').filter(|l| !l.is_empty()).count())
            .sum()
    }

    /// Deletes the oldest files while the directory is over [`MAX_SPOOL_BYTES`].
    fn enforce_cap(&self) {
        let files = self.pending();
        let mut total: u64 = files
            .iter()
            .filter_map(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .sum();
        for f in files {
            if total <= MAX_SPOOL_BYTES {
                break;
            }
            let len = std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
            if std::fs::remove_file(&f).is_ok() {
                total -= len;
                tracing::error!(
                    queue = self.name,
                    bytes = len,
                    "spool over its cap: oldest file dropped"
                );
            }
        }
    }
}

static CLAIMS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// What one replay round did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Round {
    pub sent: usize,
    pub rejected: usize,
    /// Lines left because the control plane did not accept them now.
    pub left: usize,
}

/// One replay round of `queue`. Stops at the first line the control plane
/// does not accept for a reason that may pass (unreachable, 5xx, 429).
pub async fn replay_once(client: &ControlClient, queue: &Queue) -> Round {
    queue.enforce_cap();
    let mut round = Round::default();
    for path in queue.pending() {
        // Claim the file: new dead letters go to a new file.
        let claimed = if path.extension().is_some_and(|x| x == "replaying") {
            path.clone()
        } else {
            // A unique name: a later file of the same day must not
            // overwrite one already claimed.
            let n = CLAIMS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let c = path.with_extension(format!("{}-{n}.replaying", now_ms()));
            if std::fs::rename(&path, &c).is_err() {
                continue;
            }
            c
        };
        let Ok(bytes) = std::fs::read(&claimed) else {
            continue;
        };
        let lines: Vec<&[u8]> = bytes
            .split(|&c| c == b'\n')
            .filter(|l| !l.is_empty())
            .collect();
        let mut done = 0;
        let mut blocked = false;
        for line in &lines {
            let status = client
                .send(
                    Method::POST,
                    queue.endpoint,
                    Some(line.to_vec()),
                    &[],
                    CALL_TIMEOUT,
                )
                .await
                .map(|a| a.status);
            match status {
                Ok(s) if s.is_success() => round.sent += 1,
                Ok(s) if s.is_client_error() && s != StatusCode::TOO_MANY_REQUESTS => {
                    round.rejected += 1;
                    reject(queue, line);
                    tracing::error!(
                        queue = queue.name,
                        status = s.as_u16(),
                        "spooled batch refused; moved to rejected/"
                    );
                }
                _ => {
                    blocked = true;
                    break;
                }
            }
            done += 1;
        }
        let rest = &lines[done..];
        round.left += rest.len();
        if rest.is_empty() {
            let _ = std::fs::remove_file(&claimed);
        } else {
            let mut out = Vec::new();
            for l in rest {
                out.extend_from_slice(l);
                out.push(b'\n');
            }
            let _ = std::fs::write(&claimed, out);
        }
        if blocked {
            break;
        }
    }
    round
}

fn reject(queue: &Queue, line: &[u8]) {
    let dir = queue.dir.join("rejected");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{}.ndjson", now_ms())))
    {
        let _ = f.write_all(line);
        let _ = f.write_all(b"\n");
    }
}

/// Replays every queue until the worker stops: quickly while there is a
/// backlog and the control plane accepts, with backoff while it does not.
/// The backlog shows in `/healthz` as `spool_<name>`.
pub fn spawn_replayer(
    client: ControlClient,
    queues: Vec<Queue>,
    health: Arc<Health>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut backoff = MIN_BACKOFF;
        loop {
            let mut left = 0;
            let mut progressed = false;
            for q in &queues {
                let r = replay_once(&client, q).await;
                if r.sent > 0 {
                    tracing::info!(
                        queue = q.name,
                        sent = r.sent,
                        left = r.left,
                        "spool replayed"
                    );
                }
                progressed |= r.sent > 0 || r.rejected > 0;
                left += r.left;
                let component = if q.name == "meters" {
                    "spool_meters"
                } else {
                    "spool_logs"
                };
                if r.left > 0 {
                    health.degrade(component, format!("{} batches waiting", r.left));
                } else {
                    health.recover(component);
                }
            }
            backoff = if left == 0 || progressed {
                MIN_BACKOFF
            } else {
                (backoff * 2).min(MAX_BACKOFF)
            };
            tokio::time::sleep(backoff).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A replay round that cannot reach the control plane keeps every line,
    /// also when a later dead-letter file has the same name as one already
    /// claimed (the meter writes `<YYYY-MM-DD>.ndjson`).
    #[tokio::test]
    async fn unreachable_rounds_keep_every_line() {
        let dir = std::env::temp_dir().join(format!("renox-spool-unit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let q = Queue {
            name: "meters",
            dir: dir.clone(),
            endpoint: "/v1/ingest/meters",
        };
        let client = ControlClient::new(
            "http://127.0.0.1:1",
            &format!("renox_node_{}", "a".repeat(32)),
            "n1",
        )
        .unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("2026-10-28.ndjson"), "{\"a\":1}\n{\"a\":2}\n").unwrap();
        let r = replay_once(&client, &q).await;
        assert_eq!((r.sent, r.left), (0, 2));
        std::fs::write(dir.join("2026-10-28.ndjson"), "{\"a\":3}\n").unwrap();
        q.append(b"{\"a\":4}");
        let r = replay_once(&client, &q).await;
        assert_eq!(r.sent, 0);
        assert_eq!(q.pending_lines(), 4);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
