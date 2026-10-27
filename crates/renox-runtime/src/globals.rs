//! The `renox` extension: its ops, its ESM bootstrap (`js/bootstrap.js`),
//! and the op middleware that neutralises upstream ops tenant code must
//! not reach (`docs/contracts/ops.md` section 11, "Changes to the global
//! scope"; README, "Hidden globals").

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use deno_core::{OpDecl, OpState, op2};

use crate::ops::request::{RequestTable, op_deadline_remaining_ms};

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
    ops = [op_deadline_remaining_ms, op_renox_now, op_renox_time_origin, op_renox_no_exit],
    esm_entry_point = "ext:renox/bootstrap.js",
    esm = [dir "src/js", "bootstrap.js"],
    middleware = middleware,
    state = |state| {
        state.put(CoarseClockStart(Instant::now()));
        state.put(RequestTable::default());
    },
);

/// The extension for the snapshot (ops and ESM).
pub(crate) fn for_snapshot() -> deno_core::Extension {
    renox::init_ops_and_esm()
}

/// The extension for an isolate created from the snapshot (ops and state only).
pub(crate) fn for_isolate() -> deno_core::Extension {
    renox::init_ops()
}
