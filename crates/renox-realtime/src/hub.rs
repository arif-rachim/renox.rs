//! One tenant's connections and topics (`ops.md` 1.5.0 section 18).
//!
//! A connection is a bounded outbound queue (256 messages) plus a close
//! signal. `publish` fans a message out with `try_send` only: a consumer
//! whose queue is full is closed with 1008 and counted, and the publisher
//! never waits. The transports (`ws.rs`, `sse.rs`) drain the queue to the
//! socket; the isolate is never involved in fan-out.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;

use crate::{Limits, Payload};

/// `docs/04-isolation-security.md`: the free tier's cap.
pub const FREE_CONNECTIONS: usize = 100;
/// The paid tiers' cap.
pub const PAID_CONNECTIONS: usize = 10_000;

/// WebSocket close codes the hub uses (RFC 6455 section 7.4.1).
pub mod close {
    /// The platform or the peer is going away (heartbeat timeout, shutdown).
    pub const GOING_AWAY: u16 = 1001;
    /// Policy violation: flood, backpressure, a denied subscribe.
    pub const POLICY: u16 = 1008;
    /// A message over the inbound limit.
    pub const TOO_BIG: u16 = 1009;
    /// The `open` handler threw, or a handler run was killed.
    pub const INTERNAL: u16 = 1011;
    /// A normal close by either side.
    pub const NORMAL: u16 = 1000;
}

/// The `reason` of `RENOX_REALTIME_LIMIT` (`ops.md` section 18, "Limits").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitReason {
    Tenant,
    User,
    Topics,
    MessageSize,
    Flood,
}

impl LimitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            LimitReason::Tenant => "tenant",
            LimitReason::User => "user",
            LimitReason::Topics => "topics",
            LimitReason::MessageSize => "message_size",
            LimitReason::Flood => "flood",
        }
    }
}

/// What the hub refuses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RealtimeError {
    /// `RENOX_REALTIME_LIMIT` with its reason.
    Limit(LimitReason),
    /// The caller's authorization decision was a deny (`RENOX_FORBIDDEN`).
    Forbidden,
    /// A topic outside `^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)*$`, or over 256 characters.
    BadTopic,
}

impl RealtimeError {
    pub fn code(&self) -> &'static str {
        match self {
            RealtimeError::Limit(_) => "RENOX_REALTIME_LIMIT",
            RealtimeError::Forbidden => "RENOX_FORBIDDEN",
            RealtimeError::BadTopic => "RENOX_VALIDATION",
        }
    }
}

/// `ws` or `sse`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Transport {
    Ws,
    Sse,
}

impl Transport {
    pub fn as_str(self) -> &'static str {
        match self {
            Transport::Ws => "ws",
            Transport::Sse => "sse",
        }
    }
}

/// Who connects: the principal id, or `ip:<address>` for an anonymous
/// client (the per-user cap counts either).
#[derive(Debug, Clone)]
pub struct ConnInfo {
    pub user: String,
    pub transport: Transport,
    /// `Last-Event-ID` of an SSE reconnect: missed events of the topics
    /// the connection subscribes to are replayed.
    pub last_event_id: Option<u64>,
}

/// One message to a connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    /// The hub-wide sequence number, increasing; the SSE `id:`.
    pub id: u64,
    pub topic: Option<Arc<str>>,
    /// The SSE `event:` name.
    pub event: Option<Arc<str>>,
    pub data: Arc<str>,
}

/// What a transport takes from a connection's queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outbound {
    Message(Arc<Event>),
}

/// Why a connection ended, for the counters and the meter record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Closed {
    pub code: u16,
    pub reason: String,
}

/// The receiving end of a connection: owned by its transport. Dropping it
/// disconnects.
pub struct Conn {
    pub id: String,
    pub transport: Transport,
    pub rx: mpsc::Receiver<Outbound>,
    signal: Arc<CloseSignal>,
    hub: Arc<Hub>,
    opened: Instant,
}

#[derive(Default)]
struct CloseSignal {
    closed: Mutex<Option<Closed>>,
    notify: Notify,
}

impl Conn {
    /// Resolves when the hub closed the connection (backpressure, `close`,
    /// a limit); the code and reason to send.
    pub fn closed(&self) -> impl std::future::Future<Output = Closed> + Send + 'static {
        let signal = self.signal.clone();
        async move {
            loop {
                let notified = signal.notify.notified();
                if let Some(c) = lock(&signal.closed).clone() {
                    return c;
                }
                notified.await;
            }
        }
    }

    /// Whether the hub closed the connection.
    pub fn is_closed(&self) -> bool {
        lock(&self.signal.closed).is_some()
    }

    pub fn hub(&self) -> &Arc<Hub> {
        &self.hub
    }

    /// Records the end of the connection: `code` and `reason` as sent or
    /// received; idempotent with a hub-side close.
    pub fn finish(&self, code: u16, reason: &str) {
        self.hub.set_closed(&self.id, code, reason);
    }

    /// Seconds since the connection was accepted.
    pub fn lifetime(&self) -> Duration {
        Instant::now().saturating_duration_since(self.opened)
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.hub.disconnect(&self.id, self.opened);
    }
}

struct ConnState {
    user: String,
    tx: mpsc::Sender<Outbound>,
    topics: HashSet<Arc<str>>,
    signal: Arc<CloseSignal>,
    last_event_id: Option<u64>,
}

struct TopicState {
    subscribers: HashSet<String>,
    replay: VecDeque<(Instant, Arc<Event>)>,
}

#[derive(Default)]
struct State {
    conns: HashMap<String, ConnState>,
    per_user: HashMap<String, usize>,
    topics: HashMap<Arc<str>, TopicState>,
}

/// Counters of one tenant, for the meter and the metrics endpoint.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Counters {
    pub live: usize,
    pub opened: u64,
    /// Connection-seconds of closed connections.
    pub connection_seconds: f64,
    pub messages_in: u64,
    pub messages_out: u64,
    /// Refused connects and subscribes by reason.
    pub refused: BTreeMap<&'static str, u64>,
    /// Closes by reason (`backpressure`, `flood`, `message_size`, `heartbeat`, `client`, …).
    pub closes: BTreeMap<String, u64>,
}

/// One tenant's hub.
pub struct Hub {
    limits: Limits,
    state: Mutex<State>,
    counters: Mutex<Counters>,
    next_conn: AtomicU64,
    next_event: AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `ops.md` section 18: at most 256 characters, segments `[A-Za-z0-9_.-]+`
/// split on `:`.
pub fn valid_topic(topic: &str) -> bool {
    !topic.is_empty()
        && topic.len() <= 256
        && topic.split(':').all(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        })
}

impl Hub {
    pub fn new(limits: Limits) -> Arc<Hub> {
        Arc::new(Hub {
            limits,
            state: Mutex::new(State::default()),
            counters: Mutex::new(Counters::default()),
            next_conn: AtomicU64::new(1),
            next_event: AtomicU64::new(1),
        })
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    fn refuse(&self, r: LimitReason) -> RealtimeError {
        *lock(&self.counters).refused.entry(r.as_str()).or_default() += 1;
        RealtimeError::Limit(r)
    }

    /// Accepts a connection, or refuses it over the tenant or user cap
    /// (`RENOX_REALTIME_LIMIT`, 503 with `Retry-After: 5` at the upgrade).
    pub fn connect(self: &Arc<Self>, info: ConnInfo) -> Result<Conn, RealtimeError> {
        let mut st = lock(&self.state);
        if st.conns.len() >= self.limits.tenant_connections {
            drop(st);
            return Err(self.refuse(LimitReason::Tenant));
        }
        if st.per_user.get(&info.user).copied().unwrap_or(0) >= self.limits.user_connections {
            drop(st);
            return Err(self.refuse(LimitReason::User));
        }
        let id = format!("c{}", self.next_conn.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::channel(self.limits.queue);
        let signal = Arc::new(CloseSignal::default());
        *st.per_user.entry(info.user.clone()).or_default() += 1;
        st.conns.insert(
            id.clone(),
            ConnState {
                user: info.user,
                tx,
                topics: HashSet::new(),
                signal: signal.clone(),
                last_event_id: info.last_event_id,
            },
        );
        let live = st.conns.len();
        drop(st);
        {
            let mut c = lock(&self.counters);
            c.live = live;
            c.opened += 1;
        }
        Ok(Conn {
            id,
            transport: info.transport,
            rx,
            signal,
            hub: self.clone(),
            opened: Instant::now(),
        })
    }

    /// Subscribes `conn` to `topic` with the caller's authorization
    /// decision (`allowed`, the Cedar `realtime.subscribe` check). An
    /// unknown or closed connection is ignored (`Ok`). An SSE connection
    /// with a `Last-Event-ID` gets the topic's missed events first.
    pub fn subscribe(&self, conn: &str, topic: &str, allowed: bool) -> Result<(), RealtimeError> {
        if !valid_topic(topic) {
            return Err(RealtimeError::BadTopic);
        }
        if !allowed {
            *lock(&self.counters).refused.entry("forbidden").or_default() += 1;
            return Err(RealtimeError::Forbidden);
        }
        let mut st = lock(&self.state);
        let Some(c) = st.conns.get(conn) else {
            return Ok(());
        };
        if c.topics.iter().any(|t| &**t == topic) {
            return Ok(());
        }
        if c.topics.len() >= self.limits.topics_per_connection {
            drop(st);
            return Err(self.refuse(LimitReason::Topics));
        }
        let key: Arc<str> = st
            .topics
            .get_key_value(topic)
            .map(|(k, _)| k.clone())
            .unwrap_or_else(|| topic.into());
        let replay: Vec<Arc<Event>> = match c.last_event_id {
            Some(after) => {
                let horizon = Instant::now().checked_sub(self.limits.replay_window);
                st.topics
                    .get(topic)
                    .map(|t| {
                        t.replay
                            .iter()
                            .filter(|(at, e)| e.id > after && horizon.is_none_or(|h| *at >= h))
                            .map(|(_, e)| e.clone())
                            .collect()
                    })
                    .unwrap_or_default()
            }
            None => Vec::new(),
        };
        let c = st.conns.get_mut(conn).expect("checked above");
        c.topics.insert(key.clone());
        let tx = c.tx.clone();
        let signal = c.signal.clone();
        st.topics
            .entry(key)
            .or_insert_with(|| TopicState {
                subscribers: HashSet::new(),
                replay: VecDeque::new(),
            })
            .subscribers
            .insert(conn.to_string());
        drop(st);
        let mut delivered = 0u64;
        for e in replay {
            if tx.try_send(Outbound::Message(e)).is_err() {
                self.close_signal(conn, &signal, close::POLICY, "backpressure");
                break;
            }
            delivered += 1;
        }
        lock(&self.counters).messages_out += delivered;
        Ok(())
    }

    pub fn unsubscribe(&self, conn: &str, topic: &str) {
        let mut st = lock(&self.state);
        let Some(c) = st.conns.get_mut(conn) else {
            return;
        };
        c.topics.retain(|t| &**t != topic);
        if let Some(t) = st.topics.get_mut(topic) {
            t.subscribers.remove(conn);
        }
    }

    fn event(
        &self,
        topic: Option<Arc<str>>,
        payload: Payload,
    ) -> Result<Arc<Event>, RealtimeError> {
        let (data, name) = payload.into_parts();
        if data.len() > self.limits.max_outbound_bytes {
            return Err(self.refuse(LimitReason::MessageSize));
        }
        Ok(Arc::new(Event {
            id: self.next_event.fetch_add(1, Ordering::Relaxed),
            topic,
            event: name.map(Into::into),
            data: data.into(),
        }))
    }

    /// Queues `payload` for every subscriber of `topic`; returns how many
    /// connections it was queued for. Never waits: a full queue closes
    /// that connection with 1008 (`backpressure`).
    pub fn publish(&self, topic: &str, payload: Payload) -> Result<usize, RealtimeError> {
        if !valid_topic(topic) {
            return Err(RealtimeError::BadTopic);
        }
        let mut st = lock(&self.state);
        let key: Arc<str> = st
            .topics
            .get_key_value(topic)
            .map(|(k, _)| k.clone())
            .unwrap_or_else(|| topic.into());
        let event = self.event(Some(key.clone()), payload)?;
        let window = self.limits.replay_window;
        let keep = self.limits.replay_events;
        let now = Instant::now();
        let State { topics, conns, .. } = &mut *st;
        let t = topics.entry(key).or_insert_with(|| TopicState {
            subscribers: HashSet::new(),
            replay: VecDeque::new(),
        });
        t.replay.push_back((now, event.clone()));
        while t.replay.len() > keep
            || t.replay
                .front()
                .is_some_and(|(at, _)| now.saturating_duration_since(*at) > window)
        {
            t.replay.pop_front();
        }
        let targets: Vec<(String, mpsc::Sender<Outbound>, Arc<CloseSignal>)> = t
            .subscribers
            .iter()
            .filter_map(|id| {
                conns
                    .get(id)
                    .map(|c| (id.clone(), c.tx.clone(), c.signal.clone()))
            })
            .collect();
        drop(st);
        let mut queued = 0;
        for (id, tx, signal) in targets {
            if lock(&signal.closed).is_some() {
                continue;
            }
            match tx.try_send(Outbound::Message(event.clone())) {
                Ok(()) => queued += 1,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    self.close_signal(&id, &signal, close::POLICY, "backpressure")
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {}
            }
        }
        lock(&self.counters).messages_out += queued as u64;
        Ok(queued)
    }

    /// Queues `payload` for one connection; an unknown or closed one is
    /// ignored.
    pub fn send(&self, conn: &str, payload: Payload) -> Result<(), RealtimeError> {
        let event = self.event(None, payload)?;
        let st = lock(&self.state);
        let Some(c) = st.conns.get(conn) else {
            return Ok(());
        };
        let (tx, signal) = (c.tx.clone(), c.signal.clone());
        drop(st);
        match tx.try_send(Outbound::Message(event)) {
            Ok(()) => lock(&self.counters).messages_out += 1,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.close_signal(conn, &signal, close::POLICY, "backpressure")
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {}
        }
        Ok(())
    }

    /// Closes `conn` with `code` and `reason` (the transport sends them).
    pub fn close(&self, conn: &str, code: u16, reason: &str) {
        let signal = lock(&self.state).conns.get(conn).map(|c| c.signal.clone());
        if let Some(s) = signal {
            self.close_signal(conn, &s, code, reason);
        }
    }

    fn close_signal(&self, conn: &str, signal: &CloseSignal, code: u16, reason: &str) {
        let mut c = lock(&signal.closed);
        if c.is_none() {
            *c = Some(Closed {
                code,
                reason: reason.to_string(),
            });
            drop(c);
            signal.notify.notify_waiters();
            *lock(&self.counters)
                .closes
                .entry(close_reason(code, reason))
                .or_default() += 1;
            let _ = conn;
        }
    }

    /// A close the transport saw (the client's, a heartbeat timeout, a
    /// flood): recorded once.
    pub(crate) fn set_closed(&self, conn: &str, code: u16, reason: &str) {
        let signal = lock(&self.state).conns.get(conn).map(|c| c.signal.clone());
        if let Some(s) = signal {
            self.close_signal(conn, &s, code, reason);
        }
    }

    /// One inbound message on `conn` (a frame, an SSE request body).
    pub(crate) fn count_in(&self) {
        lock(&self.counters).messages_in += 1;
    }

    fn disconnect(&self, conn: &str, opened: Instant) {
        let mut st = lock(&self.state);
        let Some(c) = st.conns.remove(conn) else {
            return;
        };
        if let Some(n) = st.per_user.get_mut(&c.user) {
            *n -= 1;
            if *n == 0 {
                st.per_user.remove(&c.user);
            }
        }
        for t in &c.topics {
            if let Some(ts) = st.topics.get_mut(t) {
                ts.subscribers.remove(conn);
            }
        }
        // A topic with no subscriber keeps its replay buffer while it is
        // fresh; an empty, stale one is dropped.
        let now = Instant::now();
        let window = self.limits.replay_window;
        st.topics.retain(|_, t| {
            !t.subscribers.is_empty()
                || t.replay
                    .back()
                    .is_some_and(|(at, _)| now.saturating_duration_since(*at) <= window)
        });
        let live = st.conns.len();
        drop(st);
        let unclosed = lock(&c.signal.closed).is_none();
        let mut k = lock(&self.counters);
        k.live = live;
        k.connection_seconds += now.saturating_duration_since(opened).as_secs_f64();
        if unclosed {
            *k.closes.entry("dropped".into()).or_default() += 1;
        }
    }

    /// Live connections of `user`.
    pub fn user_connections(&self, user: &str) -> usize {
        lock(&self.state).per_user.get(user).copied().unwrap_or(0)
    }

    /// The subscribers of `topic`.
    pub fn subscribers(&self, topic: &str) -> usize {
        lock(&self.state)
            .topics
            .get(topic)
            .map_or(0, |t| t.subscribers.len())
    }

    /// The counters now (live connection-seconds not included).
    pub fn snapshot(&self) -> Counters {
        lock(&self.counters).clone()
    }
}

fn close_reason(code: u16, reason: &str) -> String {
    if reason.is_empty() {
        format!("code_{code}")
    } else {
        reason.to_string()
    }
}
