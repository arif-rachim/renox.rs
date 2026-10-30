//! The request's span on the isolate and DB threads (#295).
//!
//! The cell enters `cell.request` (and the handler span under it) on a tokio
//! task, but tenant code runs on the isolate's own thread and statements on
//! the DB thread, where no span is entered. So the cell registers, for each
//! request id, the span the platform's spans of that request should hang
//! under and its OpenTelemetry trace id; the ops look them up by the
//! request's id: `db.query`, `fetch` and `module.service` become children of
//! the request, and tenant `op_log` lines carry `trace_id`. The registration
//! is removed when the guard drops (the dispatch ended).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

struct Entry {
    span: tracing::Span,
    trace_id: Option<String>,
}

static PARENTS: LazyLock<Mutex<HashMap<String, Entry>>> = LazyLock::new(Mutex::default);

/// Removes the registration of a request when dropped.
pub struct Registered(String);

impl Drop for Registered {
    fn drop(&mut self) {
        PARENTS.lock().expect("trace lock").remove(&self.0);
    }
}

/// Registers `span` (and its exported trace id, if any) as the parent of the
/// platform spans of `request_id` until the guard drops.
pub fn register(request_id: &str, span: tracing::Span, trace_id: Option<String>) -> Registered {
    PARENTS
        .lock()
        .expect("trace lock")
        .insert(request_id.to_string(), Entry { span, trace_id });
    Registered(request_id.to_string())
}

/// The registered parent span of `request_id`, or `Span::none()`.
pub fn parent(request_id: &str) -> tracing::Span {
    PARENTS
        .lock()
        .expect("trace lock")
        .get(request_id)
        .map_or_else(tracing::Span::none, |e| e.span.clone())
}

/// The trace id of `request_id`, when its trace is exported.
pub fn trace_id(request_id: &str) -> Option<String> {
    PARENTS
        .lock()
        .expect("trace lock")
        .get(request_id)
        .and_then(|e| e.trace_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registration_lasts_as_long_as_its_guard() {
        let g = register("req_1", tracing::Span::none(), Some("ab".repeat(16)));
        assert_eq!(
            trace_id("req_1").as_deref(),
            Some("abababababababababababababababab")
        );
        drop(g);
        assert_eq!(trace_id("req_1"), None);
        assert!(parent("req_1").is_none());
    }
}
