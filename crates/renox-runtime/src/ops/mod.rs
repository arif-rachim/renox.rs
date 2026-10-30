//! Ops: the only way tenant JavaScript reaches anything outside its isolate
//! (`docs/contracts/ops.md`).

pub mod authz;
pub mod db;
pub mod events;
pub mod fetch_connector;
pub mod jobs;
pub mod log;
pub mod modules;
pub mod net_policy;
pub mod password;
pub mod realtime;
pub mod secrets;
pub mod storage;

#[cfg(feature = "v8")]
pub(crate) mod deadline;
#[cfg(feature = "v8")]
pub mod fetch;
#[cfg(feature = "v8")]
pub(crate) mod request;
#[cfg(feature = "v8")]
pub(crate) mod response;
