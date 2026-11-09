//! A bounded queue for one connection (#522, B14): a `VecDeque` and the
//! waiting tasks' wakers behind one mutex.
//!
//! It replaces `tokio::sync::mpsc` on the per-connection paths (the hub's
//! outbound queue, the WebSocket inbound queue): an mpsc channel allocates
//! its first block of 32 slots when it is created, so every idle
//! connection paid for 32 slots it never used. This queue allocates
//! nothing until the first item, keeps at most the smallest buffer once
//! drained, and its `recv` and `send` futures hold a reference and the
//! item only (no intrusive waiter: a waker in the shared state instead).
//! It also counts the items the receiver took, which is how the cell
//! meters delivered messages without a relay task.
//!
//! Many senders (cloned), one receiver. [`Receiver::recv`] is cancel-safe:
//! an item leaves the queue only when it is returned.

use std::collections::VecDeque;
use std::future::poll_fn;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, Waker};

struct Shared<T> {
    state: Mutex<State<T>>,
    /// Senders alive; the receiver ends when the last one is dropped.
    senders: AtomicUsize,
    cap: usize,
}

struct State<T> {
    items: VecDeque<T>,
    receiver: bool,
    /// Items the receiver took.
    taken: u64,
    /// The receiver, waiting for an item.
    rx_waker: Option<Waker>,
    /// Senders waiting for room ([`Sender::send`]).
    tx_wakers: Vec<Waker>,
}

impl<T> Shared<T> {
    fn lock(&self) -> MutexGuard<'_, State<T>> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn wake_receiver(&self) {
        let w = self.lock().rx_waker.take();
        if let Some(w) = w {
            w.wake();
        }
    }
}

fn register(slot: &mut Option<Waker>, cx: &Context<'_>) {
    match slot {
        Some(w) if w.will_wake(cx.waker()) => {}
        _ => *slot = Some(cx.waker().clone()),
    }
}

/// The sending side; clone it for more senders.
pub struct Sender<T>(Arc<Shared<T>>);

/// The receiving side. Dropping it drops the queued items and makes every
/// send fail.
pub struct Receiver<T>(Arc<Shared<T>>);

/// How many items a [`Receiver`] took, readable after it was moved away
/// (the meter's delivered messages).
pub struct Taken<T>(Arc<Shared<T>>);

/// Why [`Sender::try_send`] did not queue the item.
#[derive(Debug, PartialEq, Eq)]
pub enum TrySendError<T> {
    /// The queue holds its capacity.
    Full(T),
    /// The receiver is gone.
    Closed(T),
}

/// Why [`Receiver::try_recv`] returned nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TryRecvError {
    Empty,
    /// Empty, and every sender is gone.
    Disconnected,
}

/// A queue of at most `cap` items (at least 1).
pub fn bounded<T>(cap: usize) -> (Sender<T>, Receiver<T>) {
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            items: VecDeque::new(),
            receiver: true,
            taken: 0,
            rx_waker: None,
            tx_wakers: Vec::new(),
        }),
        senders: AtomicUsize::new(1),
        cap: cap.max(1),
    });
    (Sender(shared.clone()), Receiver(shared))
}

impl<T> Sender<T> {
    /// Queues `v` without waiting.
    pub fn try_send(&self, v: T) -> Result<(), TrySendError<T>> {
        let mut st = self.0.lock();
        if !st.receiver {
            return Err(TrySendError::Closed(v));
        }
        if st.items.len() >= self.0.cap {
            return Err(TrySendError::Full(v));
        }
        st.items.push_back(v);
        let w = st.rx_waker.take();
        drop(st);
        if let Some(w) = w {
            w.wake();
        }
        Ok(())
    }

    /// Queues `v`, waiting while the queue is full; `Err(v)` once the
    /// receiver is gone.
    pub async fn send(&self, v: T) -> Result<(), T> {
        let mut v = Some(v);
        poll_fn(move |cx| {
            let item = v.take().expect("polled after completion");
            match self.try_send(item) {
                Ok(()) => Poll::Ready(Ok(())),
                Err(TrySendError::Closed(x)) => Poll::Ready(Err(x)),
                Err(TrySendError::Full(x)) => {
                    let mut st = self.0.lock();
                    // Room made between the two locks: try again at once.
                    if st.items.len() < self.0.cap || !st.receiver {
                        drop(st);
                        cx.waker().wake_by_ref();
                    } else if !st.tx_wakers.iter().any(|w| w.will_wake(cx.waker())) {
                        st.tx_wakers.reserve_exact(1);
                        st.tx_wakers.push(cx.waker().clone());
                    }
                    v = Some(x);
                    Poll::Pending
                }
            }
        })
        .await
    }

    /// Whether the receiver is gone.
    pub fn is_closed(&self) -> bool {
        !self.0.lock().receiver
    }
}

impl<T> Clone for Sender<T> {
    fn clone(&self) -> Self {
        self.0.senders.fetch_add(1, Ordering::Relaxed);
        Sender(self.0.clone())
    }
}

impl<T> Drop for Sender<T> {
    fn drop(&mut self) {
        if self.0.senders.fetch_sub(1, Ordering::AcqRel) == 1 {
            // Under the lock after the count reached zero: a receiver that
            // registers later sees the zero.
            self.0.wake_receiver();
        }
    }
}

impl<T> Receiver<T> {
    /// The next item; `None` once the queue is empty and every sender is
    /// gone. Cancel-safe.
    pub async fn recv(&mut self) -> Option<T> {
        poll_fn(|cx| self.poll_recv(cx)).await
    }

    /// Polls for the next item (see [`Receiver::recv`]).
    pub fn poll_recv(&mut self, cx: &mut Context<'_>) -> Poll<Option<T>> {
        match self.try_recv() {
            Ok(v) => Poll::Ready(Some(v)),
            Err(TryRecvError::Disconnected) => Poll::Ready(None),
            Err(TryRecvError::Empty) => {
                let mut st = self.0.lock();
                // An item or the last sender's drop between the two locks:
                // poll again at once.
                if !st.items.is_empty() || self.0.senders.load(Ordering::Acquire) == 0 {
                    drop(st);
                    cx.waker().wake_by_ref();
                } else {
                    register(&mut st.rx_waker, cx);
                }
                Poll::Pending
            }
        }
    }

    /// The next item without waiting.
    pub fn try_recv(&mut self) -> Result<T, TryRecvError> {
        let mut st = self.0.lock();
        let Some(v) = st.items.pop_front() else {
            drop(st);
            return Err(if self.0.senders.load(Ordering::Acquire) == 0 {
                TryRecvError::Disconnected
            } else {
                TryRecvError::Empty
            });
        };
        st.taken += 1;
        if st.items.is_empty() && st.items.capacity() > 4 {
            // Give a burst's buffer back: an idle connection keeps at most
            // the smallest one.
            st.items = VecDeque::new();
        }
        let wakers = std::mem::take(&mut st.tx_wakers);
        drop(st);
        wakers.into_iter().for_each(Waker::wake);
        Ok(v)
    }

    /// Items queued now.
    pub fn len(&self) -> usize {
        self.0.lock().items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// A handle on the count of items this receiver takes.
    pub fn taken(&self) -> Taken<T> {
        Taken(self.0.clone())
    }
}

impl<T> Drop for Receiver<T> {
    fn drop(&mut self) {
        let (items, wakers) = {
            let mut st = self.0.lock();
            st.receiver = false;
            st.rx_waker = None;
            (
                std::mem::take(&mut st.items),
                std::mem::take(&mut st.tx_wakers),
            )
        };
        drop(items);
        wakers.into_iter().for_each(Waker::wake);
    }
}

impl<T> Taken<T> {
    pub fn get(&self) -> u64 {
        self.0.lock().taken
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bounded_fifo_and_close() {
        let (tx, mut rx) = bounded::<u32>(2);
        let taken = rx.taken();
        tx.try_send(1).unwrap();
        tx.try_send(2).unwrap();
        assert_eq!(tx.try_send(3), Err(TrySendError::Full(3)));
        assert_eq!(rx.recv().await, Some(1));
        assert_eq!(rx.try_recv(), Ok(2));
        assert_eq!(rx.try_recv(), Err(TryRecvError::Empty));
        assert_eq!(taken.get(), 2);
        let tx2 = tx.clone();
        drop(tx);
        tx2.try_send(4).unwrap();
        drop(tx2);
        // Queued items are still delivered after the last sender is gone.
        assert_eq!(rx.recv().await, Some(4));
        assert_eq!(rx.recv().await, None);
        assert_eq!(rx.try_recv(), Err(TryRecvError::Disconnected));
    }

    #[tokio::test]
    async fn send_waits_for_room_and_fails_without_receiver() {
        let (tx, mut rx) = bounded::<u32>(1);
        tx.send(1).await.unwrap();
        let waiting = tokio::spawn(async move {
            let r = tx.send(2).await;
            (r, tx)
        });
        tokio::task::yield_now().await;
        assert_eq!(rx.recv().await, Some(1));
        let (r, tx) = waiting.await.unwrap();
        assert_eq!(r, Ok(()));
        assert_eq!(rx.recv().await, Some(2));
        drop(rx);
        assert!(tx.is_closed());
        assert_eq!(tx.send(3).await, Err(3));
        assert_eq!(tx.try_send(4), Err(TrySendError::Closed(4)));
    }

    #[tokio::test]
    async fn recv_wakes_on_last_sender_drop() {
        let (tx, mut rx) = bounded::<u32>(4);
        let r = tokio::spawn(async move { rx.recv().await });
        tokio::task::yield_now().await;
        drop(tx);
        assert_eq!(r.await.unwrap(), None);
    }
}
