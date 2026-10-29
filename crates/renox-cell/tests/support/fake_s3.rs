//! A fake object store behind a fake control API, for the artifact fetch
//! of controlled mode without Postgres or MinIO (#275): `GET
//! /v1/nodes/{node}/artifacts/{hash}` answers 307 to a presigned-looking
//! URL on the same listener, which answers the stored object (a tar).

#![allow(dead_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

const BLOCK: usize = 512;

fn header(name: &str, size: u64) -> [u8; BLOCK] {
    let mut h = [0u8; BLOCK];
    h[..name.len()].copy_from_slice(name.as_bytes());
    h[100..107].copy_from_slice(b"0000644");
    h[124..136].copy_from_slice(format!("{size:011o}\0").as_bytes());
    h[136..148].copy_from_slice(b"00000000000\0");
    h[156] = b'0';
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    h[148..156].copy_from_slice(b"        ");
    let sum: u64 = h.iter().map(|b| u64::from(*b)).sum();
    h[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    h
}

/// The ustar archive of every regular file under `dir` (names relative,
/// sorted), as `control/api` stores an upload.
pub fn tar_of(dir: &Path) -> Vec<u8> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                let rel = p
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, std::fs::read(&p).unwrap()));
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, dir, &mut files);
    files.sort();
    let mut tar = Vec::new();
    for (name, data) in files {
        tar.extend_from_slice(&header(&name, data.len() as u64));
        tar.extend_from_slice(&data);
        tar.extend(std::iter::repeat_n(0, (BLOCK - data.len() % BLOCK) % BLOCK));
    }
    tar.extend(std::iter::repeat_n(0, 2 * BLOCK));
    tar
}

/// The fake: objects by deployment hash.
#[derive(Clone, Default)]
pub struct FakeS3 {
    objects: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    /// Requests seen, as `METHOD path` (the query of a presigned URL dropped).
    pub seen: Arc<Mutex<Vec<String>>>,
}

impl FakeS3 {
    pub fn put(&self, hash: &str, bytes: Vec<u8>) {
        self.objects.lock().unwrap().insert(hash.to_string(), bytes);
    }

    /// Serves on 127.0.0.1; the base URL to give `ControlClient`.
    pub async fn start(&self) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else {
                    return;
                };
                let me = me.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match s.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let head = String::from_utf8_lossy(&buf).into_owned();
                    let mut parts = head.split_whitespace();
                    let method = parts.next().unwrap_or("").to_string();
                    let target = parts.next().unwrap_or("").to_string();
                    let path = target.split('?').next().unwrap_or("").to_string();
                    me.seen.lock().unwrap().push(format!("{method} {path}"));
                    let (status, extra, body) = if let Some(hash) = path
                        .strip_prefix("/v1/nodes/")
                        .and_then(|r| r.split_once("/artifacts/"))
                        .map(|(_, h)| h.to_string())
                    {
                        let location =
                            format!("http://{addr}/renox-artifacts/{hash}?X-Amz-Signature=fake");
                        (
                            "307 Temporary Redirect",
                            format!("location: {location}\r\n"),
                            Vec::new(),
                        )
                    } else if let Some(hash) = path.strip_prefix("/renox-artifacts/") {
                        match me.objects.lock().unwrap().get(hash) {
                            Some(b) => (
                                "200 OK",
                                "content-type: application/x-tar\r\n".to_string(),
                                b.clone(),
                            ),
                            None => ("404 Not Found", String::new(), Vec::new()),
                        }
                    } else {
                        ("404 Not Found", String::new(), Vec::new())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status}\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = s.write_all(reply.as_bytes()).await;
                    let _ = s.write_all(&body).await;
                    let _ = s.shutdown().await;
                });
            }
        });
        format!("http://{addr}")
    }
}
