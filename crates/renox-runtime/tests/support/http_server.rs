//! A minimal HTTP/1.1 test server on 127.0.0.1 for the fetch tests.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// One request the server saw.
#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub host: String,
    pub authorization: Option<String>,
    pub body_len: usize,
}

pub struct TestServer {
    pub addr: SocketAddr,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

impl TestServer {
    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

/// Routes:
/// - `/hello` -> 200 `hello`
/// - `/echo` -> 200 JSON of method, host, path, authorization, body length
/// - `/redirect?status=302&to=<url>` -> redirect to `<url>`
/// - `/big` -> 200 with a 10 MB body
/// - `/slow` -> answers after 10 s
pub async fn start() -> TestServer {
    start_on("127.0.0.1:0").await
}

pub async fn start_on(bind: &str) -> TestServer {
    let listener = TcpListener::bind(bind).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let s = s.clone();
            tokio::spawn(async move {
                let _ = serve(stream, s).await;
            });
        }
    });
    TestServer { addr, seen }
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}

async fn serve(mut stream: TcpStream, seen: Arc<Mutex<Vec<Seen>>>) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let method = first.next().unwrap_or("").to_string();
    let target = first.next().unwrap_or("").to_string();
    let mut host = String::new();
    let mut authorization = None;
    let mut content_length = 0usize;
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            let v = v.trim().to_string();
            match k.to_ascii_lowercase().as_str() {
                "host" => host = v,
                "authorization" => authorization = Some(v),
                "content-length" => content_length = v.parse().unwrap_or(0),
                _ => {}
            }
        }
    }
    let mut body_len = buf.len() - head_end;
    while body_len < content_length {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body_len += n;
    }
    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    seen.lock().unwrap().push(Seen {
        method: method.clone(),
        path: path.to_string(),
        host: host.clone(),
        authorization: authorization.clone(),
        body_len,
    });
    let param = |name: &str| {
        query
            .split('&')
            .find_map(|kv| kv.strip_prefix(&format!("{name}=")).map(decode))
    };
    match path {
        "/hello" => respond(&mut stream, "200 OK", &[], b"hello").await,
        "/echo" => {
            let body = serde_json::json!({ "method": method, "host": host, "path": path, "authorization": authorization, "body_len": body_len });
            respond(
                &mut stream,
                "200 OK",
                &[("content-type", "application/json")],
                body.to_string().as_bytes(),
            )
            .await
        }
        "/redirect" => {
            let status = param("status").unwrap_or_else(|| "302".into());
            let to = param("to").unwrap_or_default();
            respond(
                &mut stream,
                &format!("{status} Redirect"),
                &[("location", &to)],
                b"",
            )
            .await
        }
        "/big" => {
            let total = 10 * 1024 * 1024;
            let head =
                format!("HTTP/1.1 200 OK\r\ncontent-length: {total}\r\nconnection: close\r\n\r\n");
            stream.write_all(head.as_bytes()).await?;
            let block = vec![b'x'; 64 * 1024];
            let mut sent = 0;
            while sent < total {
                if stream.write_all(&block).await.is_err() {
                    return Ok(());
                }
                sent += block.len();
            }
            Ok(())
        }
        "/slow" => {
            tokio::time::sleep(Duration::from_secs(10)).await;
            respond(&mut stream, "200 OK", &[], b"late").await
        }
        _ => respond(&mut stream, "404 Not Found", &[], b"").await,
    }
}

async fn respond(
    stream: &mut TcpStream,
    status: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n",
        body.len()
    );
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await
}
