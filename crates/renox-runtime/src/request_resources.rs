//! Per-request op resources and their release (`docs/23-failure-modes.md`,
//! "Watchdog fires while a DB transaction is open"; `docs/contracts/ops.md`
//! section 11, step 6, "When the request ends for any reason").
//!
//! Every resource an op hands to a request is registered here: the open
//! database transaction (`ops/db.rs`) and the open fetch response bodies
//! (`ops/fetch.rs`). Fetches still waiting for headers and pending timers
//! need no entry: they are futures of the isolate's event loop, cancelled
//! by the request's `CancelHandle` when the request ends, and dropped with
//! the isolate when it is disposed.
//!
//! [`drain`] runs on every path that ends a request: the handler returned,
//! threw, or did not return a `Response`; the wall-clock deadline; the CPU
//! and heap limits; an uncaught error in the event loop; and disposal of the
//! isolate. It runs on the isolate thread before the reply is sent and
//! before a poisoned isolate is dropped, so the rollback reaches the DB
//! thread ahead of anything the next request sends: the writer is free for
//! it.

use std::rc::Rc;

use deno_core::{OpState, ResourceId};

use crate::ops::db::DbEnv;

/// Resources one request holds.
#[derive(Debug, Default)]
pub(crate) struct RequestResources {
    /// The open database transaction.
    pub db_tx: Option<u32>,
    /// A `begin` is waiting for the writer; when it succeeds after the
    /// request ended, `op_db_tx_begin` rolls it back itself.
    pub db_tx_pending: bool,
    /// Fetch response bodies not yet closed (each holds a connection).
    pub fetch_bodies: Vec<ResourceId>,
}

/// What [`drain`] released.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Drained {
    /// An open transaction was rolled back.
    pub rolled_back_tx: bool,
    /// Response bodies that were still open.
    pub closed_bodies: usize,
}

/// Release everything `resources` holds.
pub(crate) fn drain(state: &mut OpState, resources: &mut RequestResources) -> Drained {
    let mut drained = Drained::default();
    if let Some(tx) = resources.db_tx.take() {
        if let Some(db) = &state.borrow::<Rc<DbEnv>>().db {
            db.rollback_detached(tx);
        }
        drained.rolled_back_tx = true;
    }
    for rid in std::mem::take(&mut resources.fetch_bodies) {
        if let Ok(r) = state.resource_table.take_any(rid) {
            r.close();
            drained.closed_bodies += 1;
        }
    }
    drained
}
