//! Batching, timer flush, retry, dead-letter, and back-pressure tests for
//! `renox_meter::Meter` (docs/contracts/meter.md sections 3 and 4).

mod common;

use std::time::Duration;

use common::{FailingSink, MemorySink, record};
use renox_meter::{Meter, MeterBatch, MeterConfig, NdjsonFileSink};

fn config(dir: &std::path::Path) -> MeterConfig {
    let mut c = MeterConfig::new("t_notes@node-dxb-01", "node-dxb-01", dir);
    c.retry_backoff = Duration::from_millis(100);
    c
}

#[tokio::test]
async fn ten_thousand_records_make_exactly_ten_batches_of_one_thousand() {
    let dir = tempfile::tempdir().unwrap();
    let sink = MemorySink::default();
    let meter = Meter::start(config(dir.path()), sink.clone());
    for n in 0..10_000 {
        meter.record(record(n));
    }
    meter.flush_and_close().await;
    assert_eq!(meter.dropped(), 0);
    assert_eq!(sink.sizes(), vec![1_000; 10]);
    let batches = sink.batches.lock().unwrap();
    let ids: std::collections::HashSet<_> = batches
        .iter()
        .flat_map(|b| b.records.iter().map(|r| r.request_id.clone()))
        .collect();
    assert_eq!(ids.len(), 10_000, "every record delivered exactly once");
    assert!(
        batches
            .iter()
            .all(|b| b.schema_version == 0 && b.cell_id == "t_notes@node-dxb-01")
    );
}

#[tokio::test(start_paused = true)]
async fn timer_flushes_a_partial_batch_five_seconds_after_the_first_record() {
    let dir = tempfile::tempdir().unwrap();
    let sink = MemorySink::default();
    let meter = Meter::start(config(dir.path()), sink.clone());
    meter.record(record(1));
    tokio::time::sleep(Duration::from_secs(2)).await;
    meter.record(record(2));
    meter.record(record(3));
    tokio::time::sleep(Duration::from_millis(2_900)).await;
    assert!(sink.sizes().is_empty(), "no flush before 5 s");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        sink.sizes(),
        vec![3],
        "one partial batch at 5 s after the first record"
    );
    // An idle meter writes no empty batch.
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert_eq!(sink.sizes(), vec![3]);
    meter.flush_and_close().await;
    assert_eq!(sink.sizes(), vec![3]);
}

/// Proves `docs/23-failure-modes.md` row "Meter batch cannot be shipped":
/// sink retry exhausted → dead-letter file on disk, nothing silently lost.
#[tokio::test(start_paused = true)]
async fn failing_sink_is_retried_three_times_then_batch_goes_to_dead_letter() {
    let dir = tempfile::tempdir().unwrap();
    let sink = FailingSink::default();
    let meter = Meter::start(config(dir.path()), sink.clone());
    meter.record(record(7));
    meter.record(record(8));
    meter.flush_and_close().await;

    assert_eq!(sink.attempts(), 3);
    let at = sink.at.lock().unwrap().clone();
    assert_eq!(at[1] - at[0], Duration::from_millis(100), "first backoff");
    assert_eq!(at[2] - at[1], Duration::from_millis(200), "backoff doubles");
    assert_eq!(meter.batches_written(), 0);
    assert_eq!(meter.batches_dead_lettered(), 1);
    assert_eq!(meter.batches_lost(), 0);

    let dead = dir.path().join("meters/t_notes@node-dxb-01/dead");
    let files: Vec<_> = std::fs::read_dir(&dead)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1);
    assert!(files[0].to_string_lossy().ends_with(".ndjson"));
    let text = std::fs::read_to_string(&files[0]).unwrap();
    let lines: Vec<_> = text.lines().collect();
    assert_eq!(lines.len(), 1, "one batch, one line");
    let batch: MeterBatch = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(batch.records, vec![rounded(record(7)), rounded(record(8))]);
}

#[tokio::test(flavor = "current_thread")]
async fn record_never_blocks_when_the_channel_is_full() {
    let dir = tempfile::tempdir().unwrap();
    let sink = MemorySink::default();
    let mut c = config(dir.path());
    c.channel_capacity = 4;
    let meter = Meter::start(c, sink.clone());
    // On a current-thread runtime the batching task cannot run until this test
    // yields, so the channel is full after 4 records and stays full.
    let started = std::time::Instant::now();
    for n in 0..10_000 {
        meter.record(record(n));
    }
    let elapsed = started.elapsed();
    assert_eq!(meter.dropped(), 9_996);
    assert!(
        elapsed < Duration::from_secs(2),
        "record() returned without waiting: {elapsed:?}"
    );
    meter.flush_and_close().await;
    assert_eq!(sink.sizes(), vec![4]);
}

#[tokio::test]
async fn flush_and_close_drains_queued_records_and_rejects_later_ones() {
    let dir = tempfile::tempdir().unwrap();
    let sink = MemorySink::default();
    let meter = Meter::start(config(dir.path()), sink.clone());
    for n in 0..1_500 {
        meter.record(record(n));
    }
    meter.flush_and_close().await;
    assert_eq!(sink.sizes(), vec![1_000, 500]);
    meter.record(record(99_999));
    assert_eq!(
        meter.dropped(),
        1,
        "a closed meter counts late records as dropped"
    );
    meter.flush_and_close().await;
    assert_eq!(sink.sizes(), vec![1_000, 500]);
}

#[tokio::test]
async fn file_sink_appends_one_line_per_batch_in_the_contract_layout() {
    let dir = tempfile::tempdir().unwrap();
    let sink = NdjsonFileSink::for_cell(dir.path(), "t_notes@node-dxb-01");
    let mut c = config(dir.path());
    c.max_batch = 2;
    let meter = Meter::start(c, sink.clone());
    for n in 0..5 {
        meter.record(record(n));
    }
    meter.flush_and_close().await;

    let path = sink.path_for(std::time::SystemTime::now());
    assert!(path.starts_with(dir.path().join("meters/t_notes@node-dxb-01")));
    let text = std::fs::read_to_string(&path).unwrap();
    let sizes: Vec<_> = text
        .lines()
        .map(|l| serde_json::from_str::<MeterBatch>(l).unwrap().records.len())
        .collect();
    assert_eq!(sizes, vec![2, 2, 1]);
    assert!(!dir.path().join("meters/t_notes@node-dxb-01/dead").exists());
}

fn rounded(mut r: renox_meter::MeterRecord) -> renox_meter::MeterRecord {
    r.cpu_ms = renox_meter::round_millis(r.cpu_ms);
    r.wall_ms = renox_meter::round_millis(r.wall_ms);
    r.db_ms = renox_meter::round_millis(r.db_ms);
    r
}
