//! Protocol hardening below routing (`docs/24-threat-model.md` section C,
//! "HTTP request smuggling", "HTTP/2 rapid reset"): the hyper builder
//! settings, and two read-side guards that see the raw bytes before hyper
//! parses them.
//!
//! - [`Http1Guard`] checks every HTTP/1.x request head and follows the body
//!   framing (`Content-Length` or `chunked`) to find the next head. A request
//!   that disagrees with itself or is ambiguous to another parser is refused
//!   before hyper sees it: both `Transfer-Encoding` and `Content-Length`, a
//!   repeated `Content-Length`, a `Transfer-Encoding` other than `chunked`,
//!   bare LF or CR, obsolete line folding, whitespace before a header colon,
//!   control characters, an invalid request line, `CONNECT`, and any h2c
//!   upgrade attempt. hyper alone accepts several of these (it drops
//!   `Content-Length` when `Transfer-Encoding` is present, folds equal
//!   duplicate lengths, and accepts bare LF), so the check cannot live in the
//!   service: by then the evidence is gone.
//! - [`H2FloodBudget`] reads the HTTP/2 frame headers in both directions
//!   and closes the connection when a client goes over one of three budgets
//!   (#166): resets per connection in any one-second interval (client
//!   `RST_STREAM`, CVE-2023-44487, plus server resets the client provoked,
//!   "MadeYouReset"), the same resets summed over every connection of the
//!   client IP ([`crate::limits::IpResetLimiter`]), and control frames
//!   (`PING`, `SETTINGS`, `WINDOW_UPDATE`, `PRIORITY`). hyper's
//!   `max_pending_accept_reset_streams` only covers streams reset before the
//!   server accepted them, and `max_local_error_reset_streams` is a lifetime
//!   total, not a rate. Two floods are refused by h2 0.4.20 itself, with
//!   `GOAWAY ENHANCE_YOUR_CALM`: `CONTINUATION` (at most
//!   `max(5, 1.25 × header list / frame size)` frames per header block) and
//!   empty non-final `DATA` (at most 100 per connection).
//!
//! A refused request never reaches routing or the [`crate::CellDispatcher`]. If it is
//! the first request on the connection, the client gets a fixed `400` and
//! the connection is closed; otherwise (a response for an earlier request
//! may be in flight) the connection is closed without a response.

use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::limits::IpResetSlot;

/// HTTP/2 limits and the HTTP/1 guard's line buffer. The HTTP/1 header,
/// timeout, and connection limits are in [`crate::GatewayLimits`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtocolLimits {
    /// `SETTINGS_MAX_CONCURRENT_STREAMS` advertised to HTTP/2 clients.
    pub h2_max_concurrent_streams: u32,
    /// Stream resets on one connection in any one-second interval (sliding
    /// window) before it is closed: client `RST_STREAM` frames plus server
    /// resets the client provoked.
    pub h2_max_resets_per_second: u32,
    /// The same resets summed over all connections of one client IP (IPv6
    /// by /64), in any one-second interval. Over it, the connection that
    /// sent or provoked the reset is closed.
    pub h2_max_resets_per_ip_per_second: u32,
    /// `PING`, `SETTINGS`, `WINDOW_UPDATE`, and `PRIORITY` frames per
    /// connection: a token bucket with this burst, refilled at
    /// this rate per second. Over it, the connection is closed.
    pub h2_max_control_frames_per_second: u32,
    /// Streams reset by the client before the server accepted them (hyper /
    /// `h2`); over it the connection gets `GOAWAY ENHANCE_YOUR_CALM`.
    pub h2_max_pending_accept_reset_streams: usize,
    /// Streams the server itself resets because of a client protocol error;
    /// over it the connection gets `GOAWAY ENHANCE_YOUR_CALM`.
    pub h2_max_local_error_reset_streams: usize,
    /// HTTP/2 `PING` interval on an idle connection.
    pub h2_keep_alive_interval: Duration,
    /// How long to wait for the `PING` acknowledgement before closing.
    pub h2_keep_alive_timeout: Duration,
}

impl Default for ProtocolLimits {
    fn default() -> Self {
        Self {
            h2_max_concurrent_streams: 128,
            h2_max_resets_per_second: 100,
            h2_max_resets_per_ip_per_second: 200,
            h2_max_control_frames_per_second: 2000,
            h2_max_pending_accept_reset_streams: 20,
            h2_max_local_error_reset_streams: 1024,
            h2_keep_alive_interval: Duration::from_secs(30),
            h2_keep_alive_timeout: Duration::from_secs(20),
        }
    }
}

/// The response written when the first request on a connection is refused
/// for its framing, with a fresh `x-renox-request-id` like every gateway
/// response (`request_id.rs`).
pub fn bad_request_response() -> Vec<u8> {
    crate::request_id::raw_response("400 Bad Request", &[])
}

/// The response for a request head over the header limits (bytes or
/// count). The guard enforces them before hyper does, so this 431 carries a
/// request id; hyper's own 431 is written below the service and could not.
pub fn header_too_large_response() -> Vec<u8> {
    crate::request_id::raw_response("431 Request Header Fields Too Large", &[])
}

/// Why a request was refused. Only used in logs and tests; the client sees
/// a bare `400` or a closed connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Violation {
    BareLf,
    BareCr,
    RequestLine,
    Connect,
    ObsFold,
    HeaderName,
    HeaderValue,
    ContentLengthAndTransferEncoding,
    DuplicateContentLength,
    InvalidContentLength,
    TransferEncodingNotChunked,
    TransferEncodingOnHttp10,
    H2cUpgrade,
    ChunkFraming,
    /// The request head (request line and header lines) is over the limit.
    HeadTooLarge,
    /// More header lines than the limit.
    TooManyHeaders,
}

impl Violation {
    /// The fixed response for a refused first request: 431 for the header
    /// limits, 400 for everything else.
    pub fn response(self) -> Vec<u8> {
        match self {
            Violation::HeadTooLarge | Violation::TooManyHeaders => header_too_large_response(),
            _ => bad_request_response(),
        }
    }
}

/// One HTTP/1.x request head as the guard saw it.
#[derive(Debug, Default)]
struct Head {
    http10: bool,
    /// Header lines seen.
    headers: usize,
    content_lengths: Vec<u64>,
    transfer_encodings: Vec<Vec<u8>>,
}

#[derive(Debug)]
enum State {
    /// Before or inside a request head. `request_line` is false once the
    /// request line was read.
    Head { request_line: bool, head: Head },
    /// A `Content-Length` body with this many bytes left.
    Body(u64),
    /// Reading a chunk-size line.
    ChunkSize,
    /// Inside chunk data with this many bytes left, then CRLF.
    ChunkData(u64),
    /// The CRLF after chunk data: `0` bytes of it seen so far, or `1`.
    ChunkDataEnd(u8),
    /// Trailer lines after the last chunk, up to an empty line.
    Trailer,
}

/// Validates HTTP/1.x request framing on the bytes read from a connection.
/// Fed in order with every byte the client sends; holds at most one line.
#[derive(Debug)]
pub struct Http1Framing {
    state: State,
    line: Vec<u8>,
    max_line: usize,
    /// Header lines allowed in one head.
    max_headers: usize,
    /// Bytes of the current request head so far (bounded by `max_line`).
    head_bytes: usize,
    /// A CR was the last byte; the next must be LF.
    after_cr: bool,
    /// Whether any request head was completed on this connection.
    seen_request: bool,
}

impl Http1Framing {
    /// `max_line` bounds the bytes buffered for one line and the bytes of
    /// one request head (use the head limit: a longer head is refused as
    /// [`Violation::HeadTooLarge`]).
    pub fn new(max_line: usize) -> Self {
        Self {
            state: State::Head {
                request_line: true,
                head: Head::default(),
            },
            line: Vec::new(),
            max_line,
            max_headers: usize::MAX,
            head_bytes: 0,
            after_cr: false,
            seen_request: false,
        }
    }

    /// Refuses a head with more than `n` header lines
    /// ([`Violation::TooManyHeaders`]).
    pub fn with_max_headers(mut self, n: usize) -> Self {
        self.max_headers = n;
        self
    }

    /// Whether a complete request head was accepted before (so a response
    /// may be in flight).
    pub fn seen_request(&self) -> bool {
        self.seen_request
    }

    /// Feeds bytes; stops at the first violation.
    pub fn feed(&mut self, mut data: &[u8]) -> Result<(), Violation> {
        while !data.is_empty() {
            match &mut self.state {
                State::Body(left) => {
                    let n = (*left).min(data.len() as u64) as usize;
                    *left -= n as u64;
                    data = &data[n..];
                    if *left == 0 {
                        self.next_request();
                    }
                }
                State::ChunkData(left) => {
                    let n = (*left).min(data.len() as u64) as usize;
                    *left -= n as u64;
                    data = &data[n..];
                    if *left == 0 {
                        self.state = State::ChunkDataEnd(0);
                    }
                }
                State::ChunkDataEnd(seen) => {
                    let expected = if *seen == 0 { b'\r' } else { b'\n' };
                    if data[0] != expected {
                        return Err(Violation::ChunkFraming);
                    }
                    data = &data[1..];
                    if *seen == 0 {
                        *seen = 1;
                    } else {
                        self.state = State::ChunkSize;
                    }
                }
                State::Head { .. } | State::ChunkSize | State::Trailer => {
                    let b = data[0];
                    data = &data[1..];
                    if matches!(self.state, State::Head { .. }) {
                        // hyper refuses a head that fills its buffer
                        // (`max_buf_size` = `max_line`) before it is
                        // complete, so a full buffer is refused here first.
                        self.head_bytes += 1;
                        if self.head_bytes >= self.max_line {
                            return Err(Violation::HeadTooLarge);
                        }
                    }
                    if self.after_cr {
                        self.after_cr = false;
                        if b != b'\n' {
                            return Err(Violation::BareCr);
                        }
                        let line = std::mem::take(&mut self.line);
                        self.end_line(&line)?;
                        continue;
                    }
                    match b {
                        b'\r' => self.after_cr = true,
                        b'\n' => return Err(Violation::BareLf),
                        // A head line cannot get here: the head byte count
                        // above stops it first (431). An over-long
                        // chunk-size or trailer line is refused (hyper's own
                        // limits for those differ).
                        _ if self.line.len() >= self.max_line => {
                            return Err(Violation::ChunkFraming);
                        }
                        _ => self.line.push(b),
                    }
                }
            }
        }
        Ok(())
    }

    fn next_request(&mut self) {
        self.head_bytes = 0;
        self.state = State::Head {
            request_line: true,
            head: Head::default(),
        };
    }

    /// A complete line (CRLF removed) in a line-oriented state.
    fn end_line(&mut self, line: &[u8]) -> Result<(), Violation> {
        match &mut self.state {
            State::Head { request_line, head } => {
                if *request_line {
                    // RFC 9112 section 2.2: empty lines before the request
                    // line are ignored.
                    if line.is_empty() {
                        return Ok(());
                    }
                    head.http10 = check_request_line(line)?;
                    *request_line = false;
                    return Ok(());
                }
                if line.is_empty() {
                    let head = std::mem::take(head);
                    return self.end_head(head);
                }
                head.headers += 1;
                if head.headers > self.max_headers {
                    return Err(Violation::TooManyHeaders);
                }
                check_header_line(line, head)
            }
            State::ChunkSize => {
                let size = parse_chunk_size(line)?;
                self.state = if size == 0 {
                    State::Trailer
                } else {
                    State::ChunkData(size)
                };
                Ok(())
            }
            State::Trailer => {
                if line.is_empty() {
                    self.next_request();
                    return Ok(());
                }
                check_header_line(line, &mut Head::default())
            }
            State::Body(_) | State::ChunkData(_) | State::ChunkDataEnd(_) => Ok(()),
        }
    }

    fn end_head(&mut self, head: Head) -> Result<(), Violation> {
        let te = !head.transfer_encodings.is_empty();
        if te && !head.content_lengths.is_empty() {
            return Err(Violation::ContentLengthAndTransferEncoding);
        }
        if head.content_lengths.len() > 1 {
            return Err(Violation::DuplicateContentLength);
        }
        if te {
            if head.http10 {
                return Err(Violation::TransferEncodingOnHttp10);
            }
            if head.transfer_encodings.len() > 1
                || !head.transfer_encodings[0]
                    .trim_ascii()
                    .eq_ignore_ascii_case(b"chunked")
            {
                return Err(Violation::TransferEncodingNotChunked);
            }
        }
        self.seen_request = true;
        self.head_bytes = 0;
        self.state = match head.content_lengths.first() {
            _ if te => State::ChunkSize,
            Some(&n) if n > 0 => State::Body(n),
            _ => State::Head {
                request_line: true,
                head: Head::default(),
            },
        };
        Ok(())
    }
}

/// RFC 9110 section 5.6.2 `tchar`.
fn is_tchar(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

/// `method SP request-target SP HTTP-version`, one space each. Returns
/// whether the version is HTTP/1.0.
fn check_request_line(line: &[u8]) -> Result<bool, Violation> {
    let mut parts = line.split(|&b| b == b' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Violation::RequestLine);
    };
    if method.is_empty() || !method.iter().all(|&b| is_tchar(b)) {
        return Err(Violation::RequestLine);
    }
    if method == b"CONNECT" {
        return Err(Violation::Connect);
    }
    if target.is_empty() || !target.iter().all(|&b| (0x21..=0x7e).contains(&b)) {
        return Err(Violation::RequestLine);
    }
    match version {
        b"HTTP/1.1" => Ok(false),
        b"HTTP/1.0" => Ok(true),
        _ => Err(Violation::RequestLine),
    }
}

/// `field-name ":" OWS field-value OWS`, recording the framing headers.
fn check_header_line(line: &[u8], head: &mut Head) -> Result<(), Violation> {
    if line[0] == b' ' || line[0] == b'\t' {
        return Err(Violation::ObsFold);
    }
    let colon = line
        .iter()
        .position(|&b| b == b':')
        .ok_or(Violation::HeaderName)?;
    let (name, value) = (&line[..colon], &line[colon + 1..]);
    // No whitespace between name and colon (RFC 9112 section 5.1).
    if name.is_empty() || !name.iter().all(|&b| is_tchar(b)) {
        return Err(Violation::HeaderName);
    }
    if !value
        .iter()
        .all(|&b| b == b'\t' || b == b' ' || (0x21..=0x7e).contains(&b) || b >= 0x80)
    {
        return Err(Violation::HeaderValue);
    }
    let value = value.trim_ascii();
    if name.eq_ignore_ascii_case(b"content-length") {
        if value.is_empty() || value.len() > 19 || !value.iter().all(u8::is_ascii_digit) {
            return Err(Violation::InvalidContentLength);
        }
        let n = std::str::from_utf8(value)
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or(Violation::InvalidContentLength)?;
        head.content_lengths.push(n);
    } else if name.eq_ignore_ascii_case(b"transfer-encoding") {
        head.transfer_encodings.push(value.to_vec());
    } else if name.eq_ignore_ascii_case(b"http2-settings")
        || (name.eq_ignore_ascii_case(b"upgrade")
            && value
                .split(|&b| b == b',')
                .any(|p| p.trim_ascii().eq_ignore_ascii_case(b"h2c")))
    {
        return Err(Violation::H2cUpgrade);
    }
    Ok(())
}

/// `1*HEXDIG BWS [ ";" chunk-ext ]`; at most 16 hex digits. Whitespace
/// after the size is allowed (RFC 9112 section 7.1.1, as hyper does).
fn parse_chunk_size(line: &[u8]) -> Result<u64, Violation> {
    let end = line.iter().position(|&b| b == b';').unwrap_or(line.len());
    let (digits, ext) = line.split_at(end);
    let digits = digits.trim_ascii_end();
    if digits.is_empty() || digits.len() > 16 || !digits.iter().all(u8::is_ascii_hexdigit) {
        return Err(Violation::ChunkFraming);
    }
    if !ext
        .iter()
        .all(|&b| b == b'\t' || (0x20..=0x7e).contains(&b) || b >= 0x80)
    {
        return Err(Violation::ChunkFraming);
    }
    let digits = std::str::from_utf8(digits).map_err(|_| Violation::ChunkFraming)?;
    u64::from_str_radix(digits, 16).map_err(|_| Violation::ChunkFraming)
}

fn refused() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "request refused by protocol guard",
    )
}

/// An HTTP/1 connection's IO with [`Http1Framing`] applied to every byte
/// read. On a violation the bytes of that read are discarded (hyper never
/// sees them), a fixed `400` is written if no earlier request was accepted
/// on the connection, and the read fails, which closes the connection.
#[derive(Debug)]
pub struct Http1Guard<I> {
    inner: I,
    framing: Http1Framing,
    /// The refusal ([`Violation::response`]) and the bytes of it written
    /// so far; once written, the read fails.
    rejecting: Option<(Vec<u8>, usize)>,
    refused: Option<Arc<AtomicU64>>,
}

impl<I> Http1Guard<I> {
    pub fn new(inner: I, max_line: usize, refused: Option<Arc<AtomicU64>>) -> Self {
        Self {
            inner,
            framing: Http1Framing::new(max_line),
            rejecting: None,
            refused,
        }
    }

    /// See [`Http1Framing::with_max_headers`].
    pub fn with_max_headers(mut self, n: usize) -> Self {
        self.framing.max_headers = n;
        self
    }
}

impl<I: AsyncRead + AsyncWrite + Unpin> AsyncRead for Http1Guard<I> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            if let Some((response, written)) = &mut this.rejecting {
                if *written < response.len() {
                    let rest = &response[*written..];
                    match Pin::new(&mut this.inner).poll_write(cx, rest) {
                        Poll::Ready(Ok(n)) if n > 0 => {
                            *written += n;
                            continue;
                        }
                        Poll::Ready(_) => return Poll::Ready(Err(refused())),
                        Poll::Pending => return Poll::Pending,
                    }
                }
                // Flush (TLS buffers records), then fail the read so hyper
                // closes the connection.
                return match Pin::new(&mut this.inner).poll_flush(cx) {
                    Poll::Pending => Poll::Pending,
                    Poll::Ready(_) => Poll::Ready(Err(refused())),
                };
            }
            let before = buf.filled().len();
            match Pin::new(&mut this.inner).poll_read(cx, buf) {
                Poll::Ready(Ok(())) => {
                    let new = &buf.filled()[before..];
                    if let Err(violation) = this.framing.feed(new) {
                        buf.set_filled(before);
                        if let Some(counter) = &this.refused {
                            counter.fetch_add(1, Ordering::Relaxed);
                        }
                        if this.framing.seen_request() {
                            return Poll::Ready(Err(refused()));
                        }
                        this.rejecting = Some((violation.response(), 0));
                        continue;
                    }
                    return Poll::Ready(Ok(()));
                }
                other => return other,
            }
        }
    }
}

impl<I: AsyncWrite + Unpin> AsyncWrite for Http1Guard<I> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, data)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

/// The HTTP/2 client connection preface (RFC 9113 section 3.4).
const H2_PREFACE_LEN: usize = 24;
const H2_FRAME_HEADER_LEN: usize = 9;
const H2_PRIORITY: u8 = 0x2;
const H2_RST_STREAM: u8 = 0x3;
const H2_SETTINGS: u8 = 0x4;
const H2_PING: u8 = 0x6;
const H2_WINDOW_UPDATE: u8 = 0x8;
/// `RST_STREAM` error codes the server sends without a client fault:
/// `NO_ERROR` (response done before the request body), `INTERNAL_ERROR` (a
/// response body failed, for example a tenant stream), and `CANCEL`.
const H2_NO_ERROR: u32 = 0x0;
const H2_INTERNAL_ERROR: u32 = 0x2;
const H2_CANCEL: u32 = 0x8;

/// At most `max` events in any one-second interval: the timestamps of the
/// events of the last second, oldest first. Unlike a fixed window, a client
/// cannot fit two budgets around a window boundary. Holds at most `max`
/// entries, allocated only as events arrive.
#[derive(Debug)]
pub struct SlidingWindow {
    max: usize,
    base: Instant,
    /// Milliseconds since `base`.
    times: VecDeque<u64>,
}

impl SlidingWindow {
    pub fn new(max: u32, now: Instant) -> Self {
        Self {
            max: max as usize,
            base: now,
            times: VecDeque::new(),
        }
    }

    fn prune(&mut self, now: Instant) -> u64 {
        let t = now.saturating_duration_since(self.base).as_millis() as u64;
        while self
            .times
            .front()
            .is_some_and(|&f| t.saturating_sub(f) >= 1000)
        {
            self.times.pop_front();
        }
        t
    }

    /// Records an event; `false` (and nothing recorded) if `max` events
    /// already happened within the last second.
    pub fn hit(&mut self, now: Instant) -> bool {
        let t = self.prune(now);
        if self.times.len() >= self.max {
            return false;
        }
        self.times.push_back(t);
        true
    }

    /// Events still allowed now.
    pub fn remaining(&mut self, now: Instant) -> usize {
        self.prune(now);
        self.max.saturating_sub(self.times.len())
    }

    /// No event within the last second.
    pub fn is_idle(&mut self, now: Instant) -> bool {
        self.prune(now);
        self.times.is_empty()
    }
}

/// A token bucket: `per_second` tokens of burst, refilled continuously at
/// `per_second` per second. Constant memory, for budgets too large to keep
/// one timestamp per event.
#[derive(Clone, Copy, Debug)]
pub struct TokenBucket {
    per_second: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    pub fn new(per_second: u32, now: Instant) -> Self {
        Self {
            per_second: f64::from(per_second),
            tokens: f64::from(per_second),
            last: now,
        }
    }

    /// Takes one token; `false` if the bucket is empty.
    pub fn take(&mut self, now: Instant) -> bool {
        let dt = now.saturating_duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + dt * self.per_second).min(self.per_second);
        self.last = self.last.max(now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Which HTTP/2 budget closed a connection. Only used in logs and tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum H2Flood {
    /// Client `RST_STREAM` plus server resets the client provoked, on this
    /// connection ([`ProtocolLimits::h2_max_resets_per_second`]).
    Resets,
    /// The same resets summed over every connection of the client IP
    /// ([`ProtocolLimits::h2_max_resets_per_ip_per_second`]).
    IpResets,
    /// `PING`, `SETTINGS`, `WINDOW_UPDATE`, and `PRIORITY` frames
    /// ([`ProtocolLimits::h2_max_control_frames_per_second`]).
    ControlFrames,
}

/// One frame header seen by [`FrameParser`]; `code` is the error code of a
/// `RST_STREAM` (0 for other kinds).
#[derive(Clone, Copy, Debug)]
struct FrameHead {
    kind: u8,
    len: u32,
    code: u32,
    /// Offset of the frame's first byte in the bytes of this
    /// [`FrameParser::feed`] call; `None` if it began in an earlier call.
    start: Option<usize>,
}

/// Splits an HTTP/2 byte stream into frame headers without buffering
/// payloads (only the 4-byte error code of a `RST_STREAM`).
#[derive(Clone, Debug)]
struct FrameParser {
    preface_left: usize,
    header: [u8; H2_FRAME_HEADER_LEN],
    header_len: usize,
    payload_left: u64,
    /// A `RST_STREAM` whose error code is still being read.
    rst: Option<(FrameHead, usize)>,
}

impl FrameParser {
    fn new(preface: usize) -> Self {
        Self {
            preface_left: preface,
            header: [0; H2_FRAME_HEADER_LEN],
            header_len: 0,
            payload_left: 0,
            rst: None,
        }
    }

    /// Feeds bytes and calls `on_frame` for each frame; stops at the first
    /// `Err`.
    fn feed<E>(
        &mut self,
        mut data: &[u8],
        mut on_frame: impl FnMut(FrameHead) -> Result<(), E>,
    ) -> Result<(), E> {
        let total = data.len();
        if let Some((head, _)) = &mut self.rst {
            head.start = None;
        }
        let mut start = None;
        while !data.is_empty() {
            if self.preface_left > 0 {
                let n = self.preface_left.min(data.len());
                self.preface_left -= n;
                data = &data[n..];
            } else if self.payload_left > 0 {
                let n = self.payload_left.min(data.len() as u64) as usize;
                if let Some((head, got)) = &mut self.rst {
                    for &b in data.iter().take(n.min(4 - *got)) {
                        head.code = (head.code << 8) | u32::from(b);
                        *got += 1;
                    }
                    if *got == 4 {
                        let head = *head;
                        self.rst = None;
                        on_frame(head)?;
                    }
                }
                self.payload_left -= n as u64;
                data = &data[n..];
            } else {
                if self.header_len == 0 {
                    start = Some(total - data.len());
                }
                let n = (H2_FRAME_HEADER_LEN - self.header_len).min(data.len());
                self.header[self.header_len..self.header_len + n].copy_from_slice(&data[..n]);
                self.header_len += n;
                data = &data[n..];
                if self.header_len == H2_FRAME_HEADER_LEN {
                    self.header_len = 0;
                    let h = self.header;
                    let head = FrameHead {
                        kind: h[3],
                        len: u32::from_be_bytes([0, h[0], h[1], h[2]]),
                        code: 0,
                        start,
                    };
                    self.payload_left = u64::from(head.len);
                    // A malformed `RST_STREAM` (not 4 bytes) is h2's to
                    // refuse; it is counted at its header.
                    if head.kind == H2_RST_STREAM && head.len == 4 {
                        self.rst = Some((head, 0));
                    } else {
                        on_frame(head)?;
                    }
                }
            }
        }
        Ok(())
    }
}

/// Counts the frames of one HTTP/2 connection against its budgets: client
/// bytes through [`H2FrameCounter::feed`], server bytes through
/// [`H2FrameCounter::feed_server`].
#[derive(Debug)]
pub struct H2FrameCounter {
    client: FrameParser,
    server: FrameParser,
    resets: SlidingWindow,
    control: TokenBucket,
    ip: Option<IpResetSlot>,
}

impl H2FrameCounter {
    pub fn new(limits: &ProtocolLimits, ip: Option<IpResetSlot>, now: Instant) -> Self {
        Self {
            client: FrameParser::new(H2_PREFACE_LEN),
            server: FrameParser::new(0),
            resets: SlidingWindow::new(limits.h2_max_resets_per_second, now),
            control: TokenBucket::new(limits.h2_max_control_frames_per_second, now),
            ip,
        }
    }

    /// Bytes the client sent.
    pub fn feed(&mut self, data: &[u8], now: Instant) -> Result<(), H2Flood> {
        let Self {
            client,
            resets,
            control,
            ip,
            ..
        } = self;
        client.feed(data, |f| {
            // Empty `DATA` (CVE-2019-9518) and `CONTINUATION` floods are
            // refused by h2 itself (module docs).
            let is_control = matches!(
                f.kind,
                H2_PING | H2_SETTINGS | H2_WINDOW_UPDATE | H2_PRIORITY
            );
            if is_control && !control.take(now) {
                return Err(H2Flood::ControlFrames);
            }
            if f.kind == H2_RST_STREAM {
                count_reset(resets, ip.as_ref(), now)?;
            }
            Ok(())
        })
    }

    /// Bytes the server wrote. A `RST_STREAM` with an error code other than
    /// `NO_ERROR`, `INTERNAL_ERROR`, or `CANCEL` is a reset the client provoked (a malformed
    /// frame on an open stream, "MadeYouReset") and costs the same budget as
    /// a client reset.
    pub fn feed_server(&mut self, data: &[u8], now: Instant) -> Result<(), H2Flood> {
        let Self {
            server, resets, ip, ..
        } = self;
        server.feed(data, |f| {
            if is_provoked_reset(f) {
                count_reset(resets, ip.as_ref(), now)?;
            }
            Ok(())
        })
    }

    /// How much of `data` the server may write: `None` for all of it, or
    /// the offset of the first provoked reset that is over a budget (`0` if
    /// nothing more may be written). Lets [`H2FloodBudget`] stop before that
    /// reset reaches the client instead of noticing it after the write.
    fn server_cut(&mut self, data: &[u8], now: Instant) -> Option<(usize, H2Flood)> {
        let conn = self.resets.remaining(now);
        let ip = self.ip.as_ref().map_or(usize::MAX, |ip| ip.remaining(now));
        let (mut left, flood) = if conn <= ip {
            (conn, H2Flood::Resets)
        } else {
            (ip, H2Flood::IpResets)
        };
        let mut probe = self.server.clone();
        probe
            .feed(data, |f| {
                if !is_provoked_reset(f) {
                    return Ok(());
                }
                if left == 0 {
                    return Err((f.start.unwrap_or(0), flood));
                }
                left -= 1;
                Ok(())
            })
            .err()
    }
}

/// A server `RST_STREAM` the client caused (module docs).
fn is_provoked_reset(f: FrameHead) -> bool {
    f.kind == H2_RST_STREAM && ![H2_NO_ERROR, H2_INTERNAL_ERROR, H2_CANCEL].contains(&f.code)
}

fn count_reset(
    resets: &mut SlidingWindow,
    ip: Option<&IpResetSlot>,
    now: Instant,
) -> Result<(), H2Flood> {
    if !resets.hit(now) {
        return Err(H2Flood::Resets);
    }
    if ip.is_some_and(|ip| !ip.hit(now)) {
        return Err(H2Flood::IpResets);
    }
    Ok(())
}

fn flood_error(flood: H2Flood) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("HTTP/2 flood budget exceeded: {flood:?}"),
    )
}

/// An HTTP/2 connection's IO with [`H2FrameCounter`] applied to both
/// directions. Over a budget, the read or write fails and hyper closes the
/// connection; every later read or write fails too.
#[derive(Debug)]
pub struct H2FloodBudget<I> {
    inner: I,
    counter: H2FrameCounter,
    refused: Option<Arc<AtomicU64>>,
    closed: Option<H2Flood>,
}

impl<I> H2FloodBudget<I> {
    pub fn new(
        inner: I,
        limits: &ProtocolLimits,
        ip: Option<IpResetSlot>,
        refused: Option<Arc<AtomicU64>>,
    ) -> Self {
        Self {
            inner,
            counter: H2FrameCounter::new(limits, ip, Instant::now()),
            refused,
            closed: None,
        }
    }

    fn close(&mut self, flood: H2Flood) -> io::Error {
        if self.closed.is_none() {
            self.closed = Some(flood);
            if let Some(counter) = &self.refused {
                counter.fetch_add(1, Ordering::Relaxed);
            }
        }
        flood_error(flood)
    }
}

impl<I: AsyncRead + Unpin> AsyncRead for H2FloodBudget<I> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if let Some(flood) = this.closed {
            return Poll::Ready(Err(flood_error(flood)));
        }
        let before = buf.filled().len();
        match Pin::new(&mut this.inner).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                if let Err(flood) = this.counter.feed(&buf.filled()[before..], Instant::now()) {
                    buf.set_filled(before);
                    return Poll::Ready(Err(this.close(flood)));
                }
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}

impl<I: AsyncWrite + Unpin> AsyncWrite for H2FloodBudget<I> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if let Some(flood) = this.closed {
            return Poll::Ready(Err(flood_error(flood)));
        }
        let now = Instant::now();
        let limit = match this.counter.server_cut(data, now) {
            Some((0, flood)) => return Poll::Ready(Err(this.close(flood))),
            Some((cut, _)) => cut,
            None => data.len(),
        };
        match Pin::new(&mut this.inner).poll_write(cx, &data[..limit]) {
            Poll::Ready(Ok(n)) => match this.counter.feed_server(&data[..n], now) {
                Ok(()) => Poll::Ready(Ok(n)),
                Err(flood) => Poll::Ready(Err(this.close(flood))),
            },
            other => other,
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }

    // Not vectored: every write goes through `poll_write`, where the
    // server's frames are checked before they are written.
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(bytes: &[u8]) -> Result<(), Violation> {
        Http1Framing::new(16 * 1024).feed(bytes)
    }

    /// Feeds one byte at a time, to prove state survives split reads.
    fn feed_bytewise(bytes: &[u8]) -> Result<(), Violation> {
        let mut f = Http1Framing::new(16 * 1024);
        bytes
            .iter()
            .try_for_each(|b| f.feed(std::slice::from_ref(b)))
    }

    #[test]
    fn well_formed_requests_pass_split_anywhere() {
        let ok: &[&[u8]] = &[
            b"GET / HTTP/1.1\r\nHost: a.test\r\n\r\n",
            b"\r\nGET /x?y=1 HTTP/1.0\r\nHost: a.test\r\n\r\n",
            b"POST /a HTTP/1.1\r\nHost: a.test\r\nContent-Length: 5\r\n\r\nhelloGET / HTTP/1.1\r\nHost: a.test\r\n\r\n",
            b"POST /a HTTP/1.1\r\nHost: a.test\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n0\r\nX-T: 1\r\n\r\nGET / HTTP/1.1\r\nHost: a.test\r\n\r\n",
            b"GET / HTTP/1.1\r\nHost: a.test\r\nUpgrade: websocket\r\nX-Utf8: caf\xc3\xa9\r\n\r\n",
        ];
        for req in ok {
            assert_eq!(feed(req), Ok(()), "{}", String::from_utf8_lossy(req));
            assert_eq!(
                feed_bytewise(req),
                Ok(()),
                "{}",
                String::from_utf8_lossy(req)
            );
        }
    }

    #[test]
    fn ambiguous_requests_are_refused() {
        let bad: &[(&[u8], Violation)] = &[
            (b"GET / HTTP/1.1\nHost: a.test\r\n\r\n", Violation::BareLf),
            (b"GET / HTTP/1.1\r\nHost: a.test\rX: y\r\n\r\n", Violation::BareCr),
            (b"GET / HTTP/1.1\r\nHost: a.test\r\nX: a\r\n b\r\n\r\n", Violation::ObsFold),
            (b"GET / HTTP/1.1\r\nHost : a.test\r\n\r\n", Violation::HeaderName),
            (b"GET / HTTP/1.1\r\nHost: a\x00.test\r\n\r\n", Violation::HeaderValue),
            (b"GET  / HTTP/1.1\r\n\r\n", Violation::RequestLine),
            (b"GET /\x7f HTTP/1.1\r\n\r\n", Violation::RequestLine),
            (b"GET / HTTP/2.0\r\n\r\n", Violation::RequestLine),
            (b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", Violation::RequestLine),
            (b"CONNECT a.test:443 HTTP/1.1\r\n\r\n", Violation::Connect),
            (
                b"POST / HTTP/1.1\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n",
                Violation::ContentLengthAndTransferEncoding,
            ),
            (
                b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n",
                Violation::ContentLengthAndTransferEncoding,
            ),
            (
                b"POST / HTTP/1.1\r\nContent-Length: 4\r\nContent-Length: 4\r\n\r\n",
                Violation::DuplicateContentLength,
            ),
            (b"POST / HTTP/1.1\r\nContent-Length: +4\r\n\r\n", Violation::InvalidContentLength),
            (
                b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked, identity\r\n\r\n",
                Violation::TransferEncodingNotChunked,
            ),
            (
                b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n",
                Violation::TransferEncodingNotChunked,
            ),
            (
                b"POST / HTTP/1.0\r\nTransfer-Encoding: chunked\r\n\r\n",
                Violation::TransferEncodingOnHttp10,
            ),
            (b"GET / HTTP/1.1\r\nUpgrade: h2c\r\n\r\n", Violation::H2cUpgrade),
            (b"GET / HTTP/1.1\r\nHTTP2-Settings: AAMAAABkAAQAAP__\r\n\r\n", Violation::H2cUpgrade),
            (
                b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhelloX0\r\n\r\n",
                Violation::ChunkFraming,
            ),
            (
                b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n 5\r\nhello\r\n",
                Violation::ChunkFraming,
            ),
            (
                b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\nhello\r\n",
                Violation::BareLf,
            ),
            (
                b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5 x\r\nhello\r\n",
                Violation::ChunkFraming,
            ),
            // A smuggled second request after a Content-Length body is
            // checked like any other head.
            (
                b"POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabcGET / HTTP/1.1\nHost: b\r\n\r\n",
                Violation::BareLf,
            ),
        ];
        for (req, want) in bad {
            assert_eq!(feed(req), Err(*want), "{}", String::from_utf8_lossy(req));
            assert_eq!(
                feed_bytewise(req),
                Err(*want),
                "{}",
                String::from_utf8_lossy(req)
            );
        }
    }

    #[test]
    fn overlong_chunk_lines_are_refused_not_ignored() {
        // Adversarial review of #107: going opaque here would leave every
        // later request on the connection unchecked.
        let head = "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
        let ext = format!("{head}1;{}\r\na\r\n0\r\n\r\n", "e".repeat(100));
        assert_eq!(
            Http1Framing::new(64).feed(ext.as_bytes()),
            Err(Violation::ChunkFraming)
        );
        let trailer = format!("{head}0\r\nX-T: {}\r\n\r\n", "t".repeat(100));
        assert_eq!(
            Http1Framing::new(64).feed(trailer.as_bytes()),
            Err(Violation::ChunkFraming)
        );
    }

    #[test]
    fn whitespace_after_chunk_size_is_allowed() {
        let req =
            b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5 ;a=b\r\nhello\r\n0\t\r\n\r\n";
        assert_eq!(feed(req), Ok(()));
    }

    #[test]
    fn head_limits_are_431() {
        let req = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(100));
        assert_eq!(
            Http1Framing::new(32).feed(req.as_bytes()),
            Err(Violation::HeadTooLarge)
        );
        // Under the limit is fine, and the count starts again per head.
        let ok = "GET / HTTP/1.1\r\nX: a\r\n\r\n";
        let mut f = Http1Framing::new(ok.len() + 1);
        assert_eq!(f.feed(ok.repeat(3).as_bytes()), Ok(()));
        let three = "GET / HTTP/1.1\r\nA: 1\r\nB: 2\r\nC: 3\r\n\r\n";
        assert_eq!(
            Http1Framing::new(1024)
                .with_max_headers(3)
                .feed(three.as_bytes()),
            Ok(())
        );
        assert_eq!(
            Http1Framing::new(1024)
                .with_max_headers(2)
                .feed(three.as_bytes()),
            Err(Violation::TooManyHeaders)
        );
        let r = String::from_utf8(Violation::TooManyHeaders.response()).unwrap();
        assert!(r.starts_with("HTTP/1.1 431 "));
        assert!(r.contains("\r\nx-renox-request-id: "));
        let r = String::from_utf8(Violation::BareLf.response()).unwrap();
        assert!(r.starts_with("HTTP/1.1 400 "));
    }

    fn frame(kind: u8, len: u32) -> Vec<u8> {
        let l = len.to_be_bytes();
        let mut f = vec![l[1], l[2], l[3], kind, 0, 0, 0, 0, 1];
        f.extend(std::iter::repeat_n(0, len as usize));
        f
    }

    fn rst(code: u32) -> Vec<u8> {
        let mut f = vec![0, 0, 4, H2_RST_STREAM, 0, 0, 0, 0, 1];
        f.extend(code.to_be_bytes());
        f
    }

    fn limits(resets: u32, ip: u32, control: u32) -> ProtocolLimits {
        ProtocolLimits {
            h2_max_resets_per_second: resets,
            h2_max_resets_per_ip_per_second: ip,
            h2_max_control_frames_per_second: control,
            ..ProtocolLimits::default()
        }
    }

    const PREFACE: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

    #[test]
    fn reset_budget_counts_rst_stream_frames_per_second() {
        let now = Instant::now();
        let mut c = H2FrameCounter::new(&limits(3, 100, 100), None, now);
        let mut bytes = PREFACE.to_vec();
        bytes.extend(frame(H2_SETTINGS, 6));
        for _ in 0..3 {
            bytes.extend(frame(0x1, 10)); // HEADERS
            bytes.extend(rst(H2_CANCEL));
        }
        // Byte by byte, so frame headers split across reads are handled.
        assert!(
            bytes
                .iter()
                .all(|b| c.feed(std::slice::from_ref(b), now).is_ok())
        );
        assert_eq!(c.feed(&rst(H2_CANCEL), now), Err(H2Flood::Resets));

        // A second later the window has moved on.
        let mut c = H2FrameCounter::new(&limits(3, 100, 100), None, now);
        assert!(c.feed(&bytes, now).is_ok());
        assert!(
            c.feed(&rst(H2_CANCEL), now + Duration::from_millis(1001))
                .is_ok()
        );
    }

    /// Finding 1 of #166: a fixed window let a client send twice the budget
    /// around a window boundary. The sliding window allows `max` in any
    /// one-second interval.
    #[test]
    fn reset_budget_has_no_window_boundary() {
        let t0 = Instant::now();
        let mut w = SlidingWindow::new(10, t0);
        // First reset at 0, then nine at 0.99 s.
        assert!(w.hit(t0));
        let late = t0 + Duration::from_millis(990);
        assert!((0..9).all(|_| w.hit(late)));
        // Just after the old window's boundary: only the slot of the reset
        // at 0 is free again, not a whole new budget.
        let next = t0 + Duration::from_millis(1010);
        assert!(w.hit(next));
        assert!(!w.hit(next));
        assert!(!w.is_idle(next));
        assert!(w.is_idle(t0 + Duration::from_millis(2011)));
    }

    #[test]
    fn token_bucket_refills_at_its_rate() {
        let t0 = Instant::now();
        let mut b = TokenBucket::new(4, t0);
        assert!((0..4).all(|_| b.take(t0)));
        assert!(!b.take(t0));
        // A quarter second refills one token.
        assert!(b.take(t0 + Duration::from_millis(250)));
        assert!(!b.take(t0 + Duration::from_millis(250)));
        // Never more than the burst.
        let later = t0 + Duration::from_secs(60);
        assert!((0..4).all(|_| b.take(later)));
        assert!(!b.take(later));
    }

    #[test]
    fn server_resets_count_unless_the_server_is_at_fault() {
        let now = Instant::now();
        let mut c = H2FrameCounter::new(&limits(2, 100, 100), None, now);
        // The server's own frames: SETTINGS, then resets.
        for f in [rst(H2_NO_ERROR), rst(H2_CANCEL), rst(H2_INTERNAL_ERROR)] {
            assert!(c.feed_server(&f, now).is_ok());
        }
        let protocol_error = rst(0x1);
        let mut bytes = frame(H2_SETTINGS, 0);
        bytes.extend(&protocol_error);
        bytes.extend(rst(0x3)); // FLOW_CONTROL_ERROR
        assert!(
            bytes
                .iter()
                .all(|b| c.feed_server(std::slice::from_ref(b), now).is_ok())
        );
        assert_eq!(c.feed_server(&protocol_error, now), Err(H2Flood::Resets));

        // The write is cut before the reset over the budget: two fit, the
        // third starts at byte 26 (each is 13 bytes).
        let mut c = H2FrameCounter::new(&limits(2, 100, 100), None, now);
        let three = [rst(H2_CANCEL), rst(0x1), rst(0x1), rst(0x1)].concat();
        assert_eq!(c.server_cut(&three, now), Some((39, H2Flood::Resets)));
        assert!(c.feed_server(&three[..39], now).is_ok());
        assert_eq!(c.server_cut(&three[39..], now), Some((0, H2Flood::Resets)));
        // A reset whose header was written earlier is cut at 0 too.
        assert!(c.feed_server(&three[39..44], now).is_ok());
        assert_eq!(c.server_cut(&three[44..], now), Some((0, H2Flood::Resets)));

        // Server and client resets share the connection budget.
        let mut c = H2FrameCounter::new(&limits(2, 100, 100), None, now);
        assert!(c.feed(PREFACE, now).is_ok());
        assert!(c.feed(&rst(H2_CANCEL), now).is_ok());
        assert!(c.feed_server(&protocol_error, now).is_ok());
        assert_eq!(c.feed(&rst(H2_CANCEL), now), Err(H2Flood::Resets));
    }

    #[test]
    fn control_frames_share_one_budget() {
        let now = Instant::now();
        let mut c = H2FrameCounter::new(&limits(100, 100, 5), None, now);
        let mut bytes = PREFACE.to_vec();
        for kind in [H2_PING, H2_SETTINGS, H2_WINDOW_UPDATE, H2_PRIORITY] {
            bytes.extend(frame(kind, 4));
        }
        // Not control frames: DATA (empty or not; h2 limits empty ones),
        // HEADERS, CONTINUATION.
        bytes.extend(frame(0x0, 3));
        bytes.extend(frame(0x0, 0));
        bytes.extend(frame(0x1, 3));
        bytes.extend(frame(0x9, 3));
        assert!(c.feed(&bytes, now).is_ok());
        assert!(c.feed(&frame(H2_PRIORITY, 5), now).is_ok());
        assert_eq!(c.feed(&frame(H2_PING, 8), now), Err(H2Flood::ControlFrames));
    }

    #[test]
    fn ip_budget_is_shared_by_connections() {
        let now = Instant::now();
        let ips = crate::limits::IpResetLimiter::new(3);
        let ip = "192.0.2.7".parse().unwrap();
        let mut a = H2FrameCounter::new(&limits(100, 3, 100), Some(ips.slot(ip)), now);
        let mut b = H2FrameCounter::new(&limits(100, 3, 100), Some(ips.slot(ip)), now);
        assert!(a.feed(PREFACE, now).is_ok());
        assert!(b.feed(PREFACE, now).is_ok());
        assert!(a.feed(&rst(H2_CANCEL), now).is_ok());
        assert!(a.feed(&rst(H2_CANCEL), now).is_ok());
        assert!(b.feed(&rst(H2_CANCEL), now).is_ok());
        assert_eq!(b.feed(&rst(H2_CANCEL), now), Err(H2Flood::IpResets));
        assert_eq!(
            a.feed_server(&rst(0x1), now),
            Err(H2Flood::IpResets),
            "server resets count per IP too"
        );
    }
}
