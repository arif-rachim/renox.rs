//! Ops: the only way tenant JavaScript reaches anything outside its isolate
//! (`docs/contracts/ops.md`).

pub mod fetch_connector;
pub mod net_policy;

#[cfg(feature = "v8")]
pub mod fetch;
#[cfg(feature = "v8")]
pub(crate) mod request;
