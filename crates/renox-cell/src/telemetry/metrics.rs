//! Prometheus text for `GET /metrics` on the operator listener (#295).
//!
//! The family names are the ones `ops/observability/README.md` reserved
//! (#296), so its Grafana panels and alert rules read them as they are.
//! Request families are fed by the cell's meter records (one per request,
//! [`Metrics::request`]); the gauges are read at scrape time from the live
//! cells ([`Snapshot`]). Labels are ids and fixed words only: never a path,
//! a header, a query, or tenant text.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::Mutex;

/// Upper bounds of the request duration histogram, in seconds.
const REQUEST_BUCKETS: [f64; 10] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 10.0];
/// Upper bounds of the cold start histogram, in seconds.
const COLD_BUCKETS: [f64; 8] = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 5.0];

#[derive(Debug, Clone, Default)]
struct Histogram {
    counts: Vec<u64>,
    sum: f64,
    count: u64,
}

impl Histogram {
    fn observe(&mut self, bounds: &[f64], v: f64) {
        if self.counts.is_empty() {
            self.counts = vec![0; bounds.len()];
        }
        for (i, b) in bounds.iter().enumerate() {
            if v <= *b {
                self.counts[i] += 1;
            }
        }
        self.sum += v;
        self.count += 1;
    }

    fn write(&self, out: &mut String, name: &str, labels: &str, bounds: &[f64]) {
        let sep = if labels.is_empty() { "" } else { "," };
        for (i, b) in bounds.iter().enumerate() {
            let n = self.counts.get(i).copied().unwrap_or(0);
            let _ = writeln!(out, "{name}_bucket{{{labels}{sep}le=\"{b}\"}} {n}");
        }
        let _ = writeln!(
            out,
            "{name}_bucket{{{labels}{sep}le=\"+Inf\"}} {}",
            self.count
        );
        let braces = if labels.is_empty() {
            String::new()
        } else {
            format!("{{{labels}}}")
        };
        let _ = writeln!(out, "{name}_sum{braces} {}", self.sum);
        let _ = writeln!(out, "{name}_count{braces} {}", self.count);
    }
}

#[derive(Debug, Clone, Default)]
struct Tenant {
    /// status class (`2xx`, `4xx`, `5xx`, …) → requests.
    requests: BTreeMap<&'static str, u64>,
    duration: Histogram,
    cpu_seconds: f64,
    heap_bytes: u64,
    cold_starts: u64,
}

/// The counters fed by the cell. Cheap to share (`Arc`).
#[derive(Debug, Default)]
pub struct Metrics {
    tenants: Mutex<BTreeMap<String, Tenant>>,
    cold: Mutex<Histogram>,
}

fn status_class(status: u16) -> &'static str {
    match status {
        100..=199 => "1xx",
        200..=299 => "2xx",
        300..=399 => "3xx",
        400..=499 => "4xx",
        _ => "5xx",
    }
}

/// Gauges read from the live cells at scrape time.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    /// Live cells of this node.
    pub cells: usize,
    /// tenant → outbox (pending deliveries, age of the oldest in seconds,
    /// dead letters).
    pub outbox: BTreeMap<String, (u64, f64, u64)>,
    /// tenant → (live realtime connections, messages delivered so far).
    pub realtime: BTreeMap<String, (usize, u64)>,
    /// tenant → authorization decisions, principal cache hits and misses.
    pub authz: BTreeMap<String, (u64, u64, u64)>,
    /// Disk: used ratio (0–1) and level (0 ok, 1 warn, 2 no new cells, 3 no writes).
    pub disk: Option<(f64, u8)>,
    /// Degraded components (`/healthz` reasons).
    pub degraded: Vec<String>,
}

fn esc(v: &str) -> String {
    v.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

impl Metrics {
    /// One request's meter record.
    pub fn request(&self, tenant: &str, http_status: u16, wall_ms: f64, cpu_ms: f64, heap: u64) {
        let mut t = self.tenants.lock().expect("metrics lock");
        let t = t.entry(tenant.to_string()).or_default();
        *t.requests.entry(status_class(http_status)).or_default() += 1;
        t.duration.observe(&REQUEST_BUCKETS, wall_ms / 1000.0);
        t.cpu_seconds += cpu_ms / 1000.0;
        t.heap_bytes = heap;
    }

    /// One cell created for `tenant` in `ms`.
    pub fn cold_start(&self, tenant: &str, ms: f64) {
        self.tenants
            .lock()
            .expect("metrics lock")
            .entry(tenant.to_string())
            .or_default()
            .cold_starts += 1;
        self.cold
            .lock()
            .expect("metrics lock")
            .observe(&COLD_BUCKETS, ms / 1000.0);
    }

    /// The Prometheus text exposition (version 0.0.4).
    pub fn render(&self, s: &Snapshot) -> String {
        let mut out = String::new();
        let tenants = self.tenants.lock().expect("metrics lock").clone();
        let family = |out: &mut String, name: &str, kind: &str, help: &str| {
            let _ = writeln!(out, "# HELP {name} {help}");
            let _ = writeln!(out, "# TYPE {name} {kind}");
        };
        family(
            &mut out,
            "renox_worker_requests_total",
            "counter",
            "Requests by tenant and status class.",
        );
        for (id, t) in &tenants {
            for (class, n) in &t.requests {
                let _ = writeln!(
                    out,
                    "renox_worker_requests_total{{tenant_id=\"{}\",status_class=\"{class}\"}} {n}",
                    esc(id)
                );
            }
        }
        family(
            &mut out,
            "renox_worker_request_duration_seconds",
            "histogram",
            "Request wall time.",
        );
        for (id, t) in &tenants {
            if t.duration.count > 0 {
                t.duration.write(
                    &mut out,
                    "renox_worker_request_duration_seconds",
                    &format!("tenant_id=\"{}\"", esc(id)),
                    &REQUEST_BUCKETS,
                );
            }
        }
        family(
            &mut out,
            "renox_worker_cpu_seconds_total",
            "counter",
            "Isolate CPU time.",
        );
        for (id, t) in &tenants {
            let _ = writeln!(
                out,
                "renox_worker_cpu_seconds_total{{tenant_id=\"{}\"}} {}",
                esc(id),
                t.cpu_seconds
            );
        }
        family(
            &mut out,
            "renox_worker_heap_bytes",
            "gauge",
            "Peak heap of the tenant's last request.",
        );
        for (id, t) in &tenants {
            let _ = writeln!(
                out,
                "renox_worker_heap_bytes{{tenant_id=\"{}\"}} {}",
                esc(id),
                t.heap_bytes
            );
        }
        family(
            &mut out,
            "renox_worker_cold_starts_total",
            "counter",
            "Cells created.",
        );
        for (id, t) in &tenants {
            let _ = writeln!(
                out,
                "renox_worker_cold_starts_total{{tenant_id=\"{}\"}} {}",
                esc(id),
                t.cold_starts
            );
        }
        family(
            &mut out,
            "renox_worker_cold_start_duration_seconds",
            "histogram",
            "Cell creation time.",
        );
        self.cold.lock().expect("metrics lock").write(
            &mut out,
            "renox_worker_cold_start_duration_seconds",
            "",
            &COLD_BUCKETS,
        );
        family(
            &mut out,
            "renox_worker_cells",
            "gauge",
            "Live cells on this node.",
        );
        let _ = writeln!(out, "renox_worker_cells {}", s.cells);
        family(
            &mut out,
            "renox_worker_outbox_pending",
            "gauge",
            "Pending outbox deliveries.",
        );
        for (id, (n, _, _)) in &s.outbox {
            let _ = writeln!(
                out,
                "renox_worker_outbox_pending{{tenant_id=\"{}\"}} {n}",
                esc(id)
            );
        }
        family(
            &mut out,
            "renox_worker_outbox_oldest_age_seconds",
            "gauge",
            "Age of the oldest pending outbox delivery.",
        );
        for (id, (_, age, _)) in &s.outbox {
            let _ = writeln!(
                out,
                "renox_worker_outbox_oldest_age_seconds{{tenant_id=\"{}\"}} {age}",
                esc(id)
            );
        }
        family(
            &mut out,
            "renox_worker_dead_letters_total",
            "counter",
            "Dead-lettered outbox deliveries kept.",
        );
        for (id, (_, _, dead)) in &s.outbox {
            let _ = writeln!(
                out,
                "renox_worker_dead_letters_total{{tenant_id=\"{}\"}} {dead}",
                esc(id)
            );
        }
        // #297: the scheduler and job runs of this node.
        {
            use std::sync::atomic::Ordering::Relaxed;
            for (name, kind, help, value) in [
                (
                    "renox_worker_job_runs_total",
                    "counter",
                    "Job attempts started.",
                    crate::scheduler::RUNS.load(Relaxed) as f64,
                ),
                (
                    "renox_worker_job_failures_total",
                    "counter",
                    "Job attempts that failed.",
                    crate::scheduler::FAILURES.load(Relaxed) as f64,
                ),
                (
                    "renox_worker_job_ticks_total",
                    "counter",
                    "Scheduled ticks written (rows added or coalesced).",
                    crate::scheduler::TICKS.load(Relaxed) as f64,
                ),
                (
                    "renox_worker_job_lag_seconds",
                    "gauge",
                    "Start of the last scheduled run minus its tick.",
                    crate::scheduler::LAST_LAG_MS.load(Relaxed) as f64 / 1000.0,
                ),
            ] {
                family(&mut out, name, kind, help);
                let _ = writeln!(out, "{name} {value}");
            }
        }
        family(
            &mut out,
            "renox_worker_realtime_connections",
            "gauge",
            "Open WebSocket and SSE connections.",
        );
        for (id, (live, _)) in &s.realtime {
            let _ = writeln!(
                out,
                "renox_worker_realtime_connections{{tenant_id=\"{}\"}} {live}",
                esc(id)
            );
        }
        family(
            &mut out,
            "renox_worker_realtime_messages_total",
            "counter",
            "Realtime messages delivered.",
        );
        for (id, (_, msgs)) in &s.realtime {
            let _ = writeln!(
                out,
                "renox_worker_realtime_messages_total{{tenant_id=\"{}\"}} {msgs}",
                esc(id)
            );
        }
        // `decision` is `all` until the engine counts allows and denies apart.
        family(
            &mut out,
            "renox_worker_authz_decisions_total",
            "counter",
            "Authorization decisions of the live cells.",
        );
        for (id, (n, _, _)) in &s.authz {
            let _ = writeln!(
                out,
                "renox_worker_authz_decisions_total{{tenant_id=\"{}\",decision=\"all\"}} {n}",
                esc(id)
            );
        }
        family(
            &mut out,
            "renox_worker_authz_principal_cache_total",
            "counter",
            "Principal cache lookups by result.",
        );
        for (id, (_, hits, misses)) in &s.authz {
            let _ = writeln!(
                out,
                "renox_worker_authz_principal_cache_total{{tenant_id=\"{}\",result=\"hit\"}} {hits}",
                esc(id)
            );
            let _ = writeln!(
                out,
                "renox_worker_authz_principal_cache_total{{tenant_id=\"{}\",result=\"miss\"}} {misses}",
                esc(id)
            );
        }
        if let Some((ratio, level)) = s.disk {
            family(
                &mut out,
                "renox_worker_disk_used_ratio",
                "gauge",
                "Used share of the data directory's file system.",
            );
            let _ = writeln!(out, "renox_worker_disk_used_ratio {ratio}");
            family(
                &mut out,
                "renox_worker_disk_level",
                "gauge",
                "Disk level: 0 ok, 1 warn, 2 no new cells, 3 no writes.",
            );
            let _ = writeln!(out, "renox_worker_disk_level {level}");
        }
        family(
            &mut out,
            "renox_worker_degraded",
            "gauge",
            "1 for each degraded component.",
        );
        for c in &s.degraded {
            let component = c.split(':').next().unwrap_or(c).trim();
            let _ = writeln!(
                out,
                "renox_worker_degraded{{component=\"{}\"}} 1",
                esc(component)
            );
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_fill_the_families_and_the_histogram_is_cumulative() {
        let m = Metrics::default();
        m.request("t_a", 200, 3.0, 1.5, 1000);
        m.request("t_a", 503, 300.0, 0.5, 2000);
        m.cold_start("t_a", 40.0);
        let text = m.render(&Snapshot {
            cells: 1,
            disk: Some((0.5, 0)),
            degraded: vec!["disk: warn 81% used".into()],
            ..Snapshot::default()
        });
        assert!(
            text.contains("renox_worker_requests_total{tenant_id=\"t_a\",status_class=\"2xx\"} 1"),
            "{text}"
        );
        assert!(
            text.contains("renox_worker_requests_total{tenant_id=\"t_a\",status_class=\"5xx\"} 1")
        );
        assert!(text.contains(
            "renox_worker_request_duration_seconds_bucket{tenant_id=\"t_a\",le=\"0.005\"} 1"
        ));
        assert!(text.contains(
            "renox_worker_request_duration_seconds_bucket{tenant_id=\"t_a\",le=\"0.5\"} 2"
        ));
        assert!(text.contains("renox_worker_request_duration_seconds_count{tenant_id=\"t_a\"} 2"));
        assert!(text.contains("renox_worker_cpu_seconds_total{tenant_id=\"t_a\"} 0.002"));
        assert!(text.contains("renox_worker_cold_starts_total{tenant_id=\"t_a\"} 1"));
        assert!(text.contains("renox_worker_cold_start_duration_seconds_count 1"));
        assert!(text.contains("renox_worker_cells 1"));
        assert!(text.contains("renox_worker_degraded{component=\"disk\"} 1"));
    }
}
