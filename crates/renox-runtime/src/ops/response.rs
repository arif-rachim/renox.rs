//! `op_response_write`, `op_response_end` (`docs/contracts/ops.md` section 6,
//! "Response body", 1.2.0): a streamed response body leaves the isolate
//! chunk by chunk, after its head.
//!
//! The bootstrap reads the handler's `ReadableStream` in the request's async
//! context and hands each chunk to `op_response_write`, which counts it
//! against the response egress limit (section 10, "Response egress") and
//! puts it into a bounded channel the cell reads ([`STREAM_BUFFER_CHUNKS`]:
//! the op waits while the channel is full). `op_response_end` marks the
//! end. What a stream reported is queued in [`StreamEvents`]; the isolate's
//! serve loop drains the queue and ends the request (`isolate.rs`).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use bytes::Bytes;
use deno_core::{CancelFuture, JsBuffer, OpState, op2};
use deno_error::JsErrorBox;
use tokio::sync::mpsc;

use crate::ops::request::{live_request, no_request};

/// Chunks of one response the connection has not taken yet (`ops.md`
/// section 6, "Backpressure").
pub const STREAM_BUFFER_CHUNKS: usize = 16;

/// The sending half of one request's body, from dispatch until its end.
pub(crate) struct ResponseSink {
    /// `None` once the stream stopped (end, egress limit, client gone):
    /// the channel closes when the last pending write lets go of its clone.
    pub tx: Option<mpsc::Sender<Bytes>>,
    pub limit_bytes: u64,
    /// Bytes taken by `op_response_write`, before compression.
    pub sent_bytes: u64,
}

/// The sinks of the requests of one isolate, by request token.
#[derive(Default)]
pub(crate) struct ResponseSinks(pub HashMap<u32, ResponseSink>);

impl ResponseSinks {
    /// A sink for a new request; the cell gets the receiving half.
    pub fn open(&mut self, token: u32, limit_bytes: u64) -> mpsc::Receiver<Bytes> {
        let (tx, rx) = mpsc::channel(STREAM_BUFFER_CHUNKS);
        self.0.insert(
            token,
            ResponseSink {
                tx: Some(tx),
                limit_bytes,
                sent_bytes: 0,
            },
        );
        rx
    }
}

/// What a request's stream reported (`ops.md` section 10, "Mid-stream").
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StreamEvent {
    /// `op_response_end`: `None` is the normal end, `Some` the message of
    /// the handler's failed stream.
    End(Option<String>),
    /// The chunk that would pass the response egress limit was refused.
    EgressLimit { limit_bytes: u64, sent_bytes: u64 },
    /// The cell stopped reading: the client went away.
    ClientGone,
}

/// Stream reports not yet handled by the serve loop: `(token, event)`.
#[derive(Default)]
pub(crate) struct StreamEvents(pub Vec<(u32, StreamEvent)>);

/// The stream was stopped: the bootstrap cancels the handler's stream.
fn stopped() -> JsErrorBox {
    crate::ops::request::op_error(
        "RENOX_NO_REQUEST",
        serde_json::Value::Null,
        "The response can take no more bytes.",
    )
}

/// `op_response_write` (ops.md section 6): one chunk of a streamed body.
#[op2]
pub(crate) async fn op_response_write(
    state: Rc<RefCell<OpState>>,
    token: u32,
    #[buffer] chunk: JsBuffer,
) -> Result<(), JsErrorBox> {
    let (tx, cancel) = {
        let mut s = state.borrow_mut();
        let request = live_request(&s, token)?;
        let cancel = request.borrow().cancel.clone();
        let sinks = s.borrow_mut::<ResponseSinks>();
        let sink = sinks.0.get_mut(&token).ok_or_else(no_request)?;
        let Some(tx) = sink.tx.clone() else {
            return Err(stopped());
        };
        let n = chunk.len() as u64;
        if sink.sent_bytes.saturating_add(n) > sink.limit_bytes {
            // Refused whole: the client never gets more than the limit.
            sink.tx = None;
            let event = StreamEvent::EgressLimit {
                limit_bytes: sink.limit_bytes,
                sent_bytes: sink.sent_bytes,
            };
            s.borrow_mut::<StreamEvents>().0.push((token, event));
            return Err(stopped());
        }
        sink.sent_bytes += n;
        (tx, cancel)
    };
    if chunk.is_empty() {
        return Ok(());
    }
    // Copied: Rust never keeps a view into a JavaScript buffer (section 12).
    let bytes = Bytes::copy_from_slice(&chunk);
    match tx.send(bytes).or_cancel(cancel).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_closed)) => {
            let mut s = state.borrow_mut();
            if let Some(sink) = s.borrow_mut::<ResponseSinks>().0.get_mut(&token) {
                sink.tx = None;
            }
            s.borrow_mut::<StreamEvents>()
                .0
                .push((token, StreamEvent::ClientGone));
            Err(stopped())
        }
        // The request ended while the chunk waited for room.
        Err(_cancelled) => Err(stopped()),
    }
}

/// `op_response_end` (ops.md section 6): the end of a streamed body; never
/// throws.
#[op2]
pub(crate) fn op_response_end(state: &mut OpState, token: u32, #[string] error: Option<String>) {
    let Some(sink) = state.borrow_mut::<ResponseSinks>().0.get_mut(&token) else {
        return;
    };
    if sink.tx.take().is_none() {
        // Already stopped (egress limit, client gone): that event stands.
        return;
    }
    state
        .borrow_mut::<StreamEvents>()
        .0
        .push((token, StreamEvent::End(error)));
}
