//! `op_deadline_remaining_ms` (`docs/contracts/ops.md` section 5): backs
//! `ctx.deadline.remainingMs()`.

use std::time::Instant;

use deno_core::{OpState, op2};
use deno_error::JsErrorBox;

use crate::ops::request::live_request;

/// `op_deadline_remaining_ms` (ops.md section 5): whole milliseconds left
/// before the request's wall-clock deadline, >= 0.
#[op2(fast)]
pub(crate) fn op_deadline_remaining_ms(state: &mut OpState, token: u32) -> Result<f64, JsErrorBox> {
    let req = live_request(state, token)?;
    let left = req
        .borrow()
        .deadline
        .saturating_duration_since(Instant::now());
    Ok(left.as_millis() as f64)
}
