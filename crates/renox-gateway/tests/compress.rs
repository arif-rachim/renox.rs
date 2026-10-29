//! Issue #159: response compression, BREACH-safe (`src/compress.rs`;
//! README, "Compression"). No sockets: `negotiate` and `apply` are pure.

use std::io::Read;

use axum::http::{HeaderMap, HeaderValue, Response, StatusCode, header};
use bytes::Bytes;
use renox_gateway::compress::{
    Encoding, MIN_BYTES, NoCompress, StreamEncoder, apply, apply_streamed, negotiate,
};

fn accept(v: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(header::ACCEPT_ENCODING, HeaderValue::from_str(v).unwrap());
    h
}

fn response(content_type: &str, body: Vec<u8>) -> Response<Bytes> {
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, content_type)
        .body(Bytes::from(body))
        .unwrap()
}

fn json_body(len: usize) -> Vec<u8> {
    let mut s = String::from("[");
    let mut i = 0;
    while s.len() < len {
        s.push_str(&format!("{{\"id\":{i},\"name\":\"product {i}\"}},"));
        i += 1;
    }
    s.push_str("null]");
    s.into_bytes()
}

fn vary(r: &Response<Bytes>) -> Vec<String> {
    r.headers()
        .get_all(header::VARY)
        .iter()
        .map(|v| v.to_str().unwrap().to_ascii_lowercase())
        .collect()
}

fn gunzip(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(b)
        .read_to_end(&mut out)
        .unwrap();
    out
}

fn unbrotli(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    brotli::Decompressor::new(b, 4096)
        .read_to_end(&mut out)
        .unwrap();
    out
}

#[test]
fn negotiation_follows_accept_encoding_and_q_values() {
    assert_eq!(negotiate(&HeaderMap::new()), None);
    assert_eq!(negotiate(&accept("gzip, deflate, br")), Some(Encoding::Br));
    assert_eq!(negotiate(&accept("gzip")), Some(Encoding::Gzip));
    assert_eq!(negotiate(&accept("x-gzip")), Some(Encoding::Gzip));
    assert_eq!(
        negotiate(&accept("br;q=0.5, gzip;q=0.8")),
        Some(Encoding::Gzip)
    );
    assert_eq!(negotiate(&accept("br;q=0, gzip;q=0")), None);
    assert_eq!(negotiate(&accept("identity")), None);
    assert_eq!(negotiate(&accept("deflate")), None);
    assert_eq!(negotiate(&accept("*")), Some(Encoding::Br));
    assert_eq!(negotiate(&accept("*;q=0.1, br;q=0")), Some(Encoding::Gzip));
    assert_eq!(
        negotiate(&accept("identity;q=0, gzip")),
        Some(Encoding::Gzip)
    );
    assert_eq!(negotiate(&accept("gzip;q=nonsense")), None);
    assert_eq!(negotiate(&accept("GZIP;Q=1")), Some(Encoding::Gzip));
    // Several header lines count together.
    let mut h = accept("gzip;q=0.2");
    h.append(header::ACCEPT_ENCODING, HeaderValue::from_static("br"));
    assert_eq!(negotiate(&h), Some(Encoding::Br));
}

#[test]
fn json_and_text_over_1_kb_are_compressed_with_vary() {
    let body = json_body(8 * 1024);
    for (encoding, decode) in [
        (Encoding::Br, unbrotli as fn(&[u8]) -> Vec<u8>),
        (Encoding::Gzip, gunzip),
    ] {
        for ct in [
            "application/json",
            "application/problem+json; charset=utf-8",
            "text/html; charset=utf-8",
            "text/plain",
        ] {
            let r = apply(response(ct, body.clone()), Some(encoding));
            assert_eq!(
                r.headers()[header::CONTENT_ENCODING],
                encoding.as_str(),
                "{ct}"
            );
            assert_eq!(vary(&r), ["accept-encoding"]);
            assert!(r.body().len() < body.len() / 2, "{ct}: {}", r.body().len());
            assert_eq!(
                r.headers()[header::CONTENT_LENGTH],
                r.body().len().to_string()
            );
            assert_eq!(decode(r.body()), body, "{ct}: round trip");
        }
    }
}

/// The uncompressed path: no coding accepted, too small, not text or
/// JSON, already encoded, `no-transform`, partial content. Types the
/// gateway would compress still get `Vary`.
#[test]
fn uncompressed_path_leaves_the_body_alone() {
    let big = json_body(4096);
    // The client accepts nothing: same bytes, but Vary is set.
    let r = apply(response("application/json", big.clone()), None);
    assert!(r.headers().get(header::CONTENT_ENCODING).is_none());
    assert_eq!(vary(&r), ["accept-encoding"]);
    assert_eq!(r.body().as_ref(), big.as_slice());

    // Below the threshold.
    let small = json_body(MIN_BYTES - 100);
    let r = apply(
        response("application/json", small.clone()),
        Some(Encoding::Br),
    );
    assert!(r.headers().get(header::CONTENT_ENCODING).is_none());
    assert_eq!(vary(&r), ["accept-encoding"]);
    assert_eq!(r.body().as_ref(), small.as_slice());

    // Not text or JSON: untouched, no Vary.
    for ct in [
        "image/png",
        "application/octet-stream",
        "application/javascript",
    ] {
        let r = apply(response(ct, big.clone()), Some(Encoding::Gzip));
        assert!(r.headers().get(header::CONTENT_ENCODING).is_none(), "{ct}");
        assert!(vary(&r).is_empty(), "{ct}");
        assert_eq!(r.body().as_ref(), big.as_slice());
    }
    let mut no_type = response("text/plain", big.clone());
    no_type.headers_mut().remove(header::CONTENT_TYPE);
    assert!(
        apply(no_type, Some(Encoding::Br))
            .headers()
            .get(header::CONTENT_ENCODING)
            .is_none()
    );

    // Already encoded by the handler.
    let mut r = response("text/plain", big.clone());
    r.headers_mut()
        .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    let r = apply(r, Some(Encoding::Br));
    assert_eq!(r.headers()[header::CONTENT_ENCODING], "gzip");
    assert_eq!(r.body().as_ref(), big.as_slice());

    // Cache-Control: no-transform.
    let mut r = response("text/plain", big.clone());
    r.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, No-Transform"),
    );
    let r = apply(r, Some(Encoding::Br));
    assert!(r.headers().get(header::CONTENT_ENCODING).is_none());

    // 206 and 304.
    for status in [StatusCode::PARTIAL_CONTENT, StatusCode::NOT_MODIFIED] {
        let mut r = response("text/plain", big.clone());
        *r.status_mut() = status;
        let r = apply(r, Some(Encoding::Gzip));
        assert!(r.headers().get(header::CONTENT_ENCODING).is_none());
    }

    // A body that does not get smaller is sent as is.
    let mut noise = Vec::with_capacity(4096);
    let mut x: u32 = 0x9e37_79b9;
    for _ in 0..4096 {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        noise.push(x as u8);
    }
    let r = apply(response("text/plain", noise.clone()), Some(Encoding::Gzip));
    assert!(r.headers().get(header::CONTENT_ENCODING).is_none());
    assert_eq!(r.body().as_ref(), noise.as_slice());
}

/// `docs/24-threat-model.md`, "End user" (BREACH): a response the cell
/// marks with `NoCompress` is never compressed, whatever the client
/// accepts.
#[test]
fn responses_marked_no_compress_are_never_compressed() {
    let big = json_body(16 * 1024);
    let mut r = response("text/html; charset=utf-8", big.clone());
    r.extensions_mut().insert(NoCompress);
    let r = apply(r, Some(Encoding::Br));
    assert!(r.headers().get(header::CONTENT_ENCODING).is_none());
    assert_eq!(r.body().as_ref(), big.as_slice());
}

#[test]
fn vary_is_merged_and_strong_etags_become_weak() {
    let big = json_body(4096);
    let mut r = response("application/json", big.clone());
    r.headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Cookie"));
    r.headers_mut()
        .insert(header::ETAG, HeaderValue::from_static("\"v1\""));
    let r = apply(r, Some(Encoding::Gzip));
    assert_eq!(vary(&r), ["cookie", "accept-encoding"]);
    assert_eq!(r.headers()[header::ETAG], "W/\"v1\"");

    // Already listed, or `Vary: *`: not added twice.
    for v in ["accept-encoding", "*", "Origin, Accept-Encoding"] {
        let mut r = response("application/json", big.clone());
        r.headers_mut()
            .insert(header::VARY, HeaderValue::from_str(v).unwrap());
        let r = apply(r, Some(Encoding::Br));
        assert_eq!(r.headers().get_all(header::VARY).iter().count(), 1, "{v}");
    }

    // A weak ETag stays as it is.
    let mut r = response("application/json", big);
    r.headers_mut()
        .insert(header::ETAG, HeaderValue::from_static("W/\"v2\""));
    let r = apply(r, Some(Encoding::Br));
    assert_eq!(r.headers()[header::ETAG], "W/\"v2\"");
}

/// #161, `ops.md` section 6 ("Compression"): each chunk of a streamed body
/// is flushed, so what was sent so far decodes before the stream ends; the
/// whole stream decodes to the original bytes.
#[test]
fn streamed_chunks_are_flushed_and_decode_whole() {
    let chunks: [&[u8]; 3] = [
        b"<html><head>",
        b"<title>shop</title></head>",
        b"<body>ok</body></html>",
    ];
    for encoding in [Encoding::Gzip, Encoding::Br] {
        let mut e = StreamEncoder::new(encoding);
        let mut sent = Vec::new();
        let mut plain = Vec::new();
        for c in chunks {
            let out = e.encode(c);
            assert!(!out.is_empty(), "{encoding:?}: a flushed chunk has bytes");
            sent.extend_from_slice(&out);
            plain.extend_from_slice(c);
            // A streaming decoder gets everything written so far.
            let mut got = vec![0u8; plain.len()];
            let read = match encoding {
                Encoding::Gzip => {
                    let mut d = flate2::read::GzDecoder::new(&sent[..]);
                    read_some(&mut d, &mut got)
                }
                Encoding::Br => {
                    let mut d = brotli::Decompressor::new(&sent[..], 4096);
                    read_some(&mut d, &mut got)
                }
            };
            assert_eq!(
                &got[..read],
                &plain[..],
                "{encoding:?}: flushed bytes decode"
            );
        }
        sent.extend_from_slice(&e.finish());
        let whole = match encoding {
            Encoding::Gzip => gunzip(&sent),
            Encoding::Br => unbrotli(&sent),
        };
        assert_eq!(whole, plain);
    }
}

/// Reads until `buf` is full or the decoder has no more (an unfinished
/// stream ends in an error, after the flushed bytes).
fn read_some(r: &mut impl Read, buf: &mut [u8]) -> usize {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) | Err(_) => break,
            Ok(k) => n += k,
        }
    }
    n
}

/// #161: a streamed head follows the static rules except the size: a small
/// or unknown-length text body is compressed, `Content-Length` removed;
/// `NoCompress`, images and an existing `Content-Encoding` are left alone.
#[test]
fn streamed_heads_follow_the_static_rules_without_the_size() {
    let mut r = response("text/html; charset=utf-8", Vec::new());
    r.headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from(10));
    r.headers_mut()
        .insert(header::ETAG, HeaderValue::from_static("\"v1\""));
    let e = apply_streamed(&mut r, Some(Encoding::Br));
    assert!(e.is_some());
    assert_eq!(r.headers()[header::CONTENT_ENCODING], "br");
    assert!(r.headers().get(header::CONTENT_LENGTH).is_none());
    assert_eq!(r.headers()[header::ETAG], "W/\"v1\"");
    assert_eq!(vary(&r), vec!["accept-encoding"]);

    let mut plain = response("text/csv", Vec::new());
    assert!(apply_streamed(&mut plain, None).is_none());
    assert_eq!(
        vary(&plain),
        vec!["accept-encoding"],
        "Vary even when not compressed"
    );

    let mut marked = response("text/html", Vec::new());
    marked.extensions_mut().insert(NoCompress);
    assert!(apply_streamed(&mut marked, Some(Encoding::Gzip)).is_none());

    let mut png = response("image/png", Vec::new());
    assert!(apply_streamed(&mut png, Some(Encoding::Gzip)).is_none());
    assert!(png.headers().get(header::VARY).is_none());

    let mut encoded = response("text/plain", Vec::new());
    encoded
        .headers_mut()
        .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    assert!(apply_streamed(&mut encoded, Some(Encoding::Br)).is_none());
}
