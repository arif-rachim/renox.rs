//! Logging (`docs/contracts/ops.md` section 4): `op_log` behind `ctx.log`
//! and `console.*`, the per-tenant rate limit, size limits, reserved field
//! names, and the ndjson sink.
//!
//! Every line written for a tenant passes through [`RedactingSink`], so
//! secret values are replaced whatever produced the line: `op_log`, the
//! dispatch wrapper's error lines (message and stack of a throw), or the
//! fetch op's blocked-attempt lines.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Message limit (bytes).
pub const MAX_MESSAGE_BYTES: usize = 8 * 1024;
/// Serialized fields limit (bytes).
pub const MAX_FIELDS_BYTES: usize = 16 * 1024;
/// Rate-limit window.
pub const WINDOW: Duration = Duration::from_secs(60);

/// Top-level names Rust sets; tenant fields with these names are moved to
/// `user_<name>` so tenant code cannot spoof them.
pub const RESERVED_FIELDS: &[&str] = &[
    "ts",
    "tenant_id",
    "deployment_hash",
    "request_id",
    "module",
    "level",
];

/// Cut `s` to at most `max` bytes on a character boundary and append
/// `…[truncated N bytes]`.
pub fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated {} bytes]", &s[..end], s.len() - end)
}

/// Rename reserved names and apply the fields size limit.
pub fn clean_fields(
    fields: serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    for (k, v) in fields {
        let k = if RESERVED_FIELDS.contains(&k.as_str()) {
            format!("user_{k}")
        } else {
            k
        };
        out.insert(k, v);
    }
    let text = serde_json::Value::Object(out.clone()).to_string();
    if text.len() <= MAX_FIELDS_BYTES {
        return out;
    }
    let mut cut = serde_json::Map::new();
    cut.insert(
        "truncated_fields".into(),
        truncate(&text, MAX_FIELDS_BYTES).into(),
    );
    cut
}

/// Normalise a level name; anything unknown is `info`.
pub fn level(name: &str) -> &'static str {
    match name {
        "debug" => "debug",
        "warn" => "warn",
        "error" => "error",
        _ => "info",
    }
}

/// What the rate limiter decided for one line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admit {
    /// Write the line; `dropped` lines were dropped in the window that just
    /// ended, and one summary line `{"dropped": N}` is written first.
    Write {
        dropped: u64,
    },
    Drop,
}

#[derive(Debug)]
struct Window {
    start: Instant,
    count: u64,
    dropped: u64,
}

/// Lines per tenant per minute (1,000 free / 10,000 paid). Over the limit
/// lines are dropped, not queued. Shared by every isolate of the process,
/// keyed by tenant.
#[derive(Debug, Default)]
pub struct LogLimiter {
    windows: Mutex<HashMap<String, Window>>,
}

impl LogLimiter {
    pub fn admit(&self, tenant: &str, limit: u64, now: Instant) -> Admit {
        let mut w = self.windows.lock().expect("log limiter lock");
        let win = w.entry(tenant.to_string()).or_insert(Window {
            start: now,
            count: 0,
            dropped: 0,
        });
        let mut dropped = 0;
        if now.duration_since(win.start) >= WINDOW {
            dropped = win.dropped;
            *win = Window {
                start: now,
                count: 0,
                dropped: 0,
            };
        }
        if win.count >= limit {
            win.dropped += 1;
            return Admit::Drop;
        }
        win.count += 1;
        Admit::Write { dropped }
    }
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for a Unix time in milliseconds.
pub fn rfc3339_ms(unix_ms: u64) -> String {
    let secs = unix_ms / 1000;
    let ms = unix_ms % 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil from days (H. Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

#[cfg(feature = "v8")]
pub use v8_sinks::*;

#[cfg(feature = "v8")]
mod v8_sinks {
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::rfc3339_ms;
    use crate::ops::secrets::Redactor;
    use crate::runtime::{LogLine, LogSink};

    /// Redacts the isolate's secret values from every line before passing
    /// it on (`ops.md` section 3, "Redaction").
    pub struct RedactingSink {
        pub inner: Arc<dyn LogSink>,
        pub redactor: Arc<Redactor>,
    }

    impl LogSink for RedactingSink {
        fn log(&self, mut line: LogLine) {
            if !self.redactor.is_empty() {
                line.message = self.redactor.redact(&line.message).into_owned();
                self.redactor.redact_map(&mut line.fields);
                if let Some(id) = &line.request_id {
                    line.request_id = Some(self.redactor.redact(id).into_owned());
                }
            }
            self.inner.log(line);
        }
    }

    /// One JSON object per line: `ts`, `level`, `tenant_id`,
    /// `deployment_hash`, `request_id`, `module`, `message`, `fields`. To
    /// stdout or any writer (the worker's log file). The control-plane sink
    /// is F3.
    pub struct NdjsonLogSink {
        out: Mutex<Box<dyn Write + Send>>,
    }

    impl NdjsonLogSink {
        pub fn new(out: Box<dyn Write + Send>) -> NdjsonLogSink {
            NdjsonLogSink {
                out: Mutex::new(out),
            }
        }

        pub fn stdout() -> NdjsonLogSink {
            NdjsonLogSink::new(Box::new(std::io::stdout()))
        }

        /// The JSON object of one line.
        pub fn render(line: &LogLine) -> serde_json::Value {
            let ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            serde_json::json!({
                "ts": rfc3339_ms(ms),
                "level": line.level,
                "tenant_id": line.tenant_id,
                "deployment_hash": line.deployment_hash,
                "request_id": line.request_id,
                // F1 runs only the app's own code (module `app`).
                "module": "app",
                "message": line.message,
                "fields": line.fields,
            })
        }
    }

    impl LogSink for NdjsonLogSink {
        fn log(&self, line: LogLine) {
            let mut text = Self::render(&line).to_string();
            text.push('\n');
            let mut out = self.out.lock().expect("log sink lock");
            let _ = out.write_all(text.as_bytes());
            let _ = out.flush();
        }
    }
}

#[cfg(feature = "v8")]
pub(crate) use v8_ops::*;

#[cfg(feature = "v8")]
mod v8_ops {
    use std::sync::Arc;
    use std::time::Instant;

    use deno_core::{OpState, op2};

    use super::*;
    use crate::ops::request::RequestTable;
    use crate::runtime::{LogLine, LogSink};

    /// The logging environment of one isolate.
    pub(crate) struct LogEnv {
        /// Already redacting.
        pub sink: Arc<dyn LogSink>,
        pub limiter: Arc<LogLimiter>,
        pub tenant_id: String,
        pub deployment_hash: String,
        pub lines_per_min: u64,
    }

    /// `op_log`: never throws. Outside a request (`token` 0 or not live) the
    /// line has `request_id: null`.
    #[op2]
    pub(crate) fn op_log(
        state: &mut OpState,
        token: u32,
        #[string] level_name: &str,
        #[string] message: &str,
        #[serde] fields: Option<serde_json::Map<String, serde_json::Value>>,
    ) {
        let request = state.borrow::<RequestTable>().get(token);
        let env = state.borrow::<LogEnv>();
        let line = |level: &'static str, message: String, fields| LogLine {
            level,
            tenant_id: env.tenant_id.clone(),
            deployment_hash: env.deployment_hash.clone(),
            request_id: request.as_ref().map(|r| r.borrow().request_id.clone()),
            message,
            fields,
        };
        match env
            .limiter
            .admit(&env.tenant_id, env.lines_per_min, Instant::now())
        {
            Admit::Drop => {
                if let Some(r) = &request {
                    r.borrow_mut().logs_dropped += 1;
                }
            }
            Admit::Write { dropped } => {
                if dropped > 0 {
                    let mut f = serde_json::Map::new();
                    f.insert("dropped".into(), dropped.into());
                    env.sink.log(line(
                        "warn",
                        "log lines dropped by the rate limit".into(),
                        f,
                    ));
                }
                let mut fields = clean_fields(fields.unwrap_or_default());
                // #295: the line names its request's trace, when exported.
                if let Some(t) = request
                    .as_ref()
                    .and_then(|r| crate::trace::trace_id(&r.borrow().request_id))
                {
                    fields.insert("trace_id".into(), t.into());
                }
                env.sink.log(line(
                    level(level_name),
                    truncate(message, MAX_MESSAGE_BYTES),
                    fields,
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_keeps_char_boundaries() {
        let s = "é".repeat(10);
        let t = truncate(&s, 5);
        assert!(t.starts_with("éé"));
        assert!(t.ends_with("…[truncated 16 bytes]"));
        assert_eq!(truncate("short", 10), "short");
    }

    #[test]
    fn reserved_fields_are_moved() {
        let mut m = serde_json::Map::new();
        m.insert("tenant_id".into(), "spoof".into());
        m.insert("ok".into(), 1.into());
        let c = clean_fields(m);
        assert_eq!(c["user_tenant_id"], "spoof");
        assert!(!c.contains_key("tenant_id"));
        assert_eq!(c["ok"], 1);
    }

    #[test]
    fn large_fields_are_truncated() {
        let mut m = serde_json::Map::new();
        m.insert("big".into(), "x".repeat(MAX_FIELDS_BYTES * 2).into());
        let c = clean_fields(m);
        let t = c["truncated_fields"].as_str().unwrap();
        assert!(t.contains("…[truncated "));
    }

    /// `ops.md` section 4: over the limit lines are dropped; the window
    /// reset reports how many.
    #[test]
    fn rate_limit_drops_then_reports() {
        let l = LogLimiter::default();
        let t0 = Instant::now();
        for _ in 0..3 {
            assert_eq!(l.admit("t", 3, t0), Admit::Write { dropped: 0 });
        }
        assert_eq!(l.admit("t", 3, t0), Admit::Drop);
        assert_eq!(l.admit("t", 3, t0), Admit::Drop);
        assert_eq!(l.admit("other", 3, t0), Admit::Write { dropped: 0 });
        assert_eq!(l.admit("t", 3, t0 + WINDOW), Admit::Write { dropped: 2 });
    }

    #[test]
    fn timestamps_are_rfc3339() {
        assert_eq!(rfc3339_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339_ms(1_793_059_200_123), "2026-10-27T00:00:00.123Z");
    }
}
