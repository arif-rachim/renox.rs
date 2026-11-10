//! The WebSocket transport (RFC 6455) after the handshake: frames over any
//! `AsyncRead + AsyncWrite` (the upgraded hyper connection in the cell, an
//! in-memory duplex in tests).
//!
//! A reader task parses client frames and enforces the inbound limits
//! before buffering a payload (64 KB per message, fragments included:
//! 1009; more than 100 data messages in one second: 1008 `flood`). The
//! writer loop drains the connection's queue, sends a ping every 30 s and
//! closes with 1001 when no pong arrives within 10 s, and sends the close
//! frame the hub asked for. Data messages go to the cell through an
//! [`InboundSink`] whose capacity bounds what one connection can have in
//! flight: an [`inbox`] (no memory while idle, #522) or an mpsc channel.

use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::{Closed, Conn, Outbound, close, queue};

/// A data message from the client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inbound {
    Text(String),
    Binary(Vec<u8>),
}

/// Where [`serve`] puts the client's data messages. `send` waits while the
/// consumer is full and fails once it is gone (the reader then stops).
pub trait InboundSink: Send + 'static {
    fn send(&self, m: Inbound) -> impl std::future::Future<Output = Result<(), ()>> + Send;
}

impl InboundSink for mpsc::Sender<Inbound> {
    async fn send(&self, m: Inbound) -> Result<(), ()> {
        mpsc::Sender::send(self, m).await.map_err(|_| ())
    }
}

impl InboundSink for queue::Sender<Inbound> {
    async fn send(&self, m: Inbound) -> Result<(), ()> {
        queue::Sender::send(self, m).await.map_err(|_| ())
    }
}

/// The sending end of an [`inbox`], given to [`serve`].
pub type InboxSender = queue::Sender<Inbound>;
/// The receiving end of an [`inbox`]: `recv` ends once `serve` returned.
pub type Inbox = queue::Receiver<Inbound>;

/// A queue of at most `capacity` inbound messages for [`serve`]. Unlike an
/// mpsc channel it holds no memory while the connection is idle (B14).
pub fn inbox(capacity: usize) -> (InboxSender, Inbox) {
    queue::bounded(capacity)
}

const OP_CONT: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

/// One frame: `opcode`, `fin`, the unmasked payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub fin: bool,
    pub opcode: u8,
    pub payload: Vec<u8>,
}

/// Why reading stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// The peer closed the socket.
    Eof,
    /// Over the inbound limit (1009).
    TooBig,
    /// Not a valid client frame: unmasked, reserved bits, a bad control
    /// frame, a continuation out of place (1002), or text that is not UTF-8 (1007).
    Protocol(u16, &'static str),
}

/// Encodes a server frame (never masked).
pub fn encode(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 10);
    out.push(0x80 | opcode);
    match payload.len() {
        n if n < 126 => out.push(n as u8),
        n if n <= u16::MAX as usize => {
            out.push(126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            out.push(127);
            out.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    out.extend_from_slice(payload);
    out
}

/// The payload of a close frame.
pub fn close_payload(code: u16, reason: &str) -> Vec<u8> {
    let mut p = code.to_be_bytes().to_vec();
    // A control frame holds at most 125 bytes.
    let mut r = reason.as_bytes();
    if r.len() > 123 {
        r = &r[..123];
        while std::str::from_utf8(r).is_err() {
            r = &r[..r.len() - 1];
        }
    }
    p.extend_from_slice(r);
    p
}

/// Reads one client frame; `budget` is how many payload bytes may still
/// arrive for the current message. The length is checked before the
/// payload is read.
pub async fn read_frame<R: AsyncRead + Unpin>(
    r: &mut R,
    budget: usize,
) -> Result<Frame, FrameError> {
    let mut head = [0u8; 2];
    if r.read_exact(&mut head).await.is_err() {
        return Err(FrameError::Eof);
    }
    let fin = head[0] & 0x80 != 0;
    if head[0] & 0x70 != 0 {
        return Err(FrameError::Protocol(1002, "reserved bits set"));
    }
    let opcode = head[0] & 0x0f;
    if head[1] & 0x80 == 0 {
        return Err(FrameError::Protocol(1002, "client frames must be masked"));
    }
    let mut len = u64::from(head[1] & 0x7f);
    if len == 126 {
        let mut b = [0u8; 2];
        r.read_exact(&mut b).await.map_err(|_| FrameError::Eof)?;
        len = u64::from(u16::from_be_bytes(b));
    } else if len == 127 {
        let mut b = [0u8; 8];
        r.read_exact(&mut b).await.map_err(|_| FrameError::Eof)?;
        len = u64::from_be_bytes(b);
    }
    let control = opcode & 0x8 != 0;
    if control && (len > 125 || !fin) {
        return Err(FrameError::Protocol(1002, "bad control frame"));
    }
    if !matches!(
        opcode,
        OP_CONT | OP_TEXT | OP_BINARY | OP_CLOSE | OP_PING | OP_PONG
    ) {
        return Err(FrameError::Protocol(1002, "unknown opcode"));
    }
    if !control && len > budget as u64 {
        return Err(FrameError::TooBig);
    }
    let mut mask = [0u8; 4];
    r.read_exact(&mut mask).await.map_err(|_| FrameError::Eof)?;
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload)
        .await
        .map_err(|_| FrameError::Eof)?;
    for (i, b) in payload.iter_mut().enumerate() {
        *b ^= mask[i % 4];
    }
    Ok(Frame {
        fin,
        opcode,
        payload,
    })
}

/// What the reader hands the writer: control frames to answer, a pong
/// seen, the end of the read side. One small shared state per connection
/// instead of a channel (B14: a channel's first block is 32 slots), with
/// the writer's waker instead of a `Notify` (#522).
#[derive(Default)]
pub(crate) struct Ctrl {
    state: std::sync::Mutex<CtrlState>,
}

#[derive(Default)]
struct CtrlState {
    /// The payload of the last ping to answer.
    ping: Option<Vec<u8>>,
    pong: bool,
    /// The peer's close (`reason` "client"), or a reader-side limit.
    close: Option<(u16, String)>,
    /// Set by the reader, cleared by the writer's `take`.
    ready: bool,
    waker: Option<std::task::Waker>,
}

impl Ctrl {
    fn lock(&self) -> std::sync::MutexGuard<'_, CtrlState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn set(&self, f: impl FnOnce(&mut CtrlState)) {
        let waker = {
            let mut st = self.lock();
            f(&mut st);
            st.ready = true;
            st.waker.take()
        };
        if let Some(w) = waker {
            w.wake();
        }
    }

    /// Resolves with what the reader set since the last call.
    fn take(&self) -> impl std::future::Future<Output = CtrlState> + '_ {
        std::future::poll_fn(move |cx| {
            let mut st = self.lock();
            if st.ready {
                let mut out = std::mem::take(&mut *st);
                out.ready = false;
                return std::task::Poll::Ready(out);
            }
            match &st.waker {
                Some(w) if w.will_wake(cx.waker()) => {}
                _ => st.waker = Some(cx.waker().clone()),
            }
            std::task::Poll::Pending
        })
    }

    fn end(&self, code: u16, reason: &str) {
        self.set(|s| {
            s.close.get_or_insert((code, reason.to_string()));
        });
    }
}

/// The reader: frames to messages, limits, control frames to the writer.
async fn reader<R: AsyncRead + Unpin, I: InboundSink>(
    mut r: R,
    max: usize,
    per_second: u32,
    inbound: I,
    // The connection's shared state (hub.rs, `CloseSignal`): its `ctrl`.
    shared: std::sync::Arc<crate::hub::CloseSignal>,
    hub: std::sync::Arc<crate::Hub>,
) {
    let ctrl = &shared.ctrl;
    let mut partial: Option<(u8, Vec<u8>)> = None;
    let mut window = Instant::now();
    let mut in_window = 0u32;
    loop {
        let used = partial.as_ref().map_or(0, |(_, b)| b.len());
        let f = match read_frame(&mut r, max.saturating_sub(used)).await {
            Ok(f) => f,
            Err(FrameError::Eof) => return ctrl.end(close::GOING_AWAY, "eof"),
            Err(FrameError::TooBig) => return ctrl.end(close::TOO_BIG, "message_size"),
            Err(FrameError::Protocol(code, why)) => return ctrl.end(code, why),
        };
        let message = match f.opcode {
            OP_PING => {
                ctrl.set(|s| s.ping = Some(f.payload));
                continue;
            }
            OP_PONG => {
                ctrl.set(|s| s.pong = true);
                continue;
            }
            OP_CLOSE => {
                let code = if f.payload.len() >= 2 {
                    u16::from_be_bytes([f.payload[0], f.payload[1]])
                } else {
                    close::NORMAL
                };
                return ctrl.end(code, "client");
            }
            OP_CONT => match partial.as_mut() {
                Some((_, buf)) => {
                    buf.extend_from_slice(&f.payload);
                    if !f.fin {
                        continue;
                    }
                    partial.take().expect("checked")
                }
                None => return ctrl.end(1002, "unexpected continuation"),
            },
            _ if partial.is_some() => return ctrl.end(1002, "expected a continuation"),
            op if !f.fin => {
                partial = Some((op, f.payload));
                continue;
            }
            op => (op, f.payload),
        };
        // Flood: data messages per second (the tokio clock, faked in tests).
        let now = Instant::now();
        if now.saturating_duration_since(window) >= Duration::from_secs(1) {
            window = now;
            in_window = 0;
        }
        in_window += 1;
        if in_window > per_second {
            return ctrl.end(close::POLICY, "flood");
        }
        hub.count_in();
        let m = match message {
            (OP_TEXT, bytes) => match String::from_utf8(bytes) {
                Ok(s) => Inbound::Text(s),
                Err(_) => return ctrl.end(1007, "invalid utf-8"),
            },
            (_, bytes) => Inbound::Binary(bytes),
        };
        if inbound.send(m).await.is_err() {
            return;
        }
    }
}

/// Serves `conn` over `stream` until either side closes; data messages go
/// to `inbound`. Returns the close (code, reason) for the meter record and
/// the `close` handler.
pub async fn serve<S, I>(stream: S, conn: Conn, inbound: I) -> Closed
where
    S: AsyncRead + AsyncWrite + Send + 'static,
    I: InboundSink,
{
    let mut conn = conn;
    // The scalars only: the whole `Limits` would sit in this future for
    // the connection's life (B14).
    let (ping_every, pong_timeout, max_inbound, per_second) = {
        let l = conn.hub().limits();
        (
            l.ping_every,
            l.pong_timeout,
            l.max_inbound_bytes,
            l.inbound_per_second,
        )
    };
    let (r, mut w) = tokio::io::split(stream);
    // #680: the control state lives in the connection's shared state, not
    // in an allocation of its own.
    let shared = conn.signal().clone();
    let ctrl = &shared.ctrl;
    // The reader is polled inside this loop, not spawned: one task per
    // connection (B14), and it is never dropped mid-frame while it runs.
    let reader_fut = reader(
        r,
        max_inbound,
        per_second,
        inbound,
        shared.clone(),
        conn.hub().clone(),
    );
    tokio::pin!(reader_fut);
    let mut reader_done = false;
    let mut next_ping = Instant::now() + ping_every;
    let mut pong_due: Option<Instant> = None;
    let closed_fut = conn.closed();
    tokio::pin!(closed_fut);
    let eof = || Closed {
        code: close::GOING_AWAY,
        reason: "eof".into(),
    };
    // Each turn picks one step; its frames are written after the select,
    // at one await point, so the future holds one write state (B14).
    let closed = loop {
        // #680: the hub's one ticker watches this deadline (no timer per
        // connection); it fires within `HEARTBEAT_TICK` of it.
        conn.set_beat(pong_due.map_or(next_ping, |d| d.min(next_ping)));
        let beat = conn.beat();
        // `out`: the bytes to write; `end`: the close to return after the
        // write; `on_error`: what a failed write returns (`None`: `end`).
        let (out, end, eof_on_error): (Vec<u8>, Option<Closed>, bool) = tokio::select! {
            biased;
            c = &mut closed_fut => {
                (encode(OP_CLOSE, &close_payload(c.code, &c.reason)), Some(c), false)
            }
            _ = &mut reader_fut, if !reader_done => {
                // Its end is in `ctrl`; the next turn picks it up.
                reader_done = true;
                continue;
            }
            st = ctrl.take() => {
                if st.pong {
                    pong_due = None;
                }
                let mut out = Vec::new();
                let pong = st.ping.is_some();
                if let Some(p) = st.ping {
                    out = encode(OP_PONG, &p);
                }
                match st.close {
                    Some((code, reason)) => {
                        // Echo the client's close; send ours for a limit.
                        let text = if reason == "client" { "" } else { reason.as_str() };
                        out.extend_from_slice(&encode(OP_CLOSE, &close_payload(code, text)));
                        // A failed pong ends the connection as `eof`, as
                        // before the close could be sent.
                        (out, Some(Closed { code, reason }), pong)
                    }
                    None if pong => (out, None, true),
                    None => continue,
                }
            }
            msg = conn.rx.recv() => match msg {
                Some(Outbound::Message(e)) => (encode(OP_TEXT, e.data.as_bytes()), None, true),
                None => break Closed { code: close::GOING_AWAY, reason: "hub".into() },
            },
            () = beat => {
                let now = Instant::now();
                if pong_due.is_some_and(|d| d <= now) {
                    (
                        encode(OP_CLOSE, &close_payload(close::GOING_AWAY, "heartbeat")),
                        Some(Closed { code: close::GOING_AWAY, reason: "heartbeat".into() }),
                        false,
                    )
                } else if next_ping <= now {
                    next_ping = now + ping_every;
                    pong_due.get_or_insert(now + pong_timeout);
                    (encode(OP_PING, b""), None, true)
                } else {
                    continue;
                }
            }
        };
        let failed = w.write_all(&out).await.is_err();
        drop(out);
        if failed && eof_on_error {
            break eof();
        }
        if let Some(c) = end {
            break c;
        }
    };
    let _ = w.flush().await;
    let _ = w.shutdown().await;
    conn.finish(closed.code, &closed.reason);
    closed
}
