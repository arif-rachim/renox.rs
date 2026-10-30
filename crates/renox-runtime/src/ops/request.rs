//! Request scope for ops (`docs/contracts/ops.md` section 0, "Request
//! scope"): the table of live request tokens of one isolate, kept in its
//! `OpState`.
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

use deno_core::{CancelHandle, OpState};
use deno_error::JsErrorBox;

use crate::ops::fetch_connector::EgressCounter;
use crate::request_resources::RequestResources;

/// Build an op error the bootstrap turns into a `RenoxError`
/// (`js/bootstrap.js`, `toRenoxError`): `CODE|details-json|message`.
pub(crate) fn op_error(code: &str, details: serde_json::Value, message: &str) -> JsErrorBox {
    JsErrorBox::generic(format!("{code}|{details}|{message}"))
}

pub(crate) fn no_request() -> JsErrorBox {
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
    /// Response bodies currently open (each holds a connection); shared
    /// with the body resources, which decrement it when they close.
    pub open_bodies: Rc<std::cell::Cell<u32>>,
    /// Open transaction and fetch bodies, released when the request ends
    /// for any reason (`request_resources.rs`).
    pub resources: RequestResources,
    /// `db_ms` and `db_rows` of the meter record.
    pub db_ms: f64,
    pub db_rows: u64,
    /// `logs_dropped` of the meter record.
    pub logs_dropped: u64,
    /// A statement found the file damaged (`SQLITE_CORRUPT`, `SQLITE_NOTADB`;
    /// #311): the cell answers 503 and restores the file.
    pub db_corrupt: bool,
    /// `render_fuel` / `render_ms` of realtime `fragment` payloads the
    /// request published (ops.md 1.5.0 section 18).
    pub render_fuel: u64,
    pub render_ms: f64,
    /// Set when the request ends; an op still holding the state sees it.
    pub ended: bool,
    /// `isolate` mode (ops.md 1.7.0 section 15.6): the open transaction is
    /// the caller's, lent to this cross-isolate call; it is not rolled back
    /// when the call ends.
    pub tx_borrowed: bool,
    /// CPU the callees in other isolates used for this request (`op_modules_call`).
    pub cross_cpu_ms: f64,
    /// ops.md 1.7.0 section 21: the tenant's stored bytes after this
    /// request's last put or delete (`meter.md` 0.4, `storage_bytes`).
    pub storage_bytes: Option<u64>,
    /// The principal, the route's guard inputs, `authz_evals` (ops.md
    /// 1.5.0 section 17; `ops/authz.rs`).
    pub authz: crate::ops::authz::RequestAuthz,
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
            open_bodies: Rc::new(std::cell::Cell::new(0)),
            resources: RequestResources::default(),
            db_ms: 0.0,
            db_rows: 0,
            logs_dropped: 0,
            db_corrupt: false,
            render_fuel: 0,
            render_ms: 0.0,
            ended: false,
            tx_borrowed: false,
            cross_cpu_ms: 0.0,
            storage_bytes: None,
            authz: Default::default(),
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
        state.borrow_mut().ended = true;
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
) -> Result<Rc<RefCell<RequestState>>, JsErrorBox> {
    state
        .borrow::<RequestTable>()
        .get(token)
        .ok_or_else(no_request)
}
