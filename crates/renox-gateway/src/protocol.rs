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
//! - [`H2ResetBudget`] counts `RST_STREAM` frames per connection and closes
//!   the connection when a client resets more than
//!   [`ProtocolLimits::h2_max_resets_per_second`] streams within a second
//!   (CVE-2023-44487). hyper's `max_pending_accept_reset_streams` only covers
//!   streams reset before the server accepted them.
//!
//! A refused request never reaches routing or the [`crate::CellDispatcher`]. If it is
//! the first request on the connection, the client gets a fixed `400` and
//! the connection is closed; otherwise (a response for an earlier request
//! may be in flight) the connection is closed without a response.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// HTTP/2 limits and the HTTP/1 guard's line buffer. The HTTP/1 header,
/// timeout, and connection limits are in [`crate::GatewayLimits`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtocolLimits {
    /// `SETTINGS_MAX_CONCURRENT_STREAMS` advertised to HTTP/2 clients.
    pub h2_max_concurrent_streams: u32,
    /// `RST_STREAM` frames a client may send within one second before the
    /// connection is closed.
    pub h2_max_resets_per_second: u32,
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
            h2_max_pending_accept_reset_streams: 20,
            h2_max_local_error_reset_streams: 1024,
            h2_keep_alive_interval: Duration::from_secs(30),
            h2_keep_alive_timeout: Duration::from_secs(20),
        }
    }
}

/// The response written when the first request on a connection is refused.
pub const BAD_REQUEST_RESPONSE: &[u8] =
    b"HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

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
}

/// One HTTP/1.x request head as the guard saw it.
#[derive(Debug, Default)]
struct Head {
    http10: bool,
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
    /// A request head grew past the line buffer; hyper refuses it (431)
    /// and closes, so the guard stops looking. Never entered from chunk
    /// framing or trailers.
    Opaque,
}

/// Validates HTTP/1.x request framing on the bytes read from a connection.
/// Fed in order with every byte the client sends; holds at most one line.
#[derive(Debug)]
pub struct Http1Framing {
    state: State,
    line: Vec<u8>,
    max_line: usize,
    /// A CR was the last byte; the next must be LF.
    after_cr: bool,
    /// Whether any request head was completed on this connection.
    seen_request: bool,
}

impl Http1Framing {
    /// `max_line` bounds the bytes buffered for one line (use the head
    /// limit; hyper refuses longer heads with 431 anyway).
    pub fn new(max_line: usize) -> Self {
        Self {
            state: State::Head {
                request_line: true,
                head: Head::default(),
            },
            line: Vec::new(),
            max_line,
            after_cr: false,
            seen_request: false,
        }
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
                State::Opaque => return Ok(()),
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
                        // An over-long head is refused by hyper (431), so the
                        // guard can stop looking. An over-long chunk-size or
                        // trailer line is refused here: hyper's own limits
                        // for those differ, and going opaque would switch
                        // the guard off for the rest of the connection.
                        _ if self.line.len() >= self.max_line => {
                            if !matches!(self.state, State::Head { .. }) {
                                return Err(Violation::ChunkFraming);
                            }
                            self.state = State::Opaque;
                            self.line = Vec::new();
                        }
                        _ => self.line.push(b),
                    }
                }
            }
        }
        Ok(())
    }

    fn next_request(&mut self) {
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
            State::Body(_) | State::ChunkData(_) | State::ChunkDataEnd(_) | State::Opaque => Ok(()),
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
    /// Bytes of [`BAD_REQUEST_RESPONSE`] still to write, then fail.
    rejecting: Option<usize>,
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
}

impl<I: AsyncRead + AsyncWrite + Unpin> AsyncRead for Http1Guard<I> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            if let Some(written) = this.rejecting {
                if written < BAD_REQUEST_RESPONSE.len() {
                    let rest = &BAD_REQUEST_RESPONSE[written..];
                    match Pin::new(&mut this.inner).poll_write(cx, rest) {
                        Poll::Ready(Ok(n)) if n > 0 => {
                            this.rejecting = Some(written + n);
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
                    if let Err(_violation) = this.framing.feed(new) {
                        buf.set_filled(before);
                        if let Some(counter) = &this.refused {
                            counter.fetch_add(1, Ordering::Relaxed);
                        }
                        if this.framing.seen_request() {
                            return Poll::Ready(Err(refused()));
                        }
                        this.rejecting = Some(0);
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
const H2_RST_STREAM: u8 = 0x3;

/// Counts `RST_STREAM` frames in an HTTP/2 client byte stream.
#[derive(Debug)]
pub struct H2FrameCounter {
    preface_left: usize,
    header: [u8; H2_FRAME_HEADER_LEN],
    header_len: usize,
    payload_left: u64,
    max_per_second: u32,
    window_start: Option<Instant>,
    in_window: u32,
}

impl H2FrameCounter {
    pub fn new(max_per_second: u32) -> Self {
        Self {
            preface_left: H2_PREFACE_LEN,
            header: [0; H2_FRAME_HEADER_LEN],
            header_len: 0,
            payload_left: 0,
            max_per_second,
            window_start: None,
            in_window: 0,
        }
    }

    /// Feeds bytes; `false` once the reset budget is exceeded.
    pub fn feed(&mut self, mut data: &[u8], now: Instant) -> bool {
        while !data.is_empty() {
            if self.preface_left > 0 {
                let n = self.preface_left.min(data.len());
                self.preface_left -= n;
                data = &data[n..];
            } else if self.payload_left > 0 {
                let n = self.payload_left.min(data.len() as u64) as usize;
                self.payload_left -= n as u64;
                data = &data[n..];
            } else {
                let n = (H2_FRAME_HEADER_LEN - self.header_len).min(data.len());
                self.header[self.header_len..self.header_len + n].copy_from_slice(&data[..n]);
                self.header_len += n;
                data = &data[n..];
                if self.header_len == H2_FRAME_HEADER_LEN {
                    self.header_len = 0;
                    let h = self.header;
                    self.payload_left = u64::from(u32::from_be_bytes([0, h[0], h[1], h[2]]));
                    if h[3] == H2_RST_STREAM && !self.count_reset(now) {
                        return false;
                    }
                }
            }
        }
        true
    }

    fn count_reset(&mut self, now: Instant) -> bool {
        match self.window_start {
            Some(start) if now.duration_since(start) < Duration::from_secs(1) => {
                self.in_window += 1;
            }
            _ => {
                self.window_start = Some(now);
                self.in_window = 1;
            }
        }
        self.in_window <= self.max_per_second
    }
}

/// An HTTP/2 connection's IO with [`H2FrameCounter`] applied: over the
/// reset budget, the read fails and hyper closes the connection.
#[derive(Debug)]
pub struct H2ResetBudget<I> {
    inner: I,
    counter: H2FrameCounter,
    refused: Option<Arc<AtomicU64>>,
}

impl<I> H2ResetBudget<I> {
    pub fn new(inner: I, max_per_second: u32, refused: Option<Arc<AtomicU64>>) -> Self {
        Self {
            inner,
            counter: H2FrameCounter::new(max_per_second),
            refused,
        }
    }
}

impl<I: AsyncRead + Unpin> AsyncRead for H2ResetBudget<I> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        match Pin::new(&mut this.inner).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                if !this.counter.feed(&buf.filled()[before..], Instant::now()) {
                    buf.set_filled(before);
                    if let Some(counter) = &this.refused {
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "HTTP/2 stream reset budget exceeded",
                    )));
                }
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}

impl<I: AsyncWrite + Unpin> AsyncWrite for H2ResetBudget<I> {
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
    fn overlong_head_is_left_to_hyper() {
        let mut f = Http1Framing::new(32);
        let req = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(100));
        assert_eq!(f.feed(req.as_bytes()), Ok(()));
        assert!(matches!(f.state, State::Opaque));
    }

    fn frame(kind: u8, len: u32) -> Vec<u8> {
        let l = len.to_be_bytes();
        let mut f = vec![l[1], l[2], l[3], kind, 0, 0, 0, 0, 1];
        f.extend(std::iter::repeat_n(0, len as usize));
        f
    }

    #[test]
    fn reset_budget_counts_rst_stream_frames_per_second() {
        let now = Instant::now();
        let mut c = H2FrameCounter::new(3);
        let mut bytes = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".to_vec();
        bytes.extend(frame(0x4, 6)); // SETTINGS
        for _ in 0..3 {
            bytes.extend(frame(0x1, 10)); // HEADERS
            bytes.extend(frame(H2_RST_STREAM, 4));
        }
        // Byte by byte, so frame headers split across reads are handled.
        assert!(bytes.iter().all(|b| c.feed(std::slice::from_ref(b), now)));
        assert!(!c.feed(&frame(H2_RST_STREAM, 4), now));

        // A new second starts a new window.
        let mut c = H2FrameCounter::new(3);
        assert!(c.feed(&bytes, now));
        assert!(c.feed(&frame(H2_RST_STREAM, 4), now + Duration::from_millis(1001)));
    }
}
