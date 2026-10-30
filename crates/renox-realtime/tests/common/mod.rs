//! A WebSocket client over an in-memory duplex stream: masked frames out,
//! server frames in.
#![allow(dead_code)]

use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

pub struct Client {
    pub io: DuplexStream,
}

pub fn frame(opcode: u8, fin: bool, payload: &[u8]) -> Vec<u8> {
    let mask = [0x12u8, 0x34, 0x56, 0x78];
    let mut out = vec![(if fin { 0x80 } else { 0 }) | opcode];
    match payload.len() {
        n if n < 126 => out.push(0x80 | n as u8),
        n if n <= u16::MAX as usize => {
            out.push(0x80 | 126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            out.push(0x80 | 127);
            out.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    out.extend_from_slice(&mask);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    out
}

impl Client {
    pub async fn send_text(&mut self, s: &str) {
        self.io
            .write_all(&frame(0x1, true, s.as_bytes()))
            .await
            .unwrap();
    }

    pub async fn send_raw(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.io.write_all(bytes).await
    }

    /// The next server frame: (opcode, payload); `None` at EOF.
    pub async fn read(&mut self) -> Option<(u8, Vec<u8>)> {
        let mut h = [0u8; 2];
        self.io.read_exact(&mut h).await.ok()?;
        assert_eq!(h[1] & 0x80, 0, "server frames are not masked");
        let mut len = u64::from(h[1] & 0x7f);
        if len == 126 {
            let mut b = [0u8; 2];
            self.io.read_exact(&mut b).await.ok()?;
            len = u64::from(u16::from_be_bytes(b));
        } else if len == 127 {
            let mut b = [0u8; 8];
            self.io.read_exact(&mut b).await.ok()?;
            len = u64::from_be_bytes(b);
        }
        let mut p = vec![0u8; len as usize];
        self.io.read_exact(&mut p).await.ok()?;
        Some((h[0] & 0x0f, p))
    }

    /// The next data or close frame, answering pings on the way.
    pub async fn next(&mut self) -> Option<(u8, Vec<u8>)> {
        loop {
            let (op, p) = self.read().await?;
            if op == 0x9 {
                self.io.write_all(&frame(0xA, true, &p)).await.ok()?;
                continue;
            }
            return Some((op, p));
        }
    }

    /// The close code of a close frame.
    pub fn code(p: &[u8]) -> u16 {
        u16::from_be_bytes([p[0], p[1]])
    }
}
