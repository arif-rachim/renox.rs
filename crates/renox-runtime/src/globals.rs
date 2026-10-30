//! The `renox` extension: its ops, its ESM bootstrap (`js/bootstrap.js`),
//! and the op middleware that neutralises upstream ops tenant code must
//! not reach (`docs/contracts/ops.md` section 11, "Changes to the global
//! scope"; README, "Hidden globals").

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use deno_core::{OpDecl, OpState, op2};

use crate::ops::authz::{
    op_authz_check, op_authz_check_batch, op_authz_explain, op_authz_guard,
    op_authz_principal_cached, op_authz_principal_set, op_authz_roles_assign, op_authz_roles_list,
    op_authz_roles_revoke,
};
use crate::ops::db::{
    op_db_execute, op_db_query, op_db_query_one, op_db_savepoint_begin, op_db_savepoint_release,
    op_db_savepoint_rollback, op_db_tx_begin, op_db_tx_commit, op_db_tx_rollback,
};
use crate::ops::deadline::op_deadline_remaining_ms;
use crate::ops::events::{op_events_ack, op_events_emit};
use crate::ops::fetch::{op_fetch_body_close, op_fetch_body_read, op_renox_fetch};
use crate::ops::jobs::{op_jobs_ack, op_jobs_cancel, op_jobs_enqueue, op_jobs_list, op_jobs_retry};
use crate::ops::log::op_log;
use crate::ops::modules::{op_span_service_begin, op_span_service_end};
use crate::ops::password::{op_password_hash, op_password_verify};
use crate::ops::realtime::{
    op_realtime_close, op_realtime_publish, op_realtime_send, op_realtime_subscribe,
    op_realtime_unsubscribe,
};
use crate::ops::request::RequestTable;
use crate::ops::response::{ResponseSinks, StreamEvents, op_response_end, op_response_write};
use crate::ops::secrets::op_secrets_get_all;

/// Our own time origin for the coarsened clock ops.
struct CoarseClockStart(Instant);

/// Write `duration` into `out` the way `deno_web` does (u32 seconds, u32
/// nanoseconds, native endian), rounded **down to whole milliseconds**:
/// `performance.now()` and `performance.timeOrigin` resolution against
/// Spectre-class timing (`docs/04-isolation-security.md`).
fn expose_coarse(d: std::time::Duration, out: &mut [u8]) {
    let seconds = d.as_secs() as u32;
    let nanos = d.subsec_nanos() - d.subsec_nanos() % 1_000_000;
    if out.len() >= 8 {
        out[0..4].copy_from_slice(&seconds.to_ne_bytes());
        out[4..8].copy_from_slice(&nanos.to_ne_bytes());
    }
}

/// Replaces `deno_web`'s `op_now` (same signature).
#[op2(fast)]
fn op_renox_now(state: &mut OpState, #[buffer] buf: &mut [u8]) {
    let start = state.borrow::<CoarseClockStart>().0;
    expose_coarse(start.elapsed(), buf);
}

/// Replaces `deno_web`'s `op_time_origin` (same signature).
#[op2(fast)]
fn op_renox_time_origin(state: &mut OpState, #[buffer] buf: &mut [u8]) {
    let start = state.borrow::<CoarseClockStart>().0;
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .saturating_sub(start.elapsed());
    expose_coarse(epoch, buf);
}

/// Replaces `op_exit` (same signature): in `deno_runtime` it ends the whole
/// process, which hosts every isolate of the node. Here it does nothing;
/// the JavaScript caller (`Deno.exit`, `close()`) then throws.
#[op2(fast)]
fn op_renox_no_exit(_state: &mut OpState) {}

/// Ops replaced in every extension of the isolate.
fn middleware(op: OpDecl) -> OpDecl {
    match op.name {
        "op_exit" => op.with_implementation_from(&op_renox_no_exit()),
        "op_now" => op.with_implementation_from(&op_renox_now()),
        "op_time_origin" => op.with_implementation_from(&op_renox_time_origin()),
        _ => op,
    }
}

deno_core::extension!(
    renox,
    ops = [
        op_db_query,
        op_db_query_one,
        op_db_execute,
        op_db_tx_begin,
        op_db_tx_commit,
        op_db_tx_rollback,
        op_db_savepoint_begin,
        op_db_savepoint_release,
        op_db_savepoint_rollback,
        op_secrets_get_all,
        op_authz_principal_cached,
        op_authz_principal_set,
        op_authz_guard,
        op_authz_check,
        op_authz_check_batch,
        op_authz_explain,
        op_authz_roles_assign,
        op_authz_roles_revoke,
        op_authz_roles_list,
        op_realtime_subscribe,
        op_realtime_unsubscribe,
        op_realtime_publish,
        op_realtime_send,
        op_realtime_close,
        op_events_emit,
        op_events_ack,
        op_jobs_enqueue,
        op_jobs_ack,
        op_jobs_list,
        op_jobs_retry,
        op_jobs_cancel,
        op_span_service_begin,
        op_span_service_end,
        op_password_hash,
        op_password_verify,
        op_log,
        op_deadline_remaining_ms,
        op_renox_fetch,
        op_fetch_body_read,
        op_fetch_body_close,
        op_response_write,
        op_response_end,
        op_renox_now,
        op_renox_time_origin,
        op_renox_no_exit,
    ],
    esm_entry_point = "ext:renox/bootstrap.js",
    esm = [dir "src/js", "bootstrap.js"],
    middleware = middleware,
    state = |state| {
        state.put(CoarseClockStart(Instant::now()));
        state.put(RequestTable::default());
        state.put(ResponseSinks::default());
        state.put(StreamEvents::default());
    },
);

/// The extension for the snapshot (ops and ESM).
pub(crate) fn for_snapshot() -> deno_core::Extension {
    renox::init()
}

/// The extension for an isolate created from the snapshot (ops and state only).
pub(crate) fn for_isolate() -> deno_core::Extension {
    renox::init()
}
