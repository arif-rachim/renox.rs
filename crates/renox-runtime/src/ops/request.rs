//! Request scope for ops (`docs/contracts/ops.md` section 0, "Request
//! scope"): the table of live request tokens of one isolate, kept in its
//! `OpState`, and the deadline op (section 5).
//!
//! The token is carried by the dispatch wrapper's async context
//! (`js/bootstrap.js`, `requestVar`) and handed to each op by the bootstrap's
//! private wrappers. Tenant code cannot reach the ops (they are captured in
//! the bootstrap's closures and `Deno.core` is removed), so it cannot pass a
//! token of its own; and a token that is not live is refused.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use deno_core::anyhow::anyhow;
use deno_core::error::AnyError;
use deno_core::{CancelHandle, OpState, ResourceId, op2};

use crate::ops::fetch::EgressCounter;

/// Build an op error the bootstrap turns into a `RenoxError`
/// (`js/bootstrap.js`, `toRenoxError`): `CODE|details-json|message`.
pub(crate) fn op_error(code: &str, details: serde_json::Value, message: &str) -> AnyError {
    anyhow!("{code}|{details}|{message}")
}

pub(crate) fn no_request() -> AnyError {
    op_error(
        "RENOX_NO_REQUEST",
        serde_json::Value::Null,
        "No request is in progress for this call.",
    )
}

/// Per-request state the ops need. Lives from dispatch until the request
/// ends for any reason.
pub(crate) struct RequestState {
    pub request_id: String,
    pub deadline: Instant,
    /// Cancels every pending op of the request (deadline, CPU, OOM).
    pub cancel: Rc<CancelHandle>,
    /// `ops.md` section 2: bytes sent + received over all fetches.
    pub egress: Arc<EgressCounter>,
    /// Fetches refused with `RENOX_FETCH_BLOCKED`, caught or not.
    pub fetch_blocked: u64,
    pub fetches_in_flight: u32,
    /// Response bodies still open; closed when the request ends.
    pub fetch_bodies: Vec<ResourceId>,
}

impl RequestState {
    pub fn new(request_id: String, deadline: Instant, egress_limit_bytes: u64) -> RequestState {
        RequestState {
            request_id,
            deadline,
            cancel: CancelHandle::new_rc(),
            egress: Arc::new(EgressCounter::new(egress_limit_bytes)),
            fetch_blocked: 0,
            fetches_in_flight: 0,
            fetch_bodies: Vec::new(),
        }
    }
}

/// Live request tokens of one isolate.
#[derive(Default)]
pub(crate) struct RequestTable {
    next: u32,
    live: HashMap<u32, Rc<RefCell<RequestState>>>,
}

impl RequestTable {
    /// Register a request and return its token (never 0: 0 means "no request").
    pub fn begin(&mut self, state: RequestState) -> u32 {
        loop {
            self.next = self.next.wrapping_add(1);
            if self.next != 0 && !self.live.contains_key(&self.next) {
                break;
            }
        }
        self.live.insert(self.next, Rc::new(RefCell::new(state)));
        self.next
    }

    /// End a request: the token stops working and its pending ops are cancelled.
    pub fn end(&mut self, token: u32) -> Option<Rc<RefCell<RequestState>>> {
        let state = self.live.remove(&token)?;
        state.borrow().cancel.cancel();
        Some(state)
    }

    pub fn get(&self, token: u32) -> Option<Rc<RefCell<RequestState>>> {
        self.live.get(&token).cloned()
    }
}

/// Look up a live request or fail with `RENOX_NO_REQUEST`.
pub(crate) fn live_request(
    state: &OpState,
    token: u32,
) -> Result<Rc<RefCell<RequestState>>, AnyError> {
    state
        .borrow::<RequestTable>()
        .get(token)
        .ok_or_else(no_request)
}

/// `op_deadline_remaining_ms` (ops.md section 5): whole milliseconds left
/// before the request's wall-clock deadline, >= 0.
#[op2(fast)]
pub(crate) fn op_deadline_remaining_ms(state: &mut OpState, token: u32) -> Result<f64, AnyError> {
    let req = live_request(state, token)?;
    let left = req
        .borrow()
        .deadline
        .saturating_duration_since(Instant::now());
    Ok(left.as_millis() as f64)
}
