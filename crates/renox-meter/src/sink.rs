//! Sinks: where a batch goes (contract section 5).
//!
//! A sink persists a whole batch or fails. Retries and the dead-letter file sit
//! in front of every sink, in [`crate::Meter`], so no sink retries on its own.

use std::fmt;
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::record::MeterBatch;

/// Why a sink could not persist a batch.
#[derive(Debug)]
pub enum SinkError {
    Io(std::io::Error),
    Serialize(serde_json::Error),
    Other(String),
}

impl fmt::Display for SinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SinkError::Io(e) => write!(f, "meter sink i/o error: {e}"),
            SinkError::Serialize(e) => write!(f, "meter batch serialisation failed: {e}"),
            SinkError::Other(msg) => write!(f, "meter sink error: {msg}"),
        }
    }
}

impl std::error::Error for SinkError {}

impl From<std::io::Error> for SinkError {
    fn from(e: std::io::Error) -> Self {
        SinkError::Io(e)
    }
}

impl From<serde_json::Error> for SinkError {
    fn from(e: serde_json::Error) -> Self {
        SinkError::Serialize(e)
    }
}

/// Destination of meter batches.
pub trait Sink: Send + Sync + 'static {
    /// Persists the whole batch, or fails without a partial write the consumer
    /// could mistake for a complete batch. Called with retries by the meter.
    fn write_batch(&self, batch: &MeterBatch)
    -> impl Future<Output = Result<(), SinkError>> + Send;
}

/// Newline-delimited JSON, one batch envelope per line, appended to
/// `<dir>/<YYYY-MM-DD>.ndjson` (UTC date of the write) and `fsync`ed after each
/// append. Files are never rewritten.
#[derive(Debug, Clone)]
pub struct NdjsonFileSink {
    dir: PathBuf,
}

impl NdjsonFileSink {
    /// A sink writing date-named files directly under `dir`.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The contract layout: `<data_dir>/meters/<cell_id>/`.
    pub fn for_cell(data_dir: &Path, cell_id: &str) -> Self {
        Self::new(data_dir.join("meters").join(cell_id))
    }

    /// The dead-letter layout: `<data_dir>/meters/<cell_id>/dead/`.
    pub fn dead_letter_for_cell(data_dir: &Path, cell_id: &str) -> Self {
        Self::new(data_dir.join("meters").join(cell_id).join("dead"))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The file a write at `now` appends to.
    pub fn path_for(&self, now: SystemTime) -> PathBuf {
        self.dir.join(format!("{}.ndjson", utc_date(now)))
    }

    /// Blocking append of one already-serialised line.
    pub(crate) fn append_line_blocking(&self, line: &[u8]) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path_for(SystemTime::now()))?;
        file.write_all(line)?;
        file.sync_data()
    }
}

impl Sink for NdjsonFileSink {
    async fn write_batch(&self, batch: &MeterBatch) -> Result<(), SinkError> {
        let line = batch.to_ndjson_line()?;
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.append_line_blocking(&line))
            .await
            .map_err(|e| SinkError::Other(format!("file sink task failed: {e}")))??;
        Ok(())
    }
}

/// The same envelope line on standard output, for `renox dev`. Not durable.
#[derive(Debug, Clone, Copy, Default)]
pub struct StdoutSink;

impl Sink for StdoutSink {
    async fn write_batch(&self, batch: &MeterBatch) -> Result<(), SinkError> {
        let line = batch.to_ndjson_line()?;
        let mut out = std::io::stdout().lock();
        out.write_all(&line)?;
        out.flush()?;
        Ok(())
    }
}

/// `YYYY-MM-DD` of `t` in UTC (civil-from-days, H. Hinnant).
pub(crate) fn utc_date(t: SystemTime) -> String {
    let secs = t
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn utc_date_known_values() {
        let at = |secs| SystemTime::UNIX_EPOCH + Duration::from_secs(secs);
        assert_eq!(utc_date(at(0)), "1970-01-01");
        assert_eq!(utc_date(at(951_782_400)), "2000-02-29");
        assert_eq!(utc_date(at(1_793_318_400)), "2026-10-30");
        assert_eq!(utc_date(at(1_793_404_799)), "2026-10-30");
        assert_eq!(utc_date(at(1_793_404_800)), "2026-10-31");
    }
}
