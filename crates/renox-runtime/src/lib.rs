//! `renox-runtime`: the Renox data plane's JavaScript runtime (P1).
//!
//! Embeds `deno_runtime` (the Deno 2.1.4 runtime that Supabase Edge
//! Runtime v1.77.8 is built on, ADR D3), creates one V8 isolate per
//! deployment from a platform snapshot, loads an artifact
//! (`docs/contracts/artifact.md`), and dispatches requests to the function
//! handlers named in its manifest (`docs/contracts/ops.md` sections 6 and 11).
//! See `README.md` for the design decisions.
//!
//! With the default `v8` feature off, only the pure modules compile; their
//! tests run without linking V8.

pub mod error;
pub mod limits;
pub mod manifest;
pub mod ops;
pub mod pages;
pub mod router;

#[cfg(feature = "v8")]
mod globals;
#[cfg(feature = "v8")]
pub mod isolate;
#[cfg(feature = "v8")]
pub mod loader;
#[cfg(feature = "v8")]
mod request_resources;
#[cfg(feature = "v8")]
pub mod runtime;

#[cfg(feature = "v8")]
pub use isolate::{
    Dispatched, EventDelivered, EventEnvelope, EventOutcome, IsolateHandle, IsolateSpec, RequestCtx,
};
#[cfg(feature = "v8")]
pub use runtime::{LogLine, LogSink, Runtime, RuntimeConfig};
