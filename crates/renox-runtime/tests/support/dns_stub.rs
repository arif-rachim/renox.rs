//! A scripted DNS server over UDP for the rebinding tests (#108): the n-th
//! A (or AAAA) query for a name gets the n-th answer set of its script
//! (the last set repeats), with TTL 0.
#![allow(dead_code)]

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};

use hickory_proto::op::{Message, MessageType, ResponseCode};
use hickory_proto::rr::rdata::{A, AAAA};
use hickory_proto::rr::{RData, Record, RecordType};
use tokio::net::UdpSocket;

pub struct DnsStub {
    pub addr: SocketAddr,
    /// (name, "A" | "AAAA") -> queries answered.
    pub counts: Arc<Mutex<HashMap<(String, &'static str), usize>>>,
}

impl DnsStub {
    pub fn a_queries(&self, name: &str) -> usize {
        self.counts
            .lock()
            .unwrap()
            .get(&(name.to_string(), "A"))
            .copied()
            .unwrap_or(0)
    }
}

pub async fn start(script: HashMap<String, Vec<Vec<IpAddr>>>) -> DnsStub {
    let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = socket.local_addr().unwrap();
    let counts: Arc<Mutex<HashMap<(String, &'static str), usize>>> = Arc::default();
    let c = counts.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 1500];
        loop {
            let Ok((n, peer)) = socket.recv_from(&mut buf).await else {
                return;
            };
            let Ok(query) = Message::from_vec(&buf[..n]) else {
                continue;
            };
            let mut reply = Message::new();
            reply
                .set_id(query.id())
                .set_message_type(MessageType::Response)
                .set_recursion_desired(true)
                .set_recursion_available(true);
            let mut code = ResponseCode::NoError;
            for q in query.queries() {
                reply.add_query(q.clone());
                let name = q
                    .name()
                    .to_ascii()
                    .trim_end_matches('.')
                    .to_ascii_lowercase();
                let kind = match q.query_type() {
                    RecordType::A => "A",
                    RecordType::AAAA => "AAAA",
                    _ => continue,
                };
                let Some(sets) = script.get(&name) else {
                    code = ResponseCode::NXDomain;
                    continue;
                };
                let i = {
                    let mut c = c.lock().unwrap();
                    let e = c.entry((name.clone(), kind)).or_insert(0);
                    *e += 1;
                    *e - 1
                };
                let set = &sets[i.min(sets.len() - 1)];
                for ip in set {
                    let rdata = match (ip, kind) {
                        (IpAddr::V4(v4), "A") => RData::A(A(*v4)),
                        (IpAddr::V6(v6), "AAAA") => RData::AAAA(AAAA(*v6)),
                        _ => continue,
                    };
                    reply.add_answer(Record::from_rdata(q.name().clone(), 0, rdata));
                }
            }
            reply.set_response_code(code);
            if let Ok(bytes) = reply.to_vec() {
                let _ = socket.send_to(&bytes, peer).await;
            }
        }
    });
    DnsStub { addr, counts }
}
