//! The WebSocket transport (RFC 6455) after the handshake: frames over any
//! `AsyncRead + AsyncWrite` (the upgraded hyper connection in the cell, an
//! in-memory duplex in tests).
//!
//! A reader task parses client frames and enforces the inbound limits
//! before buffering a payload (64 KB per message, fragments included:
//! 1009; more than 100 data messages in one second: 1008 `flood`). The
//! writer loop drains the connection's queue, sends a ping every 30 s and
//! closes with 1001 when no pong arrives within 10 s, and sends the close
//! frame the hub asked for. Data messages go to the cell through a channel
//! whose capacity bounds what one connection can have in flight.

use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::{Closed, Conn, Outbound, close};

/// A data message from the client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inbound {
    Text(String),
    Binary(Vec<u8>),
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
/// instead of a channel (B14: a channel's first block is 32 slots).
#[derive(Default)]
struct Ctrl {
    state: std::sync::Mutex<CtrlState>,
    notify: tokio::sync::Notify,
}

#[derive(Default)]
struct CtrlState {
    /// The payload of the last ping to answer.
    ping: Option<Vec<u8>>,
    pong: bool,
    /// The peer's close (`reason` "client"), or a reader-side limit.
    close: Option<(u16, String)>,
}

impl Ctrl {
    fn set(&self, f: impl FnOnce(&mut CtrlState)) {
        f(&mut self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner));
        self.notify.notify_one();
    }

    fn take(&self) -> CtrlState {
        std::mem::take(
            &mut *self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    fn end(&self, code: u16, reason: &str) {
        self.set(|s| {
            s.close.get_or_insert((code, reason.to_string()));
        });
    }
}

/// The reader: frames to messages, limits, control frames to the writer.
async fn reader<R: AsyncRead + Unpin>(
    mut r: R,
    max: usize,
    per_second: u32,
    inbound: mpsc::Sender<Inbound>,
    ctrl: std::sync::Arc<Ctrl>,
    hub: std::sync::Arc<crate::Hub>,
) {
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
pub async fn serve<S>(stream: S, conn: Conn, inbound: mpsc::Sender<Inbound>) -> Closed
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let mut conn = conn;
    let limits = conn.hub().limits().clone();
    let (r, mut w) = tokio::io::split(stream);
    let ctrl = std::sync::Arc::new(Ctrl::default());
    // The reader is polled inside this loop, not spawned: one task per
    // connection (B14), and it is never dropped mid-frame while it runs.
    let reader_fut = reader(
        r,
        limits.max_inbound_bytes,
        limits.inbound_per_second,
        inbound,
        ctrl.clone(),
        conn.hub().clone(),
    );
    tokio::pin!(reader_fut);
    let mut reader_done = false;
    let mut next_ping = Instant::now() + limits.ping_every;
    let mut pong_due: Option<Instant> = None;
    let closed_fut = conn.closed();
    tokio::pin!(closed_fut);
    let eof = || Closed {
        code: close::GOING_AWAY,
        reason: "eof".into(),
    };
    let closed = loop {
        let timer = pong_due.map_or(next_ping, |d| d.min(next_ping));
        tokio::select! {
            biased;
            c = &mut closed_fut => {
                let _ = w.write_all(&encode(OP_CLOSE, &close_payload(c.code, &c.reason))).await;
                break c;
            }
            _ = &mut reader_fut, if !reader_done => {
                // Its end is in `ctrl`; the next turn picks it up.
                reader_done = true;
            }
            _ = ctrl.notify.notified() => {
                let st = ctrl.take();
                if st.pong {
                    pong_due = None;
                }
                if let Some(p) = st.ping
                    && w.write_all(&encode(OP_PONG, &p)).await.is_err()
                {
                    break eof();
                }
                if let Some((code, reason)) = st.close {
                    // Echo the client's close; send ours for a limit.
                    let text = if reason == "client" { "" } else { reason.as_str() };
                    let _ = w.write_all(&encode(OP_CLOSE, &close_payload(code, text))).await;
                    break Closed { code, reason };
                }
            }
            msg = conn.rx.recv() => match msg {
                Some(Outbound::Message(e)) => {
                    if w.write_all(&encode(OP_TEXT, e.data.as_bytes())).await.is_err() {
                        break eof();
                    }
                }
                None => break Closed { code: close::GOING_AWAY, reason: "hub".into() },
            },
            _ = tokio::time::sleep_until(timer) => {
                let now = Instant::now();
                if pong_due.is_some_and(|d| d <= now) {
                    let _ = w.write_all(&encode(OP_CLOSE, &close_payload(close::GOING_AWAY, "heartbeat"))).await;
                    break Closed { code: close::GOING_AWAY, reason: "heartbeat".into() };
                }
                if next_ping <= now {
                    next_ping = now + limits.ping_every;
                    pong_due.get_or_insert(now + limits.pong_timeout);
                    if w.write_all(&encode(OP_PING, b"")).await.is_err() {
                        break eof();
                    }
                }
            }
        }
    };
    let _ = w.flush().await;
    let _ = w.shutdown().await;
    conn.finish(closed.code, &closed.reason);
    closed
}
