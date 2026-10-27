//! Ops: the only way tenant JavaScript reaches anything outside its isolate
//! (`docs/contracts/ops.md`).

#[cfg(feature = "v8")]
pub(crate) mod request;
